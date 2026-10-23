import {manufacturerTecDocFields} from './tecalliance-sync.mts';
import {tecLifecycle} from './mira-lifecycle.mts';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';

export const DELPHI_OFFICIAL_URL='https://www.delphiautoparts.com/de-de/catalogue';
const endpoint='https://www.delphiautoparts.com/partscatalogapi/v1/emeacatalog/searchpartnumber';
export function mapDelphiOfficialArticles(rows:unknown,code:string){
 if(!Array.isArray(rows)||rows.length>25)throw Error('DELPHI_RESPONSE_INVALID');
 const matches=rows.filter(a=>a&&a.dataSupplierId===89&&String(a.mfrName||'').toUpperCase()==='DELPHI'
  &&exactCatalogCode(a.articleNumber)===exactCatalogCode(code));
 if(matches.length!==1)throw Error(matches.length?'OFFICIAL_EXACT_MATCH_AMBIGUOUS':'OFFICIAL_EXACT_MATCH_NOT_FOUND');
 const article=matches[0];
 return {code:exactCatalogCode(code),sourceUrl:DELPHI_OFFICIAL_URL,lifecycle:tecLifecycle(article),
  fields:manufacturerTecDocFields(article,'Delphi')};
}
export async function fetchDelphiOfficialFields(code:string,{fetchImpl=fetch,timeoutMs=12000}={}){
 const response=await fetchImpl(endpoint,{method:'POST',credentials:'omit',redirect:'error',
  headers:{'content-type':'application/json','accept':'application/json','user-agent':'NextMasterCatalog/1.0 (+https://portal.next-master.com)'},
  body:JSON.stringify({Lang:'en',Country:'GB',SearchType:'Any',SearchMatchType:'prefix_or_suffix',Number:code,Page:1,PerPage:25}),
  signal:AbortSignal.timeout(timeoutMs)});
 if(!response.ok){await response.body?.cancel();throw Error('DELPHI_HTTP_'+response.status);}
 if(!/application\/json/i.test(response.headers.get('content-type')||''))throw Error('DELPHI_RESPONSE_INVALID');
 const chunks:Uint8Array[]=[];let bytes=0;
 if(!response.body)throw Error('DELPHI_RESPONSE_INVALID');
 for await(const chunk of response.body){bytes+=chunk.length;if(bytes>4*1024*1024)throw Error('DELPHI_RESPONSE_TOO_LARGE');chunks.push(chunk);}
 return mapDelphiOfficialArticles(JSON.parse(Buffer.concat(chunks).toString('utf8')),code);
}
