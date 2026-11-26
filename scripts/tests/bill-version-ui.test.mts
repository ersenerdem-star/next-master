import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useState } from 'react';
import { create } from 'react-test-renderer';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
(globalThis as any).window={localStorage:{getItem:(key:string)=>key==='master-next-bills'?JSON.stringify([{id:'OLD-BILL',purchase_order_id:'PO1',created_at:'2020-01-01'}]):null}};
const output=resolve('scripts/tests/.bill-version-ui-fixture.mjs');after(async()=>{await rm(output,{force:true});});
await build({stdin:{contents:`export {upsertBill,deleteBill} from './apps/web/src/infrastructure/api/ordersApi.ts';export {buildBillFromPurchaseOrder,buildMergedBillFromPurchaseOrders} from './apps/web/src/shared/localOrders.ts';export {documentNumberError} from './apps/web/src/shared/documentNumberError.ts';`,resolveDir:process.cwd(),loader:'ts'},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'mock-api',setup(b){
  b.onResolve({filter:/\/appRpcApi$/},()=>({path:'rpc',namespace:'mock'})); b.onResolve({filter:/\/supabaseClient$/},()=>({path:'supabase',namespace:'mock'})); b.onResolve({filter:/\/organizationApi$/},()=>({path:'organization',namespace:'mock'})); b.onResolve({filter:/\/warehousesApi$/},()=>({path:'warehouses',namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='rpc'?`export const callAppRpc=(...args)=>globalThis.__billUiRpc(...args);`:path==='supabase'?`export const supabaseClient={};`:path==='organization'?`export const getCurrentOrgId=()=>null;`:`export const fetchWarehouses=()=>[];`}));
}}]});
const {upsertBill,deleteBill,buildBillFromPurchaseOrder,buildMergedBillFromPurchaseOrders,documentNumberError}=await import(pathToFileURL(output).href);
const version='2026-11-26T10:12:34.123456+00:00';
const line={product_code:'P1',qty:1,buy_price:5,line_total:5};
const order={id:'PO1',lines:[line],supplier_name:'supplier',purchase_company:'company',currency:'EUR',total_amount:5};
test('automatic and merged bills use new identities even with a local old bill',()=>{
  const one=buildBillFromPurchaseOrder(order),two=buildBillFromPurchaseOrder(order),merged=buildMergedBillFromPurchaseOrders([order]);
  assert.notEqual(one.id,'OLD-BILL'); assert.notEqual(one.id,two.id); assert.notEqual(one.id,merged.id);
  assert.equal(one.purchase_order_id,'PO1'); assert.equal(two.lines[0].qty,1);
});
test('bill save sends the original version, preserves edits and displays a conflict',async()=>{
  let rpcCall:any;(globalThis as any).__billUiRpc=async(...args:any[])=>{rpcCall=args;throw new Error('BILL_VERSION_CONFLICT');};
  function Editor(){const [bill,setBill]=useState({...buildBillFromPurchaseOrder(order),id:'B1',updated_at:version});const [message,setMessage]=useState('');return createElement('section',{},
    createElement('input',{value:String(bill.lines[0].qty),onChange:(e:any)=>setBill({...bill,lines:[{...bill.lines[0],qty:Number(e.target.value)}]})}),
    createElement('button',{onClick:async()=>{try{await upsertBill(bill,'B1')}catch(e){setMessage(documentNumberError(e,'tr','hata'))}}},'save'),createElement('p',{},message));}
  let rendered:any;await act(async()=>{rendered=create(createElement(Editor));});await act(async()=>{rendered.root.findByType('input').props.onChange({target:{value:'3'}});});await act(async()=>{await rendered.root.findByType('button').props.onClick();});
  assert.equal(rpcCall[0],'save_bill_atomic');assert.equal(rpcCall[1].payload.expected_updated_at,version);assert.equal(rpcCall[1].payload.lines[0].qty,3);assert.equal(rendered.root.findByType('input').props.value,'3');assert.match(rendered.root.findByType('p').children.join(''),/İşlem yapılmadı/);await act(async()=>rendered.unmount());
});
test('bill deletion sends the list row version',async()=>{let call:any;(globalThis as any).__billUiRpc=async(...args:any[])=>{call=args;return {}};await deleteBill('B1',version);assert.deepEqual(call,['delete_bill_guarded',{id:'B1',expected_updated_at:version}]);});
