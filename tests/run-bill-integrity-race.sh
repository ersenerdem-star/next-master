#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
container="nm-bill-integrity-test-$$"
tmpdir="$(mktemp -d)"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmpdir"' EXIT INT TERM
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest postgres:17-alpine >/dev/null
attempt=0
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 1; done
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/sql/bill_integrity_setup.sql >/dev/null
sed -n '/^create or replace function public.save_bill_atomic(/,/^grant execute on function public.save_invoice_atomic/p' supabase/migrations/20260707_95_invoice_bill_guarded_boundary.sql | sed '$d' | docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/20261126143500_bill_version_guard.sql >/dev/null
q() { docker exec "$container" psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$1"; }
privileges="$(q "select has_table_privilege('authenticated','bills','insert') and not has_table_privilege('authenticated','bills','truncate') and not has_table_privilege('authenticated','payments_received','trigger') and has_table_privilege('service_role','bills','update')")"
[ "$privileges" = t ] || { echo 'incorrect privileges' >&2; exit 1; }
if q "select public.delete_bill_guarded('B1')" >"$tmpdir/legacy" 2>&1; then echo 'legacy delete accepted' >&2; exit 1; fi
grep -q BILL_VERSION_REQUIRED "$tmpdir/legacy"
for id in PART1 PART2; do q "select public.save_bill_atomic('{\"id\":\"$id\",\"purchase_order_id\":\"PO1\",\"currency\":\"EUR\",\"lines\":[{\"qty\":1,\"buy_price\":5}]}'::jsonb,null)" >/dev/null; done
[ "$(q "select count(*) from bills where purchase_order_id='PO1'")" = 3 ] || { echo 'partial bills failed' >&2; exit 1; }
version="$(q "select updated_at::text from bills where id='B1'")"
first="select public.save_bill_atomic('{\"id\":\"B1\",\"purchase_order_id\":\"PO1\",\"currency\":\"EUR\",\"lines\":[{\"qty\":1,\"buy_price\":10}],\"expected_updated_at\":\"$version\"}'::jsonb,'B1')"
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SET application_name='nm-bill-first'; BEGIN; $first; SELECT pg_sleep(3); COMMIT;" >"$tmpdir/first" 2>&1 &
first_pid=$!
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do if [ "$(q "select count(*) from pg_stat_activity where application_name='nm-bill-first' and wait_event='PgSleep'")" = 1 ]; then ready=1; break; fi; sleep 0.1; done
[ "$ready" = 1 ] || { cat "$tmpdir/first" >&2; exit 1; }
if q "select public.delete_bill_guarded('B1','$version')" >"$tmpdir/stale" 2>&1; then echo 'stale delete accepted' >&2; exit 1; fi
wait "$first_pid"
grep -q BILL_VERSION_CONFLICT "$tmpdir/stale" || { cat "$tmpdir/stale" >&2; exit 1; }
if q "$first" >"$tmpdir/stale-save" 2>&1; then echo 'stale save accepted' >&2; exit 1; fi
grep -q BILL_VERSION_CONFLICT "$tmpdir/stale-save" || { cat "$tmpdir/stale-save" >&2; exit 1; }
[ "$(q "select count(*) from bills where id='B1' and total_amount=10")" = 1 ] || { echo 'bill lost or changed' >&2; exit 1; }
current="$(q "select updated_at::text from bills where id='B1'")"
[ "$(q "select public.delete_bill_guarded('B1','$current')->>'deleted'")" = true ] || { echo 'fresh delete failed' >&2; exit 1; }
echo 'PASS: bill partial create, legacy rejection, concurrent stale save/delete and privileged access'
