import {officialGrossWeightKg} from './official-weight.mjs';
const HOST='automotive.skf.com',BASE='https://'+HOST;
const text=v=>typeof v==='string'?v.trim():'';
export const exactSkfCode=v=>text(v).replace(/\s+/g,'').toUpperCase();
const productUrl=code=>BASE+'/eur/en/product-catalogue/'+encodeURIComponent(exactSkfCode(code));
const list=v=>Array.isArray(v)?v:[];
function jsonLd(html){
 const nodes=[];
 const add=(v,depth=0)=>{if(depth>5||nodes.length>500)throw Error('SKF_RESPONSE_INVALID');if(Array.isArray(v)){for(const x of v)add(x,depth+1);}else if(v&&typeof v==='object'){nodes.push(v);if(v['@graph'])add(v['@graph'],depth+1);}};
 for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(match[1]))continue;
  try{add(JSON.parse(match[2]));}catch{throw Error('SKF_RESPONSE_INVALID');}
 }
 return nodes;
}
const typeIs=(node,type)=>node['@type']===type||Array.isArray(node['@type'])&&node['@type'].includes(type);
function samePage(value,expected){try{const u=new URL(text(value),BASE);return u.origin===BASE&&!u.username&&!u.password&&u.pathname===new URL(expected).pathname&&!u.search&&!u.hash;}catch{return false;}}
const unique=values=>{const found=[...new Set(values.filter(Boolean))];return found.length===1?found[0]:null;};
export function mapSkfOfficialPage(html,code){
 const normalized=exactSkfCode(code),url=productUrl(code),nodes=jsonLd(html);
 if(!normalized||normalized.length>100)throw Error('SKF_CODE_INVALID');
 const matches=nodes.filter(n=>typeIs(n,'Product')&&exactSkfCode(n.sku)===normalized);
 if(!matches.length)throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');
 if(matches.length!==1)throw Error('OFFICIAL_EXACT_MATCH_AMBIGUOUS');
 const p=matches[0],brand=typeof p.brand==='string'?p.brand:p.brand?.name;
 if(text(brand).toUpperCase()!=='SKF'||!samePage(p.url,url))throw Error('SKF_PRODUCT_IDENTITY_INVALID');
 if(p.name&&exactSkfCode(p.name)!==normalized)throw Error('SKF_PRODUCT_IDENTITY_INVALID');
 const properties=list(p.additionalProperty).filter(x=>x&&typeof x==='object'),fields={};
 // A product-bound breadcrumb gives the explicit short type on SKF pages.
 const types=nodes.filter(n=>typeIs(n,'BreadcrumbList')).flatMap(n=>{
  const rows=list(n.itemListElement),last=rows.at(-1),previous=rows.at(-2);
  return last&&samePage(typeof last.item==='string'?last.item:last.item?.['@id'],url)&&exactSkfCode(last.name)===normalized&&previous?[text(previous.name)]:[];
 });
 const description=unique(types)||text(p.description);if(description&&description.length<=4000)fields.description=description;
 const eans=[p.gtin,p.gtin8,p.gtin12,p.gtin13,p.gtin14,...properties.filter(x=>/^(EAN|GTIN|Barcode)$/i.test(text(x.name))).map(x=>x.value)].map(v=>String(v??'').trim()).filter(v=>/^\d{8,14}$/.test(v));
 if(new Set(eans).size>1)throw Error('SKF_EAN_AMBIGUOUS');if(eans[0])fields.ean=eans[0];
 const weight=officialGrossWeightKg(properties.map(x=>{
  const value=String(x.value??'').trim(),measured=value.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g)$/i);
  return {label:text(x.name),val:measured?.[1]??value,unit:measured?.[2]??text(x.unitText)};
 }));if(weight!=null)fields.weight_kg=weight;
 const origin=unique([typeof p.countryOfOrigin==='string'?p.countryOfOrigin:p.countryOfOrigin?.identifier,...properties.filter(x=>/^(Country of Origin|Origin)$/i.test(text(x.name))).map(x=>x.value)].map(v=>text(v).toUpperCase()).filter(v=>/^[A-Z]{2}$/.test(v)));if(origin)fields.origin=origin;
 const tariff=unique(properties.filter(x=>/^(HS Code|Tariff Code|Customs Tariff Number|Commodity Code)$/i.test(text(x.name))).map(x=>text(x.value)).filter(v=>/^\d[\d.\s-]{1,30}\d$/.test(v)));if(tariff)fields.hs_code=tariff;
 const dimensions={},names={'Width':'width_mm','Height':'height_mm','Length':'length_mm','Inner Diameter':'inner_diameter_mm','Outer Diameter':'outer_diameter_mm'};
 for(const [name,key]of Object.entries(names)){
  const values=properties.filter(x=>text(x.name).toLowerCase()===name.toLowerCase()).map(x=>String(x.value??'').trim().match(/^(\d+(?:[.,]\d+)?)\s*mm$/i)?.[1]).filter(Boolean).map(v=>Number(v.replace(',','.'))).filter(v=>v>0&&v<=1000000);
  if(values.length&&new Set(values).size===1)dimensions[key]=values[0];
 }
 if(Object.keys(dimensions).length)fields.dimensions=dimensions;
 return {brand:'SKF',code:normalized,sourceUrl:url,fields};
}
export async function fetchSkfSupplierCatalogFields(code,timeoutMs=20000,fetchImpl=fetch){
 const normalized=exactSkfCode(code);
 if(!normalized||normalized.length>100||/[\x00-\x1f]/.test(String(code)))throw Error('SKF_CODE_INVALID');
 if(!/^[A-Z0-9][A-Z0-9._-]*$/.test(normalized))throw Error('OFFICIAL_PRODUCT_DOMAIN_UNSUPPORTED');
 const response=await fetchImpl(productUrl(code),{redirect:'error',headers:{accept:'text/html'},signal:AbortSignal.timeout(timeoutMs)});
 if(response.status===404)throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');if(!response.ok)throw Error('SKF_HTTP_'+response.status);
 if(Number(response.headers.get('content-length')||0)>4*1024*1024)throw Error('SKF_RESPONSE_TOO_LARGE');
 const reader=response.body?.getReader();if(!reader)throw Error('SKF_RESPONSE_INVALID');const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)throw Error('SKF_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
 return {...mapSkfOfficialPage(new TextDecoder().decode(bytes),code),observedAt:new Date().toISOString()};
}
