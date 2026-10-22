import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapSparetoSecondaryPage,findExactSparetoProductUrl,fetchExactSparetoSecondary} from '../../netlify/functions/_shared/catalog/spareto-secondary-provider.mjs';
import {planSparetoReviewedCorrection} from '../../netlify/functions/_shared/catalog/spareto-reviewed-correction.mjs';
import {runClaimedSparetoCorrection} from '../../netlify/functions/_shared/catalog/spareto-correction-worker.mts';
const image='https://cdn.spareto.com/variants/images/001/123/456/original/product.jpg?123456';
const html=({brand='INA',code='712 0360 10',ean='4005108359810',segment='',asset=image}={})=>`<div itemtype='http://schema.org/Product'><meta content='${ean}' itemprop='gtin13'><meta content='${asset}' itemprop='image'><h1><div><meta content='${brand}' itemprop='name'></div><span itemprop='mpn'>${code}</span><span itemprop='name'>Bearing, manual transmission</span></h1><table>${segment?`<tr><td>Vehicle Type</td><td>${segment}</td></tr>`:''}</table><section id='nav-oe'><h3>OE Numbers</h3><a href='/oe/002311125a'>002311125A</a></section><section id='nav-alternatives'><meta content='https://evil.invalid/wrong.jpg' itemprop='image'></section></div>`;
const parse=(options={})=>mapSparetoSecondaryPage(html(options),{brand:'INA',code:'712036010',sourceUrl:'https://spareto.com/products/ina-bearing/712-0360-10',expectedEan:'4005108359810'});
const before={id:'product',ean:'4005108359810',description:'Mounting, manu',oem_no:'002311125',market_segment:'pc',image_url:null,origin:'TR',hs_code:'84824000',weight_kg:.037};
test('owner correction changes the four named fields only, adds OEMs and preserves a missing source segment',()=>{
 const observation=parse(),r=planSparetoReviewedCorrection({brand:'INA',code:'712036010',before,observation});
 assert.deepEqual(r.patch,{description:'Bearing, manual transmission',oem_no:'002311125; 002311125A',image_url:image});
 for(const k of ['origin','weight_kg','hs_code','ean','dimensions','vehicle','lifecycle_status'])assert.equal(r.patch[k],undefined);
 assert.equal(r.segmentStatus,'source_missing');
});
test('segments require an explicit vehicle label and images require primary-product raster evidence',()=>{
 assert.equal(parse({segment:'Commercial vehicles'}).fields.market_segment,'cv');
 const observation=parse({asset:'https://evil.invalid/image.jpg'});assert.equal(observation.imageCandidate,null);
 assert.equal(parse({asset:'https://cdn.spareto.com/variants/images/default.jpg'}).imageCandidate,null);
 assert.equal(parse({asset:'https://cdn.spareto.com/brands/images/ina.jpg'}).imageCandidate,null);
 const commercial=html().replace('<table>','<div data-category="commercial-groups"></div><table>');
 assert.equal(mapSparetoSecondaryPage(commercial,{brand:'INA',code:'712036010',sourceUrl:'https://spareto.com/products/ina-bearing/712-0360-10'}).fields.market_segment,undefined);
});
test('conflicting or unrecorded current EAN holds every correction, including images',()=>{
 for(const eanCandidates of [[],['9999999999999']]){
  const observation={...parse(),eanCandidates};const r=planSparetoReviewedCorrection({brand:'INA',code:'712036010',before,observation});assert.equal(r.status,'held');assert.deepEqual(r.patch,{});
 }
 assert.throws(()=>planSparetoReviewedCorrection({brand:'Vitesco',code:'712036010',before,observation:parse()}),/EXACT_IDENTITY/);
});
const card=(id='search_results_direct',code='622 0662 00')=>`<div data-variant-card-gtm-item-value='{&quot;item_brand&quot;:&quot;LuK&quot;,&quot;item_id&quot;:&quot;${code}&quot;,&quot;item_list_id&quot;:&quot;${id}&quot;}'><a href='/products/luk-clutch-kit/622-0662-00'><span class='brand'>LuK</span><span class='part_number'>${code}</span></a></div>`;
test('a large alternatives section does not reject LuK direct results or supply a fake exact match',()=>{
 const many=Array.from({length:250},()=>card('search_results_alternatives','OTHER')).join('');
 assert.equal(findExactSparetoProductUrl(card()+many,{brand:'LUK',code:'622066200'}),'https://spareto.com/products/luk-clutch-kit/622-0662-00');
 assert.throws(()=>findExactSparetoProductUrl(card('search_results_alternatives'),{brand:'LUK',code:'622066200'}),/NOT_FOUND/);
 assert.throws(()=>findExactSparetoProductUrl(Array.from({length:201},()=>card()).join(''),{brand:'LUK',code:'622066200'}),/BOUND_EXCEEDED/);
});
function workerFixture({busy=false,throwFetch=null,codes=['712036010'],retryAttempts=0}={}){
 const calls=[],job={id:'job',manifest:{source_key:'spareto_schaeffler_correction_v1',adapter:'spareto-reviewed-correction.v1',brand:'INA',brand_id:'brand'},mode:'publish',next_index:0,total_items:codes.length,lease_token:'lease',retry_attempts:retryAttempts};
 let currentIndex=0,sealed=null;
 const db={rpc:async(name,args)=>{calls.push({name,args});if(name==='checkpoint_catalog_brand_job')sealed=args.input_observation;return {data:name==='reserve_catalog_spareto_correction'?!busy:name==='apply_catalog_spareto_correction_item'?(sealed?.unavailable?{status:'held',reason:sealed.unavailable}:{status:'completed',changes:{description:'Bearing'}}):true};},from(table){const q={select(){return q;},eq(name,value){if(table==='catalog_brand_job_items'&&name==='item_index')currentIndex=value;return q;},single:async()=>({data:{product_code:codes[currentIndex],observation:null,checkpoint:{}}}),then(resolve){resolve({data:[{...before,product_code:codes[currentIndex]}]});}};return q;}};
 const fetchSecondary=async({code})=>{calls.push({name:'fetch',code});const error=typeof throwFetch==='function'?throwFetch(code):throwFetch;if(error)throw typeof error==='string'?Error(error):error;return mapSparetoSecondaryPage(html({code}),{brand:'INA',code,sourceUrl:'https://spareto.com/products/ina-bearing/'+code,expectedEan:before.ean});};return {job,db,calls,fetchSecondary};
}
test('correction worker seals evidence before publication and advances only after the application',async()=>{
 const f=workerFixture();const r=await runClaimedSparetoCorrection({...f,organizationId:'org'});assert.equal(r.status,'completed');
 const names=f.calls.map(c=>c.name);assert(names.indexOf('fetch')<names.indexOf('checkpoint_catalog_brand_job'));assert(names.indexOf('checkpoint_catalog_brand_job')<names.indexOf('apply_catalog_spareto_correction_item'));
 assert.equal(f.calls.at(-1).args.input_advance,true);
});
test('busy source transport yields without HTTP and source access blocks never trigger fallbacks',async()=>{
 const busy=workerFixture({busy:true});assert.equal((await runClaimedSparetoCorrection({...busy,organizationId:'org',transportWaitMs:0})).status,'paused');assert(!busy.calls.some(c=>c.name==='fetch'));
 const denied=workerFixture({throwFetch:'SPARETO_HTTP_403'});assert.equal((await runClaimedSparetoCorrection({...denied,organizationId:'org'})).status,'failed');assert.equal(denied.calls.filter(c=>c.name==='fetch').length,1);assert(!denied.calls.some(c=>c.name==='apply_catalog_spareto_correction_item'));
});
test('a queued correction keeps its lease while the previous reader drains, preventing starvation',async()=>{
 const f=workerFixture(),original=f.db.rpc;let attempts=0,waits=0;
 f.db.rpc=async(name,args)=>name==='reserve_catalog_spareto_correction'?{data:++attempts>1}:original(name,args);
 const r=await runClaimedSparetoCorrection({...f,organizationId:'org',wait:async()=>{waits++;}});
 assert.equal(r.status,'completed');assert.equal(waits,1);assert.equal(attempts,2);
 assert(!f.calls.some(c=>c.name==='checkpoint_catalog_brand_job'&&c.args.input_end_status==='paused'));
});
test('an oversized or ambiguous source product is held with evidence while the next exact product continues',async()=>{
 for(const reason of ['SPARETO_RESPONSE_TOO_LARGE','SPARETO_FIELD_AMBIGUOUS']){
  const evidence={requestUrl:'https://spareto.com/products/ina-bearing/712036010',observedAt:'2026-10-22T09:00:00Z'};
  const f=workerFixture({codes:['712036010','712036011'],throwFetch:code=>code==='712036010'?Object.assign(Error(reason),{evidence}):null});
  const r=await runClaimedSparetoCorrection({...f,organizationId:'org'});assert.equal(r.status,'completed');assert.equal(r.processed,2);
  const saved=f.calls.filter(c=>c.name==='checkpoint_catalog_brand_job'&&c.args.input_advance);
  assert.deepEqual(saved.map(c=>c.args.input_index),[0,1]);assert.equal(saved[0].args.input_checkpoint.status,'held');
  assert.equal(saved[0].args.input_observation.unavailable,reason);assert.deepEqual(saved[0].args.input_observation.requestEvidence,evidence);
  assert.equal(saved[1].args.input_checkpoint.status,'completed');assert.equal(f.calls.filter(c=>c.name==='fetch').length,2);
 }
});
test('an interrupted response resumes the same cursor with bounded retries and never applies unsealed data',async()=>{
 for(const [retryAttempts,status]of [[0,'paused'],[4,'failed']]){
  const f=workerFixture({throwFetch:'terminated',retryAttempts}),r=await runClaimedSparetoCorrection({...f,organizationId:'org'});
  assert.equal(r.status,status);assert.equal(f.calls.at(-1).args.input_advance,false);assert.equal(f.calls.at(-1).args.input_end_status,status);
  assert(!f.calls.some(c=>c.name==='apply_catalog_spareto_correction_item'));
 }
});
test('source errors retain the conflicting field or bounded response size without raising the transport cap',async()=>{
 const ambiguous=html().replace('<table>','<table><tr><td>Width</td><td>50 mm</td></tr><tr><td>Width</td><td>60 mm</td></tr>');
 assert.throws(()=>mapSparetoSecondaryPage(ambiguous,{brand:'INA',code:'712036010',sourceUrl:'https://spareto.com/products/ina-bearing/712036010'}),error=>{
  assert.equal(error.message,'SPARETO_FIELD_AMBIGUOUS');assert.equal(error.evidence.fieldLabel,'Width');assert.deepEqual(error.evidence.candidateValues,['50 mm','60 mm']);return true;
 });
 for(const declared of [true,false]){
  let requests=0;
  await assert.rejects(fetchExactSparetoSecondary({brand:'INA',code:'712036010'},{wait:async()=>{},fetchImpl:async()=>{
   requests++;return new Response(new Uint8Array(4*1024*1024+1),{headers:declared?{'content-length':String(4*1024*1024+1)}:{}});
  }}),error=>{assert.equal(error.message,'SPARETO_RESPONSE_TOO_LARGE');assert.equal(error.evidence.maxResponseBytes,4*1024*1024);assert.equal(error.evidence.observedResponseBytes,4*1024*1024+1);assert.match(error.evidence.requestUrl,/keywords=712036010/);return true;});
  assert.equal(requests,1);
 }
});
