import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminRecordsPath = new URL("../../netlify/functions/app-admin-records.mts", import.meta.url);
const scopeMigrationPath = new URL("../../supabase/migrations/20261014000000_admin_price_list_brand_scope.sql", import.meta.url);
const brandsApiPath = new URL("../../apps/web/src/infrastructure/api/brandsApi.ts", import.meta.url);
const priceListsApiPath = new URL("../../apps/web/src/infrastructure/api/priceListsApi.ts", import.meta.url);
const priceListsPath = new URL("../../apps/web/src/presentation/pages/PriceListsPage.tsx", import.meta.url);
const [adminRecords, scopeMigration, brandsApi, priceListsApi, priceLists] = await Promise.all([
  readFile(adminRecordsPath, "utf8"),
  readFile(scopeMigrationPath, "utf8"),
  readFile(brandsApiPath, "utf8"),
  readFile(priceListsApiPath, "utf8"),
  readFile(priceListsPath, "utf8"),
]);

test("admin price-list brand scope is limited to current published pointers", () => {
  assert.match(adminRecords, /resource === "priceListBrands"/);
  assert.match(adminRecords, /isAdminLikeRole\(caller\.role/);
  assert.match(adminRecords, /cloud_admin_price_list_brands/);
  assert.match(scopeMigration, /create or replace function public\.cloud_admin_price_list_brands/);
  assert.match(scopeMigration, /status = 'published'/);
  assert.match(scopeMigration, /grant execute on function public\.cloud_admin_price_list_brands\(uuid\) to service_role/);
  assert.match(scopeMigration, /create or replace function public\.cloud_admin_price_list_setting_upsert/);
  assert.match(scopeMigration, /grant execute on function public\.cloud_admin_price_list_setting_upsert\(uuid, text, numeric, text, boolean\) to service_role/);
  assert.match(adminRecords, /cloud_admin_price_list_setting_upsert/);
  assert.match(brandsApi, /fetchCloudPriceListBrands/);
  assert.match(priceLists, /fetchCloudPriceListBrands/);
  assert.match(priceLists, /downloadEligibilityHint/);
  assert.match(adminRecords, /resource === "priceListSettings"/);
  assert.match(adminRecords, /customer_price_lists/);
  assert.match(priceListsApi, /resource: "priceListSettings"/);
  assert.doesNotMatch(priceListsApi, /\.from\("customer_price_lists"\)/);
});
