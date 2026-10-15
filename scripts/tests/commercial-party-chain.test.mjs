import test from 'node:test';
import {findCustomerByNameInList as find} from '../../apps/web/src/shared/customerAccountMatching.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {buildInvoiceFromSalesOrder,buildMergedInvoiceFromSalesOrders,buildBillFromPurchaseOrder,buildMergedBillFromPurchaseOrders} from '../../apps/web/src/shared/localOrders.ts';
import {salesOrderTotals} from '../../shared/order-money.mjs';
const customer='c0000000-0000-4000-8000-000000000001';
const vendor='c0000000-0000-4000-8000-000000000002';
const lines=[{resolvedCode:'TEST',product_code:'TEST',qty:1,buy_price:2,sell_price:10,line_total:2}];
const so={id:'so',sales_order_no:'SO',customer_id:customer,customer_name:'Same',lines,currency:'EUR',shipping_cost:0,discount_amount:0,...salesOrderTotals(lines,0,0,true)};
const po={id:'po',vendor_id:vendor,supplier_name:'Same',lines,currency:'EUR',total_amount:2};
test('single and merged builders preserve canonical customer/vendor IDs',()=>{
  assert.equal(buildInvoiceFromSalesOrder(so).customer_id,customer);
  assert.equal(buildBillFromPurchaseOrder(po).vendor_id,vendor);
  assert.equal(buildMergedInvoiceFromSalesOrders([so,{...so,id:'so2'}]).customer_id,customer);
  assert.equal(buildMergedBillFromPurchaseOrders([po,{...po,id:'po2'}]).vendor_id,vendor);
});
test('same-name different-ID and partial-ID merges fail closed',()=>{
  for(const id of [null,'c0000000-0000-4000-8000-000000000003']) {
    assert.throws(()=>buildMergedInvoiceFromSalesOrders([so,{...so,id:'so2',customer_id:id}]),/MERGE_PARTY_MISMATCH/);
    assert.throws(()=>buildMergedBillFromPurchaseOrders([po,{...po,id:'po2',vendor_id:id}]),/MERGE_PARTY_MISMATCH/);
  }
});
const source=ts.createSourceFile('ordersApi.ts',fs.readFileSync('apps/web/src/infrastructure/api/ordersApi.ts','utf8'),ts.ScriptTarget.Latest,true);
const wanted=['mapSalesOrderRow','mapPurchaseOrderRow','mapInvoiceRow','mapBillRow','mapPaymentReceivedRow','mapPaymentMadeRow','mapSalesOrderPayload','mapPurchaseOrderPayload','mapInvoicePayload','mapBillPayload','mapPaymentReceivedPayload','mapPaymentMadePayload'];
const text=source.statements.filter(n=>(ts.isFunctionDeclaration(n)&&wanted.includes(n.name?.text))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>/^(SALES_ORDER|PURCHASE_ORDER|INVOICE|BILL|PAYMENT_RECEIVED|PAYMENT_MADE)_(SUMMARY_)?COLUMNS$/.test(d.name.getText(source))))).map(n=>n.getText(source)).join('\n');
const api=new Function('toNumber','nowIso',ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+`;return {${wanted.join(',')},SALES_ORDER_COLUMNS,PURCHASE_ORDER_COLUMNS,INVOICE_COLUMNS,BILL_COLUMNS,PAYMENT_RECEIVED_COLUMNS,PAYMENT_MADE_COLUMNS};`)(Number,()=>new Date().toISOString());
test('actual API row mappers retain IDs (including order source reads)',()=>{
  for(const [name,key,id] of [['mapSalesOrderRow','customer_id',customer],['mapInvoiceRow','customer_id',customer],['mapPaymentReceivedRow','customer_id',customer],['mapPurchaseOrderRow','vendor_id',vendor],['mapBillRow','vendor_id',vendor],['mapPaymentMadeRow','vendor_id',vendor]]) {
    assert.equal(api[name]({id:'row',[key]:id})[key],id);
    assert.equal(api[name]({id:'legacy'})[key],null);
  }
});
test('actual API payload mappers transmit canonical identity',()=>{
  for(const [name,key,id] of [['mapSalesOrderPayload','customer_id',customer],['mapPurchaseOrderPayload','vendor_id',vendor],['mapInvoicePayload','customer_id',customer],['mapPaymentReceivedPayload','customer_id',customer],['mapBillPayload','vendor_id',vendor],['mapPaymentMadePayload','vendor_id',vendor]]) assert.equal(api[name]({id:'row',[key]:id},'org')[key],id);
});
test('customer label fallback refuses duplicate accounts',()=>{
  const rows=[{id:customer,display_name:'Same',company_name:'A'},{id:vendor,display_name:'Same',company_name:'B'}];
  assert.equal(find(rows,'same'),null);
  assert.equal(find(rows,'a').id,customer);
  assert.equal(find(rows,'same',vendor).id,vendor);
  assert.equal(find(rows,'a','missing-id'),null);
});
test('actual SELECT projections include source/document/payment canonical IDs',()=>{
  for(const [name,key] of [['SALES_ORDER','customer_id'],['INVOICE','customer_id'],['PAYMENT_RECEIVED','customer_id'],['PURCHASE_ORDER','vendor_id'],['BILL','vendor_id'],['PAYMENT_MADE','vendor_id']]) assert(api[name+'_COLUMNS'].split(',').includes(key));
});
