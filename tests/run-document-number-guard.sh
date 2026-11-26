#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
container="nm-document-number-guard-test-$$"
tmpdir="$(mktemp -d)"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmpdir"' EXIT INT TERM
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest postgres:17-alpine >/dev/null
attempt=0
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo 'PostgreSQL did not start' >&2; exit 1; }
  sleep 1
done
for file in tests/sql/document_number_guard_setup.sql supabase/migrations/20261126125226_document_number_guard.sql tests/sql/document_number_guard.sql; do
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$file"
done

# Separate database connections. Wait until connection 1 has inserted and is
# asleep inside its transaction; connection 2 must block until commit and
# then reject a differently formatted copy of the same business number.
run_race() {
  label="$1" first="$2" second="$3" table="$4" expected="$5"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SET application_name='nm-number-first'; BEGIN; SET LOCAL test.org='00000000-0000-0000-0000-000000000001'; SET LOCAL test.role='admin'; $first; SELECT pg_sleep(3); COMMIT;" >"$tmpdir/$label-first.log" 2>&1 &
  first_pid=$!
  ready=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [ "$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select count(*) from pg_stat_activity where application_name='nm-number-first' and wait_event='PgSleep'")" = 1 ]; then ready=1; break; fi
    sleep 0.1
  done
  [ "$ready" = 1 ] || { cat "$tmpdir/$label-first.log" >&2; echo "$label: first session did not reach its open transaction" >&2; exit 1; }
  if docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "BEGIN; SET LOCAL test.org='00000000-0000-0000-0000-000000000001'; SET LOCAL test.role='admin'; $second; COMMIT;" >"$tmpdir/$label-second.log" 2>&1; then
    echo "$label: duplicate was accepted" >&2; exit 1
  fi
  wait "$first_pid"
  if ! grep -q "$expected" "$tmpdir/$label-second.log"; then cat "$tmpdir/$label-second.log" >&2; exit 1; fi
  count="$(docker exec "$container" psql -X -A -t -U postgres -d postgres -c "select count(*) from public.$table where id like 'RACE-$label%'")"
  [ "$count" = 1 ] || { echo "$label: expected one surviving row, got $count" >&2; exit 1; }
  echo "PASS: $label concurrent duplicate rejected"
}
run_race sales "INSERT INTO public.sales_orders(id,organization_id,sales_order_no) VALUES('RACE-sales-1','00000000-0000-0000-0000-000000000001','SO-RACE')" "INSERT INTO public.sales_orders(id,organization_id,sales_order_no) VALUES('RACE-sales-2','00000000-0000-0000-0000-000000000001',' so - race ')" sales_orders SALES_ORDER_NUMBER_ALREADY_USED
run_race invoice "SELECT public.save_invoice_atomic('{\"id\":\"RACE-invoice\"}'::jsonb,null)" "SELECT public.save_invoice_atomic('{\"id\":\"RACE- INVOICE\"}'::jsonb,null)" invoices INVOICE_NUMBER_ALREADY_USED
