import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = await mkdtemp(resolve("node_modules/.supplier-report-api-test-"));
const output = resolve(tmp, "api.mjs");
await build({ stdin: { contents: `export {fetchSupplierComparisonOffers} from './apps/web/src/infrastructure/api/supplierComparisonOffersApi.ts';`, resolveDir: process.cwd(), loader: "ts" },
  outfile: output, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{ name: "rpc-fixture", setup(builder) {
    builder.onResolve({ filter: /appRpcApi$/ }, () => ({ path: "rpc", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "js", contents: `export const callAppRpc=(...args)=>globalThis.__supplierReportApiTest(...args);` }));
  } }],
});
const { fetchSupplierComparisonOffers } = await import(pathToFileURL(output).href);
after(async () => { await rm(tmp, { recursive: true, force: true }); });

test("details use the exact part code and brand and preserve supplier conditions", async () => {
  const calls: any[] = [];
  (globalThis as any).__supplierReportApiTest = async (...args: unknown[]) => { calls.push(args); return [
    { supplier_id: "one", supplier_name: "First", buy_price: "4.96", price_date: "2026-11-27", moq: 2, order_multiple: 3, stock_qty: 0, valid_to: null, notes: "note" },
    { supplier_id: "two", supplier_name: "Second", buy_price: "5.12", price_date: null, moq: null, order_multiple: null, stock_qty: null, valid_to: null, notes: null },
  ]; };
  const result = await fetchSupplierComparisonOffers({ brandId: "brand", productCode: "001/20" });
  assert.deepEqual(calls, [["report_supplier_comparison_offers", { input_brand_id: "brand", input_product_code: "001/20" }]]);
  assert.equal(result[0].buy_price, 4.96); assert.equal(result[0].stock_qty, 0); assert.equal(result[0].moq, 2);
  assert.equal(result[1].stock_qty, null);
});

test("malformed or incomplete details fail explicitly", async () => {
  for (const data of [null, {}, [{ supplier_id: "a", supplier_name: "Supplier", buy_price: null }], [{ supplier_id: "", supplier_name: "Supplier", buy_price: 5 }], [{ supplier_id: "a", supplier_name: "Supplier", buy_price: 5, stock_qty: -1 }]]) {
    (globalThis as any).__supplierReportApiTest = async () => data;
    await assert.rejects(fetchSupplierComparisonOffers({ brandId: "brand", productCode: "001/20" }), /could not be verified/);
  }
});
