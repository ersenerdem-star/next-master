import {test}from'node:test';import assert from'node:assert/strict';import{brandEngineDefinition,assertBrandEngineSource,matchesBrandEngineJob}from'../../netlify/functions/_shared/catalog/brand-engine-registry.mts';import{supplierOfficialProvider}from'../../netlify/functions/_shared/catalog/supplier-official-completion.mts';import{listTecAllianceBrandEntries}from'../../netlify/functions/_shared/catalog/tecalliance-brand-registry.mts';import{brandDispatchSignature,requireBrandDispatch}from'../../netlify/functions/_shared/catalog/brand-dispatch.mts';
test('all mapped families share durable work but keep exact brand/source identity',()=>{
 for(const entry of listTecAllianceBrandEntries())for(const brand of entry.managedBrandNames){const d=brandEngineDefinition(brand);assert.equal(d.sourceKey,entry.preferredProviderKey);assert.equal(d.family,'tecalliance');assert(supplierOfficialProvider(brand));}
 for(const b of ['Denso','Bosch','Mann']){assert.equal(brandEngineDefinition(b).workflow,'brand');assert(supplierOfficialProvider(b));}
 assert.equal(brandEngineDefinition('TRW').workflow,'zf');assert.equal(brandEngineDefinition('TRW Engine Components').reader,false);assert.equal(brandEngineDefinition('Elring').workflow,'elring');assert.equal(brandEngineDefinition('New unsupported brand').reader,false);
});
test('an existing URL, active legacy source or different brand cannot authorize a generic engine',()=>{
 const source={source_key:'denso_official_v1',is_active:true,license_posture:'internal_review_required',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{allowed_brands:['Denso']}};
 assert.throws(()=>assertBrandEngineSource(source,'Denso'));
 source.metadata.brand_engine_read_allowed=true;assert.doesNotThrow(()=>assertBrandEngineSource(source,'Denso'));assert.throws(()=>assertBrandEngineSource(source,'Denso',{publish:true}));assert.throws(()=>assertBrandEngineSource(source,'Bosch'));
});
test('background dispatch is signed for one job, tenant and engine domain',()=>{
 const job=crypto.randomUUID(),org=crypto.randomUUID(),time=String(Date.now()),key='test-key',signature=brandDispatchSignature(key,job,org,time);
 const req=new Request('https://example.invalid',{headers:{'x-catalog-time':time,'x-catalog-signature':signature}});assert.doesNotThrow(()=>requireBrandDispatch(req,key,job,org));assert.throws(()=>requireBrandDispatch(req,key,job,crypto.randomUUID()));
});

test('job actions and report reads stay bound to the selected brand and configured source',()=>{
 const d=brandEngineDefinition('Denso');assert(matchesBrandEngineJob({manifest:{brand:'Denso',source_key:'denso_official_v1'}},d));assert.equal(matchesBrandEngineJob({manifest:{brand:'Bosch',source_key:'mira_legacy_bosch'}},d),false);assert.equal(matchesBrandEngineJob({manifest:{brand:'Denso',source_key:'unreviewed_source'}},d),false);
});
