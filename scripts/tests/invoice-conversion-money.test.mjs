import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceFromSalesOrder, buildMergedInvoiceFromSalesOrders, buildBillFromPurchaseOrder, buildMergedBillFromPurchaseOrders } from '../../apps/web/src/shared/localOrders.ts';
import { salesOrderTotals } from '../../shared/order-money.mjs';

function order(id='test', buy=10.25, sell=16.5, qty=2, count=60) {
  const lines = Array.from({length:count}, (_, i) => ({resolvedCode:`TEST-${i}`, buy_price:buy, sell_price:sell, qty}));
  return {id, sales_order_no:id, currency:'EUR', shipping_cost:2.5, discount_amount:1, lines,
    ...salesOrderTotals(lines,2.5,1,true)};
}

test('actual 60-line invoice conversion does not feed a floating ratio to strict decimal parsing', () => {
  const source=order();
  const before=JSON.stringify(source);
  const invoice=buildInvoiceFromSalesOrder(source);
  assert.equal(invoice.lines.length,60);
  assert.deepEqual([invoice.subtotal,invoice.total_amount,invoice.purchase_total,invoice.profit_total,invoice.margin_percent], [1980,1981.5,1230,751.5,37.93]);
  assert.equal(invoice.lines[0].margin_percent,37.88);
  assert.equal(JSON.stringify(source),before);
});

test('invoice lines preserve unit precision and round decimal products only once', () => {
  const invoice=buildInvoiceFromSalesOrder(order('precision',0.0025,1.005,3,1));
  assert.deepEqual([invoice.lines[0].buy_price,invoice.lines[0].sell_price,invoice.lines[0].purchase_total,invoice.lines[0].sales_total], [.0025,1.005,.01,3.02]);
});

test('merged invoices use decimal sums and margin, including repeated fractions', () => {
  const merged=buildMergedInvoiceFromSalesOrders([order('a'),order('b')]);
  assert.deepEqual([merged.lines.length,merged.subtotal,merged.total_amount,merged.purchase_total,merged.profit_total,merged.margin_percent], [120,3960,3963,2460,1503,37.93]);
});

test('purchase invoice conversion keeps unit precision matching its rounded line amounts', () => {
  const po={id:'po',currency:'EUR',total_amount:3.02,lines:[{product_code:'TEST',qty:3,buy_price:1.005,line_total:3.02}]};
  assert.equal(buildBillFromPurchaseOrder(po).lines[0].buy_price,1.005);
  const merged=buildMergedBillFromPurchaseOrders([po,{...po,id:'po-2'}]);
  assert.equal(merged.lines[0].buy_price,1.005);
  assert.equal(merged.total_amount,6.04);
});
