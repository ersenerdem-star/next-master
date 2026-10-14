#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_container="nm-catalog-export-$$"
trap 'docker stop "$fixture_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$fixture_container" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 >/dev/null
for _ in {1..30}; do
  if docker exec "$fixture_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 0.2
done
psql_fixture() { docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 "$@"; }
psql_fixture < "$repo_root/scripts/tests/catalog-export-source-pg.setup.sql"
for migration in 20261013140024_supplier_price_export_quote_eligibility.sql 20261014072055_supplier_price_export_keyset_page.sql 20261014085226_catalog_export_source_contracts.sql 20261014085547_supplier_price_export_published_source.sql 20261014090241_export_source_keyset_collation.sql 20261014090712_export_source_single_count_keyset.sql 20261014090955_catalog_export_version_source_state.sql 20261014091816_export_source_json_chunks.sql 20261014092740_supplier_export_generic_plan_seek.sql 20261014093220_export_chunk_budget_and_count_index.sql; do
  psql_fixture < "$repo_root/supabase/migrations/$migration"
done
psql_fixture < "$repo_root/scripts/tests/catalog-export-source-pg.fixture.sql"
psql_fixture < "$repo_root/scripts/tests/catalog-export-source-pg.assert.sql"
