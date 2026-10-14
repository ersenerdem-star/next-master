// Only the v5 caller opts in. Keep retries inside the existing durable step,
// and never treat a domain/receipt error as permission to repeat a mutation.
import {setTimeout as delay} from 'node:timers/promises';

export const COMPACT_RPC_MAX_ATTEMPTS=4;
export const COMPACT_RPC_BACKOFF_MS=250;
const replaySafeRpcs=new Set([
 'get_supplier_price_verified_manifest',
 'claim_supplier_price_verified_release_batch',
 'stage_supplier_price_release_batch','stage_supplier_price_release_batch_v2',
 'heartbeat_supplier_price_release_batch',
 'finalize_supplier_price_release_shadow_batch',
 'complete_supplier_price_release_duckdb_validation',
]);
const taggedErrors=new WeakSet();
const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','EAI_AGAIN',
 'ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT',
 'UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
function tagged(rpcName,message,name='Error'){
 const error=new Error(message);error.name=name;
 // Do not retain raw causes, provider bodies, URLs, arguments or credentials.
 error.rpcName=rpcName;taggedErrors.add(error);return error;
}

export function compactRpcTransportError(rpcName,error){
 if(!replaySafeRpcs.has(rpcName))return error;
 if(error?.name==='TimeoutError')return tagged(rpcName,'The operation was aborted due to timeout','TimeoutError');
 const code=error?.code??error?.cause?.code;
 if(networkCodes.has(code)
  ||!code&&error?.name==='TypeError'&&error.message==='fetch failed')
  return tagged(rpcName,'fetch failed','TypeError');
 // AbortError may be intentional cancellation; unknown failures stay terminal.
 return error;
}

export function compactRpcHttpError(rpcName,status,body){
 const message=`SERVICE_RPC_HTTP_${status}`;
 const transient=status===408||status===425||status===429||status>=500&&status<=599;
 // A structured REST/SQL error can represent an integrity or authorization
 // failure even with HTTP 5xx. Only empty/non-JSON gateway responses qualify.
 const gatewayBody=body!=null&&typeof body==='object'&&!Array.isArray(body)
  &&(Object.keys(body).length===0
   ||Object.keys(body).length===1&&typeof body.raw==='string');
 return replaySafeRpcs.has(rpcName)&&transient&&gatewayBody
  ?tagged(rpcName,message):new Error(message);
}

export async function retryCompactRpcStep(fn,{sleep=delay}={}){
 for(let attempt=1;;attempt++){
  try{return await fn();}
  catch(error){
   if(!taggedErrors.has(error)||attempt>=COMPACT_RPC_MAX_ATTEMPTS)throw error;
   await sleep(COMPACT_RPC_BACKOFF_MS*2**(attempt-1));
  }
 }
}
