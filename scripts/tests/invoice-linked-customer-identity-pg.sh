#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_container="nm-invoice-identity-$$"

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
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/supabase/migrations/20261013140020_sales_order_active_customer_pricing_guard.sql"
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/supabase/migrations/20261013140023_invoice_linked_customer_identity.sql"
docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/scripts/tests/invoice-linked-customer-identity-pg.assert.sql"
