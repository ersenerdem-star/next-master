import {createHash} from 'node:crypto';
import {isSchaefflerBrand} from './schaeffler-family.mts';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';
import {officialGrossWeightKg} from './official-weight.mjs';
import {catalogLifecycleReview} from './catalog-completion-review.mjs';

const BASE='https://vehiclelifetimesolutions.schaeffler.com';
const API=BASE+'/api/AAM-COM/';
const MAX_BYTES=4*1024*1024;
const text=v=>typeof v==='string'?v.trim():'';
const brandKey=v=>text(v).toUpperCase();
const array=v=>Array.isArray(v)?v:[];
const single=values=>{const found=[...new Set(values.filter(Boolean))];return found.length===1?found[0]:null;};
const internalCode=v=>/^TA-[0-9]{1,6}-[A-Za-z0-9._-]{1,80}$/.test(text(v));
function requireIdentity(brand,code){
 if(!isSchaefflerBrand(brand))throw Error('SCHAEFFLER_BRAND_UNSUPPORTED');
 const normalized=exactCatalogCode(code);
 if(!normalized||normalized.length>100||/[\x00-\x1f]/.test(String(code)))throw Error('SCHAEFFLER_CODE_INVALID');
 return normalized;
}
const params=url=>{url.searchParams.set('lang','en');url.searchParams.set('curr','EUR');url.searchParams.set('catalogCountry','TR');return url;};
export function schaefflerSearchUrl(code){
 const u=params(new URL('products/search',API));
 // Only bounded product search; prices and unrelated content are not requested.
 u.searchParams.set('fields','products(code,catalogArticleNumber,brand(DEFAULT),seoPath),pagination(DEFAULT)');
 u.searchParams.set('query',exactCatalogCode(code)+':relevance');u.searchParams.set('pageSize','20');u.searchParams.set('source','globalsearch');return u.href;
}
export function selectSchaefflerArticle(payload,brand,code){
 const wanted=requireIdentity(brand,code);
 if(!Array.isArray(payload?.products)||payload.products.length>20)throw Error('SCHAEFFLER_RESPONSE_INVALID');
 const total=payload.pagination?.totalResults;
 if(!Number.isInteger(total)||total<0||total!==payload.products.length||(payload.pagination.currentPage??0)!==0)throw Error('SCHAEFFLER_SEARCH_INCOMPLETE');
 const matches=payload.products.filter(p=>brandKey(p?.brand?.name)===brandKey(brand)&&exactCatalogCode(p?.catalogArticleNumber)===wanted);
 if(!matches.length)throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');
 if(matches.length!==1)throw Error('OFFICIAL_EXACT_MATCH_AMBIGUOUS');
 if(!internalCode(matches[0].code))throw Error('SCHAEFFLER_PRODUCT_IDENTITY_INVALID');
 return matches[0];
}
function features(product){
 return array(product.classifications).flatMap(c=>array(c?.features)).flatMap(f=>array(f?.featureValues).map(v=>({label:text(f?.name),val:text(v?.value),unit:text(f?.featureUnit?.symbol)})));
}
export function mapSchaefflerArticle(product,brand,code,{selectedCode,oePayload}={}){
 const wanted=requireIdentity(brand,code);
 if(!product||!internalCode(product.code)||product.code!==selectedCode||brandKey(product.brand?.name)!==brandKey(brand)
  ||exactCatalogCode(product.catalogArticleNumber)!==wanted||product.url!=='/AAM-COM/products/'+selectedCode)throw Error('SCHAEFFLER_PRODUCT_IDENTITY_INVALID');
 const fields={},criteria=features(product),diagnostics=[];
 const description=text(product.fullName);
 if(description&&description.length<=12000&&!/[<>]/.test(description))fields.description=description;
 const ean=text(product.ean);if(ean){if(!/^\d{8,14}$/.test(ean))throw Error('SCHAEFFLER_EAN_INVALID');fields.ean=ean;}
 const origin=single(criteria.filter(c=>/^(Country of Origin|Country of Manufacture|Origin)$/i.test(c.label)).map(c=>c.val.toUpperCase()).filter(v=>/^[A-Z]{2}$/.test(v)));
 if(origin)fields.origin=origin;
 const tariff=single(criteria.filter(c=>/^(HS Code|Tariff Code|Customs Tariff Number|Commodity Code)$/i.test(c.label)).map(c=>c.val.replace(/[.\s-]/g,'')).filter(v=>/^\d{6,12}$/.test(v)));
 if(tariff)fields.hs_code=tariff;
 const grossRows=criteria.filter(c=>/\b(gross|brutto)\b/i.test(c.label));
 // The observed Schaeffler weight has net=true and no unit: never gross kg.
 if(product.weight?.net===false&&['kg','g'].includes(text(product.weight.unit).toLowerCase()))grossRows.push({label:'Gross weight',val:String(product.weight.value),unit:product.weight.unit});
 const gross=officialGrossWeightKg(grossRows);if(gross!=null)fields.weight_kg=gross;
 if(product.weight&&gross==null)diagnostics.push(product.weight.net===true?'NET_WEIGHT_NOT_GROSS':'WEIGHT_UNIT_OR_GROSS_SCOPE_UNVERIFIED');
 const dimensions={},names={length:'length_mm',width:'width_mm',height:'height_mm','inner diameter':'inner_diameter_mm','outer diameter':'outer_diameter_mm'};
 for(const [name,key]of Object.entries(names)){
  const values=criteria.filter(c=>c.label.replace(/\s*\[mm\]\s*$/i,'').toLowerCase()===name&&(c.unit.toLowerCase()==='mm'||/\[mm\]$/i.test(c.label))).map(c=>c.val.replace(',','.')).filter(v=>/^\d+(\.\d+)?$/.test(v)).map(Number).filter(v=>v>0&&v<=1000000);
  const value=single(values);if(value!=null)dimensions[key]=value;
 }
 if(Object.keys(dimensions).length)fields.dimensions=dimensions;
 if(product.dimensions)diagnostics.push('UNQUALIFIED_DIMENSIONS_NOT_IMPORTED');
 if(oePayload!==undefined){
  if(!Array.isArray(oePayload?.oenumbers)||oePayload.oenumbers.length>500)throw Error('SCHAEFFLER_OE_RESPONSE_INVALID');
  const numbers=[];
  for(const group of oePayload.oenumbers){if(!Array.isArray(group?.numbers)||group.numbers.length>1000)throw Error('SCHAEFFLER_OE_RESPONSE_INVALID');for(const n of group.numbers){const number=text(n?.number);if(number&&number.length<=100)numbers.push(number);}}
  const oem=[...new Set(numbers)].join('; ');if(oem.length>12000)throw Error('SCHAEFFLER_OE_RESPONSE_TOO_LARGE');if(oem)fields.oem_no=oem;
 }
 const path=array(product.seoPath);const validPath=path.length>0&&path.length<=16&&path.every(v=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{0,100}$/.test(v));
 const sourceUrl=validPath?BASE+'/en/catalog/auto-parts/'+path.join('/')+'/p-'+product.code:params(new URL('products/'+product.code,API)).href;
 const sourceStatus=text(product.catalogStatus?.name)||null;
 // Empty productReferences does not prove that successor data is supplied.
 // Availability and kit/accessory relations never become discontinued/replacement.
 const lifecycle=catalogLifecycleReview({sourceStatus});
 lifecycle.evidence={catalogStatus:product.catalogStatus??null,replacement:{coverage:'unsupported',reason:'REPLACEMENT_REFERENCE_CONTRACT_NOT_VERIFIED'}};
 return {brand,sourceBrand:product.brand.name,code:wanted,sourceUrl,sourceStatus,fields,lifecycle,diagnostics,sourceProductCode:product.code,sourceCountry:'TR'};
}
async function readJson(url,{fetchImpl,signal}){
 const u=new URL(url);if(u.origin!==BASE||!u.pathname.startsWith('/api/AAM-COM/'))throw Error('SCHAEFFLER_SOURCE_INVALID');
 const response=await fetchImpl(u.href,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal});
 if(response.status===401||response.status===403)throw Error('SCHAEFFLER_OFFICIAL_SERVER_ACCESS_REQUIRED');
 if(response.status===404)throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');
 if(!response.ok)throw Error('SCHAEFFLER_HTTP_'+response.status);
 if(response.url&&new URL(response.url).origin!==BASE)throw Error('SCHAEFFLER_SOURCE_INVALID');
 if(!/application\/(?:[a-z0-9.-]+\+)?json/i.test(response.headers.get('content-type')||''))throw Error('SCHAEFFLER_RESPONSE_INVALID');
 if(Number(response.headers.get('content-length')||0)>MAX_BYTES)throw Error('SCHAEFFLER_RESPONSE_TOO_LARGE');
 const reader=response.body?.getReader();if(!reader)throw Error('SCHAEFFLER_RESPONSE_INVALID');
 const chunks=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw Error('SCHAEFFLER_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
 const raw=new TextDecoder().decode(bytes);let value;try{value=JSON.parse(raw);}catch{throw Error('SCHAEFFLER_RESPONSE_INVALID');}
 return {value,fingerprint:createHash('sha256').update(raw).digest('hex')};
}
export async function fetchSchaefflerCatalogFields(brand,code,{fetchImpl=fetch,timeoutMs=20000,intervalMs=1100,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 requireIdentity(brand,code);
 if(!Number.isFinite(intervalMs)||intervalMs<1100)throw Error('SCHAEFFLER_PACING_REQUIRED');
 const signal=AbortSignal.timeout(timeoutMs),documents=[];
 const get=async url=>{if(documents.length)await wait(intervalMs);const r=await readJson(url,{fetchImpl,signal});documents.push({url,fingerprint:r.fingerprint});return r.value;};
 const search=await get(schaefflerSearchUrl(code)),selected=selectSchaefflerArticle(search,brand,code);
 const detailUrl=params(new URL('products/'+selected.code,API));detailUrl.searchParams.set('fields','DEFAULT');
 const product=await get(detailUrl.href);
 // Verify the detail before requesting any further product-specific resource.
 mapSchaefflerArticle(product,brand,code,{selectedCode:selected.code});
 const oeUrl=params(new URL('products/'+selected.code+'/oenumbers',API));
 const oePayload=await get(oeUrl.href);
 return {...mapSchaefflerArticle(product,brand,code,{selectedCode:selected.code,oePayload}),observedAt:new Date().toISOString(),sourceDocuments:documents,sourceFingerprint:createHash('sha256').update(JSON.stringify(documents)).digest('hex')};
}
