import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = await mkdtemp(resolve("node_modules/.supplier-report-catalog-test-"));
const output = resolve(tmp, "api.mjs");
await build({ stdin: { contents: `export {enrichSupplierReportCatalog} from './apps/web/src/infrastructure/api/supplierReportCatalogApi.ts';`, resolveDir: process.cwd(), loader: "ts" },
  outfile: output, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{ name: "rpc-fixture", setup(builder) {
    builder.onResolve({ filter: /appRpcApi$/ }, () => ({ path: "rpc", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "js", contents: `export const callAppRpc=(...args)=>globalThis.__supplierCatalogReportTest(...args);` }));
  } }],
});
const { enrichSupplierReportCatalog } = await import(pathToFileURL(output).href);
after(async () => { await rm(tmp, { recursive: true, force: true }); });

test("catalog enrichment preserves source SKU, notes and all price values", async () => {
  const calls: unknown[] = [];
  (globalThis as any).__supplierCatalogReportTest = async (...args: unknown[]) => { calls.push(args); return [
    { input_code: "W11025", product_id: "id", description: "Oil Filter", oem_no: "23658092", hs_code: "84212300", origin: "DE", weight_kg: "1.128" },
  ]; };
  const rows: any[] = [{ product_code: "W11025", product_id: null, description: null, oem_no: null, hs_code: null,
    origin: null, weight_kg: null, catalog_status: "Supplier Price Only", cheapest_price: 6.39, cheapest_supplier: "TPM",
    second_price: 9.36, sales_a: 7.03, notes: "5.53 SNP TPM" },
    { product_code: "00123", description: "Supplier name", cheapest_price: 5, catalog_status: "Supplier Price Only" }];
  const result = await enrichSupplierReportCatalog("mann", rows);
  assert.deepEqual(calls, [["report_supplier_catalog_metadata", { input_brand_id:"mann", input_product_codes:["W11025","00123"] }]]);
  assert.equal(result[0].description,"Oil Filter"); assert.equal(result[0].origin,"DE"); assert.equal(result[0].weight_kg,1.128);
  assert.equal(result[0].cheapest_price,6.39); assert.equal(result[0].second_price,9.36);assert.equal(result[0].sales_a,7.03);
  assert.equal(result[0].notes,"5.53 SNP TPM");assert.equal(result[0].catalog_status,"In Catalog");
  assert.deepEqual(result[1],rows[1]); assert.equal(rows[0].description,null);
});

test("malformed or out-of-scope metadata fails rather than joining incorrect products", async () => {
  const rows: any[] = [{product_code:"00123",description:null}];
  for (const data of [null, {}, [{input_code:"00/123",product_id:"1"}], [{input_code:"00123",product_id:""}],
    [{input_code:"00123",product_id:"1",weight_kg:-1}], [{input_code:"00123",product_id:"1"},{input_code:"00123",product_id:"2"}]]) {
    (globalThis as any).__supplierCatalogReportTest = async () => data;
    await assert.rejects(enrichSupplierReportCatalog("brand",rows),/could not be verified/);
  }
});
