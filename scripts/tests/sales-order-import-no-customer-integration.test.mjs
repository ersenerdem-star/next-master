import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { hydrateSalesOrderLines } from '../../apps/web/src/shared/hydrateSalesOrderLines.ts';
import { applySalesOrderCustomerPricing } from '../../apps/web/src/shared/salesOrderCustomerPricing.ts';

const modules = {
  appRpcApi: 'export const callAppRpc = (...args) => globalThis.__pricingIntegration.rpc(...args);',
  codeReferencesApi: 'export const fetchCodeReferenceMatchesForRows = (...args) => globalThis.__pricingIntegration.references(...args);',
  organizationApi: 'export const getCurrentOrgId = (...args) => globalThis.__pricingIntegration.org(...args);',
  supabaseClient: 'export const supabaseClient = globalThis.__pricingIntegration.db;',
};

let loadCount=0;
async function bundle(path) {
  const result = await build({
    entryPoints:[fileURLToPath(new URL(path, import.meta.url))], bundle:true, format:'esm', platform:'node', write:false,
    plugins:[{name:'pricing-boundary',setup(builder){
      builder.onResolve({filter:/\/(appRpcApi|codeReferencesApi|organizationApi|supabaseClient)$/}, args => ({path:args.path.split('/').at(-1),namespace:'fake'}));
      builder.onLoad({filter:/.*/,namespace:'fake'}, args => ({contents:modules[args.path],loader:'js'}));
    }}],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${++loadCount}`);
}

function tableClient(tables) {
  return {from(table){
    const filters=[];
    return {select(){return this},eq(column,value){filters.push(row=>row[column]===value);return this},
      in(column,values){filters.push(row=>values.includes(row[column]));return this},
      not(column,_operator,value){filters.push(row=>row[column]!==value);return this},
      then(resolve,reject){return Promise.resolve({data:(tables[table]||[]).filter(row=>filters.every(f=>f(row))),error:null}).then(resolve,reject)}};
  }};
}

function installMocks(brand='Bosch') {
  const calls=[];
  globalThis.__pricingIntegration={
    org:async()=> 'org-1', references:async()=>new Map(),
    db:tableClient({
      brands:[{id:'b',name:brand,organization_id:'org-1'}],
      product_code_normalization_policies:[],
      catalog_products:[{id:'p',product_code:'0012',normalized_code:'0012',normalized_oem:'',brand_id:'b',organization_id:'org-1',description:'Test item'}],
    }),
    rpc:async(name,args)=>{
      calls.push({name,args});
      assert.equal(name,'cloud_current_supplier_price_options_batch');
      return args.input_requests.map((item,request_index)=>({request_index,has_published_scope:true,options:[
        {supplier_id:'s2',supplier_name:'Higher',brand_id:'b',brand,product_code:item.code,buy_price:120,price_date:'2026-11-01',notes:null,moq:null,order_multiple:null,stock_qty:null,valid_to:null},
        {supplier_id:'s1',supplier_name:'Lower',brand_id:'b',brand,product_code:item.code,buy_price:100,price_date:'2026-11-01',notes:null,moq:null,order_multiple:null,stock_qty:null,valid_to:null},
      ]}));
    },
  };
  return calls;
}

test('batch import without customer retains cheapest buy option while every sale price is blank', async()=>{
  installMocks(); const {batchResolveQuoteImportRows}=await bundle('../../apps/web/src/infrastructure/api/quoteImportApi.ts');
  const [line]=await batchResolveQuoteImportRows({rows:[{code:'0012',brand:'Bosch',qty:3}],customerType:'A',marginA:10,marginB:15,calculateSellPrice:false});
  assert.equal(line.buy_price,100,JSON.stringify(line)); assert.equal(line.supplier_name,'Lower'); assert.equal(line.sell_price,null);
  assert.deepEqual(line.supplierOptions.map(o=>o.sell_price),[null,null]);
  assert.equal(line.requestedCode,'0012'); assert.equal(line.qty,3); assert.equal(line.description,'Test item');
  const [b]=applySalesOrderCustomerPricing([line],{workbenchMode:'new',hasCustomerProfile:true,customerType:'B',marginA:10,marginB:15});
  assert.equal(b.sell_price,115); assert.deepEqual(b.supplierOptions.map(o=>o.sell_price),[115,138]);
});

test('single item lookup without customer forwards quantity and never asks price-calculating legacy RPC', async()=>{
  const calls=installMocks('Wahler'); const {resolveQuoteLine}=await bundle('../../apps/web/src/infrastructure/api/quoteResolverApi.ts');
  const {resolved,supplierOptions}=await resolveQuoteLine({code:'0012',brand:'Wahler',quantity:17,customerType:'A',marginA:10,marginB:15,calculateSellPrice:false});
  assert.equal(resolved.buy_price,100,JSON.stringify(resolved)); assert.equal(resolved.sell_price,null);
  assert.equal(supplierOptions.length,2); assert.ok(supplierOptions.every(o=>o.sell_price===null));
  assert.equal(calls[0].args.input_requests[0].quantity,17);
});

test('supplier MOQ and order multiple still adjust quantity when sale pricing is deferred', async()=>{
  installMocks('Wahler');
  const originalRpc=globalThis.__pricingIntegration.rpc;
  globalThis.__pricingIntegration.rpc=async(...args)=>{
    const rows=await originalRpc(...args);
    rows[0].options.find(o=>o.supplier_id==='s1').moq=20;
    rows[0].options.find(o=>o.supplier_id==='s1').order_multiple=5;
    return rows;
  };
  const {batchResolveQuoteImportRows}=await bundle('../../apps/web/src/infrastructure/api/quoteImportApi.ts');
  const [line]=await batchResolveQuoteImportRows({rows:[{code:'0012',brand:'Wahler',qty:17}],customerType:'A',marginA:10,marginB:15,calculateSellPrice:false});
  assert.equal(line.qty,20); assert.equal(line.requested_qty,17); assert.equal(line.quantity_adjusted,true);
  assert.equal(line.buy_price,100); assert.equal(line.sell_price,null);
});

test('single buy-only lookup does not apply a second replacement after the caller has already resolved the code', async()=>{
  const calls=installMocks();
  globalThis.__pricingIntegration.references=async()=>new Map([['bosch::0012',{old_code:'0012',new_code:'0013',reason:null}]]);
  const {resolveQuoteLine}=await bundle('../../apps/web/src/infrastructure/api/quoteResolverApi.ts');
  const {resolved}=await resolveQuoteLine({code:'0012',brand:'Bosch',customerType:'A',marginA:10,marginB:15,calculateSellPrice:false});
  assert.equal(resolved.product_code,'0012'); assert.equal(resolved.buy_price,100); assert.equal(resolved.sell_price,null);
  assert.equal(calls[0].args.input_requests[0].code,'0012');
});

test('pending marker and prices survive the stored-order hydration path',()=>{
  const pending={lineId:'l1',requestedCode:'0012',resolvedCode:'0012',brand:'Bosch',qty:1,buy_price:100,sell_price:null,customer_pricing_pending:true,manual_sell_price:false,
    supplierOptions:[{supplier_name:'Lower',buy_price:100,sell_price:null,price_date:null,notes:null}],selectedSupplierKey:'Lower-0'};
  const historical={...pending,lineId:'l2',sell_price:73.5,customer_pricing_pending:false};
  const rows=hydrateSalesOrderLines(JSON.parse(JSON.stringify([pending,historical])),'order');
  assert.equal(rows[0].customer_pricing_pending,true); assert.equal(rows[0].sell_price,null);
  assert.equal(rows[1].sell_price,73.5);
  const result=applySalesOrderCustomerPricing(rows,{workbenchMode:'existing',hasCustomerProfile:true,customerType:'B',marginA:10,marginB:15});
  assert.equal(result[0].sell_price,115); assert.equal(result[1].sell_price,73.5);
});
