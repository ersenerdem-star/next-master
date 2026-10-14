import test from 'node:test';
import assert from 'node:assert/strict';
import {readSupplierCommercialTerms} from '../../apps/web/src/domain/shared/supplierCommercialTerms.ts';
import {normalizeOrderQuantity} from '../../apps/web/src/domain/shared/orderQuantityRules.ts';

const empty={moq:null,order_multiple:null,stock_qty:null,valid_to:null};
test('supplier stock preserves unknown and zero without becoming owned inventory or an order cap',()=>{
 for(const stock_qty of [null,0,2147483647]){
  const terms=readSupplierCommercialTerms({...empty,stock_qty,available_qty:999,on_hand_qty:999});
  assert.equal(terms.stock_qty,stock_qty);assert.equal('available_qty' in terms,false);assert.equal('on_hand_qty' in terms,false);
  assert.equal(normalizeOrderQuantity(7,terms).corrected,7,'Supplier stock never constrains ordered quantity');
 }
});
test('MOQ and pack multiple compose while unspecified rules preserve the existing default',()=>{
 assert.equal(normalizeOrderQuantity(1,readSupplierCommercialTerms({...empty,moq:5,order_multiple:4})).corrected,8);
 assert.equal(normalizeOrderQuantity(9,readSupplierCommercialTerms({...empty,moq:5,order_multiple:4})).corrected,12);
 assert.equal(normalizeOrderQuantity(8,readSupplierCommercialTerms({...empty,moq:5,order_multiple:4})).adjusted,false);
 assert.equal(normalizeOrderQuantity(7,readSupplierCommercialTerms({...empty,moq:0})).corrected,7);
 assert.equal(normalizeOrderQuantity(1,readSupplierCommercialTerms({...empty,order_multiple:2147483647})).corrected,2147483647);
});
test('authoritative terms reject missing, malformed and overflow values instead of falling back to permissive defaults',()=>{
 for(const [field,values] of Object.entries({stock_qty:[-1,0.5,2147483648,'0',undefined],order_multiple:[0,-1,1.5,2147483648,'4',undefined],valid_to:['2026-02-30','14/10/2026','0000-01-01','',undefined]})){
  for(const value of values)assert.throws(()=>readSupplierCommercialTerms({...empty,[field]:value}),/could not be verified/);
 }
 assert.throws(()=>readSupplierCommercialTerms({moq:null,order_multiple:null,valid_to:null}),/could not be verified/);
 assert.equal(readSupplierCommercialTerms({...empty,valid_to:'2028-02-29'}).valid_to,'2028-02-29');
});
