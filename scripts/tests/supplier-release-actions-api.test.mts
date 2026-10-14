import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import evidence from '../../netlify/functions/supplier-price-release-evidence.mts';
import review from '../../netlify/functions/supplier-price-release-review.mts';
import publish from '../../netlify/functions/supplier-price-release-publish.mts';
import {supplierReleaseActionTarget} from '../../netlify/functions/_shared/supplier-release-actions.mts';

const stage='kaxsqafdevabkxofwdod',prod='zjgueqijumzlfioihnkt';
const origin='https://next-master-v3-staging-20261006.netlify.app',url=`https://${stage}.supabase.co`;
const actor='10000000-0000-4000-8000-000000000001',org='20000000-0000-4000-8000-000000000001';
const session='30000000-0000-4000-8000-000000000001',release='40000000-0000-4000-8000-000000000001';
const decision='50000000-0000-4000-8000-000000000001',supplier='60000000-0000-4000-8000-000000000001',brand='70000000-0000-4000-8000-000000000001';
const secret='sb_secret_SYNTHETIC_NEVER_REAL';
const env={SUPPLIER_PRICE_RELEASE_ACTIONS_ENABLED:'true',SUPABASE_URL:url,SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:secret};
const command={releaseId:release,decisionId:decision,action:'recheck',reason:'comparison_repaired',expectedRevision:0,
 expectedStatus:'validated',expectedError:'BRAND_IDENTITY_COMPARISON_PENDING',expectedAudit:null};
const publication={releaseId:release,decisionId:decision,expectedReviewRevision:1,expectedPreviousPublicationId:null};
const observed={actorId:actor,organizationId:org,releaseId:release,supplierId:supplier,brandId:brand,supplier:'Fixture supplier',brand:'Fixture brand',
 mode:'replace',status:'validated',reviewRevision:0,errorCode:'BRAND_IDENTITY_COMPARISON_PENDING',brandIdentityAudit:null,
 totalRows:999997,processedRows:999997,acceptedRows:999997,rejectedRows:0,warningRows:0,conflictRows:0,sourceVerified:true,
 currentPublicationId:null,currentReleaseId:null,currentPublicationVersion:null,isCurrent:false,canReview:true,canPublish:false,reviewOperation:null,publishOperation:null};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('all three endpoints bundle with the deployment parser',async()=>{
 const result=await build({entryPoints:['evidence','review','publish'].map(kind=>fileURLToPath(new URL(`../../netlify/functions/supplier-price-release-${kind}.mts`,import.meta.url))),
  bundle:true,platform:'node',target:'node22',format:'esm',outdir:'/tmp/unused-admin-action-bundle',write:false,logLevel:'silent'});
 assert.equal(result.outputFiles.length,3);
});
async function invoke(kind:'evidence'|'review'|'publish',changes:Record<string,any>={}){
 const previousFetch=globalThis.fetch,previousEnv=(globalThis as any).Netlify,calls:any[]=[];
 const settings={...env,...changes.env};(globalThis as any).Netlify={env:{get:(name:string)=>settings[name]}};
 const now=Math.floor(Date.now()/1000),claims={sub:actor,role:'authenticated',aud:'authenticated',iss:settings.SUPABASE_URL+'/auth/v1',
  session_id:session,iat:now-10,exp:now+3600,...changes.claims};
 const token=[{alg:'HS256'},claims,'synthetic'].map(x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url')).join('.');
 globalThis.fetch=async(input,init)=>{
  const parsed=new URL(String(input));assert.equal(parsed.origin,settings.SUPABASE_URL,'All transport is synthetic');
  const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path:parsed.pathname,body});
  assert.equal(init?.redirect,'error');
  if(parsed.pathname==='/auth/v1/user')return json({id:changes.userId||actor},changes.authStatus||200);
  if(parsed.pathname==='/rest/v1/profiles')return json([{id:actor,organization_id:org,role:'admin',is_active:true,session_revoked_at:null,...changes.profile}]);
  assert.equal((init?.headers as any).apikey,secret);assert.equal((init?.headers as any).Authorization,undefined);
  assert.equal(body.input_actor_id,actor);assert.equal(body.input_organization_id,org);assert.equal(body.input_auth_session_id,session);
  assert.equal(body.input_token_iat,claims.iat);assert.equal(body.input_token_exp,claims.exp);
  assert.equal(body.input_project_ref,new URL(settings.SUPABASE_URL).hostname.split('.')[0]);
  if(changes.transportFailure)throw Error(secret);
  if(changes.rpcFailure)return json(changes.rpcFailure,changes.rpcStatus||400);
  if(kind==='evidence'){
   assert.equal(parsed.pathname,'/rest/v1/rpc/get_supplier_release_action_evidence');assert.equal(body.input_release_id,release);
   return json({...observed,privateKey:secret,...changes.receipt});
  }
  assert.equal(parsed.pathname,'/rest/v1/rpc/request_supplier_release_action');assert.equal(body.input_action,kind);
  return json({releaseId:release,decisionId:decision,action:kind==='publish'?'publish':'recheck',status:'queued',published:false,replayed:false,...changes.receipt});
 };
 try{
  const request=new Request(`${changes.origin||origin}/api/supplier-price-release-${kind}${kind==='evidence'?`?releaseId=${release}`:''}${changes.query||''}`,{
   method:changes.method||(kind==='evidence'?'GET':'POST'),headers:{'content-type':changes.contentType||'application/json',
    ...(changes.noAuth?{}:{authorization:`Bearer ${token}`}),...changes.headers},
   ...(kind==='evidence'?{}:{body:changes.raw||JSON.stringify({...(kind==='review'?command:publication),...changes.body})})});
  const response=await ({evidence,review,publish}[kind])(request);const data=await response.json();
  assert.ok(!JSON.stringify(data).includes(secret));return {status:response.status,data,calls};
 }finally{globalThis.fetch=previousFetch;(globalThis as any).Netlify=previousEnv;}
}

test('separate action gates bind exactV3/production target; upload admission is irrelevant',async()=>{
 assert.ok(supplierReleaseActionTarget(origin+'/api',name=>(env as any)[name]));
 const production={...env,SUPABASE_URL:`https://${prod}.supabase.co`,NM_PRODUCTION_TARGET:prod,SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED:'1'};
 assert.ok(supplierReleaseActionTarget('https://portal.next-master.com/api',name=>(production as any)[name]));
 for(const change of [{SUPPLIER_PRICE_RELEASE_ACTIONS_ENABLED:undefined},{SUPABASE_URL:url+'/'},{NM_PRODUCTION_TARGET:prod},
  {SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED:'1'}]){
  const result=await invoke('review',{env:change});assert.equal(result.status,503);assert.equal(result.calls.length,0);
 }
 const denied=await invoke('publish',{headers:{origin:'https://foreign.invalid'}});assert.equal(denied.status,403);assert.equal(denied.calls.length,0);
 const prodMissing=await invoke('review',{origin:'https://portal.next-master.com',env:{SUPABASE_URL:`https://${prod}.supabase.co`,NM_PRODUCTION_TARGET:prod}});
 assert.equal(prodMissing.status,503);assert.equal(prodMissing.calls.length,0);
});
test('evidence returns exactsessionactor and fullCASaudit but whitelists response fields',async()=>{
 const audit={policy:'cross-brand-v1',checked:false,review_required:true,reason:'DUCKDB_VALIDATION_BRAND_AUDIT_PENDING'};
 const result=await invoke('evidence',{receipt:{brandIdentityAudit:audit}});
 assert.equal(result.status,200);assert.equal(result.data.actorId,actor);assert.deepEqual(result.data.brandIdentityAudit,audit);
 assert.equal('privateKey' in result.data,false);assert.equal(result.calls.filter(x=>x.path.includes('/rpc/')).length,1);
 for(const receipt of [{actorId:org},{organizationId:actor},{acceptedRows:null},{currentPublicationId:'bad'},
  {brandIdentityAudit:{secret:'x'.repeat(17000)}}])assert.equal((await invoke('evidence',{receipt})).status,503);
});
test('acceptance forwards immutable CAS and decision only, never performs the long operation',async()=>{
 for(const kind of ['review','publish'] as const){
  const result=await invoke(kind);assert.equal(result.status,202);assert.equal(result.data.published,false);
  const calls=result.calls.filter(x=>x.path.includes('/rpc/'));assert.equal(calls.length,1);
  assert.deepEqual(calls[0].body.input_request,kind==='review'?command:publication);
  assert.doesNotMatch(calls[0].path,/execute|publish_supplier|validate/);
 }
 const replay=await invoke('review',{receipt:{status:'rechecked_clear',reviewRevision:1,errorCode:null,replayed:true}});
 assert.equal(replay.status,200);assert.equal(replay.data.decisionId,decision);assert.equal(replay.data.replayed,true);
});
test('body aliases, malformed CAS, unboundedbytes and unexpectedquery fail before any remote call',async()=>{
 for(const body of [{actorId:actor},{organizationId:org},{supplierId:supplier},{projectRef:prod},{expectedRevision:-1},
  {expectedStatus:'published'},{action:'approve'},{expectedAudit:'not-json'},{expectedAudit:{x:'x'.repeat(17000)}}]){
  const result=await invoke('review',{body});assert.equal(result.status,400);assert.equal(result.calls.length,0);
 }
 for(const changes of [{raw:'x'.repeat(25000),headers:{'content-length':'1'}},{raw:JSON.stringify({...command,extra:'x'.repeat(25000)})}]){
  const result=await invoke('review',changes);assert.equal(result.status,413);assert.equal(result.calls.length,0);
 }
 for(const changes of [{contentType:'text/plain'},{query:'?unexpected=1'}]){
  const result=await invoke('review',changes);assert.equal(result.status,400);assert.equal(result.calls.length,0);
 }
});
test('missing,expired,revoked,foreign and nonadmin auth never reaches acceptance',async()=>{
 for(const changes of [{noAuth:true},{authStatus:401},{claims:{exp:1}},{claims:{iss:'https://wrong.invalid/auth/v1'}},
  {userId:org},{profile:{is_active:false}},{profile:{role:'customer'}},{profile:{session_revoked_at:new Date().toISOString()}}]){
  const result=await invoke('review',changes);assert.ok([401,403].includes(result.status));assert.equal(result.calls.some(x=>x.path.includes('/rpc/')),false);
 }
 const unconfirmed=await invoke('review',{profile:{session_revoked_at:'unavailable'}});
 assert.equal(unconfirmed.status,503);assert.equal(unconfirmed.calls.some(x=>x.path.includes('/rpc/')),false);
});
test('stale CAS and ledger conflicts are409; unknown outcomes keep the same decision and never retry',async()=>{
 for(const message of ['REVIEW_STALE_EVIDENCE','ACTION_DECISION_CONFLICT','PRODUCTION_PUBLICATION_STALE_POINTER']){
  const result=await invoke('publish',{rpcFailure:{code:'P0001',message}});assert.equal(result.status,409);
  assert.equal(result.data.outcome,'not_submitted');assert.equal(result.data.decisionId,decision);
 }
 for(const changes of [{transportFailure:true},{rpcFailure:{message:secret},rpcStatus:502},{receipt:{decisionId:release}}]){
  const result=await invoke('publish',changes);assert.equal(result.status,503);assert.equal(result.data.outcome,'unknown');
  assert.equal(result.data.decisionId,decision);assert.equal(result.calls.filter(x=>x.path.includes('/rpc/')).length,1);
 }
});
test('publication receipts require exact IDs and cannot be reported by the review endpoint',async()=>{
 const receipt={status:'published',published:true,publicationId:supplier,version:2,reviewRevision:1,expectedPreviousPublicationId:null,isCurrent:true};
 const result=await invoke('publish',{receipt});assert.equal(result.status,200);assert.equal(result.data.published,true);
 assert.equal((await invoke('review',{receipt})).status,503);
 assert.equal((await invoke('publish',{receipt:{...receipt,publicationId:'bad'}})).status,503);
 const held=await invoke('publish',{receipt:{status:'review_required',errorCode:'CROSS_BRAND_BULK_OVERLAP'}});
 assert.equal(held.status,200);assert.equal(held.data.published,false);
});
test('evidence operation and terminal failures preserve action kind and never invent success',async()=>{
 const failed={releaseId:release,decisionId:decision,action:'recheck',status:'failed',errorCode:'ACTION_EXECUTION_TIMEOUT',published:false,replayed:true};
 const operation={decisionId:decision,status:'failed',receipt:failed,errorCode:failed.errorCode};
 assert.equal((await invoke('evidence',{receipt:{reviewOperation:operation}})).status,200);
 assert.equal((await invoke('evidence',{receipt:{publishOperation:operation}})).status,503);
 assert.equal((await invoke('publish',{receipt:{status:'review_required',action:'recheck',errorCode:'CROSS_BRAND_BULK_OVERLAP'}})).status,503);
 const terminal=await invoke('review',{receipt:failed});assert.equal(terminal.status,409);assert.equal(terminal.data.code,'ACTION_EXECUTION_TIMEOUT');
 assert.equal((await invoke('review',{receipt:{...failed,errorCode:null}})).status,503);
 assert.equal((await invoke('review',{body:{expectedError:'A'.repeat(101)}})).status,400);
});
