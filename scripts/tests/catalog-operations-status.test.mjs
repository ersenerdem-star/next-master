import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../../supabase/migrations/20260726145032_catalog_operations_status.sql",
  import.meta.url,
);
const rpcPath = new URL("../../netlify/functions/app-rpc.mts", import.meta.url);
const operationsPagePath = new URL("../../apps/web/src/modules/admin/OperationsStatusPage.tsx", import.meta.url);

const [migration, rpcGateway, operationsPage] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(rpcPath, "utf8"),
  readFile(operationsPagePath, "utf8"),
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
  assert.match(operationsPage, /fetchCatalogOperationsBrandStatus/);
  assert.match(operationsPage, /catalog-brand-operations/);
  assert.match(operationsPage, /missing_vehicle_count/);
});

test("TITANX report counts one correction per product and stays within the caller organization", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const sql = await readFile(new URL("../../supabase/migrations/20261123092541_bound_catalog_titanx_oem_status_count.sql",import.meta.url),"utf8");
  const db = new PGlite();
  const org = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const brand = "00000000-0000-4000-8000-000000000011";
  const otherBrand = "00000000-0000-4000-8000-000000000012";
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create function public.current_profile_org_id() returns uuid language sql stable as 'select ''${org}''::uuid';
      create table public.brands (id uuid, organization_id uuid, name text);
      create table public.catalog_products (id int, organization_id uuid, brand_id uuid, oem_no text);
      create table public.catalog_product_identifiers (catalog_product_id int, organization_id uuid, identifier_type text, normalized_value text);
      insert into public.brands values ('${brand}','${org}','TITANX'),('${otherBrand}','${other}','TITANX');
      insert into public.catalog_products values
        (1,'${org}','${brand}',null),(2,'${org}','${brand}','legacy'),(3,'${org}','${brand}',' '),
        (4,'${other}','${otherBrand}',null);
      insert into public.catalog_product_identifiers values
        (1,'${org}','oem','x'),(1,'${org}','oem','y'),(2,'${org}','oem','z'),
        (3,'${other}','oem','foreign'),(3,'${org}','oem',' '),(3,'${org}','ean','ean'),(4,'${other}','oem','foreign');
    `);
    await db.exec('begin');
    await db.exec(sql);
    await db.exec('commit');
    const result = await db.query("select catalog_titanx_oem_reference_correction() n, catalog_titanx_oem_reference_correction($1) foreign_brand, has_function_privilege('anon','catalog_titanx_oem_reference_correction(uuid)','execute') anon",[otherBrand]);
    assert.deepEqual(result.rows,[{n:1,foreign_brand:0,anon:false}]);
  } finally { await db.close(); }
});
