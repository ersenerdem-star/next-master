import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {parseReleaseAudit,releaseReviewState,releaseIssueExplanation} from '../../apps/web/src/shared/supplierReleaseReview.ts';
import {SupplierReleaseReviewCard,releaseReviewMessage} from '../../apps/web/src/modules/admin/SupplierReleaseReviewCard.tsx';
const org='10000000-0000-0000-0000-000000000001',brand='30000000-0000-0000-0000-000000000001',other='30000000-0000-0000-0000-000000000002';
const row={id:'40000000-0000-0000-0000-000000000001',brandId:brand,brand:'Gates',supplier:'Romany',status:'validated',createdAt:'2026-10-04T16:00:00+00:00',totalRows:5000,processedRows:5000,errorCode:null,current:false,audit:null};
const audit=(overrides={})=>({policy:'cross-brand-v1',checked:true,review_required:true,selected_brand_id:brand,distinct_incoming_codes:5000,
 brands:[{brand_id:other,brand_name:'Mahle',matching_codes:5000,incoming_percent:1,sample_codes:['001','A-02']}],...overrides});
test('Evidence is whitelisted; percentage is computed, not trusted from JSON',()=>{
 const parsed=parseReleaseAudit(audit({internal_note:'PRIVATE',buy_price:123}),brand);
 assert.equal(parsed.brands[0].percent,100);assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));assert.ok(!('buy_price' in parsed));
});
test('Wrong selected brand, unknown policy, malformed counts or oversized evidence fail closed',()=>{
 for(const bad of [null,{},audit({selected_brand_id:other}),audit({policy:'unknown'}),audit({distinct_incoming_codes:'5000'}),
 audit({brands:Array(11).fill(audit().brands[0])}),audit({brands:[{...audit().brands[0],sample_codes:Array(11).fill('x')}]}),
 audit({brands:[{...audit().brands[0],matching_codes:-1}]}),audit({brands:[{...audit().brands[0],matching_codes:5001}]})]) assert.equal(parseReleaseAudit(bad,brand),null);
});
test('Visible strong evidence holds even if review_required is wrongly false',()=>assert.equal(parseReleaseAudit(audit({review_required:false}),brand).reviewRequired,true));
test('Unavailable comparison is a hold, never a clear audit',()=>assert.equal(parseReleaseAudit({policy:'cross-brand-v1',checked:false,review_required:false},brand).reviewRequired,true));
test('Validated without audit is unverified; clear validated is not published',()=>{
 assert.equal(releaseReviewState(row),'unverified');
 assert.equal(releaseReviewState({...row,audit:parseReleaseAudit(audit({review_required:false,brands:[]}),brand)}),'awaiting_publication');
});
test('Completed staged release is not misreported as verification queued',()=>{
 assert.equal(releaseReviewState({...row,status:'staged',audit:null,errorCode:null}),'staged');
});
test('Review flag/error takes precedence over validated/current/published',()=>{
 assert.equal(releaseReviewState({...row,status:'published',current:true,errorCode:'CROSS_BRAND_BULK_OVERLAP'}),'review_required');
 assert.equal(releaseReviewState({...row,audit:parseReleaseAudit(audit(),brand)}),'review_required');
});
test('Only published current pointer can display active; inactive states never do',()=>{
 assert.equal(releaseReviewState({...row,status:'published',current:true}),'active');
 assert.notEqual(releaseReviewState({...row,status:'published',current:false}),'active');
 for(const status of ['superseded','cancelled','archived','failed'])assert.equal(releaseReviewState({...row,status,current:true}),'inactive');
});
test('Rejected cancellation is terminal, not pending review or successful publication',()=>{
 const rejected={...row,status:'cancelled',errorCode:'REVIEW_REJECTED',current:true,audit:parseReleaseAudit(audit(),brand)};
 assert.equal(releaseReviewState(rejected),'rejected');
 assert.equal(releaseReviewState({...rejected,status:'validated'}),'review_required');
 for(const tr of [true,false]){
  const html=renderToStaticMarkup(createElement(SupplierReleaseReviewCard,{rows:[rejected],tr,onDetails:()=>{}}));
  assert.match(html,tr?/Dosya reddedildi/:/Source rejected/);assert.match(html,tr?/düzeltilmiş dosyayla/:/corrected file/);
  assert.ok(!html.includes('mark-badge--completed'));assert.ok(!html.includes('<button'));
 }
});
test('Actual React card renders escaped brand/code text and never internal cost/notes',()=>{
 const poisoned=audit({internal_note:'PRIVATE-NOTE',brands:[{...audit().brands[0],brand_name:'<script>alert(1)</script>',sample_codes:['<img src=x onerror=alert(1)>']}]});
 const html=renderToStaticMarkup(createElement(SupplierReleaseReviewCard,{rows:[{...row,audit:parseReleaseAudit(poisoned,brand)}],tr:true,onDetails:()=>{}}));
 assert.match(html,/İnceleme gerekli/);assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('PRIVATE-NOTE'));
});
test('Actual warning text includes selected brand/supplier/other brand, count and percentage',()=>{
 const r={...row,audit:parseReleaseAudit(audit(),brand),errorCode:'CROSS_BRAND_BULK_OVERLAP'};
 for(const tr of [true,false]){const m=releaseReviewMessage(r,tr);assert.match(m,/Gates.*Romany/);assert.match(m,/Mahle/);assert.match(m,/100%/);}
});
test('Actual React card explicitly distinguishes validation from publication in TR and EN',()=>{
 const r={...row,audit:parseReleaseAudit(audit({review_required:false,brands:[]}),brand)};
 for(const tr of [true,false]){const html=renderToStaticMarkup(createElement(SupplierReleaseReviewCard,{rows:[r],tr,onDetails:()=>{}}));assert.match(html,tr?/henüz yayınlanmadı/:/not yet published/);assert.ok(!html.includes('mark-badge--completed'));}
});
// Actual API module, only transport and organization resolver stubbed. No network.
const bundled=await build({entryPoints:['apps/web/src/infrastructure/api/supplierReleaseReviewApi.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
 name:'review-transport',setup(b){
  b.onResolve({filter:/\/(supabaseClient|organizationApi)$/},args=>({path:args.path.split('/').at(-1),namespace:'review'}));
  b.onLoad({filter:/.*/,namespace:'review'},args=>({contents:args.path==='supabaseClient'
   ?'export const supabaseClient={from:(...args)=>globalThis.__releaseMock.from(...args)};'
   :'export const getCurrentOrgId=async()=>globalThis.__releaseMock.org;',loader:'js'}));
 }
}]});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].contents).toString('base64'));
async function invoke({releases=[raw()],pointers=[],releaseError=null,pointerError=null,cursor=null,abort=false,filters={}}={}){
 const log=[];globalThis.__releaseMock={org,from(table){const chain={};
  for(const method of ['select','eq','ilike','gte','lte','order','limit','or','in','abortSignal'])chain[method]=(...a)=>{log.push({table,method,args:a});return chain;};
  chain.then=(resolve,reject)=>Promise.resolve(table==='supplier_price_releases'?{data:releases,error:releaseError}:{data:pointers,error:pointerError}).then(resolve,reject);
  return chain;
 }};
 const controller=new AbortController();if(abort)controller.abort();
 try{return {page:await api.fetchSupplierReleaseReviewPage(cursor,controller.signal,filters),log};}finally{delete globalThis.__releaseMock;}
}
async function invokeIssues({rows=[],rowError=null,cursor=null,abort=false}={}){
 const log=[];globalThis.__releaseMock={org,from(table){const chain={};
  for(const method of ['select','eq','order','limit','or','in','abortSignal'])chain[method]=(...a)=>{log.push({table,method,args:a});return chain;};
  chain.then=(resolve,reject)=>Promise.resolve({data:rows,error:rowError}).then(resolve,reject);
  return chain;
 }};
 const controller=new AbortController();if(abort)controller.abort();
 try{return {page:await api.fetchSupplierReleaseIssuePage(row.id,cursor,controller.signal),log};}finally{delete globalThis.__releaseMock;}
}
function raw(extra={}){return {id:row.id,brand_id:brand,status:'validated',created_at:row.createdAt,total_rows:5000,processed_rows:5000,
 error_code:'CROSS_BRAND_BULK_OVERLAP',brand_identity_audit:audit(),brands:{name:'Gates'},suppliers:{name:'Romany'},...extra};}
test('Actual API binds both reads to organization, bounded page and page-only pointers',async()=>{
 const {page,log}=await invoke();assert.equal(page.rows.length,1);
 assert.equal(log.filter(x=>x.method==='eq'&&x.args[0]==='organization_id'&&x.args[1]===org).length,2);
 assert.ok(log.some(x=>x.method==='limit'&&x.args[0]===26));
 assert.deepEqual(log.find(x=>x.method==='in').args,['release_id',[row.id]]);
 assert.ok(log.every(x=>!['insert','update','rpc','delete'].includes(x.method)));
});
test('26 fetched records return 25 plus deterministic keyset cursor, not a false complete list',async()=>{
 const records=Array.from({length:26},(_,i)=>raw({id:`40000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`}));
 const {page}=await invoke({releases:records});assert.equal(page.rows.length,25);assert.equal(page.next.id,records[24].id);
 const {log}=await invoke({cursor:page.next});assert.ok(log.some(x=>x.method==='or'&&x.args[0].includes('id.lt.'+page.next.id)));
});
test('Empty page does not query all current pointers or pretend legacy uploads were verified',async()=>{
 const {page,log}=await invoke({releases:[]});assert.deepEqual(page,{rows:[],next:null});assert.ok(!log.some(x=>x.table==='supplier_current_price_pointers'));
});
test('Unavailable schema/permission/transport is an error, not empty success',async()=>{
 for(const o of [{releaseError:{message:'missing column'}},{pointerError:{message:'denied'}}])await assert.rejects(()=>invoke(o),/could not be verified/);
});
test('Pointer requires published publication status and can parse relation array',async()=>{
 const {page}=await invoke({pointers:[{release_id:row.id,supplier_price_publications:[{status:'published'}]}]});assert.equal(page.rows[0].current,true);
 const otherPage=await invoke({pointers:[{release_id:row.id,supplier_price_publications:{status:'superseded'}}]});assert.equal(otherPage.page.rows[0].current,false);
});
test('Malformed cursor, aborted request and invalid counts reject rather than claiming completion',async()=>{
 await assert.rejects(()=>invoke({cursor:{id:'x),organization_id.neq.x',createdAt:row.createdAt}}),/Invalid release cursor/);
 await assert.rejects(()=>invoke({cursor:{id:row.id,createdAt:'not a timestamp'}}),/Invalid release cursor/);
 await assert.rejects(()=>invoke({abort:true}),/Cancelled/);
 await assert.rejects(()=>invoke({releases:[raw({total_rows:'5000'})]}),/Invalid release counts/);
});
test('Problem detail explanation is specific and never claims publication',()=>{
 assert.match(releaseIssueExplanation({errorCode:'INVALID_BUY_PRICE'},true),/fiyatı geçerli bir sayı/);
 assert.match(releaseIssueExplanation({errorCode:'DUPLICATE_NORMALIZED_CODE'},false),/one row per code/);
 assert.match(releaseIssueExplanation({errorCode:'OTHER'},true),/Doğrulama kodu/);
});
test('Problem detail read is org-scoped, release-scoped and bounded',async()=>{
 const {page,log}=await invokeIssues({rows:[{id:'12',source_row_number:'300',product_code:'P958897',buy_price:'53.1',row_status:'conflict',error_code:'DUPLICATE_NORMALIZED_CODE',error_message:'duplicate'}]});
 assert.equal(page.rows[0].sourceRowNumber,300);assert.equal(page.rows[0].id,12);assert.equal(page.rows[0].buyPrice,'53.1');
 assert.ok(log.some(x=>x.method==='eq'&&x.args[0]==='supplier_price_releases.organization_id'&&x.args[1]===org));
 assert.ok(log.some(x=>x.method==='eq'&&x.args[0]==='release_id'&&x.args[1]===row.id));
 assert.ok(log.some(x=>x.method==='or'&&x.args[0].includes('row_status.neq.accepted')));assert.ok(log.some(x=>x.method==='limit'&&x.args[0]===51));
 assert.ok(log.every(x=>!['insert','update','rpc','delete'].includes(x.method)));
});
test('Problem detail rejects transport failure and malformed rows',async()=>{
 await assert.rejects(()=>invokeIssues({rowError:{message:'denied'}}),/could not be verified/);
 await assert.rejects(()=>invokeIssues({rows:[{id:'not-a-number',source_row_number:1}]}),/Invalid issue row/);
 await assert.rejects(()=>invokeIssues({cursor:{sourceRowNumber:-1,id:1}}),/Invalid issue cursor/);
});

 test('interrupted card visibly explains the safe cause without exposing provider details',()=>{
 const r={...row,status:'failed',errorCode:'SUPPLIER_PROCESSING_INTERRUPTED',errorMessage:'SUPPLIER_FAILURE_VALIDATION_DATABASE_TIMEOUT',updatedAt:row.createdAt};
 for(const tr of [true,false]){
  const html=renderToStaticMarkup(createElement(SupplierReleaseReviewCard,{rows:[r],tr,onDetails:()=>{}}));
  const visible=html.split('<details')[0];
  assert.match(visible,tr?/Son satır ve marka kontrolü/:/final row and brand check/);
  assert.match(visible,tr?/tekrar yüklemeniz gerekmiyor/:/Do not upload the same file/);
  assert.match(visible,/role="alert"/);
 }
 const unknown=releaseReviewMessage({...r,errorMessage:'SECRET SQL url'},true);
 assert.doesNotMatch(unknown,/SECRET|SQL|url/);
 });

test('v2 historical-only matches remain visible and cannot block a clear audit',()=>{
 const parsed=parseReleaseAudit(audit({policy:'cross-brand-v2',review_required:false,brands:[],historical_brands:audit().brands}),brand);
 assert.equal(parsed.reviewRequired,false);assert.equal(parsed.historicalBrands[0].matches,5000);
 assert.equal(releaseReviewState({...row,audit:parsed}),'awaiting_publication');
 for(const tr of [true,false]){
  const html=renderToStaticMarkup(createElement(SupplierReleaseReviewCard,{rows:[{...row,audit:parsed}],tr,onDetails:()=>{}}));
  assert.match(html,tr?/yayını engellemez/:/do not block publication/);
  assert.match(html,/Mahle/);assert.ok(!html.includes('mark-badge--completed'));
 }
});
test('v2 rejects missing/malformed historical evidence and still detects strong current matches',()=>{
 for(const historical_brands of [undefined,null,{},Array(11).fill(audit().brands[0]),[{...audit().brands[0],matching_codes:5001}]]){
  assert.equal(parseReleaseAudit(audit({policy:'cross-brand-v2',historical_brands}),brand),null);
 }
 assert.equal(parseReleaseAudit(audit({policy:'cross-brand-v2',review_required:false,historical_brands:[]}),brand).reviewRequired,true);
});

test('v3 accepts exactly 5%, blocks strictly greater, ignores absolute count and preserves precise comparison',()=>{
 const a=(n,matches)=>parseReleaseAudit(audit({policy:'cross-brand-v3',review_required:false,distinct_incoming_codes:n,historical_brands:[],brands:[{...audit().brands[0],matching_codes:matches}]}),brand);
 assert.equal(a(100,5).reviewRequired,false);assert.equal(a(100,6).reviewRequired,true);
 assert.equal(a(100001,5000).reviewRequired,false);assert.equal(a(100000,5000).reviewRequired,false);assert.equal(a(100000,5001).reviewRequired,true);
 assert.equal(a(10,1).reviewRequired,true);
 const parsed=a(100,5);
 const html=renderToStaticMarkup(createElement(SupplierReleaseReviewCard,{rows:[{...row,audit:parsed}],tr:true,onDetails:()=>{}}));
 assert.ok(!html.includes('Örtüşen marka'));assert.ok(!html.includes('İnceleme gerekli'));
});

test('Brand, supplier and Istanbul calendar dates filter the complete release query with pagination',async()=>{
 const supplier='20000000-0000-0000-0000-000000000001';
 const {log}=await invoke({filters:{brandSearch:'  Mercedes  ',supplierId:supplier,fromDate:'2026-10-01',toDate:'2026-10-23'},cursor:{id:row.id,createdAt:row.createdAt}});
 for(const [method,column,value]of [['ilike','brands.name','%Mercedes%'],['eq','supplier_id',supplier],['gte','created_at','2026-10-01T00:00:00+03:00'],['lte','created_at','2026-10-23T23:59:59.999+03:00']]){
  assert.ok(log.some(call=>call.table==='supplier_price_releases'&&call.method===method&&call.args[0]===column&&call.args[1]===value));
 }
 assert.ok(log.some(call=>call.method==='or'));
 assert.ok(log.some(call=>call.method==='select'&&call.args[0].includes('brands!inner(name)')));
});
test('Malformed supplier filters are rejected before a request is sent',async()=>{
 await assert.rejects(invoke({filters:{supplierId:'not-a-uuid'}}),/Invalid supplier filter/);
});
