import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { normalizeCatalogDisplayCode as normalizeScriptCatalogDisplayCode } from "../shared/catalog/catalog-standardization.mjs";
import { normalizeCatalogDisplayCode as normalizeLegacyScriptCatalogDisplayCode } from "../_shared/catalog-standardization.mjs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20260726134310_catalog_part_code_normalization_compatibility.sql", import.meta.url),
  "utf8",
);

const runtimeFormattingSources = [
  "../../apps/web/src/domain/shared/catalogFormatting.ts",
  "../../scripts/shared/catalog/catalog-standardization.mjs",
  "../../scripts/_shared/catalog-standardization.mjs",
  "../../netlify/functions/_shared/catalog-standardization.mts",
  "../../netlify/functions/_shared/catalog/catalog-standardization.mts",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

test("Motorservice-family display normalization removes whitespace only", () => {
  for (const normalize of [
    normalizeScriptCatalogDisplayCode,
    normalizeLegacyScriptCatalogDisplayCode,
  ]) {
    assert.equal(normalize(" 40 448 601 ", "Kolbenschmidt"), "40448601");
    assert.equal(normalize(" 7. 00468.42. 0 ", "Pierburg"), "7.00468.42.0");
    assert.equal(normalize(" 81 - 1116 ", "TRW Engine Components"), "81-1116");
    assert.equal(normalize(" 20 0602/08-260 ", "BF"), "200602/08-260");
  }
});

test("runtime formatting sources carry the same Motorservice brand policy", () => {
  for (const source of runtimeFormattingSources) {
    assert.match(source, /BF|bf/);
    assert.match(source, /KOLBENSCHMIDT|kolbenschmidt/);
    assert.match(source, /PIERBURG|pierburg/);
    assert.match(source, /TRWENGINECOMPONENTS|trwenginecomponents/);
  }
});

test("canonical SQL identity removes whitespace and preserves punctuation", () => {
  const exactNormalizer =
    migration.match(
      /create or replace function public\.normalize_catalog_product_code[\s\S]*?\$\$;/i,
    )?.[0] || "";

  assert.match(exactNormalizer, /\[\[:space:\]\]\+/);
  assert.doesNotMatch(exactNormalizer, /\[\^A-Z0-9\]/);
  assert.match(migration, /preserves punctuation/);
});

test("legacy compact lookup remains explicit and is not redefined", () => {
  assert.doesNotMatch(
    migration,
    /create or replace function public\.normalize_part_code\s*\(/i,
  );
  assert.match(migration, /normalize_part_code\(text\) intentionally remains the legacy compact/i);
  assert.match(migration, /new\.normalized_code := public\.normalize_part_code\(new\.product_code\)/);
});

test("migration is collision-guarded, trigger-enforced and target-bounded", () => {
  assert.match(migration, /having count\(\*\) > 1/);
  assert.match(migration, /errcode = '23505'/);
  assert.match(migration, /create trigger trg_catalog_products_canonical_code/);
  assert.match(migration, /before insert or update of product_code, brand_id/);
  assert.match(migration, /update public\.catalog_products p/);
  assert.match(migration, /'BF'[\s\S]*?'KOLBENSCHMIDT'[\s\S]*?'PIERBURG'[\s\S]*?'TRWENGINECOMPONENTS'/);
});

test("policy registry is read-only to authenticated runtime callers", () => {
  assert.match(
    migration,
    /revoke all on table public\.product_code_normalization_policies[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /grant select on table public\.product_code_normalization_policies[\s\S]*?to authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(insert|update|delete)[\s\S]*?product_code_normalization_policies[\s\S]*?authenticated/i,
  );
});
