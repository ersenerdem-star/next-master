import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mapSchaefflerArticle,selectSchaefflerArticle,fetchSchaefflerCatalogFields} from '../../netlify/functions/_shared/catalog/schaeffler-official-provider.mjs';
import {brandOfficialProvider} from '../../netlify/functions/_shared/catalog/brand-official-provider.mts';
import {supplierOfficialProvider,safeSupplierOfficialObservation} from '../../netlify/functions/_shared/catalog/supplier-official-completion.mts';
import {assertBrandEngineSource,brandEngineCapability,brandEngineDefinition} from '../../netlify/functions/_shared/catalog/brand-engine-registry.mts';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/schaeffler-vitesco-571012210.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(fixture.product);
const search=products=>({products,pagination:{currentPage:0,totalResults:products.length}});
const map=(p=copy())=>mapSchaefflerArticle(p,'Vitesco','571012210',{selectedCode:'TA-4319-5710122100',oePayload:fixture.oe});

test('observed Vitesco contract maps exact metadata and scoped OE, excluding net weight and unqualified dimensions',()=>{
 const r=map();assert.equal(r.fields.description,'NOx Sensor, urea injection');assert.equal(r.fields.ean,'4014870798192');assert.equal(r.fields.oem_no,'1932 603; 1936 258; 1973 527; 2006 245; 2236 408; 2293 965');
 for(const field of ['weight_kg','dimensions','origin','hs_code','vehicle','vehicle_model','price','lifecycle_status','image_url'])assert.equal(r.fields[field],undefined,field);
 assert.deepEqual(r.lifecycle.checks,{replacement:'unsupported',discontinued:'no_explicit_signal'});assert(r.diagnostics.includes('NET_WEIGHT_NOT_GROSS'));
 assert.match(r.sourceUrl,/\/p-TA-4319-5710122100$/);
});
test('shared search never substitutes another brand, punctuation-distinct article, ambiguous or truncated result',()=>{
 const p=copy();assert.equal(selectSchaefflerArticle(search([p]),'Vitesco','571 0122 10').code,p.code);
 assert.throws(()=>selectSchaefflerArticle(search([p]),'FAG','571012210'),/EXACT_MATCH_NOT_FOUND/);
 assert.throws(()=>selectSchaefflerArticle(search([p]),'Vitesco','571-0122-10'),/EXACT_MATCH_NOT_FOUND/);
 assert.throws(()=>selectSchaefflerArticle(search([p,p]),'Vitesco','571012210'),/EXACT_MATCH_AMBIGUOUS/);
 const incomplete=search([p]);incomplete.pagination.totalResults=21;assert.throws(()=>selectSchaefflerArticle(incomplete,'Vitesco','571012210'),/SEARCH_INCOMPLETE/);
 for(const alter of [p=>p.brand.name='FAG',p=>p.catalogArticleNumber='571012211',p=>p.code='TA-4319-OTHER',p=>p.url='https://example.invalid/product']){const p=copy();alter(p);assert.throws(()=>map(p),/PRODUCT_IDENTITY_INVALID/);}
});
test('bounded public-browser examples from all four brands retain their own source IDs and article numbers',()=>{
 const observed=[
  {brand:'FAG',article:'814 0001 10',id:'TA-1180-8140001100'},
  {brand:'INA',article:'712 0360 10',id:'TA-4099-7120360100'},
  {brand:'LuK',article:'622 0662 00',id:'TA-479-6220662000'},
  {brand:'Vitesco',article:'571 0122 10',id:'TA-4319-5710122100'},
 ];
 for(const row of observed){const p={code:row.id,brand:{name:row.brand},catalogArticleNumber:row.article};assert.equal(selectSchaefflerArticle(search([p]),row.brand.toUpperCase(),row.article.replaceAll(' ','')).code,row.id);}
});
test('only explicitly qualified gross kg, ISO origin, tariff and numeric mm criteria may complete metadata',()=>{
 const p=copy();p.classifications[0].features.push(...[
  {name:'Gross Weight [g]',featureUnit:{symbol:'g'},featureValues:[{value:'450'}]},
  {name:'Country of Origin',featureValues:[{value:'JP'}]},
  {name:'HS Code',featureValues:[{value:'8409.99'}]},
  {name:'Width [mm]',featureValues:[{value:'12,5'}]},
 ]);
 const r=map(p);assert.equal(r.fields.weight_kg,0.45);assert.equal(r.fields.origin,'JP');assert.equal(r.fields.hs_code,'840999');assert.deepEqual(r.fields.dimensions,{width_mm:12.5});
 p.classifications[0].features.push({name:'Gross Weight [kg]',featureUnit:{symbol:'kg'},featureValues:[{value:'9'}]});assert.equal(map(p).fields.weight_kg,undefined);
});
test('normal, unavailable and unrelated kit relations never manufacture a discontinued assertion or successor',()=>{
 for(const name of ['Normal','Unavailable','Not deliverable']){const p=copy();p.catalogStatus.name=name;p.productReferences=[{referenceType:'CONSISTS_OF',target:{code:'KIT'}}];const r=map(p);assert.equal(r.lifecycle.checks.replacement,'unsupported');assert.equal(r.lifecycle.checks.discontinued,'no_explicit_signal');assert.equal(r.fields.lifecycle_status,undefined);}
 const p=copy();p.catalogStatus.name='Production discontinued';assert.equal(map(p).lifecycle.checks.discontinued,'found');
});
test('shared reader uses three fixed official requests, no credentials, pacing, source hashes and a sealed exact identity',async()=>{
 const calls=[],delays=[],p=copy(),responses=[search([p]),p,fixture.oe];
 const result=await fetchSchaefflerCatalogFields('Vitesco','571012210',{wait:async ms=>{delays.push(ms);},fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json(responses.shift());}});
 assert.equal(calls.length,3);assert.deepEqual(delays,[1100,1100]);
 for(const {url,init}of calls){assert.equal(new URL(url).origin,'https://vehiclelifetimesolutions.schaeffler.com');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.deepEqual(init.headers,{accept:'application/json'});assert(init.signal);}
 assert.match(calls[2].url,/\/TA-4319-5710122100\/oenumbers\?/);assert.match(result.sourceFingerprint,/^[a-f0-9]{64}$/);assert.equal(result.sourceDocuments.length,3);
 const safe=safeSupplierOfficialObservation(result,'571012210','test-brand');assert.equal(safe.evidence.sourceFingerprint,result.sourceFingerprint);assert.equal(safe.evidence.sourceEan,'4014870798192');
});
test('access denials, redirects, invalid responses and limits stop without cookie or token retries',async()=>{
 for(const status of [401,403]){let calls=0;await assert.rejects(fetchSchaefflerCatalogFields('Vitesco','571012210',{fetchImpl:async()=>{calls++;return new Response('Access denied',{status});}}),/SERVER_ACCESS_REQUIRED/);assert.equal(calls,1);}
 await assert.rejects(fetchSchaefflerCatalogFields('Vitesco','571012210',{fetchImpl:async()=>new Response('<html>blocked</html>',{headers:{'content-type':'text/html'}})}),/RESPONSE_INVALID/);
 await assert.rejects(fetchSchaefflerCatalogFields('Vitesco','571012210',{fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'5000000'}})}),/RESPONSE_TOO_LARGE/);
 await assert.rejects(fetchSchaefflerCatalogFields('Vitesco','571012210',{intervalMs:1}),/PACING_REQUIRED/);
 let calls=0;const p=copy();await assert.rejects(fetchSchaefflerCatalogFields('Vitesco','571012210',{wait:async()=>{},fetchImpl:async()=>{calls++;return Response.json(calls===1?search([p]):{...p,brand:{name:'FAG'}});}}),/PRODUCT_IDENTITY_INVALID/);assert.equal(calls,2);
});
test('four shared readers stay behind source verification and cannot silently enter the supplier upload pipeline',()=>{
 for(const brand of ['FAG','INA','LUK','Vitesco']){assert.equal(brandOfficialProvider(brand).key,'schaeffler_aftermarket');assert.equal(supplierOfficialProvider(brand),null);}
 const def=brandEngineDefinition('FAG'),source={source_key:def.sourceKey,is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{allowed_brands:['FAG'],brand_engine_read_allowed:true}};
 assert.equal(def.reader,true);assert.equal(brandEngineCapability(def,source),'server_access_required');assert.throws(()=>assertBrandEngineSource(source,'FAG'),/SERVER_ACCESS_REQUIRED/);
 source.metadata.server_access_verified=true;assert.doesNotThrow(()=>assertBrandEngineSource(source,'FAG'));assert.equal(brandEngineCapability(def,source),'ready');
 assert.throws(()=>assertBrandEngineSource(source,'FAG',{publish:true}),/PUBLICATION_NOT_APPROVED/);
});
