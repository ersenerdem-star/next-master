import {createHash} from 'node:crypto';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';
import {knorrCodeIdentity,assessKnorrCanonicalIdentity,verifyKnorrSearchIdentity} from './knorr-code-identity.mjs';

const ORIGIN='https://api-mytruckservices.knorr-bremse.com';
const WEB='https://mytruckservices.knorr-bremse.com';
const MAX=4*1024*1024;
const clean=v=>typeof v==='string'?v.trim():'';
function validCode(code){const v=exactCatalogCode(code);try{return knorrCodeIdentity(v).sourceCode}catch{throw Error('KNORR_CODE_INVALID');}}
export function mapKnorrArticle(product,code){
 const wanted=validCode(code);
 if(!product||product.code!==wanted)throw Error('OFFICIAL_OBSERVATION_IDENTITY_INVALID');
 const identity=assessKnorrCanonicalIdentity({sourceCode:wanted,officialCode:product.code});
 const fields={};const name=clean(product.name);if(name&&name.length<=12000&&!/[<>]/.test(name))fields.description=name;
 const ean=clean(product.sapEan);if(ean&&/^\d{8,14}$/.test(ean))fields.ean=ean;
 const tariff=clean(product.tariffNumber);if(/^\d{6,12}$/.test(tariff))fields.hs_code=tariff;
 const countries={Mexico:'MX',Germany:'DE',France:'FR',Italy:'IT',Spain:'ES',Poland:'PL',Turkey:'TR',China:'CN',India:'IN',Brazil:'BR',Hungary:'HU',Romania:'RO',Czechia:'CZ',Austria:'AT',Sweden:'SE',USA:'US'};
 const origin=clean(product.countryOfOrigin);if(countries[origin])fields.origin=countries[origin];else if(/^[A-Z]{2}$/.test(origin))fields.origin=origin;
 const weight=product.grossWeight;if(typeof weight==='number'&&weight>0&&weight<=1000000&&clean(product.weightUnit).toUpperCase()==='KG')fields.weight_kg=weight;
 const dimensions={};if(clean(product.dimensionUnit).toUpperCase()==='MM')for(const [key,field] of [['dimensionLength','length_mm'],['dimensionWidth','width_mm'],['dimensionHeight','height_mm']]){const n=product[key];if(typeof n==='number'&&n>0&&n<=1000000)dimensions[field]=n;}
 if(Object.keys(dimensions).length)fields.dimensions=dimensions;
 const next=clean(product.replacedByProductCode);const replacement=/^[A-Z0-9]{1,80}$/.test(next)&&next!==wanted?next:null;
 const sourceUrl=WEB+'/p/'+encodeURIComponent(wanted);
 // Sales status codes describe commercial availability, not production cessation.
 const lifecycle={checks:{replacement:replacement?'found':'no_explicit_signal',discontinued:'unsupported'},evidence:{salesStatusCode:product.salesStatusCode||null,sapLifecycleStatus:product.sapLifecycleStatus||null,replacement:{relations:replacement?[{old_code:wanted,new_code:replacement}]:[]}}};
 return {brand:'Knorr-Bremse',code:wanted,identity,sourceUrl,sourceStatus:null,fields,lifecycle,diagnostics:['SALES_STATUS_NOT_PRODUCTION_STATUS']};
}
export async function fetchKnorrCatalogFields(code,{fetchImpl=fetch,timeoutMs=20000}={}){
 const wanted=validCode(code),url=new URL('/occ/v2/EMEA/products/'+encodeURIComponent(wanted),ORIGIN);url.searchParams.set('fields','FULL');url.searchParams.set('lang','en_GB');url.searchParams.set('curr','GBP');
 const response=await fetchImpl(url.href,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 if(response.status===404)throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');
 if(response.status===401||response.status===403)throw Error('KNORR_OFFICIAL_SERVER_ACCESS_REQUIRED');
 if(!response.ok)throw Error('KNORR_HTTP_'+response.status);
 if(response.url&&new URL(response.url).origin!==ORIGIN)throw Error('KNORR_SOURCE_INVALID');
 if(!/application\/(?:[a-z0-9.-]+\+)?json/i.test(response.headers.get('content-type')||''))throw Error('KNORR_RESPONSE_INVALID');
 if(Number(response.headers.get('content-length')||0)>MAX)throw Error('KNORR_RESPONSE_TOO_LARGE');
 const reader=response.body?.getReader();if(!reader)throw Error('KNORR_RESPONSE_INVALID');const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX)throw Error('KNORR_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const raw=Buffer.concat(chunks).toString('utf8');let payload;try{payload=JSON.parse(raw);}catch{throw Error('KNORR_RESPONSE_INVALID');}
 const result=mapKnorrArticle(payload,wanted);
 if(result.identity.requiresCollisionReview){
  if(wanted.includes('/'))return {...result,observedAt:new Date().toISOString(),sourceFingerprint:createHash('sha256').update(raw).digest('hex')};
  const search=new URL('/occ/v2/EMEA/products/search',ORIGIN);search.searchParams.set('query',result.identity.canonicalCode);search.searchParams.set('pageSize','100');search.searchParams.set('lang','en_GB');search.searchParams.set('curr','GBP');
  await new Promise(resolve=>setTimeout(resolve,1100));
  const sr=await fetchImpl(search.href,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!sr.ok)throw Error('KNORR_HTTP_'+sr.status);if(sr.url&&new URL(sr.url).origin!==ORIGIN)throw Error('KNORR_SOURCE_INVALID');if(!/application\/(?:[a-z0-9.-]+\+)?json/i.test(sr.headers.get('content-type')||''))throw Error('KNORR_RESPONSE_INVALID');
  if(Number(sr.headers.get('content-length')||0)>MAX)throw Error('KNORR_RESPONSE_TOO_LARGE');const reader=sr.body?.getReader();if(!reader)throw Error('KNORR_RESPONSE_INVALID');let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX)throw Error('KNORR_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const searchRaw=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(searchRaw)}catch{throw Error('KNORR_RESPONSE_INVALID');}
  result.identity={...verifyKnorrSearchIdentity(wanted,data),searchFingerprint:createHash('sha256').update(searchRaw).digest('hex')};
 }
 return {...result,observedAt:new Date().toISOString(),sourceFingerprint:createHash('sha256').update(raw).digest('hex')};
}
