import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewKnorrWilminkCrossReference,fetchKnorrWilminkReview} from '../../netlify/functions/_shared/catalog/knorr-wilmink-review.mjs';
const url='https://www.wilminkengineparts.com/en/valve/wg123';
const official={authority:'official',brand:'Knorr-Bremse',code:'ABC123',sourceUrl:'https://mytruckservices.knorr-bremse.com/p/ABC123',fingerprint:'a'.repeat(64)};
const html=`<script type="application/ld+json">{"@type":"Product","sku":"WG123","mpn":"DT-123","brand":{"name":"DT Spareparts"},"offers":{"url":"${url}"}}</script>
<vehicle-accordion :manufacturers='[{&quot;name&quot;:&quot;DAF&quot;}]'></vehicle-accordion>
<div id="references"><h3>OE Numbers</h3><span class="search-value">OE-1</span><h3>Cross-references</h3><tr><span data-manufacturer="KNORR-BREMSE"></span><span class="search-value">ABC123</span></tr><tr><span data-manufacturer="OTHER"></span><span class="search-value">FAKE</span></tr></div>`;
test('cross-brand OEM and vehicle references are evidence only and never write catalog fields',()=>{const r=reviewKnorrWilminkCrossReference(html,{sourceUrl:url,code:'ABC123',official});assert.deepEqual(r.evidence,{oemNumbers:['OE-1'],vehicleMakes:['DAF']});assert.deepEqual(r.fields,{});assert.equal(r.canonicalWrite,false);assert.equal(r.status,'review_required');});
test('exact official and exact labelled Knorr identity are required',()=>{for(const opts of [{official:null},{official:{...official,code:'OTHER'}},{official:{...official,sourceUrl:'https://evil.test/p/ABC123'}},{code:'OTHER'}])assert.throws(()=>reviewKnorrWilminkCrossReference(html,{sourceUrl:url,code:'ABC123',official,...opts}));assert.throws(()=>reviewKnorrWilminkCrossReference(html.replace('KNORR-BREMSE','OTHER'),{sourceUrl:url,code:'ABC123',official}),/CROSS_REFERENCE_NOT_FOUND/);});
test('bounded reader hands only explicit source URL to review',async()=>{let n=0;const r=await fetchKnorrWilminkReview({sourceUrl:url,code:'ABC123',official},{readHtml:async source=>{n++;assert.equal(source,url);return html;}});assert.equal(n,1);assert.equal(r.sourceSku,'WG123');});
