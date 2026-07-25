import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../../supabase/migrations/20260725190000_catalog_product_relation_contract.sql", import.meta.url),
  "utf8",
);
const example = readFileSync(
  new URL("../../supabase/examples/catalog_product_relation_import.example.sql", import.meta.url),
  "utf8",
);
const preflight = readFileSync(
  new URL("../../supabase/validation/NM-CATALOG-PRODUCT_RELATION_CONTRACT_PREFLIGHT.sql", import.meta.url),
  "utf8",
);
const api = readFileSync(new URL("../../netlify/functions/app-rpc.mts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../apps/web/src/presentation/pages/CatalogPage.tsx", import.meta.url), "utf8");
const types = readFileSync(new URL("../../apps/web/src/types/catalogDetails.ts", import.meta.url), "utf8");

test("relation identity removes whitespace only and preserves punctuation", () => {
  assert.match(migration, /regexp_replace\(btrim\(coalesce\(input, ''\)\), '\\s\+', '', 'g'\)/);
  assert.doesNotMatch(
    migration.match(/create or replace function public\.normalize_catalog_relation_code[\s\S]*?\$\$;/i)?.[0] || "",
    /\[\^A-Z0-9\]/,
  );
  assert.match(example, /OLD 12\/34\.A -> OLD12\/34\.A/);
});

test("relation writer is source-bound, tenant-bound, idempotent and service-owned", () => {
  assert.match(migration, /s\.organization_id = v_product\.organization_id/);
  assert.match(migration, /s\.catalog_product_id = v_product\.id/);
  assert.match(migration, /on conflict \(organization_id, catalog_product_id, relation_fingerprint\)[\s\S]*?do nothing/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /revoke insert on table public\.catalog_product_relations from authenticated/);
  assert.match(migration, /drop policy if exists catalog_product_relations_insert_admin/);
  assert.match(migration, /revoke all on function public\.record_catalog_product_relation[\s\S]*?from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.record_catalog_product_relation[\s\S]*?to service_role/);
});

test("relation evidence does not auto-apply operational or canonical writes", () => {
  const writer = migration.match(/create or replace function public\.record_catalog_product_relation[\s\S]*?\$\$;/i)?.[0] || "";
  assert.doesNotMatch(writer, /insert\s+into\s+public\.item_code_references/i);
  assert.doesNotMatch(writer, /update\s+public\.catalog_products/i);
  assert.match(migration, /does not create operational replacement mappings/);
});

test("product details API and drawer expose source-backed relations", () => {
  assert.match(types, /relations: CatalogProductRelation\[\]/);
  assert.match(types, /relations: number/);
  assert.match(api, /\"catalog_product_relations\"/);
  assert.match(api, /source_record_id,relation_fingerprint,created_at/);
  assert.match(page, /catalog-product-details__relations/);
  assert.match(page, /relation\.related_product_code/);
  assert.match(page, /relationEvidenceHint/);
});

test("example is generic and does not assert a Kolbenschmidt supersession", () => {
  assert.match(example, /EXAMPLE CURRENT BRAND/);
  assert.match(example, /Official source record is required/);
  assert.doesNotMatch(example, /Kolbenschmidt/i);
});

test("production preflight blocks invalid targets and source-boundary mismatches", () => {
  assert.match(preflight, /invalid_target_rows/);
  assert.match(preflight, /source_boundary_mismatches/);
  assert.match(preflight, /s\.organization_id <> r\.organization_id/);
  assert.match(preflight, /s\.catalog_product_id <> r\.catalog_product_id/);
});
