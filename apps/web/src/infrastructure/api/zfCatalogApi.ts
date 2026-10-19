import {supabaseClient} from './supabaseClient';
export type ZfJob={id:string;mode:'stage'|'publish';status:string;total_items:number;next_index:number;error_message:string|null;lease_expires_at:string|null;manifest:{brand:string;codes:string[]}};
export type ZfObservation={brand:string;code:string;sourceUrl?:string;observedAt:string;unavailable?:string;sourceStatus?:string;before:Record<string,unknown>;fields:Record<string,unknown>;sourceFields?:Record<string,unknown>;replacements:Array<{code:string;direction:string;error?:string;verified:boolean;sourceUrl?:string}>};
export type ZfItem={productCode:string;state:string;error:string|null;observation:ZfObservation|null;result:{fields?:Record<string,string>;relations?:Array<{old:string;new:string;status:string}>;status?:string}};
export type ZfStatus={capability?:{status:string;reader:boolean;family:string;workflow:string};sourceUrl:string;readAllowed:boolean;publishAllowed:boolean;jobs:ZfJob[];items:ZfItem[]};
async function request(brand:string,method:string,body?:unknown,jobId?:string,engine:'zf'|'brand'='zf'){
 let {data,error}=await supabaseClient.auth.getSession();
 if(data.session?.expires_at&&data.session.expires_at*1000<Date.now()+30000){const refreshed=await supabaseClient.auth.refreshSession();data=refreshed.data;error=refreshed.error;}
 if(error||!data.session?.access_token)throw Error('AUTH_REQUIRED');
 const params=new URLSearchParams({brand});if(jobId)params.set('jobId',jobId);
 const response=await fetch(`/api/catalog-${engine}?${params}`,{method,headers:{'content-type':'application/json',authorization:`Bearer ${data.session.access_token}`},
  body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const payload=await response.json().catch(()=>({}));if(!response.ok)throw Error(response.status===401?'AUTH_REQUIRED':payload.error||'ZF_REQUEST_FAILED');return payload;
}
export const getZfStatus=(brand:string,jobId?:string):Promise<ZfStatus>=>request(brand,'GET',undefined,jobId);
export const actOnZfJob=(brand:string,body:{action:'start'|'resume'|'publish';jobId?:string;codes?:string[];requestId?:string}):Promise<{job:ZfJob;dispatchPending:boolean}>=>request(brand,'POST',{...body,brand});

export const getBrandEngineStatus=(brand:string,jobId?:string):Promise<ZfStatus>=>request(brand,'GET',undefined,jobId,'brand');
export const actOnBrandEngineJob=(brand:string,body:{action:'start'|'resume'|'publish';jobId?:string;codes?:string[];requestId?:string}):Promise<{job:ZfJob;dispatchPending:boolean}>=>request(brand,'POST',{...body,brand},undefined,'brand');
export type CatalogEngineEntry={brand:string;family:string;sourceUrl:string;sourceKey:string|null;reader:boolean;workflow:string;status:string};
export const listBrandEngines=async():Promise<CatalogEngineEntry[]> => (await request('','GET',undefined,undefined,'brand')).brands;
