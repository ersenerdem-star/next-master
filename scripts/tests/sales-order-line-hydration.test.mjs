import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateSalesOrderLines } from '../../apps/web/src/shared/hydrateSalesOrderLines.ts';

test('minimal persisted monetary fixture opens without fabricating prices or mutating source', () => {
  const source = Object.freeze({ qty: 2, buy_price: 10.25, sell_price: 16.5, resolvedCode: 'V3-TEST-001', supplier_name: 'V3 Test Vendor' });
  const [row] = hydrateSalesOrderLines([source], 'V3-SO-FINAL-001');
  assert.equal(row.lineId.split('-').at(-1), '1');
  assert.deepEqual([row.qty, row.buy_price, row.sell_price], [2, 10.25, 16.5]);
  assert.equal(row.requestedCode, 'V3-TEST-001');
  assert.deepEqual(row.supplierOptions, []);
  assert.equal(source.lineId, undefined);
  assert.deepEqual(hydrateSalesOrderLines([source], 'V3-SO-FINAL-001'), [row]);
});

test('existing identities, metadata, exact prices and explicit zero remain unchanged', () => {
  const rows = [{ lineId:'manual-55', requestedCode:'old', resolvedCode:'new', qty:0, buy_price:null,
    sell_price:0, notes:'private', supplierOptions:[{supplier_name:'vendor'}], weight_kg:0 }];
  const [row] = hydrateSalesOrderLines(rows, 'other');
  for (const [key, value] of Object.entries(rows[0])) assert.deepEqual(row[key], value);
  assert.equal(rows[0].origin, undefined);
});

test('generated identities are stable and unique for repeated product codes', () => {
  const rows = hydrateSalesOrderLines([{resolvedCode:'repeat'}, {resolvedCode:'repeat'}], 'order');
  assert.notEqual(rows[0].lineId, rows[1].lineId);
  assert.equal(rows[0].buy_price, undefined);
  assert.equal(rows[0].sell_price, undefined);
});
