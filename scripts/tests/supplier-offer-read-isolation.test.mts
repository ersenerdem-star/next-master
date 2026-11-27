import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Execute the real supplier reader and order RPC mappers while replacing only
// their transport. Any unplanned table or network access fails immediately.
const temp = await mkdtemp(resolve('node_modules/.supplier-offer-test-'));
const output = resolve(temp,'reader.mjs');
await build({
  stdin:{contents:`export {fetchCurrentSupplierOptionsForOrder} from './apps/web/src/infrastructure/api/quoteImportApi.ts'; export {upsertSalesOrder,confirmSalesOrderWithPurchases} from './apps/web/src/infrastructure/api/ordersApi.ts';`,resolveDir:process.cwd(),loader:'ts'},
  outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},
  plugins:[{name:'read-transport-spy',setup(builder){
    builder.onResolve({filter:/\/appRpcApi$/},()=>({path:'rpc',namespace:'spy'}));
    builder.onResolve({filter:/\/supabaseClient$/},()=>({path:'client',namespace:'spy'}));
    builder.onLoad({filter:/.*/,namespace:'spy'},({path})=>({loader:'js',contents:path==='rpc'
      ? `export const callAppRpc=(...args)=>globalThis.__supplierOfferReadSpy.rpc(...args);`
      : `export const supabaseClient={from:(...args)=>globalThis.__supplierOfferReadSpy.from(...args)};`}));
  }}],
});
const {fetchCurrentSupplierOptionsForOrder,upsertSalesOrder,confirmSalesOrderWithPurchases}=await import(pathToFileURL(output).href);
after(async()=>{await rm(temp,{recursive:true,force:true});delete (globalThis as any).__supplierOfferReadSpy;});
const offer=(id:string,name:string,price:number,moq:number,code='00.31')=>({supplier_id:id,supplier_name:name,buy_price:price,product_code:code,brand:'Wahler',price_date:'2026-11-26',notes:null,moq,order_multiple:1,stock_qty:5,valid_to:null,applied_min_quantity:1});
function setup(rows:any,scope=true){
 const calls:Array<{name:string,args:any}>=[];
 (globalThis as any).__supplierOfferReadSpy={
  rpc:async(name:string,args:any)=>{calls.push({name,args});
    if(name==='cloud_current_supplier_price_options_batch')return [{request_index:0,has_published_scope:scope,options:rows}];
    if(name==='save_sales_order_atomic')return {sales_order:args.payload};
    if(name==='confirm_sales_order_with_purchases_safe')return {sales_order:args.payload,purchase_orders:[]};
    throw Error(`Unexpected RPC ${name}`);
  },
  from:(table:string)=>{throw Error(`Unexpected direct table access ${table}`)},
 };
 return calls;
}
const input={code:'00.31',brand:'Wahler',quantity:6};

test('current quantity offers are read without applying another supplier minimum or touching price lists',async()=>{
 const calls=setup([offer('a','Supplier A',10,12),offer('b','Supplier B',18,6)]);
 const options=await fetchCurrentSupplierOptionsForOrder(input);
 assert.deepEqual(options.map((x:any)=>[x.supplier_name,x.buy_price,x.moq,x.sell_price]),[['Supplier A',10,12,null],['Supplier B',18,6,null]]);
 assert.deepEqual(calls.map(x=>x.name),['cloud_current_supplier_price_options_batch']);
 assert.deepEqual(calls[0].args.input_requests,[{code:'00.31',brand:'Wahler',quantity:6}]);
});

test('legacy and empty supplier scopes stay read-only and never manufacture an offer',async()=>{
 let calls=setup([],false);assert.deepEqual(await fetchCurrentSupplierOptionsForOrder(input),[]);
 assert.deepEqual(calls.map(x=>x.name),['cloud_current_supplier_price_options_batch']);
 calls=setup([offer('b','Supplier B',18,6)],false);const result=await fetchCurrentSupplierOptionsForOrder(input);
 assert.equal(result[0].buy_price,18);assert.equal(result[0].sell_price,null);assert.equal(calls.length,1);
});

test('punctuation, leading zeros, ambiguous supplier ids and malformed prices fail closed',async()=>{
 for(const bad of [[offer('a','Supplier A',10,1,'0031')],[offer('a','Supplier A',10,1,'0.31')],
   [offer('a','Supplier A',10,1),offer('b','Supplier A',12,1)], [offer('','Supplier A',10,1)],
   [offer('a','Supplier A',0,1)], [{...offer('a','Supplier A',10,1),stock_qty:undefined}]]){
   setup(bad);await assert.rejects(fetchCurrentSupplierOptionsForOrder(input));
 }
});

test('real sales save and confirmation map only to their order RPCs, never price-list writes',async()=>{
 const calls=setup([]);
 const order:any={id:'synthetic-so',sales_order_no:'synthetic-so',customer_name:'Synthetic',currency:'EUR',status:'draft',
   shipping_cost:0,discount_amount:0,lines:[{lineId:'1',requestedCode:'00.31',resolvedCode:'00.31',brand:'Wahler',qty:6,
   supplier_name:'Supplier B',buy_price:18,sell_price:11,supplier_override_keep_sell_price:true,supplierOptions:[],selectedSupplierKey:''}]};
 await upsertSalesOrder(order,null);
 await confirmSalesOrderWithPurchases(order,'40000000-0000-4000-8000-000000000001',null);
 assert.deepEqual(calls.map(x=>x.name),['save_sales_order_atomic','confirm_sales_order_with_purchases_safe']);
 assert.equal(calls[1].args.payload.lines[0].buy_price,18);assert.equal(calls[1].args.payload.lines[0].sell_price,11);
});

test('invalid or omitted response and ambiguous supplier identities never produce selectable offers',async()=>{
 for(const response of [null,[],[{request_index:1,has_published_scope:true,options:[]}],
   [{request_index:0,has_published_scope:'yes',options:[]}],[{request_index:0,has_published_scope:true,options:null}],
   [{request_index:0,has_published_scope:true,options:[offer('same','Supplier A',10,1),offer('same','Supplier B',11,1)]}],
   [{request_index:0,has_published_scope:true,options:[{...offer('a','Supplier A',10,1),applied_min_quantity:9}]}]]){
   setup([]);(globalThis as any).__supplierOfferReadSpy.rpc=async()=>response;
   await assert.rejects(fetchCurrentSupplierOptionsForOrder(input));
 }
});

test('duplicate responses are removed only when identical; differing prices or conditions fail closed',async()=>{
  const first=offer('a','Supplier A',10,1);
  setup([first,{...first}]);const identical=await fetchCurrentSupplierOptionsForOrder(input);
  assert.equal(identical.length,1);assert.equal(identical[0].buy_price,10);
  for(const other of [offer('a','Supplier A',11,1),offer('a','Supplier A',10,6),{...first,notes:'Different terms'}]){
    setup([first,other]);await assert.rejects(fetchCurrentSupplierOptionsForOrder(input),/conflicting current offers/);
  }
});
