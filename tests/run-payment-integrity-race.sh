#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
container="nm-payment-integrity-test-$$"
tmpdir="$(mktemp -d)"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmpdir"' EXIT INT TERM
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest postgres:17-alpine >/dev/null
attempt=0
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { echo 'PostgreSQL did not start' >&2; exit 1; }
  sleep 1
done
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/sql/payment_integrity_setup.sql >/dev/null
sed -n '/^create or replace function public.save_payment_received_atomic(/,/^create or replace function public.delete_payment_received_guarded(/p' supabase/migrations/20260707_94_payment_atomic_status_boundary.sql | sed '$d' | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
sed -n '/^create or replace function public.delete_payment_received_guarded(/,/^grant execute on function public.save_payment_received_atomic/p' supabase/migrations/20260707_94_payment_atomic_status_boundary.sql | sed '$d' | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/20261126133711_payment_integrity_guard.sql >/dev/null

run_race() {
  label="$1" fn="$2" field="$3" table="$4"
  first="SELECT public.$fn('{\"id\":\"RACE-$label\",\"$field\":\"A\",\"amount\":100,\"currency\":\"EUR\"}'::jsonb,null)"
  second="SELECT public.$fn('{\"id\":\" race - $label \",\"$field\":\"A\",\"amount\":200,\"currency\":\"EUR\"}'::jsonb,null)"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SET application_name='nm-payment-first'; BEGIN; $first; SELECT pg_sleep(3); COMMIT;" >"$tmpdir/$label-first.log" 2>&1 &
  first_pid=$!
  ready=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [ "$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select count(*) from pg_stat_activity where application_name='nm-payment-first' and wait_event='PgSleep'")" = 1 ]; then ready=1; break; fi
    sleep 0.1
  done
  [ "$ready" = 1 ] || { cat "$tmpdir/$label-first.log" >&2; exit 1; }
  if docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "BEGIN; $second; COMMIT;" >"$tmpdir/$label-second.log" 2>&1; then
    echo "$label: duplicate was accepted" >&2; exit 1
  fi
  wait "$first_pid"
  if ! grep -q PAYMENT_NUMBER_ALREADY_USED "$tmpdir/$label-second.log"; then cat "$tmpdir/$label-second.log" >&2; exit 1; fi
  count="$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select count(*) from public.$table where id like 'RACE-$label%'")"
  [ "$count" = 1 ] || { echo "$label: expected one surviving payment, got $count" >&2; exit 1; }
  echo "PASS: $label concurrent duplicate rejected"
}
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/20261126140500_payment_version_guard.sql >/dev/null
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/20261126141700_payment_delete_version_guard.sql >/dev/null
run_race receipt save_payment_received_atomic invoice_id payments_received
run_race made save_payment_made_atomic bill_id payments_made

run_update_race() {
  label="$1" fn="$2" field="$3" table="$4"
  id="UPDATE-$label"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SELECT public.$fn('{\"id\":\"$id\",\"$field\":\"A\",\"amount\":100,\"currency\":\"EUR\"}'::jsonb,null)" >/dev/null
  version="$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select updated_at::text from public.$table where id='$id'")"
  first="SELECT public.$fn('{\"id\":\"$id\",\"$field\":\"A\",\"amount\":200,\"currency\":\"EUR\",\"expected_updated_at\":\"$version\"}'::jsonb,'$id')"
  second="SELECT public.$fn('{\"id\":\"$id\",\"$field\":\"A\",\"amount\":300,\"currency\":\"EUR\",\"expected_updated_at\":\"$version\"}'::jsonb,'$id')"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SET application_name='nm-version-first'; BEGIN; $first; SELECT pg_sleep(3); COMMIT;" >"$tmpdir/$label-version-first.log" 2>&1 &
  first_pid=$!
  ready=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [ "$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select count(*) from pg_stat_activity where application_name='nm-version-first' and wait_event='PgSleep'")" = 1 ]; then ready=1; break; fi
    sleep 0.1
  done
  [ "$ready" = 1 ] || { cat "$tmpdir/$label-version-first.log" >&2; exit 1; }
  if docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "BEGIN; $second; COMMIT;" >"$tmpdir/$label-version-second.log" 2>&1; then echo "$label stale update accepted" >&2; exit 1; fi
  wait "$first_pid"
  grep -q PAYMENT_VERSION_CONFLICT "$tmpdir/$label-version-second.log" || { cat "$tmpdir/$label-version-second.log" >&2; exit 1; }
  amount="$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select amount from public.$table where id='$id'")"
  [ "$amount" = 200.00 ] || [ "$amount" = 200 ] || { echo "$label wrong resulting amount $amount" >&2; exit 1; }
  echo "PASS: $label concurrent stale update rejected"
}
run_update_race receipt save_payment_received_atomic invoice_id payments_received
run_update_race made save_payment_made_atomic bill_id payments_made

run_delete_race() {
  label="$1" savefn="$2" deletefn="$3" field="$4" table="$5" resultkey="$6"
  id="DELETE-$label"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SELECT public.$savefn('{\"id\":\"$id\",\"$field\":\"A\",\"amount\":100,\"currency\":\"EUR\"}'::jsonb,null)" >/dev/null
  version="$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select updated_at::text from public.$table where id='$id'")"
  if docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SELECT public.$deletefn('$id')" >"$tmpdir/$label-old-delete.log" 2>&1; then echo "$label legacy delete accepted" >&2; exit 1; fi
  grep -q PAYMENT_VERSION_REQUIRED "$tmpdir/$label-old-delete.log" || { cat "$tmpdir/$label-old-delete.log" >&2; exit 1; }
  update="SELECT public.$savefn('{\"id\":\"$id\",\"$field\":\"A\",\"amount\":200,\"currency\":\"EUR\",\"expected_updated_at\":\"$version\"}'::jsonb,'$id')"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SET application_name='nm-delete-first'; BEGIN; $update; SELECT pg_sleep(3); COMMIT;" >"$tmpdir/$label-delete-first.log" 2>&1 &
  first_pid=$!
  ready=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [ "$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select count(*) from pg_stat_activity where application_name='nm-delete-first' and wait_event='PgSleep'")" = 1 ]; then ready=1; break; fi
    sleep 0.1
  done
  [ "$ready" = 1 ] || { cat "$tmpdir/$label-delete-first.log" >&2; exit 1; }
  if docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SELECT public.$deletefn('$id','$version')" >"$tmpdir/$label-delete-stale.log" 2>&1; then echo "$label stale delete accepted" >&2; exit 1; fi
  wait "$first_pid"
  grep -q PAYMENT_VERSION_CONFLICT "$tmpdir/$label-delete-stale.log" || { cat "$tmpdir/$label-delete-stale.log" >&2; exit 1; }
  count="$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select count(*) from public.$table where id='$id'")"
  [ "$count" = 1 ] || { echo "$label unexpectedly deleted" >&2; exit 1; }
  current="$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select updated_at::text from public.$table where id='$id'")"
  result="$(docker exec "$container" psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres -c "select public.$deletefn('$id','$current')->'$resultkey'->>'id'")"
  [ "$result" = A ] || { echo "$label failed to recalculate document" >&2; exit 1; }
  echo "PASS: $label stale delete rejected; fresh delete recalculates"
}
run_delete_race receipt save_payment_received_atomic delete_payment_received_guarded invoice_id payments_received invoice
run_delete_race made save_payment_made_atomic delete_payment_made_guarded bill_id payments_made bill
