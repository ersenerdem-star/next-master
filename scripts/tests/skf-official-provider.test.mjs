import {test} from 'node:test';import assert from 'node:assert/strict';
import {mapSkfOfficialPage,fetchSkfSupplierCatalogFields} from '../../netlify/functions/_shared/catalog/skf-official-provider.mjs';
const url='https://automotive.skf.com/eur/en/product-catalogue/VKBA906';
const article={"@type":"Product",sku:'VKBA906',name:'VKBA 906',url,brand:{name:'SKF'},description:'Product-specific description',additionalProperty:[{name:'Width',value:'37 mm'},{name:'Inner Diameter',value:'35 mm'},{name:'Weight',value:'0.62 kg'}]};
const breadcrumb={"@type":"BreadcrumbList",itemListElement:[{name:'Wheel Bearing Kit',item:'https://automotive.skf.com/eur/en/product-catalogue?type=kit'},{name:'VKBA 906',item:url}]};
const page=(...items)=>items.map(x=>'<script type="application/ld+json">'+JSON.stringify(x)+'</script>').join('');
test('SKF source-bound exact article and breadcrumb type produce measured dimensions, not inferred weight or origin',()=>{
 const r=mapSkfOfficialPage(page(article,breadcrumb),'VKBA 906');assert.equal(r.code,'VKBA906');assert.equal(r.fields.description,'Wheel Bearing Kit');assert.deepEqual(r.fields.dimensions,{width_mm:37,inner_diameter_mm:35});
 for(const field of ['weight_kg','origin','hs_code','ean','oem_no','vehicle','vehicle_model','market_segment'])assert.equal(r.fields[field],undefined);
});
test('only an exact SKF product on the same official article page is admitted',()=>{
 for(const p of [{...article,sku:'VKBA-906'},{...article,brand:{name:'FAG'}},{...article,url:'https://spareto.com/eur/en/product-catalogue/VKBA906'},{...article,url:url+'?different=1'},{...article,url:url.replace('906','907')},{...article,name:'VKBA907'}])assert.throws(()=>mapSkfOfficialPage(page(p),'VKBA906'));
 assert.throws(()=>mapSkfOfficialPage(page(article,article),'VKBA906'),/AMBIGUOUS/);
 assert.throws(()=>mapSkfOfficialPage(page({'@type':'Organization',name:'SKF'}),'VKBA906'),/NOT_FOUND/);
});
test('graph JSON and product-bound evidence are accepted; unrelated breadcrumbs cannot replace a description',()=>{
 const unrelated={...breadcrumb,itemListElement:[{name:'Wrong type'},{name:'VKBA907',item:url.replace('906','907')}]};
 const r=mapSkfOfficialPage(page({'@graph':[article,unrelated]}),'VKBA906');assert.equal(r.fields.description,'Product-specific description');
 assert.throws(()=>mapSkfOfficialPage('<script type="application/ld+json">{bad}</script>','VKBA906'),/RESPONSE_INVALID/);
});
test('only explicit consistent gross weights with units, ISO origin and literal tariff fields qualify',()=>{
 const p={...article,gtin13:'7316575793906',countryOfOrigin:'DE',additionalProperty:[{name:'Gross Weight',value:'620 g'},{name:'Gross Weight [kg]',value:'0.62'},{name:'HS Code',value:'0087.08.80'}]};
 const r=mapSkfOfficialPage(page(p),'VKBA906');assert.equal(r.fields.weight_kg,.62);assert.equal(r.fields.origin,'DE');assert.equal(r.fields.hs_code,'0087.08.80');assert.equal(r.fields.ean,'7316575793906');
 for(const additionalProperty of [[{name:'Net Weight',value:'2 kg'}],[{name:'Gross Weight',value:'2'}],[{name:'Gross Weight',value:'2 kg'},{name:'Gross Weight',value:'3 kg'}]])assert.equal(mapSkfOfficialPage(page({...p,additionalProperty}),'VKBA906').fields.weight_kg,undefined);
 assert.throws(()=>mapSkfOfficialPage(page({...p,gtin14:'99999999999999'}),'VKBA906'),/EAN_AMBIGUOUS/);
});
test('SKF fetch has a fixed official host, bound response size and explicit unsupported product-domain outcome',async()=>{
 let request;const r=await fetchSkfSupplierCatalogFields('VKBA 906',20000,async(u,init)=>{request={u,init};return new Response(page(article));});assert.equal(r.code,'VKBA906');assert.equal(request.u,url);assert.equal(request.init.redirect,'error');assert(request.init.signal);
 await assert.rejects(fetchSkfSupplierCatalogFields('1201 ETN9 /SKF/',20000,async()=>{throw Error('must not fetch');}),/OFFICIAL_PRODUCT_DOMAIN_UNSUPPORTED/);
 await assert.rejects(fetchSkfSupplierCatalogFields('VKBA906',20000,async()=>new Response('',{status:404})),/NOT_FOUND/);
 await assert.rejects(fetchSkfSupplierCatalogFields('VKBA906',20000,async()=>new Response('',{status:403})),/403/);
 await assert.rejects(fetchSkfSupplierCatalogFields('VKBA906',20000,async()=>new Response('',{headers:{'content-length':String(5*1024*1024)}})),/TOO_LARGE/);
});
