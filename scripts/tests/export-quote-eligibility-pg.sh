#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_container="nm-export-eligibility-$$"

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

psql_fixture() {
  docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 "$@"
}

psql_fixture < "$repo_root/scripts/tests/export-quote-eligibility-pg.setup.sql"
psql_fixture < "$repo_root/supabase/migrations/20261013140014_supplier_price_export_complete_source_fingerprint.sql"
psql_fixture -c "create table public.export_version_before as select public.get_admin_price_list_export_version('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002') as version"
psql_fixture < "$repo_root/supabase/migrations/20261013140024_supplier_price_export_quote_eligibility.sql"
psql_fixture < "$repo_root/scripts/tests/export-quote-eligibility-pg.assert.sql"
