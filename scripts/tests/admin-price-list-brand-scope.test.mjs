import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminRecordsPath = new URL("../../netlify/functions/app-admin-records.mts", import.meta.url);
const brandsApiPath = new URL("../../apps/web/src/infrastructure/api/brandsApi.ts", import.meta.url);
const priceListsApiPath = new URL("../../apps/web/src/infrastructure/api/priceListsApi.ts", import.meta.url);
const priceListsPath = new URL("../../apps/web/src/presentation/pages/PriceListsPage.tsx", import.meta.url);
const [adminRecords, brandsApi, priceListsApi, priceLists] = await Promise.all([
  readFile(adminRecordsPath, "utf8"),
  readFile(brandsApiPath, "utf8"),
  readFile(priceListsApiPath, "utf8"),
  readFile(priceListsPath, "utf8"),
]);

test("admin price-list brand scope is limited to current published pointers", () => {
  const listPriceListBrands = adminRecords.slice(
    adminRecords.indexOf("async function listPriceListBrands"),
    adminRecords.indexOf("async function listPriceListSettings"),
  );
  assert.match(adminRecords, /resource === "priceListBrands"/);
  assert.match(adminRecords, /isAdminLikeRole\(caller\.role/);
  assert.match(listPriceListBrands, /supplier_current_price_pointers/);
  assert.match(listPriceListBrands, /supplier_price_publications/);
  assert.match(listPriceListBrands, /status: "eq\.published"/);
  assert.match(listPriceListBrands, /buildRestUrl\(supabaseUrl, "brands", \{[\s\S]*id: `in\.\(\$\{brandIds\.join/);
  assert.doesNotMatch(listPriceListBrands, /buildRestUrl\(supabaseUrl, "brands", \{[\s\S]*organization_id:/);
  assert.match(brandsApi, /fetchCloudPriceListBrands/);
  assert.match(priceLists, /fetchCloudPriceListBrands/);
  assert.match(priceLists, /downloadEligibilityHint/);
  assert.match(adminRecords, /resource === "priceListSettings"/);
  assert.match(adminRecords, /customer_price_lists/);
  assert.match(priceListsApi, /resource: "priceListSettings"/);
  assert.doesNotMatch(priceListsApi, /\.from\("customer_price_lists"\)/);
});
