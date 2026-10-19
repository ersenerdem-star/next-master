import test from 'node:test';
import assert from 'node:assert/strict';
import {runElringJob} from '../../netlify/functions/_shared/catalog/elring-job-worker.mjs';
const source={source_key:'tecalliance_elring',base_url:'https://web.tecalliance.net/elring/en/home',is_active:true,license_posture:'allowed',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{allowed_brands:['Elring'],automated_read_only_approved:true,internal_observation_allowed:true}};
function setup({claimed=true,observation={fields:{product_code:'115.100'}},lost=false,mode='stage'}={}){
 const calls=[];const saved=[];let processed=0;
 const db={rpc:async(name,args)=>{calls.push(name);if(name==='claim_catalog_elring_job')return{data:claimed?{id:'job',next_index:0,total_items:1,mode,lease_token:'token',manifest:{segment:'pc',fitment_max_requests:128}}:null};
   if(name==='heartbeat_catalog_elring_job'&&lost)return{error:{message:'Elring worker lease lost'}};
   if(name==='checkpoint_catalog_elring_job')saved.push(structuredClone(args));return{data:true};},
  from:table=>{const data=table==='catalog_external_sources'?source:table==='brands'?{id:'brand'}:{product_code:'115.100',observation,checkpoint:{}};
   const chain={select:()=>chain,eq:()=>chain,single:async()=>({data})};return chain;}};
 return{db,calls,saved,process:async({db,checkpoint,save})=>{await db.rpc('stage_command',{});processed++;checkpoint.sealed=true;await save();},get processed(){return processed;}};
}
test('duplicate invocation does no source reads or writes',async()=>{const s=setup({claimed:false});const result=await runElringJob({db:s.db,organizationId:'org',jobId:'job',readArticle:()=>{throw Error('unexpected');}});assert.equal(result.claimed,false);assert.equal(s.calls.length,1);});
test('persisted observation resumes without collecting again and stage stays reviewed',async()=>{const s=setup();const r=await runElringJob({db:s.db,organizationId:'org',jobId:'job',process:s.process,readArticle:()=>{throw Error('recrawl');}});assert.equal(r.status,'reviewed');assert.equal(s.saved.at(-1).input_state,'reviewed');assert.equal(s.saved.at(-1).input_advance,true);assert.equal(s.saved[0].input_checkpoint.sealed,true);});
test('expired worker cannot mutate a package',async()=>{const s=setup({lost:true});const r=await runElringJob({db:s.db,organizationId:'org',jobId:'job',process:s.process});assert.equal(r.status,'failed');assert.equal(s.processed,0);assert.ok(!s.calls.includes('stage_command'));});
test('source publication gate blocks worker before canonical processing',async()=>{const s=setup({mode:'publish'});const r=await runElringJob({db:s.db,organizationId:'org',jobId:'job',process:s.process});assert.equal(r.status,'failed');assert.equal(s.processed,0);assert.match(s.saved.at(-1).input_error,/PUBLICATION_NOT_AUTHORIZED/);});
