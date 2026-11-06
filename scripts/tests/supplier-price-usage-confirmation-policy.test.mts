import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPreservedSupplierConfirmationLines} from '../../apps/web/src/shared/preservedSupplierConfirmation.ts';
import type {QuoteBuilderLine} from '../../apps/web/src/types/quoteBuilder.ts';

const line={supplier_name:'GNK-Diesel',brand:'Bosch',resolvedCode:'001/20'} as QuoteBuilderLine;
const input={lines:[line],currency:'EUR',customerType:'A',customerId:null,customerName:'Customer'};
test('new orders still consult server policy and reject cached disabled supplier options',async()=>{
 await assert.rejects(fetchPreservedSupplierConfirmationLines(input,async request=>{
  assert.equal(request.input_order_id,null);
  return {preserved_indices:[],disabled_indices:[0]};
 }),/closed to new prices/);
});
test('only validated server-proved saved indices bypass today pricing',async()=>{
 const preserved=await fetchPreservedSupplierConfirmationLines({...input,orderId:'stored'},async request=>{
  assert.equal(request.input_order_id,'stored');assert.deepEqual(request.input_lines,[line]);
  assert.equal(request.input_currency,'EUR');assert.equal(request.input_customer_type,'A');
  return {preserved_indices:[0],disabled_indices:[]};
 });
 assert.deepEqual([...preserved],[0]);
 assert.deepEqual([...await fetchPreservedSupplierConfirmationLines(input,async()=>({preserved_indices:[],disabled_indices:[]}))],[]);
});
test('incomplete, forged and unavailable policy responses fail closed',async()=>{
 for(const response of [null,[],{}, {preserved_indices:[1],disabled_indices:[]},{preserved_indices:[0,0],disabled_indices:[]},
  {preserved_indices:['0'],disabled_indices:[]},{preserved_indices:[],disabled_indices:[-1]}]){
  await assert.rejects(fetchPreservedSupplierConfirmationLines(input,async()=>response),/could not be verified/);
 }
 await assert.rejects(fetchPreservedSupplierConfirmationLines(input,async()=>{throw new Error('offline');}),/offline/);
});
