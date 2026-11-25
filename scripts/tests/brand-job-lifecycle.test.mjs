import {test} from 'node:test';import assert from 'node:assert/strict';
import {runBrandJob} from '../../netlify/functions/_shared/catalog/brand-job-worker.mts';
const org='test-org',jobId='test-job';
function fixture(brand='Denso',sourceKey='denso_official_v1',code='DCRI100360',codes=[code],missingCodes=[]){
 const saves=[],job={manifest:{brand,source_key:sourceKey},next_index:0,total_items:codes.length,mode:'stage',lease_token:'lease'};
 const source={source_key:sourceKey,is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,allowed_brands:[brand]}};
 const row={id:'product-id',product_code:code,origin:'TR'};
 let index=0;
 const db={rpc:async(name,args)=>{if(name==='claim_catalog_brand_job')return {data:job};if(name==='checkpoint_catalog_brand_job')saves.push(structuredClone(args));return {data:{}};},from(table){const q={select(){return q;},limit(){return q;},eq(name,value){if(table==='catalog_brand_job_items'&&name==='item_index')index=value;return q;},single:async()=>({data:table==='catalog_external_sources'?source:table==='brands'?{id:'brand-id'}:{product_code:codes[index],observation:null}}),then(resolve){resolve({data:missingCodes.includes(codes[index])?[]:[{...row,product_code:codes[index]}]});}};return q;}};
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
test('one ambiguous or missing catalog article does not stop the next exact brand review',async()=>{
 for(const missing of [false,true]){
  const {db,saves}=fixture('Denso','denso_official_v1','DCRI100360',['DCRI100360','DCRI100510'],missing?['DCRI100360']:[]);let requests=0;
  const result=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async code=>{
   requests++;if(code==='DCRI100360')throw Error('OFFICIAL_EXACT_MATCH_AMBIGUOUS');return {code,sourceUrl:'https://www.denso-am.eu/catalog/part/'+code,fields:{description:'Injector'}};
  }})});
  assert.equal(result.status,'reviewed');const advanced=saves.filter(s=>s.input_advance);assert.deepEqual(advanced.map(s=>s.input_index),[0,1]);
  assert.equal(advanced[0].input_observation.unavailable,missing?'CATALOG_IDENTITY_MISSING_OR_AMBIGUOUS':'OFFICIAL_EXACT_MATCH_AMBIGUOUS');assert.deepEqual(advanced[0].input_observation.fields,{});
  assert.equal(advanced[1].input_observation.fields.description,'Injector');assert.equal(requests,missing?1:2);
 }
});
test('an official access denial stops at the same cursor rather than being mistaken for an article hold',async()=>{
 const {db,saves}=fixture('Denso','denso_official_v1','DCRI100360',['DCRI100360','DCRI100510']);let requests=0;
 const result=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>{requests++;throw Error('DENSO_HTTP_403');}})});
 assert.equal(result.status,'failed');assert.equal(requests,1);assert.equal(saves.at(-1).input_advance,false);assert.equal(saves.at(-1).input_observation,null);
});
test('Knorr brand job records exact Spareto candidates after official evidence without changing official patch',async()=>{
 const {db,saves,source}=fixture('Knorr-Bremse','knorr_bremse_aftermarket','K031740N00');source.metadata.secondary_spareto_read_allowed=true;
 const official={code:'K031740N00',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/K031740N00',fields:{description:'Brake',ean:'4068078109397'}};
 let secondaryCalls=0;
 const r=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>official}),fetchSecondary:async({expectedEan})=>{secondaryCalls++;assert.equal(expectedEan,official.fields.ean);return {brand:'Knorr-Bremse',code:official.code,sourceUrl:'https://spareto.com/products/example',fingerprint:'evidence',observedAt:new Date().toISOString(),exactIdentity:true,fields:{ean:expectedEan,oem_no:'OE-1',vehicle:'DAF',weight_kg:12}};}});
 assert.equal(r.status,'reviewed');const obs=saves[0].input_observation;assert.equal(secondaryCalls,1);assert.deepEqual(obs.secondary.fields,{oem_no:'OE-1',vehicle:'DAF'});assert.equal(obs.secondary.canonicalWrite,false);assert.equal(obs.fields.oem_no,undefined);
});
test('Knorr secondary source failure preserves the official observation',async()=>{
 const {db,saves,source}=fixture('Knorr-Bremse','knorr_bremse_aftermarket','K031740N00');source.metadata.secondary_spareto_read_allowed=true;
 const r=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>({code:'K031740N00',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/K031740N00',fields:{description:'Brake'}})}),fetchSecondary:async()=>{throw Error('SPARETO_HTTP_403');}});
 assert.equal(r.status,'reviewed');assert.equal(saves[0].input_observation.fields.description,'Brake');assert.equal(saves[0].input_observation.secondary.reason,'SPARETO_HTTP_403');
});

test('Knorr secondary stays disabled until source access is verified',async()=>{
 const {db,saves}=fixture('Knorr-Bremse','knorr_bremse_aftermarket','K031740N00');let requests=0;
 const r=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>({code:'K031740N00',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/K031740N00',fields:{description:'Brake'}})}),fetchSecondary:async()=>{requests++;throw Error('unexpected');}});
 assert.equal(r.status,'reviewed');assert.equal(requests,0);assert.equal(saves[0].input_observation.secondary,undefined);
});
test('Knorr background job admits only registered Wilmink evidence and leaves it review-only',async()=>{
 const f=fixture('Knorr-Bremse','knorr_bremse_aftermarket','K031740N00');f.source.metadata.secondary_wilmink_read_allowed=true;
 const original=f.db.from;let helperKey='',catalogId='';
 f.db.from=table=>{
  if(table==='catalog_external_sources')return {select(){return this},eq(k,v){if(k==='source_key')helperKey=v;return this},single:async()=>({data:f.source}),maybeSingle:async()=>({data:{source_key:helperKey,is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,allowed_brands:['Knorr-Bremse']}}})};
  if(table==='catalog_product_source_records')return {select(){return this},eq(k,v){if(k==='catalog_product_id')catalogId=v;return this},order(){return this},limit(){return this},maybeSingle:async()=>({data:{source_url:'https://www.wilminkengineparts.com/en/valve/wg123'}})};
  return original(table);
 };
 let calls=0;const result=await runBrandJob({db:f.db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>({code:'K031740N00',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/K031740N00',fields:{description:'Brake'}})}),fetchWilmink:async input=>{calls++;assert.equal(input.official.authority,'official');assert.equal(catalogId,'product-id');return {status:'review_required',fields:{},canonicalWrite:false}}});
 assert.equal(result.status,'reviewed');assert.equal(calls,1);assert.equal(f.saves[0].input_observation.wilmink.canonicalWrite,false);
});
test('missing Knorr article is staged from exact official identity for guarded creation',async()=>{
 const f=fixture('Knorr-Bremse','knorr_bremse_aftermarket','K031740N00',['K031740N00'],['K031740N00']);
 const r=await runBrandJob({db:f.db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>({code:'K031740N00',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/K031740N00',fields:{description:'Brake',ean:'4068078109397'}})})});
 assert.equal(r.status,'reviewed');const o=f.saves[0].input_observation;assert.equal(o.missingCatalogProduct,true);assert.deepEqual(o.before,{});assert.equal(o.fields.description,'Brake');assert.equal(o.unavailable,undefined);
});
test('published missing Knorr observation dispatches the guarded creation RPC',async()=>{
 const orgId='test-org',id='test-job',calls=[];const source={source_key:'knorr_bremse_aftermarket',is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,brand_engine_enrichment_allowed:true,approval_actor:'owner',publication_approval_reference:'test',allowed_brands:['Knorr-Bremse']}};
 const observation={missingCatalogProduct:true,brand:'Knorr-Bremse',code:'K031740N00',lifecycle:{evidence:{salesStatusCode:'CODE30'}},before:{},fields:{description:'Brake'}};
 const job={manifest:{brand:'Knorr-Bremse',source_key:source.source_key},next_index:0,total_items:1,mode:'publish',lease_token:'lease'};
 const db={rpc:async(name)=>{calls.push(name);return {data:name==='claim_catalog_brand_job'?job:name==='apply_catalog_knorr_create_item'?{status:'created'}:{}}},from(table){const q={select(){return q},eq(){return q},single:async()=>({data:table==='catalog_external_sources'?source:table==='brands'?{id:'brand-id'}:{product_code:'K031740N00',observation}})};return q;}};
 const r=await runBrandJob({db,organizationId:orgId,jobId:id,delayMs:0,providerFactory:()=>({fetch:async()=>{throw Error('must use sealed observation')}})});assert.equal(r.status,'completed');assert(calls.includes('apply_catalog_knorr_create_item'));assert(!calls.includes('apply_catalog_brand_job_item'));
});
test('punctuated Knorr identity never reaches a publication RPC without reviewed mapping',async()=>{
 const calls=[];const source={source_key:'knorr_bremse_aftermarket',is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,brand_engine_enrichment_allowed:true,approval_actor:'owner',publication_approval_reference:'test',allowed_brands:['Knorr-Bremse']}};
 const observation={missingCatalogProduct:true,brand:'Knorr-Bremse',code:'0-0066506-3',identity:{requiresCollisionReview:true},before:{},fields:{}};
 const job={manifest:{brand:'Knorr-Bremse',source_key:source.source_key},next_index:0,total_items:1,mode:'publish',lease_token:'lease'};
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='claim_catalog_brand_job'?job:{}}},from(table){const q={select(){return q},eq(){return q},single:async()=>({data:table==='catalog_external_sources'?source:table==='brands'?{id:'brand-id'}:{product_code:observation.code,observation}})};return q;}};
 const r=await runBrandJob({db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>{throw Error('unexpected')}})});assert.equal(r.status,'completed');assert(!calls.some(c=>c.name==='apply_catalog_knorr_create_item'||c.name==='apply_catalog_brand_job_item'));const save=calls.find(c=>c.name==='checkpoint_catalog_brand_job');assert.equal(save.args.input_checkpoint.reason,'KNORR_CANONICAL_IDENTITY_REVIEW_REQUIRED');
});
test('Knorr recorded source collision is sealed and never published',async()=>{
 const f=fixture('Knorr-Bremse','knorr_bremse_aftermarket','K031740N00');const original=f.db.from;
 f.db.from=table=>{if(table!=='catalog_product_source_records')return original(table);const q={select(){return q},eq(){return q},limit(){return q},then(resolve){resolve({data:[{source_key:'knorr_bremse_aftermarket',source_product_id:'K031740N-00',payload_fingerprint:'a'.repeat(64)}]})}};return q};
 const r=await runBrandJob({db:f.db,organizationId:org,jobId,delayMs:0,providerFactory:()=>({fetch:async()=>({code:'K031740N00',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/K031740N00',fields:{description:'Brake'}})})});assert.equal(r.status,'reviewed');assert.equal(f.saves[0].input_observation.recordedOwnership.status,'collision');
});

test('Monroe verifies lifecycle direction and only an explicit production stop, while staging indicated weight and official images', async () => {
  const {mapMonroeCatalogArticle}=await import('../../netlify/functions/_shared/catalog/tecalliance-sync.mts');
  const image='https://digital-assets.tecalliance.services/images/800/'+'f'.repeat(40)+'.jpg';
  const article={articleNumber:'10024',dataSupplierId:37,mfrName:'MONROE',
    articleCriteria:[{criteriaId:212,criteriaDescription:'Weight [kg]',criteriaUnitDescription:'kg',formattedValue:'3.3'}],
    articleLogisticsCriteria:[{criteriaId:3869,rawValue:'87088035'}],
    images:[{typeKey:1,assetSource:'article',sortNumber:1,imageURL800:'https://foreign.invalid/img.jpg'},
      {typeKey:1,assetSource:'article',sortNumber:2,imageURL800:image}],
    replacesArticles:{values:[{articleNumber:'10023',mfrName:'MONROE'}]},
    replacedByArticles:[{articleNumber:'10025',mfrName:'MONROE'},{articleNumber:'10026',mfrName:'Other'}],
    misc:{articleStatusDescription:'Normal'}};
  const review=mapMonroeCatalogArticle(article,'10024');
  assert.equal(review.imageCandidate,image);
  assert.deepEqual(review.sourceLogistics,{reportedWeightKg:3.3,combinedNomenclature:'87088035'});
  assert.equal(review.fields.weight_kg,null);
  assert.equal(review.lifecycle.checks.discontinued,'no_explicit_signal');
  assert.deepEqual(review.lifecycle.evidence.replacement.relations.map(({old_code,new_code})=>[old_code,new_code]),[['10023','10024'],['10024','10025']]);
  const stopped=mapMonroeCatalogArticle({...article,misc:{articleStatusDescription:'Production discontinued'},
    articleLogisticsCriteria:[...article.articleLogisticsCriteria,{criteriaId:3870,criteriaDescription:'Gross Weight [g]',rawValue:'3550'}]},'10024');
  assert.equal(stopped.lifecycle.checks.discontinued,'found');
  assert.equal(stopped.fields.weight_kg,3.55);
  assert.throws(()=>mapMonroeCatalogArticle({...article,dataSupplierId:10},'10024'),/IDENTITY_INVALID/);
});
