import {test} from 'node:test';import assert from 'node:assert/strict';
import {mapDensoArticle,fetchDensoSupplierCatalogFields} from '../../netlify/functions/_shared/catalog/denso-official-provider.mjs';
const article={name:'DCRI100360',title:'Injector Nozzle',ean:'8717613058732',criteria:[{label:'Net Weight [g]',val:'720'},{label:'Gross Weight [g]',val:'920'}],ref_numbers:[{maker:'OPEL',numbers:['5821085']},{maker:'DENSO',numbers:['095000-0366']}],cars:[{title:[{lang_tid:4,val:'OPEL'}],items:[{title:'ASTRA'}]}]};
const payload=a=>({status:'success',data:[a]});
test('DENSO exact identity keeps gross/net units and true OE references separate',()=>{
 const r=mapDensoArticle(payload(article),'DCRI100360');assert.equal(r.fields.weight_kg,.92);assert.equal(r.fields.oem_no,'5821085');assert.equal(r.fields.ean,'8717613058732');assert.equal(r.fields.vehicle_model,'OPEL ASTRA');assert.equal(r.fields.origin,undefined);assert.equal(r.fields.hs_code,undefined);
});
test('DENSO rejects fuzzy matches, punctuation collisions, foreign brand and duplicate exact articles',()=>{
 for(const a of [{...article,name:'DCRI100361'},{...article,name:'DCRI-100360'},{...article,brand:'Bosch'}])assert.throws(()=>mapDensoArticle(payload(a),'DCRI100360'));
 assert.throws(()=>mapDensoArticle({status:'success',data:[article,article]},article.name),/AMBIGUOUS/);
});
test('unknown units, net-only or conflicting gross weights remain unknown; tariff leading zeros survive',()=>{
 for(const criteria of [[{label:'Net Weight [g]',val:'720'}],[{label:'Gross Weight',val:'920'}],[{label:'Gross Weight [kg]',val:'1'},{label:'Gross Weight [kg]',val:'2'}]])assert.equal(mapDensoArticle(payload({...article,criteria}),article.name).fields.weight_kg,undefined);
 const r=mapDensoArticle(payload({...article,criteria:[{label:'HS Code',val:'0012.34'},{label:'Country of Origin',val:'JP'}]}),article.name);assert.equal(r.fields.hs_code,'0012.34');assert.equal(r.fields.origin,'JP');
});
test('DENSO fetch is bounded, official-only and uses the requested exact code',async()=>{
 let target;const r=await fetchDensoSupplierCatalogFields(article.name,20000,async(url,init)=>{target=url;assert.equal(init.redirect,'error');assert(init.signal);return Response.json(payload(article));});assert.equal(new URL(target).hostname,'www.denso-am.eu');assert.equal(r.code,article.name);
 await assert.rejects(fetchDensoSupplierCatalogFields(article.name,20000,async()=>new Response('x',{status:429})),/429/);
});
