import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {parseWilminkProduct,wilminkReview,wilminkPageUrl,safeWilminkObservation} from '../../netlify/functions/_shared/catalog/wilmink-kolbenschmidt.mjs';
import {brandEngineDefinition,brandEngineForSource,assertBrandEngineSource,matchesBrandEngineJob} from '../../netlify/functions/_shared/catalog/brand-engine-registry.mts';
import {runWilminkDiscovery} from '../../netlify/functions/_shared/catalog/wilmink-discovery-worker.mts';
const fixtures={Elring:['elring','https://www.wilminkengineparts.com/en/shaft-seal-crankshaft/wg1194774','750.330'],INA:['ina','https://www.wilminkengineparts.com/en/water-pump--timing-belt-kit/wg1251435','530020133']};
for(const [brand,[file,url,code]] of Object.entries(fixtures))test(`${brand} exact product metadata remains distributor evidence with no pricing or inferred lifecycle`,()=>{
 const html=readFileSync(new URL(`./fixtures/wilmink-${file}-product.html`,import.meta.url),'utf8');
 const parsed=parseWilminkProduct(html,{sourceUrl:url,expectedBrand:brand,expectedCode:code});assert.equal(parsed.code,code);assert.equal(parsed.sourceKey,`wilmink_${file}_support_v1`);assert(parsed.fields.oem_no);assert(parsed.fields.vehicle);
 for(const key of ['price','buy_price_eur','weight_kg','origin','hs_code','image_url'])assert.equal(parsed.fields[key],undefined);
 assert.deepEqual(parsed.lifecycle.checks,{replacement:'unsupported',discontinued:'unsupported'});
 assert.throws(()=>parseWilminkProduct(html,{sourceUrl:url}),/IDENTITY/);assert.throws(()=>safeWilminkObservation(parsed,code,brand==='INA'?'Elring':'INA'),/IDENTITY/);
 assert.deepEqual(wilminkReview(parsed,{ean:'9999999999999'}).fields,{});
});
test('support is opt-in and cannot replace primary Schaeffler or Elring source, use another brand, or unlock a revoked source',()=>{
 for(const [brand,[file]] of Object.entries(fixtures)){
  const key=`wilmink_${file}_support_v1`,helper=brandEngineForSource(brand,key),primary=brandEngineDefinition(brand);
  assert.notEqual(helper.sourceKey,primary.sourceKey);assert.equal(helper.authority,'distributor');assert(!matchesBrandEngineJob({manifest:{brand,source_key:primary.sourceKey}},helper));
  const source={source_key:key,is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,allowed_brands:[brand]}};
  assert.doesNotThrow(()=>assertBrandEngineSource(source,brand,{sourceKey:key}));assert.throws(()=>assertBrandEngineSource(source,brand));assert.throws(()=>assertBrandEngineSource(source,brand,{sourceKey:key,publish:true}));
  assert.throws(()=>brandEngineForSource(brand,brand==='INA'?'wilmink_elring_support_v1':'wilmink_ina_support_v1'));
 }
 assert.throws(()=>wilminkPageUrl('https://www.wilminkengineparts.com/en/brands/ina','INA'),/PAGE_URL_INVALID/);
 assert.throws(()=>wilminkPageUrl('https://www.wilminkengineparts.com/en/brands/elring?brands-filter=INA','Elring'),/PAGE_URL_INVALID/);
});
test('a missing or wrong-brand product is held while the next exact INA source URL is reviewed',async()=>{
 const [file,url]=fixtures.INA,html=readFileSync(new URL(`./fixtures/wilmink-${file}-product.html`,import.meta.url),'utf8'),bad='https://www.wilminkengineparts.com/en/test/wg999';let cp={},completed;
 const job={id:'job',lease_token:'token',mode:'stage',manifest:{adapter:'wilmink-support-discovery.v1',brand:'INA',source_key:'wilmink_ina_support_v1',urls:[bad,url]}};
 const source={is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{brand_engine_read_allowed:true,allowed_brands:['INA']}};
 const db={rpc:async(name,args)=>{if(name==='checkpoint_catalog_brand_job')cp=structuredClone(args.input_checkpoint);if(name==='complete_catalog_wilmink_support')completed=args;assert.notEqual(name,'apply_catalog_brand_job_item');return {data:{}};},from(table){const q={select(){return q;},eq(){return q;},single:async()=>({data:table==='catalog_external_sources'?source:table==='brands'?{id:'brand'}:{checkpoint:cp}}),then(resolve){resolve({data:[{id:'p',product_code:'530020133',ean:'4005108817549'}]});}};return q;}};
 const result=await runWilminkDiscovery({db,organizationId:'org',job,readHtml:async u=>{if(u===bad)throw Error('WILMINK_HTTP_404');return html;}});
 assert.equal(result.status,'reviewed');assert.equal(completed.input_products[0].unavailable,'WILMINK_HTTP_404');assert.equal(completed.input_products[1].brand,'INA');assert.equal(completed.input_products[1].code,'530020133');assert.equal(cp.captured.length,2);
});
