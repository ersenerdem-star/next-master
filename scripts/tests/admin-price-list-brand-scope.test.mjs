import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminRecordsPath = new URL("../../netlify/functions/app-admin-records.mts", import.meta.url);
const brandsApiPath = new URL("../../apps/web/src/infrastructure/api/brandsApi.ts", import.meta.url);
const priceListsPath = new URL("../../apps/web/src/presentation/pages/PriceListsPage.tsx", import.meta.url);
const [adminRecords, brandsApi, priceLists] = await Promise.all([
  readFile(adminRecordsPath, "utf8"),
  readFile(brandsApiPath, "utf8"),
  readFile(priceListsPath, "utf8"),
]);

test("admin price-list brand scope is limited to current published pointers", () => {
  assert.match(adminRecords, /resource === "priceListBrands"/);
  assert.match(adminRecords, /canAccessSalesModules\(caller\.role/);
  assert.match(adminRecords, /supplier_current_price_pointers/);
  assert.match(adminRecords, /supplier_price_publications/);
  assert.match(adminRecords, /status: "eq\.published"/);
  assert.match(brandsApi, /fetchCloudPriceListBrands/);
  assert.match(priceLists, /fetchCloudPriceListBrands/);
  assert.match(priceLists, /downloadEligibilityHint/);
});
