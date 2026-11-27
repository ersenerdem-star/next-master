import test, { after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = await mkdtemp(resolve("node_modules/.supplier-note-indicator-test-"));
const output = resolve(tmp, "api.mjs");
await build({ stdin: { contents: `export {fetchSupplierComparisonNoteIndicators} from './apps/web/src/infrastructure/api/supplierComparisonNoteIndicatorsApi.ts';`, resolveDir: process.cwd(), loader: "ts" },
  outfile: output, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{ name: "rpc-fixture", setup(builder) {
    builder.onResolve({ filter: /appRpcApi$/ }, () => ({ path: "rpc", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "js", contents: `export const callAppRpc=(...args)=>globalThis.__supplierNoteIndicatorTest(...args);` }));
  } }],
});
const { fetchSupplierComparisonNoteIndicators } = await import(pathToFileURL(output).href);
after(async () => { await rm(tmp, { recursive: true, force: true }); });

test("batch indicators use original exact codes, including leading zeroes and punctuation", async () => {
  const calls: unknown[][] = [];
  (globalThis as any).__supplierNoteIndicatorTest = async (...args: unknown[]) => { calls.push(args); return { "00/123": true, "00123": false }; };
  assert.deepEqual(await fetchSupplierComparisonNoteIndicators("brand", ["00/123", "00123", "00/123"]), { "00/123": true, "00123": false });
  assert.deepEqual(calls, [["report_supplier_comparison_note_indicators", { input_brand_id: "brand", input_product_codes: ["00/123", "00123"] }]]);
  assert.deepEqual(await fetchSupplierComparisonNoteIndicators("brand", []), {});
});

test("incomplete or malformed indicators fail instead of hiding notes", async () => {
  for (const data of [null, [], {}, { P1: "true" }, { P1: false, Extra: true }]) {
    (globalThis as any).__supplierNoteIndicatorTest = async () => data;
    await assert.rejects(fetchSupplierComparisonNoteIndicators("brand", ["P1"]), /could not be verified/);
  }
  await assert.rejects(fetchSupplierComparisonNoteIndicators("brand", Array.from({ length: 51 }, (_, i) => `P${i}`)), /could not be verified/);
});
