import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapKnorrArticle,fetchKnorrCatalogFields} from '../../netlify/functions/_shared/catalog/knorr-official-provider.mjs';
import {brandOfficialProvider} from '../../netlify/functions/_shared/catalog/brand-official-provider.mts';
import {brandEngineDefinition,assertBrandEngineSource} from '../../netlify/functions/_shared/catalog/brand-engine-registry.mts';
import {safeSupplierOfficialObservation} from '../../netlify/functions/_shared/catalog/supplier-official-completion.mts';
import {catalogReplacementReviewRows} from '../../netlify/functions/_shared/catalog/catalog-completion-review.mjs';
const sample={code:'K031740N00',name:'Spring Brake (S-Cam)',sapEan:'4068078109397',countryOfOrigin:'Mexico',tariffNumber:'84123100',grossWeight:9.4,weightUnit:'KG',dimensionUnit:'MM',dimensionLength:206,dimensionWidth:633,dimensionHeight:239,replacedByProductCode:'K285739N00',salesStatusCode:'CODE40',sapLifecycleStatus:'Y6',hasServiceSolution:{hasSpares:[{target:{code:'KIT'}}]}};
test('official exact product maps bounded technical fields and replacement only',()=>{
 const r=mapKnorrArticle(sample,'K031740N00');assert.deepEqual(r.fields,{description:'Spring Brake (S-Cam)',ean:'4068078109397',hs_code:'84123100',origin:'MX',weight_kg:9.4,dimensions:{length_mm:206,width_mm:633,height_mm:239}});
 const safe=safeSupplierOfficialObservation(r,'K031740N00','brand');assert.deepEqual(catalogReplacementReviewRows(safe.evidence.lifecycle,r.code),[{code:'K285739N00',direction:'replaced_by',verified:false}]);assert.equal(safe.evidence.lifecycle.checks.discontinued,'unsupported');
});
test('identity, unsupported units and unrelated kit data never fabricate a replacement or discontinued status',()=>{
 assert.throws(()=>mapKnorrArticle(sample,'OTHER'),/IDENTITY_INVALID/);assert.throws(()=>mapKnorrArticle(sample,'../unsafe'),/CODE_INVALID/);
 const r=mapKnorrArticle({...sample,replacedByProductCode:'',weightUnit:'LB',dimensionUnit:'IN'},'K031740N00');assert.equal(r.fields.weight_kg,undefined);assert.equal(r.fields.dimensions,undefined);assert.deepEqual(r.lifecycle.evidence.replacement.relations,[]);assert.equal(r.lifecycle.checks.discontinued,'unsupported');
});
test('official reader uses one exact public request, bounded JSON and no credentials',async()=>{
 let call;const r=await fetchKnorrCatalogFields('K031740N00',{fetchImpl:async(url,init)=>{call={url,init};return Response.json(sample);}});assert.equal(new URL(call.url).origin,'https://api-mytruckservices.knorr-bremse.com');assert.equal(call.init.redirect,'error');assert.equal(call.init.credentials,'omit');assert.match(r.sourceFingerprint,/^[a-f0-9]{64}$/);
 await assert.rejects(fetchKnorrCatalogFields('K031740N00',{fetchImpl:async()=>new Response('',{status:403})}),/SERVER_ACCESS_REQUIRED/);
 await assert.rejects(fetchKnorrCatalogFields('K031740N00',{fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'5000000'}})}),/RESPONSE_TOO_LARGE/);
});
test('brand engine requires registered source and separate publication authorization',()=>{
 const def=brandEngineDefinition('Knorr-Bremse');assert.equal(def.sourceKey,'knorr_bremse_aftermarket');assert.equal(brandOfficialProvider('Knorr-Bremse').key,def.sourceKey);
 const source={source_key:def.sourceKey,is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{allowed_brands:['Knorr-Bremse'],brand_engine_read_allowed:true}};
 assert.doesNotThrow(()=>assertBrandEngineSource(source,'Knorr-Bremse'));assert.throws(()=>assertBrandEngineSource(source,'Knorr-Bremse',{publish:true}),/PUBLICATION_NOT_APPROVED/);
});

test('Spareto completion for Knorr is restricted to missing OEM and vehicle fields',async()=>{
 const {planSparetoMissingCompletion}=await import('../../netlify/functions/_shared/catalog/catalog-completion-review.mjs');
 const official={authority:'official',brand:'Knorr-Bremse',code:'K031740N00',fingerprint:'official',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/K031740N00',fields:{ean:'4068078109397'}};
 const secondary={brand:'Knorr-Bremse',code:'K031740N00',sourceUrl:'https://spareto.com/products/example',fingerprint:'secondary',observedAt:new Date().toISOString(),exactIdentity:true,fields:{ean:'4068078109397',description:'secondary description',oem_no:'OE-1',vehicle:'DAF',vehicle_model:'DAF CF',weight_kg:20}};
 const r=planSparetoMissingCompletion({brand:'Knorr-Bremse',code:'K031740N00',existing:{},official,secondary});assert.deepEqual(r.fields,{oem_no:'OE-1',vehicle:'DAF',vehicle_model:'DAF CF'});assert.equal(r.canonicalWrite,false);
});

test('Knorr Spareto search uses the requested brand-filtered link and exact product code',async()=>{
 const {sparetoBrandSearchUrl}=await import('../../netlify/functions/_shared/catalog/spareto-secondary-provider.mjs');
 const u=new URL(sparetoBrandSearchUrl('Knorr-Bremse','K031740N00'));
 assert.equal(u.origin,'https://spareto.com');assert.equal(u.searchParams.get('brand[]'),'Knorr-Bremse');assert.equal(u.searchParams.get('keywords'),'K031740N00');
});
test('punctuated manufacturer article stays exact and is flagged before canonical publication',()=>{
 const r=mapKnorrArticle({...sample,code:'0-0066506-3',replacedByProductCode:''},'0-0066506-3');assert.equal(r.code,'0-0066506-3');assert.equal(r.identity.canonicalCode,'000665063');assert.equal(r.identity.status,'review_required');assert.match(r.sourceUrl,/0-0066506-3$/);assert.throws(()=>mapKnorrArticle({...sample,code:'000665063'},'0-0066506-3'),/IDENTITY_INVALID/);
});
