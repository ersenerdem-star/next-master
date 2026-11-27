import assert from 'node:assert/strict';
import test from 'node:test';
import {readVagSparetoObservation,validateVagSparetoItem,VAG_SPARETO_SOURCE} from '../../netlify/functions/_shared/catalog/vag-spareto-review.mts';
import {assertBrandEngineSource,brandEngineDefinition} from '../../netlify/functions/_shared/catalog/brand-engine-registry.mts';

const code='WHT000884';
const sourceUrl='https://spareto.com/products/volkswagen-ag-seal-ring/wht-000-884';
const source={source_key:VAG_SPARETO_SOURCE,is_active:true,license_posture:'internal_review_required',robots_posture:'allowed',
 credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,allowed_brands:['VAG'],exact_product_review_only:true}};
const page=(sourceBrand:string,article=code)=>`<div itemtype="https://schema.org/Product"><meta content="4000000000001" itemprop="gtin13">
<h1><meta content="${sourceBrand}" itemprop="name"><span itemprop="mpn">${article}</span><span itemprop="name">Seal ring</span></h1>
<table><tr><td>Customs Code</td><td>401693</td></tr></table><section id="nav-alternatives"></section></div>`;

test('a VAG job accepts only direct Volkswagen AG links for the same code',()=>{
 assert.deepEqual(validateVagSparetoItem(code,sourceUrl),{code,sourceUrl});
 for(const url of [sourceUrl+'?brand=Volkswagen',sourceUrl.replace('spareto.com','spareto.com.example'),
  sourceUrl.replace('volkswagen-ag','audi'),sourceUrl.replace('884','885'),'https://spareto.com/products?brand=Volkswagen'])
  assert.throws(()=>validateVagSparetoItem(code,url),/VAG_SPARETO_ITEM_INVALID/);
});

test('the Spareto lane cannot authorize publication or substitute for the official source',()=>{
 assert.equal(brandEngineDefinition('VAG').sourceKey,'vag_partslink24_authorized');
 assert.doesNotThrow(()=>assertBrandEngineSource(source,'VAG',{sourceKey:VAG_SPARETO_SOURCE}));
 assert.throws(()=>assertBrandEngineSource(source,'VAG',{sourceKey:VAG_SPARETO_SOURCE,publish:true}),/VAG_SPARETO_REVIEW_ONLY/);
 assert.throws(()=>assertBrandEngineSource({...source,robots_posture:'blocked'},'VAG',{sourceKey:VAG_SPARETO_SOURCE}));
});

test('exact brand, code and known EAN are verified without preparing a catalog write',async()=>{
 const data=await readVagSparetoObservation({code,sourceUrl,expectedEan:'4000000000001'},async(url,init)=>{
  assert.equal(url,sourceUrl);
  assert.equal(init?.redirect,'error');
  return new Response(page('Volkswagen AG'));
 });
 assert.equal(data.authority,'secondary');
 assert.equal(data.canonicalWrite,false);
 assert.equal(data.fitmentEvidence.status,'no_vehicle_links');
 assert.deepEqual(data.fields,{});
 assert.equal(data.sourceFields.hs_code,'401693');
 await assert.rejects(readVagSparetoObservation({code,sourceUrl},async()=>new Response(page('Audi'))),/EXACT_IDENTITY_MISMATCH/);
 await assert.rejects(readVagSparetoObservation({code,sourceUrl},async()=>new Response(page('Volkswagen AG','WHT000885'))),/EXACT_IDENTITY_MISMATCH/);
 await assert.rejects(readVagSparetoObservation({code,sourceUrl,expectedEan:'4000000000002'},async()=>new Response(page('Volkswagen AG'))),/EAN_IDENTITY_CONFLICT/);
});

test('the shared brand worker obtains a Spareto permit and records a review receipt',async t=>{
 const {runBrandJob}=await import('../../netlify/functions/_shared/catalog/brand-job-worker.mts');
 const calls:string[]=[];
 const job={lease_token:'lease',mode:'stage',next_index:0,total_items:1,manifest:{
  brand:'VAG',source_key:VAG_SPARETO_SOURCE,adapter:'vag-spareto-exact-review.v1',products:[{code,sourceUrl}],
 }};
 const db={
  from(table:string){
   const rows:Record<string,unknown>={catalog_external_sources:source,brands:{id:'vag'},catalog_brand_job_items:{product_code:code}};
   assert.ok(table in rows,table);
   return {select(){return this;},eq(){return this;},async single(){return {data:rows[table]};}};
  },
  async rpc(name:string,args:Record<string,any>){
   calls.push(name);
   if(name==='claim_catalog_brand_job')return {data:job};
   if(name==='acquire_catalog_source_request'){assert.equal(args.input_group,'spareto');return {data:{granted:true}};}
   if(name==='checkpoint_catalog_brand_job'){
    assert.equal(args.input_state,'reviewed');
    assert.equal(args.input_advance,true);
    assert.equal(args.input_observation.canonicalWrite,false);
   }
   return {data:true};
  },
 };
 t.mock.method(globalThis,'fetch',async(url:string)=>{
  assert.equal(url,sourceUrl);
  assert.equal(calls.at(-1),'acquire_catalog_source_request');
  return new Response(page('Volkswagen AG'));
 });
 const result=await runBrandJob({db,organizationId:'org',jobId:'job',delayMs:0});
 assert.equal(result.status,'reviewed');
 assert.deepEqual(calls,['claim_catalog_brand_job','heartbeat_catalog_brand_job','acquire_catalog_source_request','checkpoint_catalog_brand_job']);
});
