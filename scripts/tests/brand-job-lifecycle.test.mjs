import {test} from 'node:test';import assert from 'node:assert/strict';
import {runBrandJob} from '../../netlify/functions/_shared/catalog/brand-job-worker.mts';
const org='test-org',jobId='test-job';
function fixture(brand='Denso',sourceKey='denso_official_v1',code='DCRI100360'){
 const saves=[],job={manifest:{brand,source_key:sourceKey},next_index:0,total_items:1,mode:'stage',lease_token:'lease'};
 const source={source_key:sourceKey,is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,allowed_brands:[brand]}};
 const row={id:'product-id',product_code:code,origin:'TR'};
 const db={rpc:async(name,args)=>{if(name==='claim_catalog_brand_job')return {data:job};if(name==='checkpoint_catalog_brand_job')saves.push(structuredClone(args));return {data:{}};},from(table){const q={select(){return q;},eq(){return q;},single:async()=>({data:table==='catalog_external_sources'?source:table==='brands'?{id:'brand-id'}:{product_code:code,observation:null}}),then(resolve){resolve({data:[row]});}};return q;}};
 return {db,saves,source};
}
test('generic worker seals lifecycle coverage and directional candidates alongside exact official fields',async()=>{
 const {db,saves}=fixture();const result=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>({code:'DCRI100360',sourceUrl:'https://www.denso-am.eu/catalog/part/DCRI100360',fields:{description:'Injector'},lifecycle:{checks:{replacement:'found',discontinued:'no_explicit_signal'},evidence:{replacement:{relations:[{old_code:'DCRI100360',new_code:'DCRI100510'}]}}}})})});
 assert.equal(result.status,'reviewed');assert.equal(saves[0].input_observation.lifecycle.checks.replacement,'found');assert.deepEqual(saves[0].input_observation.replacements,[{code:'DCRI100510',direction:'replaced_by',verified:false}]);assert.equal(saves[0].input_observation.fields.lifecycle_status,undefined);assert.equal(saves[0].input_observation.fields.origin,undefined);
});
test('missing article records blocked lifecycle coverage rather than an empty successful replacement check',async()=>{
 const {db,saves}=fixture();await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>{throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');}})});
 assert.deepEqual(saves[0].input_observation.lifecycle.checks,{replacement:'blocked',discontinued:'blocked'});assert.equal(saves[0].input_observation.unavailable,'OFFICIAL_EXACT_MATCH_NOT_FOUND');
});
test('Schaeffler source admission blocks HTTP execution and preserves its job position until verified',async()=>{
 const {db,saves,source}=fixture('FAG','schaeffler_aftermarket','814000110');source.is_active=false;let requests=0;
 const r=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>{requests++;throw Error('must not fetch');}})});
 assert.equal(requests,0);assert.equal(r.status,'failed');assert.equal(r.error,'SCHAEFFLER_OFFICIAL_SERVER_ACCESS_REQUIRED');assert.equal(saves[0].input_index,0);assert.equal(saves[0].input_advance,false);assert.equal(saves[0].input_observation,null);
});
