import test from 'node:test';
import assert from 'node:assert/strict';
import {adminReleaseActionConfig,createAdminReleaseActionConsumer} from '../../apps/engine/supplier-price-shadow/src/admin-release-review-worker.mjs';
import {createWorkerService,SERVICE_RPC_NAMES} from '../../apps/engine/supplier-price-shadow/src/worker-service.mjs';

const stage='kaxsqafdevabkxofwdod',prod='zjgueqijumzlfioihnkt';
const owner='10000000-0000-4000-8000-000000000001',decision='20000000-0000-4000-8000-000000000001';
const release='30000000-0000-4000-8000-000000000001',publication='40000000-0000-4000-8000-000000000001';
const secret='sb_secret_SYNTHETIC_NEVER_REAL';
const env={SUPABASE_URL:`https://${stage}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:secret,
 SUPPLIER_PRICE_EXPECTED_HOST:stage+'.supabase.co',SUPPLIER_PRICE_RELEASE_ACTIONS_WORKER_ENABLED:'1'};
const claim={status:'claimed',decision_id:decision,release_id:release,action:'review',lease_owner:owner};
const receipt={releaseId:release,decisionId:decision,action:'recheck',status:'rechecked_clear',reviewRevision:1,errorCode:null,published:false,replayed:false};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const empty={status:'empty',published:false};
async function consume({steps=[],claimChange={},receiptChange={},kind='review'}={}){
 const calls=[];let issuedOwners=0;
 const worker=createAdminReleaseActionConsumer({env,uuid:()=>{issuedOwners++;return owner;},fetchImpl:async(url,opts)=>{
  const parsed=new URL(url),name=parsed.pathname.split('/').at(-1),args=JSON.parse(opts.body);
  assert.equal(parsed.origin,env.SUPABASE_URL);assert.equal(opts.redirect,'error');assert.equal(opts.headers.apikey,secret);
  assert.equal(opts.headers.Authorization,undefined);assert.ok(opts.signal instanceof AbortSignal);
  assert.equal(args.input_project_ref,stage);calls.push({name,args});
  if(steps.length){const step=steps.shift();if(step instanceof Error)throw step;if(step)return step;}
  if(name==='claim_supplier_release_action')return response({...claim,action:kind,...claimChange});
  assert.deepEqual(args,{input_project_ref:stage,input_decision_id:decision,input_lease_owner:owner});
  return response({...receipt,...receiptChange});
 }});
 const result=await worker();assert.ok(!JSON.stringify(result).includes(secret));return {result,calls,issuedOwners};
}

test('admin consumer is independently default off and retains exact target/production opt-ins',()=>{
 assert.equal(createAdminReleaseActionConsumer({env:{}}),undefined);
 assert.equal(adminReleaseActionConfig({...env,SUPPLIER_PRICE_RELEASE_ACTIONS_WORKER_ENABLED:'true'}),null);
 assert.equal(adminReleaseActionConfig(env).projectRef,stage);
 const production={...env,SUPABASE_URL:`https://${prod}.supabase.co`,SUPPLIER_PRICE_TARGET_ENVIRONMENT:'production',
  SUPPLIER_PRICE_EXPECTED_HOST:prod+'.supabase.co',SUPPLIER_PRICE_PRODUCTION_ENABLED:'1',SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED:'1'};
 assert.equal(adminReleaseActionConfig(production).projectRef,prod);
 for(const patch of [{SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED:'1'},{SUPABASE_URL:env.SUPABASE_URL+'/rest/v1'},
  {SUPABASE_URL:'https://foreign.invalid'},{SUPABASE_SERVICE_ROLE_KEY:''}])assert.throws(()=>adminReleaseActionConfig({...env,...patch}));
 for(const key of ['SUPPLIER_PRICE_PRODUCTION_ENABLED','SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED'])
  assert.throws(()=>adminReleaseActionConfig({...production,[key]:undefined}));
 assert.equal([...SERVICE_RPC_NAMES].some(name=>/admin|publish|release_action/.test(name)),false,'privileged actions stay outside generic ingestion RPCs');
});
test('claim then execute uses the persisted decision and lease, without generating decisions or direct publisher calls',async()=>{
 const {result,calls,issuedOwners}=await consume();
 assert.deepEqual(result,{status:'completed',decisionId:decision,releaseId:release,published:false});
 assert.deepEqual(calls.map(x=>x.name),['claim_supplier_release_action','execute_supplier_release_action']);assert.equal(issuedOwners,1);
 const published=await consume({kind:'publish',receiptChange:{action:'publish',status:'published',published:true,publicationId:publication,version:2}});
 assert.equal(published.result.published,true);
 const noWork=await consume({claimChange:{status:'empty'}});assert.deepEqual(noWork.result,empty);assert.equal(noWork.calls.length,1);
});
test('unknown response after possible commit never settles failure or retries; next cycle reconciles the same DB decision',async()=>{
 let commits=0,reads=0;const calls=[];
 const worker=createAdminReleaseActionConsumer({env,uuid:()=>owner,fetchImpl:async(url,opts)=>{
  const name=new URL(url).pathname.split('/').at(-1);calls.push(name);
  if(name==='claim_supplier_release_action'){reads++;return response(claim);}
  assert.equal(name,'execute_supplier_release_action');assert.equal(JSON.parse(opts.body).input_decision_id,decision);
  if(commits===0){commits++;throw Error(secret+' response lost after commit');}
  return response({...receipt,replayed:true});
 }});
 assert.deepEqual(await worker(),{status:'pending',decisionId:decision,releaseId:release,published:null});
 assert.deepEqual(await worker(),{status:'completed',decisionId:decision,releaseId:release,published:false});
 assert.equal(commits,1);assert.equal(reads,2);assert.equal(calls.includes('fail_supplier_release_action'),false);
});
test('only authoritative SQL rollback can settle failure under the same lease',async()=>{
 for(const [sqlCode,message,expected] of [['57014','canceling statement due to statement timeout','ACTION_EXECUTION_TIMEOUT'],
  ['P0001','REVIEW_STALE_EVIDENCE','ACTION_EXECUTION_FAILED']]){
  const calls=[];
  const worker=createAdminReleaseActionConsumer({env,uuid:()=>owner,fetchImpl:async(url,opts)=>{
   const name=new URL(url).pathname.split('/').at(-1),args=JSON.parse(opts.body);calls.push(name);
   if(name==='claim_supplier_release_action')return response(claim);
   if(name==='execute_supplier_release_action')return response({code:sqlCode,message,details:secret},400);
   assert.equal(name,'fail_supplier_release_action');assert.deepEqual(args,{input_project_ref:stage,input_decision_id:decision,input_lease_owner:owner,input_error_code:expected});
   return response({...receipt,status:'failed',errorCode:expected});
  }});
  assert.deepEqual(await worker(),{status:'failed',decisionId:decision,releaseId:release,published:false});assert.equal(calls.length,3);
 }
});
test('gateway errors, malformed payloads, foreign claims and action-mismatched receipts fail closed',async()=>{
 for(const badResponse of [response({code:'502',message:secret},502),response({code:'P0001',message:secret},400),
  {ok:true,json:async()=>{throw Error(secret);}}]){
  const {result,calls}=await consume({steps:[null,badResponse]});assert.equal(result.status,'pending');assert.equal(result.published,null);assert.equal(calls.length,2);
 }
 for(const receiptChange of [{decisionId:owner},{releaseId:owner},{status:'published',published:true,action:'publish',publicationId:publication,version:1},
  {status:'rechecked_clear',action:'publish'}])assert.equal((await consume({receiptChange})).result.status,'pending');
 for(const claimChange of [{lease_owner:decision},{decision_id:'bad'},{release_id:'bad'},{action:'approve'}])
  await assert.rejects(consume({claimChange}),/CLAIM_UNCONFIRMED/);
 const lostSettlement=await consume({steps:[null,response({code:'57014',message:'cancelled'},400),Error(secret)]});
 assert.equal(lostSettlement.result.status,'pending');assert.equal(lostSettlement.calls.length,3);
});
test('service consumes explicit actions only after idle intake/history and never after stop or busy work',async()=>{
 const setup=changes=>createWorkerService({verify:async()=>empty,dispatch:async()=>empty,probe:async()=>({busy:false,failed:false}),log:()=>{},...changes});
 for(const changes of [{verify:async()=>({status:'verified',published:false})},{dispatch:async()=>({status:'enqueued',published:false})},
  {probe:async()=>({busy:true,failed:false})}]){
  let consumed=0;const s=setup({...changes,consumeAdminAction:async()=>{consumed++;return empty;}});
  await s.cycle();
  assert.equal(consumed,0);
 }
 let consumed=0,s;s=setup({probe:async()=>{s.stop();return {busy:false,failed:false};},consumeAdminAction:async()=>{consumed++;return empty;}});
 await s.cycle();assert.equal(consumed,0);assert.equal(s.snapshot().stopping,true);assert.equal(s.snapshot().ready,false);
 const order=[],logs=[];const live=setup({verify:async()=>{order.push('verify');return empty;},dispatch:async()=>{order.push('dispatch');return empty;},
  probe:async()=>{order.push('history');return {busy:false,failed:false};},consumeAdminAction:async()=>{order.push('action');return {status:'completed',decisionId:decision,releaseId:release,published:true};},log:x=>logs.push(JSON.parse(x))});
 await live.cycle();assert.deepEqual(order,['verify','dispatch','history','action']);assert.equal(logs[0].published,true);
 assert.equal(live.snapshot().published,false,'infrastructure state is not an action receipt');assert.equal(live.snapshot().phase,'admin-action-completed');
});

test('historical failures retain degraded readiness while exact leased admin decisions still settle',async()=>{
 const {worker,calls}=(()=>{const calls=[];return {calls,worker:createAdminReleaseActionConsumer({env,uuid:()=>owner,fetchImpl:async(url)=>{
 const name=new URL(url).pathname.split('/').at(-1);calls.push(name);
 return response(name==='claim_supplier_release_action'?claim:receipt);
 }})};})();
 const s=createWorkerService({verify:async()=>empty,dispatch:async()=>empty,probe:async()=>({busy:false,failed:true}),consumeAdminAction:worker,log:()=>{}});
 await assert.rejects(s.cycle(),/REQUIRES_REVIEW/);
 assert.deepEqual(calls,['claim_supplier_release_action','execute_supplier_release_action']);
 assert.equal(s.snapshot().ready,false);assert.equal(s.snapshot().published,false);
});
