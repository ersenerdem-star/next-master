import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {parseWilminkProduct,parseWilminkBrandPage,wilminkProductUrl,wilminkPageUrl,readWilminkHtml,safeWilminkObservation,wilminkReview} from '../../netlify/functions/_shared/catalog/wilmink-kolbenschmidt.mjs';
import {safeSupplierOfficialObservation,supplierOfficialProvider} from '../../netlify/functions/_shared/catalog/supplier-official-completion.mts';
import {brandEngineDefinition,assertBrandEngineSource} from '../../netlify/functions/_shared/catalog/brand-engine-registry.mts';
const html=readFileSync(new URL('./fixtures/wilmink-kolbenschmidt-41504600.html',import.meta.url),'utf8'),url='https://www.wilminkengineparts.com/en/piston/wg1380527';
test('real public Kolbenschmidt product binds supplier SKU, manufacturer article and EAN; blank JSON-LD titles never win',()=>{
 const v=parseWilminkProduct(html,{sourceUrl:url,expectedCode:'41 504 600'});assert.equal(v.code,'41504600');assert.equal(v.sourceSku,'WG1380527');assert.equal(v.fields.description,'Piston');assert.equal(v.fields.ean,'4028977841316');assert.equal(v.authority,'distributor');
 assert(v.fields.oem_no.split('; ').includes('04294197'));assert(!v.fields.oem_no.includes('8713690010'));assert.equal(v.fields.vehicle,'DEUTZ-FAHR');assert.deepEqual(v.fields.dimensions,{length_mm:108});
 assert.equal(v.fields.weight_kg,undefined);assert.equal(v.fields.origin,undefined);assert.equal(v.fields.hs_code,undefined);assert.equal(v.fields.market_segment,undefined);assert(v.technicalAttributes.some(([k,x])=>k==='Packaging weight (kg)'&&x==='2,290'));assert(v.imageCandidate.endsWith('/WG1380527/19BFCDC2.JPG'));
 assert.deepEqual(v.lifecycle.checks,{replacement:'unsupported',discontinued:'unsupported'});assert.equal(v.fields.lifecycle_status,undefined);assert.equal(v.fields.price,undefined);
});
test('related products, cross references, other brand, wrong EAN and supplier SKU cannot impersonate the requested article',()=>{
 assert.throws(()=>parseWilminkProduct(html,{sourceUrl:url,expectedCode:'40448601'}),/IDENTITY/);
 for(const changed of [html.replace('"name": "Kolbenschmidt"','"name": "Mahle"'),html.replace('"mpn": "41504600"','"mpn": "OTHER"'),html.replace('"gtin": "4028977841316"','"gtin": "9999999999999"')])assert.throws(()=>parseWilminkProduct(changed,{sourceUrl:url}),/IDENTITY/);
 assert.throws(()=>parseWilminkProduct(html,{sourceUrl:url.replace('1380527','1380528')}),/IDENTITY/);
 const v=parseWilminkProduct(html,{sourceUrl:url});assert.throws(()=>safeSupplierOfficialObservation(v,v.code,'brand'),/SOURCE_INVALID/);assert.equal(supplierOfficialProvider('Kolbenschmidt'),null);
});
test('completion preserves populated values and conflicting EAN; marketplace images do not enter generic patches',()=>{
 const v=parseWilminkProduct(html,{sourceUrl:url}),before={id:'p',description:'Owner description',origin:'TR',hs_code:'001234',ean:v.fields.ean,oem_no:'OLD',weight_kg:9};
 const r=wilminkReview(v,before);assert.equal(r.fields.description,undefined);assert.equal(r.fields.weight_kg,undefined);assert(r.fields.oem_no.startsWith('OLD; '));assert.equal(r.fields.image_url,undefined);
 assert.deepEqual(wilminkReview(v,{...before,ean:'9999999999999'}).fields,{});assert(safeWilminkObservation(v,v.code).fields.ean);
});
test('discovery follows observed same-brand listing URLs and next page only; account/search/foreign URLs are rejected',()=>{
 const card=(brand='Kolbenschmidt',uri='/en/piston/wg1380527')=>`<li class="noscript-product-item"><a href="${uri}"><span class="product-brand">${brand}</span></a></li>`;
 const page=parseWilminkBrandPage(card()+card('Mahle','/en/piston/wg999')+'<a href="en/brands/kolbenschmidt?page=2">2</a><a href="en/brands/kolbenschmidt?page=349">last</a>','https://www.wilminkengineparts.com/en/brands/kolbenschmidt');
 assert.deepEqual(page.urls,[url]);assert(page.nextUrl.endsWith('?page=2'));assert.equal(page.lastPage,349);
 assert.throws(()=>parseWilminkBrandPage(card('Mahle'),page.pageUrl),/EMPTY_OR_INVALID/);
 for(const x of ['https://evil.invalid/en/piston/wg1380527','https://user:secret@www.wilminkengineparts.com/en/piston/wg1380527',url+'?account=1','https://www.wilminkengineparts.com/system/api'])assert.throws(()=>wilminkProductUrl(x));
 for(const x of [page.pageUrl+'?page=0',page.pageUrl+'?keywords=test',page.pageUrl+'?page=2&page=3'])assert.throws(()=>wilminkPageUrl(x));
});
test('bounded anonymous transport stops on 403 and refuses redirects, non-HTML and oversized responses',async()=>{
 let options,waits=0;await assert.rejects(readWilminkHtml(url,{wait:async()=>{waits++;},fetchImpl:async(u,o)=>{options=o;return new Response('blocked',{status:403});}}),/HTTP_403/);assert.equal(waits,1);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.authorization,undefined);
 await assert.rejects(readWilminkHtml(url,{wait:async()=>{},fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json'}})}),/RESPONSE_INVALID/);
 await assert.rejects(readWilminkHtml(url,{wait:async()=>{},fetchImpl:async()=>new Response('a'.repeat(4*1024*1024+1),{headers:{'content-type':'text/html'}})}),/TOO_LARGE/);
});
test('Wilmink is an explicit Kolbenschmidt distributor engine; old official and other brands remain separate',()=>{
 const d=brandEngineDefinition('Kolbenschmidt');assert.equal(d.family,'wilmink_kolbenschmidt');assert.equal(d.authority,'distributor');assert.equal(d.sourceKey,'wilmink_kolbenschmidt_v1');
 assert.throws(()=>assertBrandEngineSource({source_key:'mira_legacy_kolbenschmidt'},'Kolbenschmidt'),/NOT_CONFIGURED/);assert.notEqual(brandEngineDefinition('Mahle').sourceKey,d.sourceKey);
});
