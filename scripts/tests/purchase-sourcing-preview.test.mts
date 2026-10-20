import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerForLine, offerBlockReason, sourcingTotals, compatiblePurchaseTargets } from '../../apps/web/src/shared/purchaseSourcing.ts';
const offer = {supplier_id:'TPM',supplier_name:'TPM',product_code:'000366',brand:'Sachs',buy_price:12.35,price_date:'2026-10-19',moq:2,order_multiple:2,stock_qty:10,valid_to:'2099-01-01'};
const order:any={id:'PO-R',supplier_name:'Romany',sales_order_id:'SO1',status:'draft',currency:'EUR',purchase_company:'Next',lines:[{product_code:'000366',qty:2,buy_price:10},{product_code:'000369',qty:4,buy_price:15}]};
test('preview preserves leading zeros and punctuation, refuses ambiguous prices',()=>{
 assert.equal(offerForLine([offer],'TPM','000 366'),offer);
 assert.equal(offerForLine([offer],'TPM','366'),null);
 assert.equal(offerForLine([{...offer,product_code:'000-366'}],'TPM','000366'),null);
 assert.equal(offerForLine([offer,offer],'TPM','000366'),null);
});
test('coverage, money and commercial rules never show a partial total as an order total',()=>{
 assert.deepEqual(sourcingTotals(order,[0],[offer,null]),{oldTotal:20,newTotal:24.7});
 assert.deepEqual(sourcingTotals(order,[0,1],[offer,null]),{oldTotal:80,newTotal:null});
 assert.equal(offerBlockReason(offer,1),'quantity');assert.equal(offerBlockReason(offer,3),'quantity');assert.equal(offerBlockReason(offer,12),'stock');
 assert.equal(offerBlockReason({...offer,valid_to:'2020-01-01'},2),'expired');
 assert.equal(offerBlockReason({...offer,buy_price:NaN},2),'price');
 assert.equal(offerBlockReason({...offer,valid_to:'2026-10-20'},2,'2026-10-20'),null);
});
test('merge targets require same confirmed-sale lineage, company, currency and draft supplier',()=>{
 const target={...order,id:'PO-T',supplier_name:'TPM'};
 assert.deepEqual(compatiblePurchaseTargets([target,{...target,id:'other-sale',sales_order_id:'SO2'},{...target,id:'issued',status:'open'},{...target,id:'fx',currency:'USD'},{...target,id:'company',purchase_company:'Other'}],order,'TPM').map(o=>o.id),['PO-T']);
});
