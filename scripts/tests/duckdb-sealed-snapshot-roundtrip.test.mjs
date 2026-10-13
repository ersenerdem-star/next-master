import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeSealedSnapshotWithDuckDB,
  createDuckDbPagedExportSource,
} from '../../apps/engine/supplier-price-shadow/src/export/duckdb-export-source.mjs';

test('sealed snapshot DuckDB CSV round trip preserves priced fields and paging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duckdb-sealed-roundtrip-'));
  const binding = 'sealed-snapshot-test-binding';
  const snapshotId = '00000000-0000-4000-8000-000000000001';
  const rows = [
    { code: '61/1', description: 'Oil filter, "premium"\nseries', price: '12.34' },
    { code: '611', description: 'Different SKU', price: '2.50' },
    { code: 'A-3', description: 'Third part', price: '100.00' },
    { code: 'B 4', description: 'Fourth part', price: '0.99' },
    { code: 'Z/5', description: 'Fifth part', price: '20.10' },
  ].map((row, index) => ({
    ordinal: index + 1,
    payload: {
      cursorKey: String(index + 1).padStart(12, '0'),
      code: row.code,
      description: row.description,
      price: row.price,
      currency: 'EUR',
      priceDate: '2026-10-13',
      discontinued: index === 2,
      replacementCode: index === 2 ? 'A-4' : '',
      brand: 'Clevite',
    },
  }));
  let released = false;
  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          assert.match(sql, /export_snapshot_private\.rows/);
          assert.equal(params[0], snapshotId);
          return { rows: rows.filter((row) => row.ordinal > params[1]).slice(0, params[2]) };
        },
        release() { released = true; },
      };
    },
  };

  try {
    const materialized = await materializeSealedSnapshotWithDuckDB({
      pool, snapshotId, binding, expectedRows: rows.length,
      outputDir: directory, tempDirectory: directory, batchSize: 2,
    });
    assert.equal(materialized.processedRows, 5);
    assert.equal(materialized.pageCount, 3);
    assert.equal(released, true);

    const fetchPage = createDuckDbPagedExportSource({
      sortedPath: materialized.sortedPath, binding, expectedRows: rows.length, pageSize: 2,
    });
    const first = await fetchPage({ binding, after: null, limit: 2 });
    assert.equal(first.done, false);
    assert.equal(first.nextCursor, '000000000002');
    const second = await fetchPage({ binding, after: first.nextCursor, limit: 2 });
    assert.equal(second.done, false);
    assert.equal(second.nextCursor, '000000000004');
    const third = await fetchPage({ binding, after: second.nextCursor, limit: 2 });
    assert.equal(third.done, true);
    assert.equal(third.nextCursor, null);

    const actual = [...first.rows, ...second.rows, ...third.rows];
    assert.deepEqual(actual.map(({ cursorKey, code, description, price, priceDate }) => ({
      cursorKey, code, description, price, priceDate,
    })), rows.map(({ payload }) => ({
      cursorKey: payload.cursorKey, code: payload.code,
      description: payload.description, price: payload.price, priceDate: payload.priceDate,
    })));
    assert.equal(actual[2].discontinued, true);
    assert.equal(actual[2].replacementCode, 'A-4');
    assert.equal(actual[0].brand, 'Clevite');
    assert.equal(actual[0].currency, 'EUR');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
