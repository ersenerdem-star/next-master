#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_container="nm-invoice-conversion-$$"

cleanup() {
  docker stop "$fixture_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$fixture_container" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 >/dev/null
for _ in {1..30}; do
  if docker exec "$fixture_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
docker exec "$fixture_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null

docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/scripts/tests/invoice-linked-customer-identity-pg.setup.sql"
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/supabase/migrations/20260707_95_invoice_bill_guarded_boundary.sql"
docker exec "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c "alter table public.sales_orders add column lines jsonb not null default '[]'::jsonb"
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/supabase/migrations/20261013140023_invoice_linked_customer_identity.sql"
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/supabase/migrations/20261126125226_document_number_guard.sql"
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/supabase/migrations/20261126133750_invoice_full_conversion_guard.sql"
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/scripts/tests/invoice-full-conversion-pg.assert.sql"
# Exercise two separate database sessions, with the first holding its transaction
# after conversion. The second must see the committed invoice after waiting.
docker exec "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c "insert into public.sales_orders (id, organization_id, customer_id, customer_name, currency, status, lines, updated_at) values ('race','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Customer A','EUR','confirmed','[{\"buy_price\":10,\"sell_price\":11}]','2026-01-01T00:00:00Z')" >/dev/null
first_log="$(mktemp)"
second_log="$(mktemp)"
trap 'rm -f "$first_log" "$second_log"; cleanup' EXIT
docker exec "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c "begin; set role authenticated; set app.test_org='11111111-1111-4111-8111-111111111111'; set app.test_role='admin'; select public.create_full_sales_invoices_atomic('[{\"id\":\"race-a\",\"sales_order_id\":\"race\",\"customer_name\":\"Customer A\",\"currency\":\"EUR\",\"lines\":[{\"buy_price\":10,\"sell_price\":11}]}]','{\"race\":\"2026-01-01T00:00:00Z\"}'); select pg_sleep(2); commit;" >"$first_log" 2>&1 &
first_pid=$!
sleep 0.5
if docker exec "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c "set role authenticated; set app.test_org='11111111-1111-4111-8111-111111111111'; set app.test_role='admin'; select public.create_full_sales_invoices_atomic('[{\"id\":\"race-b\",\"sales_order_id\":\"race\",\"customer_name\":\"Customer A\",\"currency\":\"EUR\",\"lines\":[{\"buy_price\":10,\"sell_price\":11}]}]','{\"race\":\"2026-01-01T00:00:00Z\"}');" >"$second_log" 2>&1; then
  cat "$second_log"
  exit 1
fi
wait "$first_pid"
if ! rg -q 'SALES_ORDER_ALREADY_INVOICED' "$second_log"; then
  cat "$second_log"
  exit 1
fi
# Old clients racing to invoice the same entire order are serialized too.
docker exec "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c "insert into public.sales_orders (id, organization_id, customer_id, customer_name, currency, status, lines) values ('old-race','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Customer A','EUR','confirmed','[{\"resolvedCode\":\"A\",\"brand\":\"B\",\"qty\":10,\"buy_price\":10,\"sell_price\":11}]')" >/dev/null
docker exec "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c "begin; set role authenticated; set app.test_org='11111111-1111-4111-8111-111111111111'; set app.test_role='admin'; select public.save_invoice_atomic('{\"id\":\"old-race-a\",\"sales_order_id\":\"old-race\",\"customer_name\":\"Customer A\",\"currency\":\"EUR\",\"lines\":[{\"product_code\":\"A\",\"brand\":\"B\",\"qty\":10,\"buy_price\":10,\"sell_price\":11}]}'); select pg_sleep(2); commit;" >"$first_log" 2>&1 &
first_pid=$!
sleep 0.5
if docker exec "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c "set role authenticated; set app.test_org='11111111-1111-4111-8111-111111111111'; set app.test_role='admin'; select public.save_invoice_atomic('{\"id\":\"old-race-b\",\"sales_order_id\":\"old-race\",\"customer_name\":\"Customer A\",\"currency\":\"EUR\",\"lines\":[{\"product_code\":\"A\",\"brand\":\"B\",\"qty\":10,\"buy_price\":10,\"sell_price\":11}]}');" >"$second_log" 2>&1; then
  cat "$second_log"
  exit 1
fi
wait "$first_pid"
if ! rg -q 'SALES_ORDER_ALREADY_INVOICED' "$second_log"; then
  cat "$second_log"
  exit 1
fi
