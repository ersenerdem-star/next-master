#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
container="nm-sales-brand-report-test-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT INT TERM
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest postgres:17-alpine >/dev/null
attempt=0
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "PostgreSQL did not start" >&2; exit 1; }
  sleep 1
done
for file in tests/sql/sales_order_brand_report_setup.sql supabase/migrations/20261125130848_sales_order_brand_report.sql tests/sql/sales_order_brand_report.sql; do
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < "$file"
done
