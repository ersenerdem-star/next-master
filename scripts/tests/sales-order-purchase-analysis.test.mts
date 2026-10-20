import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {buildSalesPurchaseAnalysis,loadSalesPurchaseAnalysisOffers} from '../../apps/web/src/shared/salesOrderPurchaseAnalysis.ts';
import {buildWorkbookBytes} from '../../apps/web/src/shared/xlsxCore.ts';
import {buildDocumentWorksheet} from '../../apps/web/src/shared/documentExport.ts';
import handler from '../../netlify/functions/app-rpc.mts';

const lines=[{code:'000123',brand:'Sachs',description:'Damper',qty:2,supplier:'Romany',buyPrice:7.60,sellPrice:12.5},
 {code:'001-23',brand:'Sachs',description:'=untrusted text',qty:3,supplier:'TPM',buyPrice:25.83,sellPrice:40}];
const offer=(code:string,id:string,name:string,price:number)=>({product_code:code,brand:'Sachs',supplier_id:id,supplier_name:name,buy_price:price,
 price_date:'2026-10-20',moq:null,order_multiple:null,stock_qty:null,valid_to:null});

test('supplier matrix keeps actual identities in stable numeric columns, exact codes as text and absent prices blank',()=>{
 const model=buildSalesPurchaseAnalysis({number:'SO-1',currency:'USD',lines,generatedAt:'2026-10-20T20:00:00Z',offers:[
  [offer('000123','T','TPM',8.56),offer('000123','R','Romany',7.60),offer('000123','G','GroupAuto',7.5)],
  [offer('001-23','G','GroupAuto',34.40),offer('00123','T','TPM',1),{...offer('001-23','R','Romany',2),brand:'Boge'}],
 ]});
 assert.deepEqual(model.rows[4].slice(8,11),['GroupAuto buy (EUR)','Romany buy (EUR)','TPM buy (EUR)']);
 assert.deepEqual(model.rows[5].slice(8,11),[7.5,7.6,8.56]);
 assert.deepEqual(model.rows[6].slice(8,11),[34.4,null,null]);
 assert.equal(model.rows[4][6],'Sales unit price (USD)');
 const wb=XLSX.read(buildWorkbookBytes('Purchase analysis',model.rows,model.numericColumns,model.options),{type:'array',cellNF:true});
 const ws=wb.Sheets['Purchase analysis'];
 assert.equal(ws.A6.v,'000123');assert.equal(ws.A6.t,'s');assert.equal(ws.A7.v,'001-23');
 assert.equal(ws.C7.t,'s');assert.equal(ws.C7.f,undefined);assert.equal(ws.C7.v,'=untrusted text');
 assert.equal(ws.I6.t,'n');assert.equal(ws.I6.v,7.5);assert.equal(ws.K7.v,'');assert.equal(ws.G6.v,12.5);assert.equal(ws.H6.v,25);
 assert.equal(ws['!autofilter']?.ref,'A5:K7');
 assert.throws(()=>buildSalesPurchaseAnalysis({number:'SO',currency:'EUR',lines,offers:[],generatedAt:''}),/incomplete/);
 assert.throws(()=>buildSalesPurchaseAnalysis({number:'SO',currency:'EUR',lines:[lines[0]],offers:[[offer('000123','T','TPM',8),offer('000123','T','TPM',9)]],generatedAt:''}),/Ambiguous/);
});

test('100–200 lines use bounded current-price batches and reject partial responses without an export',async()=>{
 const many=Array.from({length:200},(_,i)=>({...lines[0],code:String(i).padStart(6,'0')}));
 let calls=0;const progress:number[]=[];
 const rows=await loadSalesPurchaseAnalysisOffers(many,async args=>{
  calls++;assert.equal(args.input_requests.length,25);
  return args.input_requests.map((r,i)=>({request_index:i,options:[offer(r.code,'T','TPM',i+1)]})).reverse();
 },count=>progress.push(count));
 assert.equal(calls,8);assert.equal(rows.length,200);assert.equal(rows[199][0].product_code,'000199');assert.equal(progress.at(-1),200);
 await assert.rejects(loadSalesPurchaseAnalysisOffers(lines,async()=>[]),/incomplete/);
 await assert.rejects(loadSalesPurchaseAnalysisOffers(lines,async()=>[{request_index:0,options:[]},{request_index:0,options:[]}]),/incomplete/);
 await assert.rejects(loadSalesPurchaseAnalysisOffers([{...lines[0],brand:''}],async()=>[]),/brand/);
});

test('ordinary sales Excel keeps accepted sales prices and excludes supplier alternatives',()=>{
 const model=buildDocumentWorksheet({kind:'sales-order',audience:'admin',number:'SO',party:'Customer',currency:'EUR',
  lines:lines.map(l=>({code:l.code,brand:l.brand,qty:l.qty,unitPrice:l.sellPrice})),total:145});
 const wb=XLSX.read(buildWorkbookBytes('Sales Order',model.rows,model.numericColumns,model.options),{type:'array'});
 const data=XLSX.utils.sheet_to_json(wb.Sheets['Sales Order'],{header:1}) as any[][];
 const row=data.find(r=>r.includes('000123'));assert.ok(row);assert.ok(row.includes(12.5));assert.ok(row.includes(25));
 assert.ok(!JSON.stringify(data).includes('GroupAuto'));assert.ok(!JSON.stringify(data).includes('TPM'));assert.ok(!JSON.stringify(data).includes('7.6'));
});

test('analysis gateway rejects every non-superadmin and forwards only bounded price inputs with the actual caller JWT',async()=>{
 const savedFetch=globalThis.fetch;const savedNetlify=(globalThis as any).Netlify;
 let role='sales',active=true,dispatched=0;
 (globalThis as any).Netlify={env:{get:(k:string)=>({SUPABASE_URL:'https://analysis.invalid',SUPABASE_ANON_KEY:'anon-fixture',SUPABASE_SERVICE_ROLE_KEY:'service-fixture'} as Record<string,string>)[k]}};
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname==='/auth/v1/user')return Response.json({id:'actor',email:'test@example.invalid'});
  if(url.pathname==='/rest/v1/profiles')return Response.json([{organization_id:'org',role,department:'purchasing',permissions:{'purchasing.orders':true},is_active:active}]);
  assert.equal(url.pathname,'/rest/v1/rpc/cloud_current_supplier_price_options_batch');
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer caller-fixture');assert.equal(new Headers(init?.headers).get('apikey'),'anon-fixture');
  assert.deepEqual(JSON.parse(String(init?.body)),{input_requests:[{code:'000123',brand:'Sachs'}]});
  dispatched++;return Response.json([{request_index:0,options:[offer('000123','T','TPM',8.56)]}]);
 };
 const request=(input_requests:any=[{code:'000123',brand:'Sachs',organization_id:'other'}],token=true)=>new Request('https://portal.example.invalid/api/app-rpc',{
  method:'POST',headers:{...(token?{Authorization:'Bearer caller-fixture'}:{}),'Content-Type':'application/json'},
  body:JSON.stringify({name:'sales_order_purchase_analysis_options',args:{input_requests,organization_id:'other'}})});
 try {
  for(role of ['admin','sales','warehouse','viewer','customer','']) {assert.equal((await handler(request(),{} as any)).status,403);assert.equal(dispatched,0);}
  role='superadmin';active=false;assert.equal((await handler(request(),{} as any)).status,401);assert.equal(dispatched,0);
  active=true;assert.equal((await handler(request(undefined,false),{} as any)).status,401);
  for(const bad of [[],Array(26).fill({code:'x',brand:'Sachs'}),[{code:'x'}],[{code:'',brand:'Sachs'}]]) assert.equal((await handler(request(bad),{} as any)).status,400);
  assert.equal(dispatched,0);
  const result=await handler(request(),{} as any);assert.equal(result.status,200);assert.equal(dispatched,1);assert.equal((await result.json()).data[0].options[0].buy_price,8.56);
 } finally {globalThis.fetch=savedFetch;(globalThis as any).Netlify=savedNetlify;}
});
