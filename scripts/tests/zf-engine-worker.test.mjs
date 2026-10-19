import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertZfSource,collectZfObservation,runZfJob} from '../../netlify/functions/_shared/catalog/zf-job-worker.mjs';
const source={source_key:'zf_group_official_v2',base_url:'https://aftermarket.zf.com',is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{allowed_brands:['Sachs','Boge','TRW','Lemforder','Wabco','ZF'],automated_read_only_approved:true,internal_observation_allowed:true,internal_catalog_correction_allowed:true,approval_actor:'user',publication_approval_reference:'request'}};
const observation={brand:'Sachs',code:'318189',fields:{description:'Correct'},raw:{details:{number:'318189',brandName:'SACHS'}},replacementCandidates:[],before:{id:'product'},replacements:[]};
function setup({mode='stage',claimed=true,lost=false,existing=observation,sourceValue=source}={}){
 const saves=[],calls=[];const db={rpc:async(name,args)=>{calls.push(name);if(name==='claim_catalog_zf_job')return{data:claimed?{next_index:0,total_items:1,mode,lease_token:'token',manifest:{brand:'Sachs'}}:null};
  if(name==='heartbeat_catalog_zf_job'&&lost)return{error:{message:'ZF worker lease lost'}};
  if(name==='checkpoint_catalog_zf_job')saves.push(structuredClone(args));return{data:{status:'completed'}};},from:table=>{
  const value=table==='catalog_external_sources'?sourceValue:table==='brands'?{id:'brand'}:table==='catalog_products'?[{id:'product',product_code:'318189'}]:{product_code:'318189',observation:existing,checkpoint:{}};
  const chain={select:()=>chain,eq:()=>chain,single:async()=>({data:value}),then:(resolve,reject)=>Promise.resolve({data:value}).then(resolve,reject)};return chain;}};
 return{db,saves,calls};
}
test('six brand policy is bounded, internal, separate from other sources and fails closed',()=>{
 for(const brand of source.metadata.allowed_brands)assert.doesNotThrow(()=>assertZfSource(source,brand,{apply:true}));
 for(const altered of [{...source,is_active:false},{...source,source_key:'mira_legacy_zf'},{...source,metadata:{...source.metadata,internal_catalog_correction_allowed:false}}])assert.throws(()=>assertZfSource(altered,'Sachs',{apply:true}));
 assert.throws(()=>assertZfSource(source,'TRW Engine Components'));
});
test('collector verifies every directional target and retains unverified targets for review',async()=>{
 const requests=[];const r=await collectZfObservation({brand:'Sachs',code:'318189',before:{id:'product'},readArticle:async(brand,code)=>{requests.push(code);if(code==='999')throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');return code==='318189'?{...observation,replacementCandidates:[{code:'350038',direction:'replaced_by',brand:null},{code:'999',direction:'replaces',brand:null}]}:{...observation,code,raw:{details:{number:code,brandName:'SACHS'}}};}});
 assert.deepEqual(requests,['318189','350038','999']);assert.equal(r.replacements[0].target.raw.details.number,'350038');assert.equal(r.replacements[1].error,'TARGET_IDENTITY_NOT_VERIFIED');
 await assert.rejects(collectZfObservation({brand:'Sachs',code:'318189',before:{},readArticle:async()=>{throw Error('429 rate limited');}}),/429/);
});
test('duplicate worker does nothing; application reuses immutable observation without recrawl',async()=>{
 const duplicate=setup({claimed:false});assert.equal((await runZfJob({db:duplicate.db,organizationId:'org',jobId:'job'})).claimed,false);assert.equal(duplicate.calls.length,1);
 const s=setup({mode:'publish'});const result=await runZfJob({db:s.db,organizationId:'org',jobId:'job',readArticle:()=>{throw Error('recrawl');}});
 assert.equal(result.status,'completed');assert.ok(s.calls.includes('apply_catalog_zf_job_item'));assert.equal(s.saves[0].input_advance,true);
});
test('lost lease and revoked source prevent canonical writes and preserve retry details',async()=>{
 for(const options of [{lost:true},{sourceValue:{...source,is_active:false}}]){const s=setup({mode:'publish',...options});const r=await runZfJob({db:s.db,organizationId:'org',jobId:'job'});assert.equal(r.status,'failed');assert.ok(!s.calls.includes('apply_catalog_zf_job_item'));assert.match(s.saves.at(-1).input_error,/Sachs \/ 318189:/);}
});
test('source outage saves product-specific checkpoint and never reports success',async()=>{
 const s=setup({existing:null});const r=await runZfJob({db:s.db,organizationId:'org',jobId:'job',requestDelayMs:0,readArticle:async()=>{throw Error('HTTP 503 official source unavailable');}});
 assert.equal(r.status,'failed');assert.equal(s.saves.at(-1).input_advance,false);assert.match(s.saves.at(-1).input_error,/318189.*503/);
});
