// Official DENSO public parts API used by the owner-supplied catalogue.
// Only exact DENSO article responses are admissible; OE/fuzzy alternatives are not.
export const DENSO_SOURCE_URL='https://www.denso-am.eu/catalog/pv';
export const exactDensoCode=value=>String(value??'').trim().replace(/\s+/g,'').toUpperCase();
const text=value=>typeof value==='string'?value.trim():'';
// PHP preserves sparse numeric keys as JSON objects (e.g. DSN2112 fitments).
// Accept that list representation without treating an arbitrary object as rows.
const list=value=>{
 if(value==null)return [];
 if(Array.isArray(value))return value;
 if(typeof value==='object'&&Object.keys(value).every(k=>/^\d+$/.test(k)))return Object.values(value);
 throw Error('DENSO_COLLECTION_INVALID');
};
const english=value=>typeof value==='string'?value:text(list(value).find(v=>v?.lang_tid===4)?.val);
const joined=values=>[...new Set(values.map(text).filter(Boolean))].join('; ');
const criterion=(article,pattern)=>list(article.criteria).filter(c=>pattern.test(text(c?.label)));
const singleValue=rows=>{const values=[...new Set(rows.map(c=>text(c.val)).filter(Boolean))];return values.length===1?values[0]:null;};
export function mapDensoArticle(payload,code){
 if(payload?.status!=='success'||!Array.isArray(payload.data)||payload.data.length>100)throw Error('DENSO_RESPONSE_INVALID');
 const matches=payload.data.filter(a=>exactDensoCode(a?.name)===exactDensoCode(code));
 if(!matches.length)throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');
 if(matches.length!==1)throw Error('OFFICIAL_EXACT_MATCH_AMBIGUOUS');
 const article=matches[0];
 if(article.brand&&text(article.brand).toUpperCase()!=='DENSO')throw Error('DENSO_BRAND_MISMATCH');
 const fields={};if(text(article.title))fields.description=text(article.title);
 if(/^[0-9]{8,14}$/.test(String(article.ean??'')))fields.ean=String(article.ean);
 const gross=criterion(article,/^Gross Weight\s*\[(g|kg)\]$/i);
 const weights=gross.map(c=>{const unit=text(c.label).match(/\[(g|kg)\]/i)?.[1].toLowerCase(),raw=String(c.val??'').trim().replace(',','.');return /^\d+(\.\d+)?$/.test(raw)?Number(raw)/(unit==='g'?1000:1):NaN;});
 if(weights.length&&weights.every(w=>Number.isFinite(w)&&w>0&&w<=100000)&&new Set(weights).size===1)fields.weight_kg=weights[0];
 const origin=singleValue(criterion(article,/^(Country of Origin|Country of Manufacture|Origin)$/i));
 if(origin&&/^[A-Z]{2}$/.test(origin.toUpperCase()))fields.origin=origin.toUpperCase();
 const tariff=singleValue(criterion(article,/^(HS Code|Tariff Code|Customs Tariff Number|Commodity Code)$/i));
 if(tariff&&/^\d[\d.\s-]{1,30}\d$/.test(tariff))fields.hs_code=tariff;
 const oem=joined(list(article.ref_numbers).filter(g=>g?.maker&&text(g.maker).toUpperCase()!=='DENSO').flatMap(g=>list(g.numbers)).filter(n=>typeof n==='string'&&!n.includes('*')));
 if(oem&&oem.length<=12000)fields.oem_no=oem;
 const cars=list(article.cars).filter(c=>c&&typeof c==='object');
 const makes=joined(cars.map(c=>english(c.title)));if(makes&&makes.length<=12000)fields.vehicle=makes;
 const models=joined(cars.flatMap(c=>list(c.items).filter(m=>m&&typeof m==='object'&&english(m.title)).map(m=>[english(c.title),english(m.title)].filter(Boolean).join(' '))));if(models&&models.length<=12000)fields.vehicle_model=models;
 // Vehicle type is not inferred from the selected PV page: products can fit
 // both passenger and commercial vehicles. Missing source facts stay missing.
 return {code:exactDensoCode(code),brand:'Denso',fields,sourceUrl:'https://www.denso-am.eu/catalog/part/'+encodeURIComponent(text(article.name)),
  sourceStatus:text(article.status),replacementCandidates:{replaces:article.replaces||[],replacedBy:article.replaced_by||[]}};
}
export async function fetchDensoSupplierCatalogFields(code,timeoutMs=20000,fetchImpl=fetch){
 if(!exactDensoCode(code)||exactDensoCode(code).length>100||/[\x00-\x1f]/.test(String(code)))throw Error('DENSO_CODE_INVALID');
 const url=new URL('https://www.denso-am.eu/api/v1/parts/'+encodeURIComponent(text(code)));
 url.searchParams.set('vt','1');url.searchParams.set('country','TR');
 const signal=AbortSignal.timeout(timeoutMs);
 const response=await fetchImpl(url.href,{headers:{accept:'application/json'},redirect:'error',signal});
 if(response.status===404)throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');
 if(!response.ok)throw Error('DENSO_HTTP_'+response.status);
 if(Number(response.headers.get('content-length')||0)>4*1024*1024)throw Error('DENSO_RESPONSE_TOO_LARGE');
 const reader=response.body?.getReader();if(!reader)throw Error('DENSO_RESPONSE_INVALID');
 const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)throw Error('DENSO_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const data=new Uint8Array(size);let at=0;for(const c of chunks){data.set(c,at);at+=c.byteLength;}
 const result=mapDensoArticle(JSON.parse(new TextDecoder().decode(data)),code);
 return {...result,sourceApiUrl:url.href,observedAt:new Date().toISOString()};
}
