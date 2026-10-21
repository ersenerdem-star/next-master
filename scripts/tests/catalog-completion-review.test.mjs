import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogLifecycleReview,planSparetoMissingCompletion} from '../../netlify/functions/_shared/catalog/catalog-completion-review.mjs';
import {mapSparetoSecondaryPage,fetchSparetoSecondaryPage} from '../../netlify/functions/_shared/catalog/spareto-secondary-provider.mjs';
import {extractCurrentLifecycle} from '../../netlify/functions/_shared/catalog/spareto-sync.mts';
import {brandEngineDefinition,brandEngineCapability} from '../../netlify/functions/_shared/catalog/brand-engine-registry.mts';
const url='https://spareto.com/products/sachs-shock-absorber/280-960';
const page=(extra='',alternatives='')=>`<div itemscope='' itemtype='http://schema.org/Product'>
<meta content='4013872371037' itemprop='gtin13'><h1><div itemprop='brand'><meta content='SACHS' itemprop='name'></div><span itemprop='mpn'>280 960</span><span itemprop='name'>Shock Absorber</span></h1>
<table><tr><td>Customs Code</td><td>870880</td></tr><tr><td>Country of Origin</td><td>Mexico</td></tr><tr><td>Weight</td><td>2.138 Kg</td></tr></table>${extra}
<section class='mb-5' id='nav-alternatives'>${alternatives}</section>`;
const read=(html=page())=>mapSparetoSecondaryPage(html,{brand:'Sachs',code:'280960',sourceUrl:url});
const official={authority:'official',brand:'Sachs',code:'280960',sourceUrl:'https://aftermarket.zf.com/en/catalog/',fingerprint:'official-hash',fields:{description:'Official description',ean:'4013872371037'}};
const plan=(options={})=>planSparetoMissingCompletion({brand:'Sachs',code:'280960',official,secondary:read(),...options});

test('missing lifecycle is explicitly unsupported, not active or no replacement',()=>{
 assert.deepEqual(catalogLifecycleReview().checks,{replacement:'unsupported',discontinued:'unsupported'});
 assert.deepEqual(catalogLifecycleReview({}, {unavailable:'SOURCE_403'}).checks,{replacement:'blocked',discontinued:'blocked'});
 for(const status of ['No longer available','No longer deliverable by the manufacturer','0','Replaced'])assert.notEqual(catalogLifecycleReview({sourceStatus:status}).checks.discontinued,'found');
 assert.equal(catalogLifecycleReview({sourceStatus:'Production discontinued'}).checks.discontinued,'found');
 assert.equal(catalogLifecycleReview({replacementCandidates:{replacedBy:['123']}}).checks.replacement,'review_required');
});
test('parsed official relations retain direction and checks independently from discontinued',()=>{
 const lifecycle={checks:{replacement:'found',discontinued:'no_explicit_signal'},evidence:{replacement:{relations:[{old_code:'12',new_code:'34'}]}}};
 const r=catalogLifecycleReview({lifecycle});assert.equal(r.evidence.replacement.relations[0].new_code,'34');assert.equal(r.checks.discontinued,'no_explicit_signal');assert.equal(r.reviewOnly,true);
});
test('exact Spareto primary identity admits explicit fields; alternate lifecycle and unqualified weight are excluded',()=>{
 const r=read(page('', 'Production discontinued. Product has been replaced by: <a href="/products/sachs/999">999</a>'));
 assert.equal(r.fields.origin,'MX');assert.equal(r.fields.hs_code,'870880');assert.equal(r.fields.ean,'4013872371037');assert.equal(r.fields.weight_kg,undefined);assert.equal(r.rawShippingWeight,'2.138 Kg');
 assert.deepEqual(r.lifecycle.checks,{replacement:'no_explicit_signal',discontinued:'no_explicit_signal'});assert.equal(r.canonicalWrite,false);
});
test('brand, product punctuation and missing identity cannot be inferred from a recommendation',()=>{
 for(const html of [page().replace('SACHS','TRW'),page().replace('280 960','280-960'),page().replace("itemprop='mpn'","itemprop='unknown'")])assert.throws(()=>read(html),/IDENTITY/);
 assert.throws(()=>mapSparetoSecondaryPage(page(),{brand:'VAG',code:'280960',sourceUrl:url}),/IDENTITY/);
});
test('secondary availability and successor label stay review-only without manufacturing a discontinued fact',()=>{
 const r=read(page('No longer deliverable by the manufacturer. Product has been replaced by: <strong></strong><a href="/products/sachs/999">999 Shock Absorber</a>'));
 assert.equal(r.lifecycle.checks.discontinued,'review_required');assert.equal(r.lifecycle.checks.replacement,'review_required');assert.equal(r.lifecycle.replacementCandidates[0].targetIdentityVerified,false);
 assert.equal(r.fields.lifecycle_status,undefined);
 for(const wording of ['No longer deliverable by the manufacturer','No longer available'])assert.equal(extractCurrentLifecycle(page(wording),'sachs').discontinued,false);
 assert.equal(extractCurrentLifecycle(page('Production discontinued'),'sachs').discontinued,true);
 assert.equal(extractCurrentLifecycle(page('', 'Production discontinued'),'sachs').discontinued,false);
});
test('Spareto fills only jointly missing fields, with separate source provenance and no canonical write',()=>{
 const r=plan({existing:{origin:'TR',oem_no:'123'}});assert.equal(r.status,'staged_candidate');assert.equal(r.fields.description,undefined);assert.equal(r.fields.origin,undefined);assert.equal(r.fields.ean,undefined);assert.equal(r.fields.hs_code,'870880');assert.equal(r.provenance.hs_code.authority,'secondary');assert.equal(r.provenance.hs_code.sourceUrl,url);assert.equal(r.canonicalWrite,false);
 const both=plan({official:{...official,fields:{...official.fields,hs_code:'009999'}},existing:{hs_code:'001234'}});assert.equal(both.fields.hs_code,undefined);
 assert.deepEqual(r.conflicts.find(c=>c.field==='origin'),{field:'origin',preservedValue:'TR',secondaryValue:'MX',sourceUrl:url});
});
test('existing identifier fields cannot gain arbitrary secondary additions and EAN conflict holds the whole secondary candidate',()=>{
 const secondary=read();secondary.fields.oem_no='WRONG';secondary.fields.vehicle_model='WRONG';
 const r=plan({existing:{oem_no:'123',vehicle_model:'Known model'},secondary});assert.equal(r.fields.oem_no,undefined);assert.equal(r.fields.vehicle_model,undefined);
 const conflict=plan({existing:{ean:'9999999999999'}});assert.deepEqual(conflict.fields,{});assert(conflict.issues.includes('EAN_IDENTITY_CONFLICT'));
});
test('blocked/missing official identity never triggers marketplace promotion',()=>{
 for(const value of [null,{...official,brand:'TRW'},{...official,code:'280-960'},{...official,unavailable:'403'},{...official,authority:'secondary'}])assert(plan({official:value}).issues.includes('EXACT_OFFICIAL_RECEIPT_REQUIRED'));
 const bad=read();bad.code='280-960';assert(plan({secondary:bad}).issues.includes('SECONDARY_IDENTITY_OR_SOURCE_INVALID'));
});
test('fixed-host product URL, response caps and redirects protect the secondary source boundary',async()=>{
 for(const sourceUrl of ['https://evil.example/products/a','https://spareto.com/products/a?brand=x','https://spareto.com/products/a#part','https://spareto.com@evil.example/products/a'])await assert.rejects(fetchSparetoSecondaryPage({sourceUrl}),/URL_INVALID/);
 let init;await fetchSparetoSecondaryPage({brand:'Sachs',code:'280960',sourceUrl:url},{fetchImpl:async(u,i)=>{init=i;return new Response(page());}});assert.equal(init.redirect,'error');assert(init.signal);
 await assert.rejects(fetchSparetoSecondaryPage({sourceUrl:url},{fetchImpl:async()=>new Response('',{status:403})}),/403/);
 await assert.rejects(fetchSparetoSecondaryPage({sourceUrl:url},{fetchImpl:async()=>new Response('',{headers:{'content-length':'5000000'}})}),/TOO_LARGE/);
});
test('VAG has a verified official channel but stays access-required without a reader',()=>{
 const d=brandEngineDefinition('VAG');assert.equal(d.sourceUrl,'https://www.partslink24.com/');assert.equal(d.reader,false);assert.equal(brandEngineCapability(d,null),'authorized_access_required');
});


test('multiple primary GTINs require a known matching barcode; nested review barcodes never enter primary identity',()=>{
 const html=page().replace("<h1>","<meta content='9999999999999' itemprop='gtin13'><h1>");
 const input={brand:'Sachs',code:'280960',sourceUrl:url};
 const unknown=mapSparetoSecondaryPage(html,input);assert.equal(unknown.fields.ean,undefined);assert.equal(unknown.eanCandidates.length,2);
 assert.equal(mapSparetoSecondaryPage(html,{...input,expectedEan:'4013872371037'}).fields.ean,'4013872371037');
 assert.throws(()=>mapSparetoSecondaryPage(html,{...input,expectedEan:'1111111111111'}),/EAN_IDENTITY_CONFLICT/);
 const review=page("<section id='product-reviews'><meta content='8888888888888' itemprop='gtin13'>Production discontinued</section>");
 const r=mapSparetoSecondaryPage(review,input);assert.equal(r.fields.ean,'4013872371037');assert.equal(r.lifecycle.checks.discontinued,'no_explicit_signal');
});
