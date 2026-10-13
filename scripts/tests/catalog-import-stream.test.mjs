import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const importApi = await readFile(new URL("../../apps/web/src/infrastructure/api/importApi.ts", import.meta.url), "utf8");
const catalogPage = await readFile(new URL("../../apps/web/src/presentation/pages/CatalogPage.tsx", import.meta.url), "utf8");

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("catalog import uses a bounded async stream instead of a full payload array", () => {
  const streamBlock = blockBetween(importApi, "export async function bulkImportCatalogStream", "async function waitForSupplierPriceRollupRefresh");
  assert.match(streamBlock, /AsyncIterable<Record<string, unknown>>/);
  assert.match(streamBlock, /for await \(const row of rows\)/);
  assert.match(streamBlock, /batch\.length >= CATALOG_IMPORT_MAX_BATCH_ROWS/);
  assert.match(streamBlock, /batchBytes \+ rowBytes \+ 1 > CATALOG_IMPORT_TARGET_BATCH_BYTES/);
  assert.doesNotMatch(streamBlock, /normalizedPayload/);
});

test("catalog UI performs a two-pass stream preflight and upload", () => {
  const importBlock = blockBetween(catalogPage, "async function handleCatalogImport", "async function handleBilsteinProductStage");
  assert.match(importBlock, /streamCsvRows\(file\)/);
  assert.match(importBlock, /bulkImportCatalogStream\(mappedRows\(\)/);
  assert.doesNotMatch(importBlock, /file\.text\(\)/);
  assert.doesNotMatch(importBlock, /const payload = dataRows/);
});
