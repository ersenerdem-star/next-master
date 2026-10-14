export type UploadPhase='hashing'|'admitting'|'uploading'|'verifying'|'queued'|'verified'|'failed'|'paused'|'unknown';
export type UploadProgress={phase:UploadPhase;bytes:number;totalBytes:number;sessionId?:string;releaseId?:string;message:string};
export type UploadStatus={sessionId:string;releaseId:string;uploadStatus:string;verificationStatus:string;transferReady:boolean;
 totalBytes:number;totalRows:number;processedRows:number;releaseStatus:string;expiresAt:string;updatedAt:string;published:false};
export type UploadAdmission={session_id:string;release_id:string;status:string;storage_bucket:string;storage_object_path:string;
 total_bytes:number;upload_endpoint:string;expires_at:string;verification_required:true};
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function requireVerifiedSupplierReplaceMode(mode: unknown): asserts mode is 'replace' {
 if(mode !== 'replace') throw Error('Verified supplier upload currently requires a complete replacement price list. Merge is not supported.');
}
export function validateUploadAdmission(raw:unknown,file:{name:string;size:number},supabaseUrl:string):UploadAdmission {
 const r=raw as UploadAdmission,url=new URL(supabaseUrl),endpoint=new URL(String(r?.upload_endpoint));
 if(!r||!uuid(r.session_id)||!uuid(r.release_id)||r.verification_required!==true
  ||!['created','uploading','uploaded'].includes(r.status)||r.storage_bucket!=='supplier-price-imports'
  ||r.total_bytes!==file.size||!Number.isFinite(Date.parse(r.expires_at))||Date.parse(r.expires_at)<=Date.now()
  ||endpoint.origin!==url.origin||endpoint.pathname!=='/storage/v1/upload/resumable'||endpoint.search||endpoint.hash
  ||!new RegExp(`^[0-9a-f-]{36}/supplier-price/${r.session_id}/`).test(r.storage_object_path)
  ||r.storage_object_path.split('/').length!==4||!uuid(r.storage_object_path.split('/')[0])
  ||r.storage_object_path.split('/')[3]!==file.name.replace(/[^A-Za-z0-9._-]+/g,'_')) throw Error('Upload receipt could not be verified. Do not start a different upload.');
 return r;
}
export function directStorageEndpoint(supabaseUrl:string) {
 const url=new URL(supabaseUrl);
 if(url.protocol!=='https:'||! /^[a-z0-9]+\.supabase\.co$/.test(url.hostname)||url.username||url.password||url.port)
  throw Error('Verified upload requires the configured Supabase project host.');
 return `https://${url.hostname.replace('.supabase.co','.storage.supabase.co')}/storage/v1/upload/resumable`;
}
export function safeTusUrl(value:string,endpoint:string) {
 try{const u=new URL(value),e=new URL(endpoint);return u.origin===e.origin&&!u.username&&!u.password&&!u.search&&!u.hash
  &&u.pathname.startsWith(e.pathname+'/')&&u.pathname.length>e.pathname.length+1;}catch{return false;}
}
export async function hashUploadFile(file:Blob,hasher:{init:()=>unknown;update:(b:Uint8Array)=>unknown;digest:()=>string},
 signal:AbortSignal,onProgress:(bytes:number)=>void,chunkSize=4*1024*1024) {
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>1073741824||chunkSize<1) throw Error('Select a file between 1 byte and 1 GiB.');
 hasher.init();
 for(let offset=0;offset<file.size;offset+=chunkSize){signal.throwIfAborted();
  const bytes=new Uint8Array(await file.slice(offset,Math.min(offset+chunkSize,file.size)).arrayBuffer());
  signal.throwIfAborted();hasher.update(bytes);onProgress(Math.min(offset+bytes.length,file.size));
  // Yield to render progress and keep the browser responsive.
  await new Promise<void>(resolve=>setTimeout(resolve,0));
 }
 signal.throwIfAborted();return hasher.digest();
}
export function parseUploadStatus(raw:unknown,sessionId:string,totalBytes?:number):UploadStatus {
 const r=raw as UploadStatus;
 if(!r||r.sessionId!==sessionId||!uuid(r.releaseId)||r.published!==false||typeof r.transferReady!=='boolean'
  ||!['created','uploading','uploaded','failed','expired','aborted'].includes(r.uploadStatus)
  ||!['not_requested','queued','verifying','verified','failed'].includes(r.verificationStatus)
  ||!Number.isSafeInteger(r.totalBytes)||r.totalBytes<1||(totalBytes!==undefined&&r.totalBytes!==totalBytes)
  ||!Number.isSafeInteger(r.totalRows)||r.totalRows<0||!Number.isSafeInteger(r.processedRows)||r.processedRows<0
  ||typeof r.releaseStatus!=='string'||!Number.isFinite(Date.parse(r.expiresAt))||!Number.isFinite(Date.parse(r.updatedAt)))
  throw Error('Upload status could not be verified. Check the same session again.');
 return r;
}
