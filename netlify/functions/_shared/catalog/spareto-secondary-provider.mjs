import {createHash} from 'node:crypto';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';
import {catalogLifecycleReview} from './catalog-completion-review.mjs';

const text=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
const key=s=>text(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const aliases={febibilstein:'febi',mannfilter:'mann',hengstfilter:'hengst',lemfoerder:'lemforder',schaefflerfag:'fag',schaefflerina:'ina',schaefflerluk:'luk',trwenginecomponent:'trwenginecomponents'};
const brandKey=s=>aliases[key(s)]||key(s);
function productUrl(value){const u=new URL(value);if(u.origin!=='https://spareto.com'||u.username||u.password||u.search||u.hash||!/^\/products\/[a-zA-Z0-9._~%/-]+$/.test(u.pathname))throw Error('SPARETO_PRODUCT_URL_INVALID');return u.href;}
const one=(values,error)=>{const u=[...new Set(values.filter(Boolean))];if(u.length>1)throw Error(error);return u[0]||'';};
function originCode(value){
 if(/^[A-Z]{2}$/.test(value))return value;
 const names=new Intl.DisplayNames(['en'],{type:'region'}),matches=[];
 for(let a=65;a<91;a++)for(let b=65;b<91;b++){const code=String.fromCharCode(a,b);if(key(names.of(code))===key(value)&&names.of(code)!==code)matches.push(code);}
 return matches.length===1?matches[0]:null;
}
export function mapSparetoSecondaryPage(html,{brand,code,sourceUrl,expectedEan}){
 const url=productUrl(sourceUrl);
 // Start at the actual Product scope; recommendations and related cards must
 // never supply the requested identity, fields or lifecycle signal.
 const start=html.search(/<div\b[^>]*itemtype=['"]https?:\/\/schema\.org\/Product['"]/i);
 if(start<0)throw Error('SPARETO_PRODUCT_IDENTITY_MISSING');
 const parts=html.slice(start).split(/<section\b[^>]*\bid=['"]nav-alternatives['"]/i);
 if(parts.length<2)throw Error('SPARETO_PRODUCT_BOUNDARY_MISSING');
 const product=parts[0];
 const main=product.split(/<section\b[^>]*\bid=['"](?:product-reviews|nav-oe|nav-vehicles)['"]/i)[0];
 const header=product.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||'';
 const sourceBrand=header.match(/<meta\b[^>]*content=['"]([^'"]+)['"][^>]*itemprop=['"]name['"]/i)?.[1];
 const mpn=header.match(/<span\b[^>]*itemprop=['"]mpn['"][^>]*>([\s\S]*?)<\/span>/i)?.[1];
 if(!sourceBrand||brandKey(sourceBrand)!==brandKey(brand)||!mpn||exactCatalogCode(text(mpn))!==exactCatalogCode(code))throw Error('SPARETO_EXACT_IDENTITY_MISMATCH');
 const fields={},description=header.match(/<span\b[^>]*itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/i)?.[1];
 if(description)fields.description=text(description);
 const identityPrefix=main.slice(0,main.search(/<h1\b/i));
 const eans=[...identityPrefix.matchAll(/<meta\b[^>]*content=['"](\d{8,14})['"][^>]*itemprop=['"]gtin(?:8|12|13|14)?['"]/gi)].map(m=>m[1]);
 const eanCandidates=[...new Set(eans)],knownEan=String(expectedEan??'').replace(/\s+/g,'');
 if(knownEan&&eanCandidates.length&&!eanCandidates.includes(knownEan))throw Error('SPARETO_EAN_IDENTITY_CONFLICT');
 const ean=knownEan&&eanCandidates.includes(knownEan)?knownEan:eanCandidates.length===1?eanCandidates[0]:null;
 if(ean)fields.ean=ean;
 const cells=[...main.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)].map(m=>[text(m[1]),text(m[2])]);
 const property=label=>{const values=cells.filter(([name])=>name===label).map(([,value])=>value);try{return one(values,'SPARETO_FIELD_AMBIGUOUS');}catch(error){error.evidence={requestUrl:url,fieldLabel:label,candidateValues:[...new Set(values)],observedAt:new Date().toISOString()};throw error;}};
 const tariff=property('Customs Code');if(/^\d{6,12}$/.test(tariff))fields.hs_code=tariff;
 // Only a labelled vehicle class can establish a segment. Product-category
 // slugs such as commercial-groups do not mean commercial vehicles.
 const segmentNames={'passenger cars':'pc','passenger car':'pc','commercial vehicles':'cv','commercial vehicle':'cv','light commercial vehicles':'lcv','motorcycles':'motorcycle','off-highway':'off_highway'};
 const segments=[...new Set(cells.filter(([name])=>['Market Segment','Vehicle Type','Vehicle Class'].includes(name)).map(([,v])=>segmentNames[v.toLowerCase()]).filter(Boolean))];
 if(segments.length===1)fields.market_segment=segments[0];
 const country=property('Country of Origin'),origin=country&&originCode(country);if(origin)fields.origin=origin;
 const dimensions={};
 for(const [label,name]of Object.entries({'Width':'width_mm','Height':'height_mm','Length':'length_mm','Inner Diameter':'inner_diameter_mm','Outer Diameter':'outer_diameter_mm'})){
  const v=property(label).match(/^(\d+(?:[.,]\d+)?)\s*mm$/i);if(v)dimensions[name]=Number(v[1].replace(',','.'));
 }
 if(Object.keys(dimensions).length)fields.dimensions=dimensions;
 const oe=product.match(/<h3\b[^>]*>\s*OE Numbers\s*<\/h3>([\s\S]*?)(?:<h3\b|<\/section>)/i)?.[1]||'';
 const numbers=[...oe.matchAll(/<a\b[^>]*href=['"]\/oe\/[^'"]+['"][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>text(m[1]));
 if(numbers.length&&numbers.length<500)fields.oem_no=[...new Map(numbers.map(n=>[exactCatalogCode(n),n])).values()].join('; ');
 const vehicles=product.match(/<section\b[^>]*\bid=['"]nav-vehicles['"][^>]*>([\s\S]*?)<\/section>/i)?.[1]||'';
 const makes=[],models=[];
 for(const block of vehicles.split(/<div\b[^>]*data-controller=['"]collapse['"][^>]*>/i).slice(1)){
  const make=text(block.match(/<div\b[^>]*style=['"][^'"]*font-weight:\s*bold[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  if(!make)continue;
  for(const frame of block.matchAll(/<turbo-frame\b[^>]*src=['"]([^'"]+)['"]/gi)){
   const fit=new URL(text(frame[1]),url),model=fit.searchParams.get('model_name');
   if(fit.origin==='https://spareto.com'&&fit.pathname===new URL(url).pathname+'/fitment'&&model&&model.length<100){makes.push(make);models.push(make+' '+model);}
  }
 }
 if(makes.length)fields.vehicle=[...new Set(makes)].join('; ');
 if(models.length)fields.vehicle_model=[...new Set(models)].join('; ');
 // Shipping weight is retained as raw evidence, not guessed to be gross kg.
 const weight=property('Gross Weight').match(/^(\d+(?:[.,]\d+)?)\s*(kg|g)$/i);
 if(weight)fields.weight_kg=Number(weight[1].replace(',','.'))/(weight[2].toLowerCase()==='g'?1000:1);
 const lifecycle=catalogLifecycleReview();
 lifecycle.checks={replacement:'no_explicit_signal',discontinued:'no_explicit_signal'};
 const replacement=main.match(/Product has been replaced by:[\s\S]{0,1500}?<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
 if(replacement){
  lifecycle.checks.replacement='review_required';
  try{lifecycle.replacementCandidates=[{oldCode:text(mpn),targetLabel:text(replacement[2]),targetUrl:productUrl(new URL(replacement[1],url).href),targetIdentityVerified:false}];}catch{lifecycle.reason='SECONDARY_REPLACEMENT_TARGET_INVALID';}
 }
 const availability=text(main).match(/No longer deliverable by the manufacturer|No longer available/i)?.[0];
 if(availability){lifecycle.availabilitySignal=availability;lifecycle.checks.discontinued='review_required';}
 const production=text(main).match(/\b(?:Production discontinued|No longer produced|Production ended)\b/i)?.[0];
 if(production){lifecycle.sourceStatus=production;lifecycle.checks.discontinued='review_required';}
 const rawShippingWeights=[...new Set(cells.filter(([name])=>name==='Weight').map(([,value])=>value))];
 const images=[...identityPrefix.matchAll(/<meta\b[^>]*content=['"]([^'"]+)['"][^>]*itemprop=['"]image['"]/gi)].map(m=>text(m[1]));
 const primaryImages=[...new Set(images.filter(v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.hostname==='cdn.spareto.com'&&!u.username&&!u.password&&!u.port&&!u.hash&&/^\/variants\/images\/[A-Za-z0-9/_-]+\.(?:jpe?g|png|webp)$/i.test(u.pathname)&&!/(placeholder|no[-_]?image|default)/i.test(u.pathname);}catch{return false;}}))];
 // Image evidence remains outside CATALOG_FIELDS and the missing-only planner.
 // Only the separately owner-approved correction workflow may publish it.
 return {brand,code:exactCatalogCode(code),sourceBrand:text(sourceBrand),sourceUrl:url,exactIdentity:true,fields,lifecycle,
  imageCandidate:primaryImages.length===1?primaryImages[0]:null,imageEvidence:{scope:'primary_product_meta',candidates:primaryImages},
  segmentEvidence:{status:segments.length===1?'explicit_vehicle_class':segments.length>1?'ambiguous':'source_missing'},
  eanCandidates,observedAt:new Date().toISOString(),fingerprint:createHash('sha256').update(html).digest('hex'),rawShippingWeight:rawShippingWeights.length===1?rawShippingWeights[0]:null,rawShippingWeights,fitmentScope:'page_model_summary',canonicalWrite:false};
}
async function fetchHtml(url,{fetchImpl=fetch,timeoutMs=20000}={}){
 let r;try{r=await fetchImpl(url,{redirect:'error',headers:{accept:'text/html'},signal:AbortSignal.timeout(timeoutMs)});}catch(error){error.evidence={requestUrl:url,observedAt:new Date().toISOString()};throw error;}
 if(!r.ok)throw Object.assign(Error('SPARETO_HTTP_'+r.status),{evidence:{requestUrl:url,httpStatus:r.status,observedAt:new Date().toISOString()}});
 const max=4*1024*1024;
 const oversized=bytes=>Object.assign(Error('SPARETO_RESPONSE_TOO_LARGE'),{evidence:{requestUrl:url,maxResponseBytes:max,observedResponseBytes:bytes,observedAt:new Date().toISOString()}});
 if(Number(r.headers.get('content-length')||0)>max){await r.body?.cancel().catch(()=>{});throw oversized(Number(r.headers.get('content-length')));}
 const reader=r.body?.getReader();if(!reader)throw Error('SPARETO_RESPONSE_INVALID');
 const chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max)throw oversized(length);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks).toString('utf8');
}
export async function fetchSparetoSecondaryPage(input,options={}){return mapSparetoSecondaryPage(await fetchHtml(productUrl(input.sourceUrl),options),input);}

export function findExactSparetoProductUrl(html,{brand,code}){
 const cards=[...html.matchAll(/<div\b[^>]*data-variant-card-gtm-item-value=['"]([^'"]+)['"][^>]*>/gi)],urls=[];
 if(cards.length>4096)throw Error('SPARETO_SEARCH_BOUND_EXCEEDED');
 let directCards=0;
 for(let i=0;i<cards.length;i++){
  let item;try{item=JSON.parse(text(cards[i][1]));}catch{throw Error('SPARETO_SEARCH_SCHEMA_CHANGED');}
  if(item.item_list_id&&item.item_list_id!=='search_results_direct')continue;
  if(++directCards>200)throw Error('SPARETO_SEARCH_BOUND_EXCEEDED');
  if(brandKey(item.item_brand)!==brandKey(brand)||exactCatalogCode(item.item_id)!==exactCatalogCode(code))continue;
  const body=html.slice(cards[i].index+cards[i][0].length,cards[i+1]?.index??html.length);
  const visibleBrand=text(body.match(/<span\b[^>]*class=['"]brand['"][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
  const visibleCode=text(body.match(/<span\b[^>]*class=['"]part_number['"][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
  if(brandKey(visibleBrand)!==brandKey(brand)||exactCatalogCode(visibleCode)!==exactCatalogCode(code))continue;
  const href=body.match(/<a\b[^>]*href=['"]([^'"#?]+)['"]/i)?.[1];
  if(href)urls.push(productUrl(new URL(href,'https://spareto.com').href));
 }
 const unique=[...new Set(urls)];if(!unique.length)throw Error('SPARETO_EXACT_MATCH_NOT_FOUND');if(unique.length!==1)throw Error('SPARETO_EXACT_MATCH_AMBIGUOUS');return unique[0];
}
export async function fetchExactSparetoSecondary({brand,code,expectedEan},{fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),delayMs=1100}={}){
 const exact=exactCatalogCode(code);if(!exact||exact.length>100||/[\x00-\x1f]/.test(String(code)))throw Error('SPARETO_CODE_INVALID');
 const search=new URL('https://spareto.com/products');search.searchParams.set('keywords',String(code));
 await wait(Math.max(1100,delayMs));const html=await fetchHtml(search.href,{fetchImpl});
 let sourceUrl;try{sourceUrl=findExactSparetoProductUrl(html,{brand,code});}catch(error){
  error.evidence={requestUrl:search.href,searchUrl:search.href,searchFingerprint:createHash('sha256').update(html).digest('hex'),observedAt:new Date().toISOString()};throw error;
 }
 await wait(Math.max(1100,delayMs));
 const result=await fetchSparetoSecondaryPage({brand,code,sourceUrl,expectedEan},{fetchImpl});
 return {...result,searchUrl:search.href,searchFingerprint:createHash('sha256').update(html).digest('hex')};
}
