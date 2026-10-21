import {createHash} from 'node:crypto';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';
import {catalogLifecycleReview} from './catalog-completion-review.mjs';

const text=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
const key=s=>text(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const aliases={febibilstein:'febi',mannfilter:'mann',hengstfilter:'hengst',lemfoerder:'lemforder'};
const brandKey=s=>aliases[key(s)]||key(s);
function productUrl(value){const u=new URL(value);if(u.origin!=='https://spareto.com'||u.username||u.password||u.search||u.hash||!/^\/products\/[a-zA-Z0-9._~%/-]+$/.test(u.pathname))throw Error('SPARETO_PRODUCT_URL_INVALID');return u.href;}
const one=(values,error)=>{const u=[...new Set(values.filter(Boolean))];if(u.length>1)throw Error(error);return u[0]||'';};
function originCode(value){
 if(/^[A-Z]{2}$/.test(value))return value;
 const names=new Intl.DisplayNames(['en'],{type:'region'}),matches=[];
 for(let a=65;a<91;a++)for(let b=65;b<91;b++){const code=String.fromCharCode(a,b);if(key(names.of(code))===key(value)&&names.of(code)!==code)matches.push(code);}
 return matches.length===1?matches[0]:null;
}
export function mapSparetoSecondaryPage(html,{brand,code,sourceUrl}){
 const url=productUrl(sourceUrl);
 // Start at the actual Product scope; recommendations and related cards must
 // never supply the requested identity, fields or lifecycle signal.
 const start=html.search(/<div\b[^>]*itemtype=['"]https?:\/\/schema\.org\/Product['"]/i);
 if(start<0)throw Error('SPARETO_PRODUCT_IDENTITY_MISSING');
 const product=html.slice(start).split(/<section\b[^>]*\bid=['"]nav-alternatives['"]/i)[0];
 const header=product.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||'';
 const sourceBrand=header.match(/<meta\b[^>]*content=['"]([^'"]+)['"][^>]*itemprop=['"]name['"]/i)?.[1];
 const mpn=header.match(/<span\b[^>]*itemprop=['"]mpn['"][^>]*>([\s\S]*?)<\/span>/i)?.[1];
 if(!sourceBrand||brandKey(sourceBrand)!==brandKey(brand)||!mpn||exactCatalogCode(text(mpn))!==exactCatalogCode(code))throw Error('SPARETO_EXACT_IDENTITY_MISMATCH');
 const fields={},description=header.match(/<span\b[^>]*itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/i)?.[1];
 if(description)fields.description=text(description);
 const eans=[...product.matchAll(/<meta\b[^>]*content=['"](\d{8,14})['"][^>]*itemprop=['"]gtin(?:8|12|13|14)?['"]/gi)].map(m=>m[1]);
 const ean=one(eans,'SPARETO_EAN_AMBIGUOUS');if(ean)fields.ean=ean;
 const cells=[...product.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)].map(m=>[text(m[1]),text(m[2])]);
 const property=label=>one(cells.filter(([name])=>name===label).map(([,value])=>value),'SPARETO_FIELD_AMBIGUOUS');
 const tariff=property('Customs Code');if(/^\d{6,12}$/.test(tariff))fields.hs_code=tariff;
 const country=property('Country of Origin'),origin=country&&originCode(country);if(origin)fields.origin=origin;
 // Shipping weight is retained as raw evidence, not guessed to be gross kg.
 const weight=property('Gross Weight').match(/^(\d+(?:[.,]\d+)?)\s*(kg|g)$/i);
 if(weight)fields.weight_kg=Number(weight[1].replace(',','.'))/(weight[2].toLowerCase()==='g'?1000:1);
 const lifecycle=catalogLifecycleReview();
 lifecycle.checks={replacement:'no_explicit_signal',discontinued:'no_explicit_signal'};
 const replacement=product.match(/Product has been replaced by:[\s\S]{0,1500}?<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
 if(replacement){
  lifecycle.checks.replacement='review_required';
  try{lifecycle.replacementCandidates=[{oldCode:text(mpn),targetLabel:text(replacement[2]),targetUrl:productUrl(new URL(replacement[1],url).href),targetIdentityVerified:false}];}catch{lifecycle.reason='SECONDARY_REPLACEMENT_TARGET_INVALID';}
 }
 const availability=text(product).match(/No longer deliverable by the manufacturer|No longer available/i)?.[0];
 if(availability){lifecycle.availabilitySignal=availability;lifecycle.checks.discontinued='review_required';}
 const production=text(product).match(/\b(?:Production discontinued|No longer produced|Production ended)\b/i)?.[0];
 if(production){lifecycle.sourceStatus=production;lifecycle.checks.discontinued='review_required';}
 return {brand,code:exactCatalogCode(code),sourceBrand:text(sourceBrand),sourceUrl:url,exactIdentity:true,fields,lifecycle,
  observedAt:new Date().toISOString(),fingerprint:createHash('sha256').update(html).digest('hex'),rawShippingWeight:property('Weight')||null,canonicalWrite:false};
}
export async function fetchSparetoSecondaryPage(input,{fetchImpl=fetch,timeoutMs=20000}={}){
 const url=productUrl(input.sourceUrl),r=await fetchImpl(url,{redirect:'error',headers:{accept:'text/html'},signal:AbortSignal.timeout(timeoutMs)});
 if(!r.ok)throw Error('SPARETO_HTTP_'+r.status);
 const max=4*1024*1024;if(Number(r.headers.get('content-length')||0)>max)throw Error('SPARETO_RESPONSE_TOO_LARGE');
 const reader=r.body?.getReader();if(!reader)throw Error('SPARETO_RESPONSE_INVALID');
 const chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max)throw Error('SPARETO_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return mapSparetoSecondaryPage(Buffer.concat(chunks).toString('utf8'),input);
}
