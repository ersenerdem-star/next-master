import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationSql = readFileSync(
  new URL("../../supabase/migrations/20260725111411_kolbenschmidt_catalog_foundation.sql", import.meta.url),
  "utf8",
);
const logoSource = readFileSync(
  new URL("../../apps/web/src/presentation/components/common/logoAssets.ts", import.meta.url),
  "utf8",
);
const templateSource = readFileSync(
  new URL("../../apps/web/src/shared/importTemplates.ts", import.meta.url),
  "utf8",
);

test("Kolbenschmidt foundation keeps source data normalized and tenant-scoped", () => {
  assert.match(migrationSql, /catalog_product_source_records/);
  assert.match(migrationSql, /catalog_product_identifiers/);
  assert.match(migrationSql, /catalog_product_fitments/);
  assert.match(migrationSql, /catalog_product_relations/);
  assert.match(migrationSql, /catalog_product_attributes/);
  assert.match(migrationSql, /organization_id = public\.current_profile_org_id\(\)/);
  assert.match(migrationSql, /source_url ~\* '\^https:\/\//);
  assert.match(migrationSql, /payload_fingerprint ~ '\^\[0-9a-fA-F\]\{64\}\$'/);
});

test("EAN and vehicle model are carried through the staged import boundary", () => {
  assert.match(migrationSql, /add column if not exists ean text/);
  assert.match(migrationSql, /add column if not exists vehicle_model text/);
  assert.match(migrationSql, /item\.value->>'source_fingerprint'/);
  assert.match(migrationSql, /catalog_products cp[\s\S]*set ean = coalesce/);
  assert.doesNotMatch(
    migrationSql.match(/create or replace function public\.finalize_catalog_import[\s\S]*?\$\$;/i)?.[0] || "",
    /image_url\s*=/i,
  );
});

test("Kolbenschmidt logo fallback and import fields are discoverable", () => {
  assert.match(logoSource, /kolbenschmidt_logo\.jpeg/);
  assert.match(templateSource, /"EAN"/);
  assert.match(templateSource, /"Vehicle_Model"/);
  assert.match(templateSource, /"Source_Fingerprint"/);
});
