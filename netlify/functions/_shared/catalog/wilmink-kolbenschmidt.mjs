import {wilminkSource} from './wilmink-sources.mjs';
import {createHash} from 'node:crypto';
import {exactCatalogCode,CATALOG_FIELDS,planSupplierCatalogEnrichment} from './supplier-enrichment-plan.mjs';

export const WILMINK_SOURCE='wilmink_kolbenschmidt_v1';
export const WILMINK_SCAN='wilmink-kolbenschmidt-discovery.v1';
export const WILMINK_BRAND_URL='https://www.wilminkengineparts.com/en/brands/kolbenschmidt';
const origin='https://www.wilminkengineparts.com';
const hash=s=>createHash('sha256').update(s).digest('hex');
const decode=s=>String(s??'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v>0&&v<=0x10ffff?String.fromCodePoint(v):'';}).replace(/&(amp|quot|apos|lt|gt|nbsp);/g,(_,n)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '})[n]);
const text=s=>decode(String(s??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const attr=(s,key)=>decode(s.match(new RegExp('\\b'+key+'=["\']([^"\']*)["\']','i'))?.[1]||'');
const uniq=a=>[...new Set(a.filter(Boolean))];
function section(html,id){const a=html.search(new RegExp('\\bid=["\']'+id+'["\']'));if(a<0)return '';const tail=html.slice(a),end=tail.slice(1).search(/<div\b[^>]*class=["'][^"']*\btab-pane\b/i);return end<0?tail:tail.slice(0,end+1);}
export function wilminkProductUrl(value){const u=new URL(value,origin);if(u.origin!==origin||u.username||u.password||u.search||u.hash||!/^\/en\/[a-z0-9-]+\/wg\d+$/i.test(u.pathname))throw Error('WILMINK_PRODUCT_URL_INVALID');return u.href;}
export function wilminkPageUrl(value,brand='Kolbenschmidt'){const source=wilminkSource(brand),u=new URL(value,origin);if(!source.pageUrl||u.origin!==origin||u.username||u.password||u.hash||u.pathname!==new URL(source.pageUrl).pathname||[...u.searchParams.keys()].some(k=>k!=='page')||u.searchParams.getAll('page').length>1||!/^([1-9]\d{0,3})$/.test(u.searchParams.get('page')||'1'))throw Error('WILMINK_PAGE_URL_INVALID');return u.href;}
export function parseWilminkBrandPage(html,url,expectedBrand='Kolbenschmidt'){
 url=wilminkPageUrl(url,expectedBrand);if(typeof html!=='string'||Buffer.byteLength(html)>4*1024*1024)throw Error('WILMINK_RESPONSE_TOO_LARGE');
 const entries=[...html.matchAll(/<li\b[^>]*class=["'][^"']*\bnoscript-product-item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)].map(m=>{const a=m[1].match(/<a\b[^>]*>/i)?.[0]||'',brand=text(m[1].match(/<span\b[^>]*class=["']product-brand["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);return brand===expectedBrand?wilminkProductUrl(attr(a,'href')):null;}).filter(Boolean);
 if(!entries.length||entries.length>48||uniq(entries).length!==entries.length)throw Error('WILMINK_BRAND_PAGE_EMPTY_OR_INVALID');
 const page=Number(new URL(url).searchParams.get('page')||1),links=uniq([...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].map(m=>{try{return wilminkPageUrl(decode(m[1]),expectedBrand);}catch{return null;}}));
 const next=links.find(v=>Number(new URL(v).searchParams.get('page')||1)===page+1)||null;
 return {pageUrl:url,page,pageFingerprint:hash(html),urls:entries,nextUrl:next,lastPage:Math.max(page,...links.map(v=>Number(new URL(v).searchParams.get('page')||1)))};
}
export function parseWilminkProduct(html,{sourceUrl,expectedCode,expectedBrand='Kolbenschmidt'}={}){
 const source=wilminkSource(expectedBrand);
 sourceUrl=wilminkProductUrl(sourceUrl);if(typeof html!=='string'||Buffer.byteLength(html)>4*1024*1024)throw Error('WILMINK_RESPONSE_TOO_LARGE');
 const products=[...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap(m=>{try{const v=JSON.parse(m[1]);return Array.isArray(v)?v:[v];}catch{return [];}}).filter(v=>v?.['@type']==='Product');
 if(products.length!==1)throw Error('WILMINK_EXACT_IDENTITY_INVALID');const p=products[0];
 const specs=section(html,'specs'),rows=[...specs.matchAll(/<tr\b[^>]*>\s*<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)].map(m=>[text(m[1]),text(m[2])]);
 const get=key=>{const a=uniq(rows.filter(([k])=>k===key).map(([,v])=>v));return a.length===1?a[0]:'';};
 const sku=String(p.sku||'').trim(),code=exactCatalogCode(p.mpn),ean=String(p.gtin||p.gtin13||'').trim();
 if(p.brand?.name!==expectedBrand||get('Brand')!==expectedBrand||!/^WG\d+$/.test(sku)||!new URL(sourceUrl).pathname.endsWith('/'+sku.toLowerCase())||get('Article number')!==sku||!code||code!==exactCatalogCode(get('External article number'))||(expectedCode&&code!==exactCatalogCode(expectedCode))||(get('EAN')&&get('EAN')!==ean)||!/^\d{8,14}$/.test(ean)||wilminkProductUrl(p.offers?.url)!==sourceUrl)throw Error('WILMINK_EXACT_IDENTITY_INVALID');
 const heading=[...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map(m=>text(m[1])).find(v=>v.startsWith(expectedBrand+' - '));
 const description=heading?.slice((expectedBrand+' - ').length).trim();if(!description||description.length>500)throw Error('WILMINK_DESCRIPTION_MISSING');
 const fields={description,ean},references=section(html,'references'),oe=references.split(/<h3\b[^>]*>\s*Cross-references\s*<\/h3>/i)[0];
 const oems=uniq([...oe.matchAll(/<span\b[^>]*class=["']search-value["'][^>]*>([\s\S]*?)<\/span>/gi)].map(m=>text(m[1])));if(oems.length&&oems.join('; ').length<=12000)fields.oem_no=oems.join('; ');
 // Product dimensions only. Packaging measurements and unqualified weights
 // remain inspectable attributes; neither is silently a product/gross fact.
 const dimensions={};for(const [label,key] of [['Length [mm]','length_mm'],['Width [mm]','width_mm'],['Height [mm]','height_mm']]){const s=get(label);if(/^\d+(?:[.,]\d+)?$/.test(s)&&Number(s.replace(',','.'))>0)dimensions[key]=Number(s.replace(',','.'));}if(Object.keys(dimensions).length)fields.dimensions=dimensions;
 const gross=get('Gross weight (kg)')||get('Gross Weight [kg]');if(/^\d+(?:[.,]\d+)?$/.test(gross)&&Number(gross.replace(',','.'))>0)fields.weight_kg=Number(gross.replace(',','.'));
 const country=get('Country of origin');if(/^[A-Z]{2}$/.test(country)&&!['QU','ZZ','XX'].includes(country))fields.origin=country;
 const tariff=get('Customs tariff number')||get('HS Code');if(/^\d[\d.\s-]{1,30}\d$/.test(tariff))fields.hs_code=tariff;
 const segment={ 'Passenger cars':'pc','Commercial vehicles':'cv','Light commercial vehicles':'lcv','Agricultural machinery':'agriculture','Industrial':'industrial','Marine':'marine' }[get('Vehicle type')];if(segment)fields.market_segment=segment;
 const manufacturer=html.match(/<vehicle-accordion\b[^>]*:manufacturers=["'](.*?)["']/i)?.[1];try{const makes=JSON.parse(decode(manufacturer));if(Array.isArray(makes)&&makes.length<=200){const value=uniq(makes.map(x=>typeof x.name==='string'?x.name.trim():'')).join('; ');if(value&&value.length<=12000)fields.vehicle=value;}}catch{}
 const images=uniq((Array.isArray(p.image)?p.image:[p.image]).filter(v=>typeof v==='string'&&v.startsWith(origin+'/content_resources/images/product-images/')&&v.includes('/'+sku+'/')&&/\.(?:jpe?g|png|webp)$/i.test(v)));
 return {brand:expectedBrand,code,sourceKey:source.sourceKey,authority:'distributor',sourceUrl,sourceSku:sku,exactIdentity:true,fields,
  imageCandidate:images.length===1?images[0]:null,technicalAttributes:rows.filter(([k])=>!['Availability','General information'].includes(k)),sourceStatus:get('Article status')||null,
  lifecycle:{checks:{replacement:'unsupported',discontinued:'unsupported'},reviewOnly:true,reason:'Distributor availability, related products and cross-references are not manufacturer lifecycle evidence'},
  fingerprint:hash(html),observedAt:new Date().toISOString()};
}
export async function readWilminkHtml(url,{fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=20000,brand='Kolbenschmidt'}={}){
 if(new URL(url).pathname.startsWith('/en/brands/'))wilminkPageUrl(url,brand);else wilminkProductUrl(url);
 await wait(1100);const response=await fetchImpl(url,{headers:{accept:'text/html','user-agent':'NextMasterCatalog/1.0 (+https://portal.next-master.com)'},redirect:'error',signal:AbortSignal.timeout(timeoutMs),credentials:'omit'});
 if(!response.ok)throw Error('WILMINK_HTTP_'+response.status);if(!/text\/html/i.test(response.headers.get('content-type')||''))throw Error('WILMINK_RESPONSE_INVALID');
 const reader=response.body?.getReader();if(!reader)throw Error('WILMINK_RESPONSE_INVALID');const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)throw Error('WILMINK_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}return new TextDecoder().decode(bytes);
}
export function safeWilminkObservation(value,code,brand='Kolbenschmidt'){
 const source=wilminkSource(brand);
 if(value?.sourceKey!==source.sourceKey||value.authority!=='distributor'||value.brand!==brand||value.exactIdentity!==true||value.code!==exactCatalogCode(code)||!/^WG\d+$/.test(value.sourceSku)||!wilminkProductUrl(value.sourceUrl).endsWith('/'+value.sourceSku.toLowerCase())||!/^[a-f0-9]{64}$/.test(value.fingerprint))throw Error('WILMINK_EXACT_IDENTITY_INVALID');
 return {fields:Object.fromEntries(CATALOG_FIELDS.filter(k=>value.fields?.[k]!=null).map(k=>[k,value.fields[k]])),evidence:{authority:'distributor',lifecycle:value.lifecycle,fingerprint:value.fingerprint,sourceUrl:value.sourceUrl,observedAt:value.observedAt}};
}
export function wilminkReview(value,before){const safe=safeWilminkObservation(value,value.code,value.brand),plan=planSupplierCatalogEnrichment({existing:before,incoming:safe.fields,phase:'official'});return {...value,before,sourceFields:safe.fields,fields:plan.patch,issues:plan.issues,missing:plan.missing,replacements:[]};}
