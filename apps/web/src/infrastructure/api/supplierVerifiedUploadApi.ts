import {supabaseClient} from './supabaseClient';
import {validateUploadAdmission,directStorageEndpoint,parseUploadStatus,requireVerifiedSupplierReplaceMode,supplierUploadStatusView,type UploadProgress,type UploadStatus} from '../../shared/supplierUploadProtocol';
import {transferSupplierUpload} from '../../shared/supplierTusTransfer';
import {supplierVerifiedUploadTargetEnabled} from './supplierVerifiedUploadTargetGate';
import {computeSupplierUploadChecksum} from '../../shared/supplierUploadChecksum';

export const verifiedSupplierUploadRequested = import.meta.env.VITE_SUPPLIER_PRICE_VERIFIED_UPLOAD_ENABLED === 'true';
export function isVerifiedSupplierUploadEnabled() {
 return supplierVerifiedUploadTargetEnabled({enabled:import.meta.env.VITE_SUPPLIER_PRICE_VERIFIED_UPLOAD_ENABLED,
  productionEnabled:import.meta.env.VITE_SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED,
  productionTarget:import.meta.env.VITE_NM_PRODUCTION_TARGET,supabaseUrl:import.meta.env.VITE_SUPABASE_URL,
  portalOrigin:typeof window==='undefined'?undefined:window.location.origin});
}
function requireTarget() {
 if(!isVerifiedSupplierUploadEnabled()) throw Error('Verified supplier upload is not enabled for this environment.');
}

async function accessToken() {
 const {data,error}=await supabaseClient.auth.getSession();
 if(error||!data.session?.access_token) throw Error('Sign in again to continue this upload.');
 return {token:data.session.access_token,actorId:data.session.user.id};
}
export async function fetchVerifiedSupplierUploadOptions<T>() {
 requireTarget();
 const {token}=await accessToken();
 const res=await fetch('/api/supplier-price-upload-options',{headers:{Authorization:`Bearer ${token}`},cache:'no-store',redirect:'error'});
 const data=await res.json().catch(()=>null);
 if(!res.ok||!data) throw Error(typeof data?.error==='string'?data.error:'Supplier upload options could not be loaded.');
 return data as T;
}
async function request(path:string,signal:AbortSignal,body?:unknown) {
 requireTarget();
 signal.throwIfAborted();const {token}=await accessToken();const controller=new AbortController();
 const abort=()=>controller.abort(signal.reason);signal.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15000);
 try{
  const res=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',redirect:'error',signal:controller.signal});
  const data=await res.json().catch(()=>null);
  if(!res.ok||!data) throw Error(typeof data?.error==='string'?data.error:'Upload response could not be confirmed. Keep the same session and retry.');
  return data;
 }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
export async function fetchVerifiedUploadStatus(sessionId:string,signal:AbortSignal,totalBytes?:number):Promise<UploadStatus> {
 if(!/^[0-9a-f-]{36}$/i.test(sessionId)) throw Error('Invalid upload session.');
 return parseUploadStatus(await request(`/api/supplier-price-upload-status?sessionId=${encodeURIComponent(sessionId)}`,signal),sessionId,totalBytes);
}
export async function uploadVerifiedSupplierFile(file:File,input:{supplierId:string;brandId:string;mode:'replace'|'merge';sourceDate:string},
 signal:AbortSignal,onProgress:(p:UploadProgress)=>void):Promise<UploadStatus> {
 requireVerifiedSupplierReplaceMode(input.mode);
 requireTarget();
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>1073741824) throw Error('Select a file between 1 byte and 1 GiB.');
 if(!/\.(csv|xlsx)$/i.test(file.name)) throw Error('Select a CSV or XLSX file.');
 if(!/^[0-9a-f-]{36}$/i.test(input.supplierId)||! /^[0-9a-f-]{36}$/i.test(input.brandId)) throw Error('Create the supplier and brand before using verified upload.');
 if(!/^\d{4}-\d\d-\d\d$/.test(input.sourceDate)) throw Error('A valid source date is required.');
 const base=String(import.meta.env.VITE_SUPABASE_URL),endpoint=directStorageEndpoint(base);
 const emit=(phase:UploadProgress['phase'],bytes:number,message:string,sessionId?:string,releaseId?:string)=>onProgress({phase,bytes,totalBytes:file.size,message,sessionId,releaseId});
 emit('hashing',0,'Checking file integrity. No prices have been written.');
 const checksumSha256=await computeSupplierUploadChecksum(file,signal,
  bytes=>emit('hashing',bytes,'Checking file integrity.'));
 const {actorId}=await accessToken();
 // Receipt-only checkpoint: never tokens, credentials, or supplier price rows.
 const binding=JSON.stringify([base,actorId,input.supplierId,input.brandId,input.mode,input.sourceDate,file.name,file.size,checksumSha256]);
 const key='supplier-verified-upload:v2:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(binding))))
  .map(b=>b.toString(16).padStart(2,'0')).join('');
 emit('admitting',0,'Opening the same verified upload session.');
 const receipt=await request('/api/supplier-price-upload-session',signal,{...input,idempotencyKey:key,fileName:file.name,totalBytes:file.size,
  contentType:/\.xlsx$/i.test(file.name)?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv',checksumSha256});
 const admission=validateUploadAdmission(receipt.data,file,base),sessionId=admission.session_id,releaseId=admission.release_id;
 // Storage is allowed to be unavailable; deterministic server admission still
 // prevents another release. Tus can resume only on this session fingerprint.
 try{localStorage.setItem(key,JSON.stringify({sessionId,releaseId}));}catch{ /* Server remains authoritative. */ }
 emit('uploading',0,'Checking this upload before transferring bytes.',sessionId,releaseId);
 let status=await fetchVerifiedUploadStatus(sessionId,signal,file.size);
 if(status.errorCode){const view=supplierUploadStatusView(status);emit(view.phase,file.size,view.message,sessionId,releaseId);return status;}
 if(status.verificationStatus==='failed'||['failed','expired','aborted'].includes(status.uploadStatus)) throw Error('This upload needs review. Check its status; do not create a new upload.');
 if(!status.transferReady&&status.verificationStatus==='not_requested') {
  const {Upload}=await import('tus-js-client');
  await transferSupplierUpload(file,{endpoint,base,actorId,sessionId,checksum:checksumSha256,bucket:admission.storage_bucket,path:admission.storage_object_path,
   contentType:/\.xlsx$/i.test(file.name)?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv'},signal,
   bytes=>emit('uploading',bytes,'Transferring file directly to private Storage.',sessionId,releaseId),
   (f,options)=>new Upload(f,options),accessToken);
  status=await fetchVerifiedUploadStatus(sessionId,signal,file.size);
 }
 if(status.verificationStatus==='not_requested') {
  emit('verifying',file.size,'File transferred. Requesting server-side verification; prices are not active yet.',sessionId,releaseId);
  const accepted=await request('/api/supplier-price-upload-finish',signal,{sessionId});
  if(accepted.sessionId!==sessionId||accepted.releaseId!==releaseId||accepted.published!==false) throw Error('Verification receipt is unknown. Check the same upload status.');
 }
 // Short UI observation, not a worker/scheduler. Durable processing outlives
 // this page. Stop polling after 60 seconds without inventing a failure.
 const until=Date.now()+60000;
 do {
  status=await fetchVerifiedUploadStatus(sessionId,signal,file.size);
  if(status.verificationStatus==='verified'||status.verificationStatus==='failed') break;
  emit('verifying',file.size,'Server verification continues. You can leave this screen safely.',sessionId,releaseId);
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},3000);
   const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 }while(Date.now()<until);
 const view=supplierUploadStatusView(status);
 emit(view.phase,file.size,view.message,sessionId,releaseId);
 return status;
}
