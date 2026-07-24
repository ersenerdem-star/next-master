import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationSql = readFileSync(
  new URL("../../supabase/migrations/20260724_003_catalog_products_image_url_authenticated_hardening.sql", import.meta.url),
  "utf8",
);
const validationSql = readFileSync(
  new URL("../../supabase/validation/NM-CATALOG-WP2-F2_IMAGE_URL_WRITE_HARDENING_BEHAVIOR_VALIDATE.sql", import.meta.url),
  "utf8",
);

test("H2 restricts authenticated Product updates to editor fields and excludes image_url", () => {
  assert.match(migrationSql, /revoke update on table public\.catalog_products from authenticated/);
  const grant = migrationSql.match(/grant update \([\s\S]*?\) on table public\.catalog_products to authenticated/i)?.[0] || "";
  assert.match(grant, /description/);
  assert.match(grant, /lifecycle_note/);
  assert.doesNotMatch(grant, /image_url/);
  assert.match(migrationSql, /revoke update on table public\.catalog_products from anon, public/);
  assert.doesNotMatch(migrationSql, /revoke update on table public\.catalog_products from[^;]*service_role/i);
});

test("H2 behavior validator proves permitted editor writes and blocked direct image writes with rollback", () => {
  assert.match(validationSql, /^begin;/m);
  assert.match(validationSql, /rollback;\s*$/m);
  assert.match(validationSql, /has_column_privilege\('authenticated'.*'description'.*'update'\)/);
  assert.match(validationSql, /has_column_privilege\('authenticated'.*'image_url'.*'update'\)/);
  assert.match(validationSql, /set local role authenticated/);
  assert.match(validationSql, /when insufficient_privilege/);
  assert.match(validationSql, /IMAGE_URL_WRITE_HARDENING_BEHAVIOR_VERIFIED/);
});
