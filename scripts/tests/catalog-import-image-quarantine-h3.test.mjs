import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationSql = readFileSync(
  new URL("../../supabase/migrations/20260724_004_catalog_import_image_quarantine.sql", import.meta.url),
  "utf8",
);
const validationSql = readFileSync(
  new URL("../../supabase/validation/NM-CATALOG-WP2-F2_H3_IMPORT_IMAGE_QUARANTINE_VALIDATE.sql", import.meta.url),
  "utf8",
);
const preflightSql = readFileSync(
  new URL("../../supabase/validation/NM-CATALOG-WP2-F2_H3_IMPORT_IMAGE_QUARANTINE_PREFLIGHT.sql", import.meta.url),
  "utf8",
);

test("H3 quarantines staged import images and removes public/service-role finalizer execute", () => {
  assert.match(migrationSql, /add column if not exists image_quarantined_count/);
  assert.match(migrationSql, /alter function public\.validate_catalog_import\(uuid\)\s+rename to validate_catalog_import_pre_h3/i);
  assert.match(migrationSql, /image_url_quarantined/);
  assert.match(migrationSql, /revoke all on function public\.finalize_catalog_import\(uuid\) from public, anon, authenticated, service_role/i);
  assert.match(migrationSql, /grant execute on function public\.finalize_catalog_import\(uuid\) to authenticated/i);
  assert.doesNotMatch(migrationSql.match(/create or replace function public\.finalize_catalog_import[\s\S]*?\$\$;/i)?.[0] || "", /image_url\s*=/i);
  assert.match(migrationSql, /image_quarantined_count/);
});

test("H3 local validator proves both insert and update images are quarantined with rollback", () => {
  assert.match(validationSql, /^begin;/m);
  assert.match(validationSql, /rollback;\s*$/m);
  assert.match(validationSql, /F2-H3-EXISTING/);
  assert.match(validationSql, /F2-H3-NEW/);
  assert.match(validationSql, /F2-H3-EXISTING/);
  assert.match(validationSql, /H3 validation did not quarantine image-only delta as a skip/);
  assert.match(validationSql, /H3_IMPORT_IMAGE_QUARANTINE_VERIFIED/);
  assert.match(validationSql, /has_function_privilege\('authenticated'/);
  assert.match(validationSql, /has_function_privilege\('anon'/);
});

test("H3 preflight stops safely when an H3-like baseline or rename target already exists", () => {
  assert.match(preflightSql, /^begin read only;/m);
  assert.match(preflightSql, /validate_catalog_import_pre_h3/);
  assert.match(preflightSql, /image_quarantined_count/);
  assert.match(preflightSql, /BLOCKED: H3 baseline drift detected/);
  assert.match(preflightSql, /do not drop, rename, or overwrite functions to proceed/);
  assert.match(preflightSql, /rollback;\s*$/m);
});
