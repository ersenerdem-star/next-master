import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createCatalogImportBatches,
  cursorAfterCatalogBatch,
  detectCatalogDelimiter,
  normalizeCatalogImportRow,
  parseCatalogImportRows,
  toCatalogStagePayload,
  validateCatalogImportSource,
} from "../src/catalog-import-adapter.mjs";

async function collect(iterable) {
  const rows = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

function chunks(text, size = 3) {
  const bytes = Buffer.from(text, "utf8");
  return Readable.from((function* () {
    for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size);
  })());
}

test("catalog parser preserves quoted newline, UTF-8 and semicolon delimiter", async () => {
  const source = "Brand;Product_Code;Description_Tr;Weight\r\nCorteco;12/3;\"Conta,\nşık\";1,25\r\n";
  assert.equal(detectCatalogDelimiter(source), ";");
  const rows = await collect(parseCatalogImportRows(chunks(source, 2)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description_tr, "Conta,\nşık");
  assert.equal(rows[0].weight_kg, 1.25);
  assert.equal(rows[0].normalized_code, "12/3");
});

test("catalog parser rejects duplicate or missing required headers", async () => {
  await assert.rejects(collect(parseCatalogImportRows(chunks("Brand,Code,code\nA,1,2\n"))), /CATALOG_DUPLICATE_HEADER/);
  await assert.rejects(collect(parseCatalogImportRows(chunks("Brand,Description\nA,x\n"))), /CATALOG_REQUIRED_HEADER_MISSING:product_code/);
});

test("catalog parser accepts a selected fallback brand when the file omits Brand", async () => {
  const rows = await collect(parseCatalogImportRows(chunks("Product_Code,Description\nA-1,One\n"), { fallbackBrand: "Clevite" }));
  assert.equal(rows[0].brand, "Clevite");
});

test("catalog parser maps the import API brand_name alias", async () => {
  const rows = await collect(parseCatalogImportRows(chunks("brand_name,product_code\nClevite,A-1\n")));
  assert.equal(rows[0].brand, "Clevite");
});

test("catalog adapter maps lifecycle, segment and stage payload fields", () => {
  const row = normalizeCatalogImportRow({ sourceRowNumber: 4, row: {
    brand: "Bosch", product_code: " 0 123 456 789 ", market_segment: "Passenger Car", lifecycle_status: "obsolete", source_fingerprint: "A".repeat(64), weight_kg: "1,50",
  }});
  assert.equal(row.normalized_code, "0123456789");
  assert.equal(row.market_segment, "pc");
  assert.equal(row.lifecycle_status, "discontinued");
  assert.equal(row.weight_kg, 1.5);
  assert.equal(row.row_status, "accepted");
});

test("catalog adapter fails closed on invalid normalized values and keeps source metadata", () => {
  const sourceFingerprint = "A".repeat(64);
  assert.throws(() => normalizeCatalogImportRow({ sourceRowNumber: 2, row: {
    brand: "Corteco",
    product_code: "12/3",
    weight_kg: "not-a-number",
    source_url: "https://supplier.example/catalog.csv",
    source_as_of: "2026-10-14",
    source_retrieved_at: "2026-10-14T12:34:56Z",
    source_fingerprint: sourceFingerprint.toLowerCase(),
  }}), /CATALOG_ROW_INVALID:2:INVALID_WEIGHT/);
  assert.throws(() => normalizeCatalogImportRow({ sourceRowNumber: 2, row: {
    brand: "Corteco",
    product_code: "12/3",
    source_url: "http://supplier.example/catalog.csv",
  }}), /CATALOG_ROW_INVALID:2:INVALID_SOURCE_URL/);

  const row = normalizeCatalogImportRow({ sourceRowNumber: 2, row: {
    brand: "Corteco",
    product_code: "12/3",
    source_url: "https://supplier.example/catalog.csv",
    source_as_of: "2026-10-14",
    source_retrieved_at: "2026-10-14T12:34:56Z",
    source_fingerprint: sourceFingerprint.toLowerCase(),
  }});
  assert.deepEqual({
    source_url: row.source_url,
    source_as_of: row.source_as_of,
    source_retrieved_at: row.source_retrieved_at,
    source_fingerprint: row.source_fingerprint,
  }, {
    source_url: "https://supplier.example/catalog.csv",
    source_as_of: "2026-10-14",
    source_retrieved_at: "2026-10-14T12:34:56Z",
    source_fingerprint: sourceFingerprint.toLowerCase(),
  });
});

test("catalog stage payload rejects rows that carry an invalid weight instead of staging NULL", () => {
  assert.throws(() => toCatalogStagePayload({
    source_row_number: 1,
    brand: "Corteco",
    product_code: "12/3",
    weight_kg: "1,2,3",
  }), /CATALOG_ROW_INVALID:1:INVALID_WEIGHT/);

  const payload = toCatalogStagePayload({
    source_row_number: 1,
    brand: "Corteco",
    product_code: "12/3",
    weight_kg: "1,25",
    source_url: "https://supplier.example/catalog.csv",
    source_as_of: "2026-10-14",
    source_retrieved_at: "2026-10-14T12:34:56Z",
    source_fingerprint: "A".repeat(64),
  });
  assert.equal(payload.weight_kg, 1.25);
  assert.deepEqual({
    source_url: payload.source_url,
    source_as_of: payload.source_as_of,
    source_retrieved_at: payload.source_retrieved_at,
    source_fingerprint: payload.source_fingerprint,
  }, {
    source_url: "https://supplier.example/catalog.csv",
    source_as_of: "2026-10-14",
    source_retrieved_at: "2026-10-14T12:34:56Z",
    source_fingerprint: "a".repeat(64),
  });
});

test("catalog parser enforces strict UTF-8 and row/field byte limits", async () => {
  await assert.rejects(collect(parseCatalogImportRows([Buffer.from([0x42, 0x72, 0x61, 0x6e, 0x64, 0x2c, 0x50, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x5f, 0x43, 0x6f, 0x64, 0x65, 0x0a, 0xc3, 0x28, 0x2c, 0x41, 0x0a])])), /CATALOG_INVALID_UTF8/);

  await assert.rejects(
    collect(parseCatalogImportRows(chunks("Brand,Product_Code,Description\nA,1,oversized\n"), { maxRowBytes: 20 })),
    /CATALOG_ROW_TOO_LARGE/,
  );
  await assert.rejects(
    collect(parseCatalogImportRows(chunks("Brand,Product_Code,Description\nA,1,oversized\n"), { maxFieldBytes: 4 })),
    /CATALOG_FIELD_TOO_LARGE/,
  );
});

test("catalog batches are bounded, checksummed and resumable", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => normalizeCatalogImportRow({ sourceRowNumber: index + 1, row: { brand: "Clevite", product_code: `A-${index + 1}` } }));
  const sourceSha256 = "C".repeat(64);
  const first = await collect(createCatalogImportBatches(rows, { maxRows: 2, maxBytes: 10_000, sourceSha256 }));
  assert.deepEqual(first.map((batch) => [batch.batchNumber, batch.cursorStart, batch.cursorEnd, batch.rowCount]), [[1, 1, 2, 2], [2, 3, 4, 2], [3, 5, 5, 1]]);
  assert.match(first[0].checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(cursorAfterCatalogBatch(first[1]), { lastSourceRowNumber: 4, sourceSha256: sourceSha256.toLowerCase() });
  const resumed = await collect(createCatalogImportBatches(rows, { maxRows: 2, maxBytes: 10_000, resumeAfter: 4, sourceSha256 }));
  assert.deepEqual(resumed.map((batch) => [batch.cursorStart, batch.cursorEnd]), [[5, 5]]);
  assert.notEqual(first[0].checksum, first[1].checksum);
});

test("catalog batches reject non-contiguous source rows and oversized rows", async () => {
  const nonContiguous = [
    normalizeCatalogImportRow({ sourceRowNumber: 1, row: { brand: "Clevite", product_code: "A-1" } }),
    normalizeCatalogImportRow({ sourceRowNumber: 3, row: { brand: "Clevite", product_code: "A-3" } }),
  ];
  await assert.rejects(collect(createCatalogImportBatches(nonContiguous)), /CATALOG_CURSOR_NOT_CONTIGUOUS/);

  const oversized = [normalizeCatalogImportRow({ sourceRowNumber: 1, row: { brand: "Clevite", product_code: "A-1", description: "x".repeat(2_000) } })];
  await assert.rejects(collect(createCatalogImportBatches(oversized, { maxBytes: 1_024 })), /CATALOG_BATCH_ROW_TOO_LARGE:1/);
});

test("catalog adapter rejects conflicting source and stage row indexes", () => {
  assert.throws(() => normalizeCatalogImportRow({ sourceRowNumber: 2, row: {
    row_index: 0,
    brand: "Clevite",
    product_code: "A-2",
  }}), /CATALOG_ROW_INDEX_MISMATCH/);
});

test("catalog source validation rejects traversal, remote paths and bad checksums", () => {
  assert.deepEqual(validateCatalogImportSource({ sourcePath: "org/run/catalog.csv", sourceBytes: 42, sourceSha256: "B".repeat(64) }, { requireChecksum: true }), {
    sourcePath: "org/run/catalog.csv", format: "csv", sourceBytes: 42, sourceSha256: "b".repeat(64),
  });
  for (const source of ["../catalog.csv", "/tmp/catalog.csv", "https://example.test/catalog.csv", "org/run/catalog.xlsx"]) {
    assert.throws(() => validateCatalogImportSource(source), /CATALOG_SOURCE_(PATH_INVALID|FORMAT_UNSUPPORTED)/);
  }
  assert.throws(() => validateCatalogImportSource({ sourcePath: "org/run/catalog.csv", sourceSha256: "bad" }, { requireChecksum: true }), /CATALOG_SOURCE_CHECKSUM_REQUIRED/);
});
