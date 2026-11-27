import test from 'node:test';
import assert from 'node:assert/strict';
import {runElringJob} from '../../netlify/functions/_shared/catalog/elring-job-worker.mjs';
const source={source_key:'tecalliance_elring',base_url:'https://web.tecalliance.net/elring/en/home',is_active:true,license_posture:'allowed',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{allowed_brands:['Elring'],automated_read_only_approved:true,internal_observation_allowed:true}};
function setup({claimed=true,observation={fields:{product_code:'115.100'}},lost=false,mode='stage',bounded=false}={}){
 const calls=[];const saved=[];let processed=0;
 const db={rpc:async(name,args)=>{calls.push(name);if(name==='claim_catalog_elring_job')return{data:claimed?{id:'job',next_index:0,total_items:1,mode,lease_token:'token',manifest:{adapter:bounded?'elring-bounded-review.v1':'elring-official.v2',segment:'pc',fitment_max_requests:bounded?6:128}}:null};
   if(name==='heartbeat_catalog_elring_job'&&lost)return{error:{message:'Elring worker lease lost'}};
   if(name==='checkpoint_catalog_elring_job')saved.push(structuredClone(args));return{data:true};},
  from:table=>{const data=table==='catalog_external_sources'?{...source,metadata:{...source.metadata,bounded_review_only:bounded}}:table==='brands'?{id:'brand'}:{product_code:'115.100',observation,checkpoint:{}};
   const chain={select:()=>chain,eq:()=>chain,single:async()=>({data})};return chain;}};
 return{db,calls,saved,process:async({db,checkpoint,save})=>{await db.rpc('stage_command',{});processed++;checkpoint.sealed=true;await save();},get processed(){return processed;}};
}
test('duplicate invocation does no source reads or writes',async()=>{const s=setup({claimed:false});const result=await runElringJob({db:s.db,organizationId:'org',jobId:'job',readArticle:()=>{throw Error('unexpected');}});assert.equal(result.claimed,false);assert.equal(s.calls.length,1);});
test('persisted observation resumes without collecting again and stage stays reviewed',async()=>{const s=setup();const r=await runElringJob({db:s.db,organizationId:'org',jobId:'job',process:s.process,readArticle:()=>{throw Error('recrawl');}});assert.equal(r.status,'reviewed');assert.equal(s.saved.at(-1).input_state,'reviewed');assert.equal(s.saved.at(-1).input_advance,true);assert.equal(s.saved[0].input_checkpoint.sealed,true);});
test('expired worker cannot mutate a package',async()=>{const s=setup({lost:true});const r=await runElringJob({db:s.db,organizationId:'org',jobId:'job',process:s.process});assert.equal(r.status,'failed');assert.equal(s.processed,0);assert.ok(!s.calls.includes('stage_command'));});
test('source publication gate blocks worker before canonical processing',async()=>{const s=setup({mode:'publish'});const r=await runElringJob({db:s.db,organizationId:'org',jobId:'job',process:s.process});assert.equal(r.status,'failed');assert.equal(s.processed,0);assert.match(s.saved.at(-1).input_error,/PUBLICATION_NOT_AUTHORIZED/);});

test('Elring defers the leased item on the same upstream budget used by Monroe', async () => {
 const s=setup({observation:null});
 const next='2026-11-27T11:00:00Z',calls=[];
 const rpc=s.db.rpc;
 s.db.rpc=async(name,args)=>{
  calls.push([name,args]);
  if(name==='acquire_catalog_source_request')return {data:{granted:false,retryAt:next,retryAfterMs:45000}};
  return rpc(name,args);
 };
 const result=await runElringJob({db:s.db,organizationId:'org',jobId:'job',
  readArticle:(_code,{fetchImpl})=>fetchImpl('https://example.invalid'),process:s.process});
 assert.equal(result.status,'paused');
 assert.equal(s.processed,0);
 assert.deepEqual(calls.find(([name])=>name==='acquire_catalog_source_request')[1],{input_group:'tecalliance'});
 assert.deepEqual(calls.at(-1),['defer_catalog_elring_source_request',{input_org:'org',input_job:'job',input_token:'token',input_retry_at:next}]);
 assert.equal(s.saved.length,0);
});

test('bounded Elring review saves evidence without invoking the legacy stage or product writer', async () => {
 const fixture=setup({bounded:true,observation:null});
 const result=await runElringJob({db:fixture.db,organizationId:'org',jobId:'job',
  process:()=>{throw Error('writer was called');},
  readArticle:async(code,opts)=>{
   assert.equal(code,'115.100');
   assert.equal(opts.fitmentMaxRequests,6);
   return {fields:{product_code:code},fitment:{complete:false,requests:6,vehicles:[{id:1}],
    evidence:[{request:{getArticleLinkedAllLinkingTarget4:{}},retrieved_at:'2026-11-27T12:00:00Z',response_fingerprint:'abc',response:{}}]}};
  },
 });
 assert.equal(result.status,'reviewed');
 assert.equal(fixture.saved.length,1);
 const checkpoint=fixture.saved[0];
 assert.equal(checkpoint.input_advance,true);
 assert.equal(checkpoint.input_observation.fitment.complete,false);
 assert.deepEqual(checkpoint.input_observation.fitment.evidence,[{
  method:'getArticleLinkedAllLinkingTarget4',retrieved_at:'2026-11-27T12:00:00Z',response_fingerprint:'abc',
 }]);
});

test('a busy queue checkpoint retains the review cursor and uses bounded backoff', async () => {
 const fixture=setup({bounded:true});
 const rpc=fixture.db.rpc;
 fixture.db.rpc=async(name,args)=>{
  if(name==='checkpoint_catalog_elring_job')return {error:{code:'55P03',message:'lock timeout'}};
  if(name==='defer_catalog_elring_lock_wait')return {data:'paused'};
  return rpc(name,args);
 };
 const result=await runElringJob({db:fixture.db,organizationId:'org',jobId:'job'});
 assert.equal(result.status,'paused');
 assert.equal(result.error,'ELRING_REVIEW_DATABASE_BUSY');
 assert.equal(fixture.processed,0);
});
