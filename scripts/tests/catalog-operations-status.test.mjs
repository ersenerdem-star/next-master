import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../../supabase/migrations/20260726145032_catalog_operations_status.sql",
  import.meta.url,
);
const rpcPath = new URL("../../netlify/functions/app-rpc.mts", import.meta.url);
const catalogPagePath = new URL("../../apps/web/src/presentation/pages/CatalogPage.tsx", import.meta.url);

const [migration, rpcGateway, catalogPage] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(rpcPath, "utf8"),
  readFile(catalogPagePath, "utf8"),
]);

test("Catalog Operations Status keeps full-catalog health separate from projection coverage", () => {
  assert.match(migration, /catalog_complete_count bigint not null default 0/);
  assert.match(migration, /catalog_incomplete_count bigint not null default 0/);
  assert.match(migration, /'evaluation_coverage_percent'/);
  assert.match(migration, /'data_completeness_percent'/);
  assert.match(migration, /'pending_count', greatest\(total_products - evaluated_products, 0\)/);
});

test("brand operations snapshot is tenant scoped and read-only to authenticated callers", () => {
  assert.match(migration, /create table if not exists public\.catalog_operations_brand_summary/);
  assert.match(migration, /organization_id = public\.current_profile_org_id\(\)/);
  assert.match(migration, /grant select on table public\.catalog_operations_brand_summary\s+to authenticated, service_role/);
  assert.doesNotMatch(migration, /grant (insert|update|delete).*authenticated/i);
  assert.match(migration, /create or replace function public\.get_catalog_operations_brand_status/);
  assert.match(migration, /security invoker/);
});

test("catalog writes maintain operations counters transactionally", () => {
  assert.match(migration, /create or replace function public\.apply_catalog_product_operations_delta\(\)/);
  assert.match(migration, /after insert or delete or update of/);
  assert.match(migration, /execute function public\.apply_catalog_product_operations_delta\(\)/);
});

test("gateway and UI expose brand operations analysis", () => {
  assert.match(rpcGateway, /"get_catalog_operations_brand_status"/);
  assert.match(catalogPage, /fetchCatalogOperationsBrandStatus/);
  assert.match(catalogPage, /catalog-brand-operations/);
  assert.match(catalogPage, /missing_vehicle_count/);
});
