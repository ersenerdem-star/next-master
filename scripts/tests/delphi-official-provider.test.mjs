import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {mapDelphiOfficialArticles,fetchDelphiOfficialFields} from '../../netlify/functions/_shared/catalog/delphi-official-provider.mts';
import {safeSupplierOfficialObservation,supplierOfficialProvider} from '../../netlify/functions/_shared/catalog/supplier-official-completion.mts';
import {brandEngineDefinition,assertBrandEngineSource} from '../../netlify/functions/_shared/catalog/brand-engine-registry.mts';
const rows=JSON.parse(readFileSync(new URL('./fixtures/delphi-official-25372484-12B1.json',import.meta.url),'utf8')),code='25372484-12B1';
test('manufacturer-hosted Delphi response retains exact article and conservative official fields',()=>{
 const r=mapDelphiOfficialArticles(rows,code);assert.equal(r.code,code);assert(r.fields.description);assert.equal(r.sourceUrl,'https://www.delphiautoparts.com/de-de/catalogue');
 for(const k of ['price','buy_price','sell_price','origin','hs_code','image_url','lifecycle_status'])assert.equal(r.fields[k],undefined,k);
 assert.equal(supplierOfficialProvider('Delphi').key,'delphi_official_catalog');assert.equal(brandEngineDefinition('Delphi').reader,true);
 assert.equal(safeSupplierOfficialObservation(r,code,'brand').evidence.authority,'official');
});
test('brand, manufacturer id, punctuation, duplicates and response bounds fail closed',()=>{
 for(const data of [[{...rows[0],mfrName:'TRW'}],[{...rows[0],dataSupplierId:90}],[{...rows[0],articleNumber:'2537248412B1'}],[]])assert.throws(()=>mapDelphiOfficialArticles(data,code),/EXACT_MATCH_NOT_FOUND/);
 assert.throws(()=>mapDelphiOfficialArticles([rows[0],rows[0]],code),/EXACT_MATCH_AMBIGUOUS/);assert.throws(()=>mapDelphiOfficialArticles(Array(26).fill(rows[0]),code),/RESPONSE_INVALID/);
});
test('Delphi explicit lifecycle directions are same-manufacturer evidence; unavailable and net weight are not production/gross assertions',()=>{
 const article={...rows[0],misc:{articleStatusDescription:'Production discontinued'},replacedByArticles:[{articleNumber:'25372485-12B1',mfrName:'DELPHI'},{articleNumber:'OTHER123',mfrName:'TRW'}],articleCriteria:[{criteriaDescription:'Weight [kg]',rawValue:'8'}]};
 const r=mapDelphiOfficialArticles([article],code);assert.equal(r.lifecycle.checks.discontinued,'found');assert.equal(r.lifecycle.evidence.replacement.relations.length,1);assert.equal(r.lifecycle.evidence.replacement.relations[0].old_code,code);assert.equal(r.fields.weight_kg,null);
 assert.equal(mapDelphiOfficialArticles([{...article,misc:{articleStatusDescription:'Unavailable'}}],code).lifecycle.checks.discontinued,'no_explicit_signal');
});
test('Delphi reader uses the observed public API contract without cookies or credentials; access failures are not converted to empty articles',async()=>{
 let sent;const r=await fetchDelphiOfficialFields(code,{fetchImpl:async(url,options)=>{sent={url,options};return new Response(JSON.stringify(rows),{headers:{'content-type':'application/json'}});}});
 assert.equal(r.code,code);assert(sent.url.endsWith('/partscatalogapi/v1/emeacatalog/searchpartnumber'));assert.equal(JSON.parse(sent.options.body).Number,code);assert.equal(sent.options.credentials,'omit');assert.equal(sent.options.redirect,'error');assert.equal(sent.options.headers.authorization,undefined);
 await assert.rejects(fetchDelphiOfficialFields(code,{fetchImpl:async()=>new Response('denied',{status:403})}),/DELPHI_HTTP_403/);
 await assert.rejects(fetchDelphiOfficialFields(code,{fetchImpl:async()=>new Response('<html>Gateway</html>',{headers:{'content-type':'text/html'}})}),/RESPONSE_INVALID/);
 const source={source_key:'delphi_official_catalog',is_active:true,license_posture:'allowed',credential_boundary:'none',rate_limit_posture:'bounded',metadata:{allowed_brands:['Delphi'],brand_engine_read_allowed:true,brand_engine_enrichment_allowed:true,approval_actor:'owner',publication_approval_reference:'recovery'}};
 assert.doesNotThrow(()=>assertBrandEngineSource(source,'Delphi',{publish:true}));assert.throws(()=>assertBrandEngineSource({...source,is_active:false},'Delphi',{publish:true}));
});
