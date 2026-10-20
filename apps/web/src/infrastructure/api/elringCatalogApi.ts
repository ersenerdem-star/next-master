import {supabaseClient} from './supabaseClient';
export type ElringJob={id:string;mode:'stage'|'publish';status:'queued'|'running'|'paused'|'reviewed'|'completed'|'failed';total_items:number;next_index:number;error_message:string|null;lease_expires_at:string|null};
export type ElringItem={productCode:string;state:string;error:string|null;runId?:string;fields:Record<string,string>;sourceChecks:Record<string,string>;limitations:string[];lifecycle:null|{discontinued_applied?:number;relations_inserted?:number;outcomes?:Array<{source_status?:string;relation_evidence_count?:number}>}};
export type ElringStatus={sourceUrl:string;readAllowed:boolean;publishAllowed:boolean;jobs:ElringJob[];items:ElringItem[]};
async function request(method:string,body?:unknown,jobId?:string,details=false){
 const {data,error}=await supabaseClient.auth.getSession();
 if(error||!data.session?.access_token)throw Error('AUTH_REQUIRED');
 const response=await fetch(`/api/catalog-elring${jobId?`?jobId=${encodeURIComponent(jobId)}${details?'&details=1':''}`:''}`,{method,
  headers:{'content-type':'application/json',authorization:`Bearer ${data.session.access_token}`},
  body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const payload=await response.json().catch(()=>({}));if(!response.ok)throw Error(payload.error||'ELRING_REQUEST_FAILED');return payload;
}
export const getElringStatus=(jobId?:string,details=false):Promise<ElringStatus>=>request('GET',undefined,jobId,details);
export const actOnElringJob=(body:{action:'start'|'resume'|'publish';jobId?:string;codes?:string[];segment?:string;requestId?:string}):Promise<{job:ElringJob;dispatchPending:boolean}>=>request('POST',body);
