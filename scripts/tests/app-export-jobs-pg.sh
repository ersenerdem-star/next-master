#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_container="nm-export-jobs-$$"
trap 'docker stop "$fixture_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$fixture_container" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16 >/dev/null
for _ in {1..30}; do
  if docker exec "$fixture_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 0.2
done
psql_fixture() { docker exec -i "$fixture_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 "$@"; }
psql_fixture <<'SQL'
create role anon; create role authenticated; create role service_role;
create table public.organizations(id uuid primary key);
create table public.profiles(id uuid primary key);
SQL
# Validate both clean-environment ordering and replacing the constraint on an
# existing table. The final constraint migration must preserve all six types.
for migration in 20261014091607_app_export_jobs_supplier_type.sql 20261014091652_app_export_jobs_schema_contract.sql 20261014091607_app_export_jobs_supplier_type.sql; do
  psql_fixture < "$repo_root/supabase/migrations/$migration"
done
psql_fixture < "$repo_root/scripts/tests/app-export-jobs-pg.assert.sql"
