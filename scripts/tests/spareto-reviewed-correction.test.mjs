import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapSparetoSecondaryPage,findExactSparetoProductUrl} from '../../netlify/functions/_shared/catalog/spareto-secondary-provider.mjs';
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
function workerFixture({busy=false,throwFetch=null}={}){
 const calls=[],job={id:'job',manifest:{source_key:'spareto_schaeffler_correction_v1',adapter:'spareto-reviewed-correction.v1',brand:'INA',brand_id:'brand'},mode:'publish',next_index:0,total_items:1,lease_token:'lease'};
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='reserve_catalog_spareto_correction'?!busy:name==='apply_catalog_spareto_correction_item'?{status:'completed',changes:{description:'Bearing'}}:true};},from(table){const q={select(){return q;},eq(){return q;},single:async()=>({data:{product_code:'712036010',observation:null,checkpoint:{}}}),then(resolve){resolve({data:[{...before,product_code:'712036010'}]});}};return q;}};
 const fetchSecondary=async()=>{calls.push({name:'fetch'});if(throwFetch)throw Error(throwFetch);return parse();};return {job,db,calls,fetchSecondary};
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
