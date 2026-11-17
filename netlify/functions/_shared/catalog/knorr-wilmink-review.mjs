import {createHash} from 'node:crypto';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';
import {wilminkProductUrl,readWilminkHtml} from './wilmink-kolbenschmidt.mjs';

const decode=s=>String(s??'').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const unique=a=>[...new Set(a.filter(Boolean))];
// A cross-reference on a distributor's different brand is a lead only. It
// cannot prove identical fitment, replacement direction, or manufacturer EAN.
export function reviewKnorrWilminkCrossReference(html,{sourceUrl,code,official}={}){
 const url=wilminkProductUrl(sourceUrl),wanted=exactCatalogCode(code);
 if(!/^[A-Z0-9]{1,80}$/.test(wanted))throw Error('KNORR_CODE_INVALID');
 if(!official||official.authority!=='official'||official.brand!=='Knorr-Bremse'||exactCatalogCode(official.code)!==wanted||!/^[a-f0-9]{64}$/.test(official.fingerprint||''))throw Error('KNORR_OFFICIAL_RECEIPT_REQUIRED');
 const officialUrl=new URL(official.sourceUrl);if(officialUrl.origin!=='https://mytruckservices.knorr-bremse.com'||officialUrl.username||officialUrl.password||!officialUrl.pathname.endsWith('/p/'+wanted))throw Error('KNORR_OFFICIAL_RECEIPT_REQUIRED');
 if(typeof html!=='string'||Buffer.byteLength(html)>4*1024*1024)throw Error('WILMINK_RESPONSE_TOO_LARGE');
 const products=[...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap(m=>{try{const v=JSON.parse(m[1]);return Array.isArray(v)?v:[v]}catch{return []}}).filter(x=>x?.['@type']==='Product');
 if(products.length!==1)throw Error('WILMINK_EXACT_IDENTITY_INVALID');
 const p=products[0],sku=String(p.sku||''),brand=String(p.brand?.name||''),article=String(p.mpn||'');
 if(!/^WG\d+$/.test(sku)||!url.endsWith('/'+sku.toLowerCase())||!brand||!article||wilminkProductUrl(p.offers?.url)!==url)throw Error('WILMINK_EXACT_IDENTITY_INVALID');
 const refs=html.match(/<div\b[^>]*id=["']references["'][^>]*>([\s\S]*)/i)?.[1]||'';
 const cross=refs.split(/<h3\b[^>]*>\s*Cross-references\s*<\/h3>/i);if(cross.length!==2)throw Error('WILMINK_REFERENCE_SECTION_INVALID');
 const crossValues=[];
 for(const row of cross[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const block=row[1],manufacturer=decode(block.match(/data-manufacturer=["']([^"']+)["']/i)?.[1]);
  const value=decode(block.match(/<span\b[^>]*class=["'][^"']*\bsearch-value\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
  if(manufacturer.toUpperCase()==='KNORR-BREMSE'&&exactCatalogCode(value)===wanted)crossValues.push(value);
 }
 if(!crossValues.length)throw Error('WILMINK_KNORR_CROSS_REFERENCE_NOT_FOUND');
 const numbers=unique([...cross[0].matchAll(/<span\b[^>]*class=["'][^"']*\bsearch-value\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map(m=>decode(m[1])));
 const vehicleEvidence=[];const raw=html.match(/<vehicle-accordion\b[^>]*:manufacturers=["'](.*?)["']/i)?.[1];
 try{const makes=JSON.parse(decode(raw));if(Array.isArray(makes)&&makes.length<=200)for(const make of makes)if(typeof make.name==='string'&&make.name.length<=100)vehicleEvidence.push(make.name.trim());}catch{}
 return {brand:'Knorr-Bremse',code:wanted,sourceUrl:url,sourceSku:sku,sourceBrand:brand,sourceArticle:article,sourceFingerprint:createHash('sha256').update(html).digest('hex'),officialFingerprint:official.fingerprint,matchedCrossReference:unique(crossValues),evidence:{oemNumbers:numbers,vehicleMakes:unique(vehicleEvidence)},status:'review_required',reason:'CROSS_BRAND_FITMENT_NOT_VERIFIED',fields:{},canonicalWrite:false};
}
export async function fetchKnorrWilminkReview(input,{readHtml=readWilminkHtml}={}){
 const html=await readHtml(input.sourceUrl,{brand:'Kolbenschmidt'});
 return reviewKnorrWilminkCrossReference(html,input);
}
