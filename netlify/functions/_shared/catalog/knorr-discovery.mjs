import {createHash} from 'node:crypto';
import {knorrCodeIdentity} from './knorr-code-identity.mjs';
const ORIGIN='https://api-mytruckservices.knorr-bremse.com',MAX=6*1024*1024,PAGE_SIZE=100;
export function knorrDiscoveryUrl(page){
 if(!Number.isSafeInteger(page)||page<0||page>100000)throw Error('KNORR_DISCOVERY_PAGE_INVALID');
 const u=new URL('/occ/v2/EMEA/products/search',ORIGIN);for(const [k,v] of Object.entries({query:':relevance',sort:'code-asc',pageSize:String(PAGE_SIZE),currentPage:String(page),lang:'en_GB',curr:'GBP'}))u.searchParams.set(k,v);return u.href;
}
export function mapKnorrDiscoveryPage(payload,{page,previous}={}){
 const p=payload?.pagination,products=payload?.products;
 if(!Number.isSafeInteger(page)||page<0||!p||p.currentPage!==page||p.pageSize!==PAGE_SIZE||p.sort!=='code-asc'||!Number.isSafeInteger(p.totalResults)||p.totalResults<0||!Number.isSafeInteger(p.totalPages)||p.totalPages!==Math.ceil(p.totalResults/PAGE_SIZE)||!Array.isArray(products)||products.length>PAGE_SIZE*2)throw Error('KNORR_DISCOVERY_INCOMPLETE');
 if(previous&&(previous.totalResults!==p.totalResults||previous.totalPages!==p.totalPages||previous.nextPage!==page))throw Error('KNORR_DISCOVERY_SNAPSHOT_CHANGED');
 const rawCodes=products.map(x=>typeof x?.code==='string'?x.code.trim():'');if(rawCodes.some(c=>!c||c.length>100||/[\x00-\x1f]/.test(c)))throw Error('KNORR_DISCOVERY_IDENTITY_INVALID');
 // Knorr may repeat the exact same article in a single page. Fetching each
 // distinct source code once is safe; never merge different raw identities.
 const codes=[...new Set(rawCodes)];if(codes.length!==Math.min(PAGE_SIZE,Math.max(0,p.totalResults-page*PAGE_SIZE)))throw Error('KNORR_DISCOVERY_INCOMPLETE');
 const candidates=codes.map(code=>{try{const identity=knorrCodeIdentity(code);const eligible=!identity.sourceCode.includes('/');return {...identity,eligible,reason:eligible?null:'OFFICIAL_CODE_PATH_REQUIRES_IDENTITY_REVIEW'};}catch{return {sourceCode:code,canonicalCode:null,eligible:false,reason:'OFFICIAL_CODE_FORMAT_UNSUPPORTED'};}});
 return {page,totalResults:p.totalResults,totalPages:p.totalPages,duplicateCodesRemoved:rawCodes.length-codes.length,nextPage:page+1<p.totalPages?page+1:null,candidates,complete:false,coverage:'best_effort_live_pagination',canonicalWrite:false};
}
export async function fetchKnorrDiscoveryPage(page,{fetchImpl=fetch,previous,timeoutMs=20000}={}){
 const url=knorrDiscoveryUrl(page),r=await fetchImpl(url,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 if(!r.ok)throw Error('KNORR_DISCOVERY_HTTP_'+r.status);if(r.url&&new URL(r.url).origin!==ORIGIN)throw Error('KNORR_DISCOVERY_SOURCE_INVALID');
 if(!/application\/(?:[a-z0-9.-]+\+)?json/i.test(r.headers.get('content-type')||''))throw Error('KNORR_DISCOVERY_RESPONSE_INVALID');
 if(Number(r.headers.get('content-length')||0)>MAX)throw Error('KNORR_DISCOVERY_RESPONSE_TOO_LARGE');const reader=r.body?.getReader();if(!reader)throw Error('KNORR_DISCOVERY_RESPONSE_INVALID');let size=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX)throw Error('KNORR_DISCOVERY_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const raw=Buffer.concat(chunks).toString('utf8');let payload;try{payload=JSON.parse(raw)}catch{throw Error('KNORR_DISCOVERY_RESPONSE_INVALID');}
 return {...mapKnorrDiscoveryPage(payload,{page,previous}),sourceFingerprint:createHash('sha256').update(raw).digest('hex')};
}
