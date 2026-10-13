#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_container="nm-invoice-lookup-$$"

cleanup() {
  docker stop "$fixture_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$fixture_container" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 >/dev/null
for _ in {1..30}; do
  if docker exec "$fixture_container" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
docker exec "$fixture_container" pg_isready -U postgres >/dev/null

docker exec -i "$fixture_container" psql -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/scripts/tests/invoice-price-customer-lookup-pg.setup.sql"
docker exec -i "$fixture_container" psql -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/supabase/migrations/20261013140021_invoice_price_customer_exact_lookup.sql"
docker exec -i "$fixture_container" psql -U postgres -v ON_ERROR_STOP=1 \
  < "$repo_root/scripts/tests/invoice-price-customer-lookup-pg.assert.sql"
