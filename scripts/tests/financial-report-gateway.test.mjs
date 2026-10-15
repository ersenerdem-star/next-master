import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import handler from '../../netlify/functions/app-rpc.mts';
const org='b0000000-0000-4000-8000-000000000001';
const reports=['reporting_customer_balance_by_brand_product','reporting_supplier_balance_by_brand_product','reporting_sales_margin_report'];
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const token=`${encode({alg:'none'})}.${encode({iat:2000000000})}.synthetic`;
// Actual handler; network and Auth are explicit stubs, NOT remote E2E.
async function stubbed(callback, profileOverrides={}, authStatus=200, authBody={id:'b0000000-0000-4000-8000-000000000010'}) {
 const prior=globalThis.fetch, priorNetlify=globalThis.Netlify, calls=[];
 globalThis.Netlify={env:{get:k=>({SUPABASE_URL:'http://127.0.0.1:54321',SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-secret'}[k])}};
 globalThis.fetch=async(input,init={})=>{
  const url=String(input);calls.push({url,init});
  if(url.endsWith('/auth/v1/user'))return Response.json(authBody,{status:authStatus});
  if(url.includes('/rest/v1/profiles?'))return Response.json([{id:'b0000000-0000-4000-8000-000000000010',organization_id:org,role:'admin',department:'management',is_active:true,permissions:{},...profileOverrides}]);
  if(url.includes('/rest/v1/rpc/reporting_'))return Response.json([{currency:'EUR',balance_amount:1.01}]);
  throw new Error('Unexpected request:'+url);
 };
 try {return await callback(calls);}finally{globalThis.fetch=prior;globalThis.Netlify=priorNetlify;}
}
const request=(name,args)=>new Request('http://localhost/api/app-rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({name,args})});
for(const name of reports)test(name+': actual gateway uses server organization and caller JWT',async()=>stubbed(async calls=>{
 const response=await handler(request(name,{p_limit:500}),{});assert.equal(response.status,200);assert.deepEqual((await response.json()).data,[{currency:'EUR',balance_amount:1.01}]);
 const rpc=calls.find(c=>c.url.endsWith('/rpc/'+name));assert(rpc);assert.equal(JSON.parse(rpc.init.body).p_organization_id,org);
 assert.equal(rpc.init.headers.Authorization,`Bearer ${token}`);assert.equal(rpc.init.headers.apikey,'synthetic-public');assert(!JSON.stringify(rpc).includes('synthetic-secret'));
}));
test('foreign organization is rejected before report transport',async()=>stubbed(async calls=>{
 assert.equal((await handler(request(reports[0],{p_organization_id:'other'}),{})).status,403);
 assert(!calls.some(c=>c.url.includes('/rpc/')));
}));
test('revoked actor does not reach report transport',async()=>stubbed(async calls=>{
 assert.equal((await handler(request(reports[0],{}),{})).status,401);
 assert(!calls.some(c=>c.url.includes('/rpc/')));
},{session_revoked_at:new Date(2000000001000).toISOString()}));
for(const status of [401,403])test(`Auth ${status} becomes session-expired 401 without report transport`,async()=>stubbed(async calls=>{
 assert.equal((await handler(request(reports[0],{}),{})).status,401);
 assert(!calls.some(c=>c.url.includes('/rest/v1/')));
},{},status,{message:'invalid session'}));
for(const status of [429,503])test(`Auth ${status} is not misclassified as signed-out credentials`,async()=>stubbed(async calls=>{
 assert.notEqual((await handler(request(reports[0],{}),{})).status,401);
 assert(!calls.some(c=>c.url.includes('/rest/v1/')));
},{},status,{message:'upstream temporarily unavailable'}));
test('Missing Auth user fails closed as 401 without profile/report reads',async()=>stubbed(async calls=>{
 assert.equal((await handler(request(reports[0],{}),{})).status,401);
 assert(!calls.some(c=>c.url.includes('/rest/v1/')));
},{},200,{}));
// Execute the actual frontend fetch function without loading browser storage.
const path='apps/web/src/infrastructure/api/reportingApi.ts';
const source=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
const declarations=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&['normalizeReportFilters','fetchReportRows'].includes(n.name?.text));
const code=ts.transpileModule(declarations.map(n=>n.getText(source)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('financial frontend rejects missing job/response instead of reporting empty success',async()=>{
 for(const value of [undefined,null,{},'not rows']) {
  const fetchRows=new Function('callAppRpc','supabaseClient',`${code};return fetchReportRows;`)(async()=>value,{rpc:()=>{throw Error('Direct RPC forbidden');}});
  await assert.rejects(fetchRows(reports[0],{organizationId:org}),/missing or incomplete/);
 }
});
test('all three financial frontend readers use gateway and preserve complete rows',async()=>{
 const calls=[],rows=[{currency:'EUR',balance_amount:1.01},{currency:'USD',balance_amount:2.02}];
 const fetchRows=new Function('callAppRpc','supabaseClient',`${code};return fetchReportRows;`)(async(name,args)=>{calls.push({name,args});return rows;},{rpc:()=>{throw Error('Direct RPC forbidden');}});
 for(const name of reports)assert.deepEqual(await fetchRows(name,{organizationId:org,partyQuery:'  Client  ',limit:2500}),rows);
 assert.equal(calls.length,3);assert(calls.every(c=>c.args.p_party_query==='Client'&&c.args.p_limit===2500));
});
test('atomic confirmation remains closed on an environment without commercial acceptance',async()=>stubbed(async calls=>{
 const response=await handler(request('confirm_sales_order_with_purchases_atomic',{payload:{id:'local'},decision_id:'b0000000-0000-4000-8000-000000000099'}),{});
 assert.equal(response.status,409);
 assert.equal((await response.json()).code,'COMMERCIAL_UPGRADE_NOT_ENABLED');
 assert(!calls.some(c=>c.url.includes('/rpc/')));
}));
