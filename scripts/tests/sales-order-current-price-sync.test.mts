import test from "node:test";
import assert from "node:assert/strict";
import {
  currentSupplierPriceKey,
  fetchCurrentSupplierPriceMap,
  type CurrentSupplierPriceBatchRow,
} from "../../apps/web/src/shared/currentSupplierPriceSync.mts";

test("explicit repricing keeps punctuation-distinct supplier SKUs separate", async () => {
  const requests = [
    { brand: "Clevite", productCode: "61/1", supplierName: "Sood" },
    { brand: "Clevite", productCode: "611", supplierName: "Sood" },
  ];
  const prices = await fetchCurrentSupplierPriceMap(requests, async (items) => {
    assert.deepEqual(items, [{ code: "61/1", brand: "Clevite" }, { code: "611", brand: "Clevite" }]);
    return [
      { request_index: 1, has_published_scope: true, options: [
        { supplier_name: "Sood", product_code: "611", buy_price: 405.72, price_date: "2026-10-13", notes: null },
      ] },
      { request_index: 0, has_published_scope: true, options: [
        { supplier_name: "Sood", product_code: "61/1", buy_price: 8.34, price_date: "2026-10-13", notes: "published" },
        { supplier_name: "Other", product_code: "61/1", buy_price: 1, price_date: "2026-10-13", notes: null },
        { supplier_name: "Sood", product_code: "611", buy_price: 0.5, price_date: "2026-10-13", notes: null },
      ] },
    ] satisfies CurrentSupplierPriceBatchRow[];
  });
  assert.equal(prices.get(currentSupplierPriceKey(requests[0]))?.buy_price, 8.34);
  assert.equal(prices.get(currentSupplierPriceKey(requests[1]))?.buy_price, 405.72);
});

test("explicit repricing refuses a missing or non-exact current supplier price", async () => {
  const request = { brand: "Clevite", productCode: "61/1", supplierName: "Sood" };
  await assert.rejects(
    fetchCurrentSupplierPriceMap([request], async () => [{
      request_index: 0,
      has_published_scope: true,
      options: [{ supplier_name: "Sood", product_code: "611", buy_price: 405.72, price_date: null, notes: null }],
    }]),
    /No published price for Clevite 61\/1 from Sood/,
  );
  await assert.rejects(
    fetchCurrentSupplierPriceMap([request], async () => []),
    /incomplete data/,
  );
});

test("legacy-only scopes accept a current exact supplier option", async () => {
  const request = { brand: "Bosch", productCode: "0 986 452 044", supplierName: "Sood" };
  const prices = await fetchCurrentSupplierPriceMap([request], async () => [{
    request_index: 0,
    has_published_scope: false,
    options: [{
      supplier_name: "Sood",
      product_code: "0986452044",
      buy_price: "12.50",
      price_date: "2026-10-13",
      notes: "legacy current",
    }],
  }]);
  assert.equal(prices.get(currentSupplierPriceKey(request))?.buy_price, 12.5);
});

test("current-price RPC requests are deduplicated and capped at 25", async () => {
  const requests = Array.from({ length: 27 }, (_, index) => ({
    brand: "Clevite", productCode: `SKU-${index}`, supplierName: "Sood",
  }));
  requests.push(requests[0]);
  const sizes: number[] = [];
  const prices = await fetchCurrentSupplierPriceMap(requests, async (items) => {
    sizes.push(items.length);
    return items.map((item, index) => ({
      request_index: index,
      has_published_scope: true,
      options: [{ supplier_name: "Sood", product_code: item.code, buy_price: 2, price_date: null, notes: null }],
    }));
  });
  assert.deepEqual(sizes, [25, 2]);
  assert.equal(prices.size, 27);
});
