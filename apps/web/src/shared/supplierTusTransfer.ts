import type {Upload,UploadOptions,PreviousUpload} from 'tus-js-client';
import {safeTusUrl} from './supplierUploadProtocol';

// Dependency injection lets tests exercise the same callbacks as the browser.
type UploadHandle=Pick<Upload,'abort'|'findPreviousUploads'|'resumeFromPreviousUpload'|'start'>;
export async function transferSupplierUpload(file:File,input:{endpoint:string;base:string;actorId:string;sessionId:string;checksum:string;bucket:string;path:string;contentType:string},
 signal:AbortSignal,onProgress:(bytes:number)=>void,createUpload:(file:File,options:UploadOptions)=>UploadHandle,
 accessToken:()=>Promise<{actorId:string;token:string}>,idleTimeoutMs=90000,attempt=0,forceFresh=false) {
 signal.throwIfAborted();
 return new Promise<void>((resolve,reject)=>{
  let idleTimer:ReturnType<typeof setTimeout>;
  let settled=false;
  const cleanup=()=>{settled=true;clearTimeout(idleTimer);signal.removeEventListener('abort',onAbort);};
  const touch=()=>{if(settled)return;clearTimeout(idleTimer);idleTimer=setTimeout(()=>{
   cleanup();void upload.abort(false).then(()=>reject(Error('Transfer stalled. Resume the same upload session.')),
    ()=>reject(Error('Transfer stalled. Resume the same upload session.')));
  },idleTimeoutMs);};
  const upload=createUpload(file,{endpoint:input.endpoint,chunkSize:6*1024*1024,retryDelays:[0,3000,5000,10000,20000],
   ...(forceFresh?{storeFingerprintForResuming:false}:{}),
   uploadDataDuringCreation:true,removeFingerprintOnSuccess:true,
   fingerprint:async()=>`${input.base}:${input.actorId}:${input.sessionId}:${input.checksum}`,
   metadata:{bucketName:input.bucket,objectName:input.path,contentType:input.contentType,cacheControl:'0'},
   onBeforeRequest:async req=>{
    signal.throwIfAborted();const url=req.getURL();
    if(url!==input.endpoint&&!safeTusUrl(url,input.endpoint)) throw Error('Untrusted upload URL rejected.');
    const auth=await accessToken();if(auth.actorId!==input.actorId) throw Error('The signed-in account changed. Pause this upload.');
    req.setHeader('authorization',`Bearer ${auth.token}`);
    touch();
   },
   onShouldRetry:error=>{const code=error.originalResponse?.getStatus();
    return !signal.aborted&&(code===undefined||code===0||code===408||code===429||code>=500);},
   onProgress:bytes=>{touch();onProgress(bytes);},
   onError:error=>{
    const status=(error as Error & {originalResponse?:{getStatus?:()=>number}}).originalResponse?.getStatus?.();
    // Supabase expires resumable URLs. A 404/410 means only that the old
    // transfer URL is gone; rotate that URL on the SAME admitted session,
    // bounded to avoid masking a real endpoint or policy failure.
    if((status===404||status===410)&&attempt<2&&!signal.aborted){
     cleanup();
     const internal=upload as UploadHandle & {_removeFromUrlStorage?:()=>void};
     internal._removeFromUrlStorage?.();
     void transferSupplierUpload(file,input,signal,onProgress,createUpload,accessToken,idleTimeoutMs,attempt+1,true)
      .then(resolve,reject);
     return;
    }
    cleanup();
    // Keep the user-facing message safe, but preserve the HTTP class/status
    // needed to distinguish auth/policy rejection from an expired/conflicting
    // resumable upload. Never surface the response body or a signed URL.
    const suffix=typeof status==='number'&&status>0?` (HTTP ${status})`:'';
    reject(Error(`Transfer could not complete${suffix}. Select the same file and resume the same upload.`));
   },
   onSuccess:()=>{cleanup();resolve();}
  });
  const onAbort=()=>{cleanup();void upload.abort(false).then(()=>reject(new DOMException('Upload paused.','AbortError')),
   ()=>reject(new DOMException('Upload paused.','AbortError')));};
  signal.addEventListener('abort',onAbort,{once:true});
  touch();
  const previousUploads=forceFresh?Promise.resolve([] as PreviousUpload[]):upload.findPreviousUploads();
  void previousUploads.then((previous:PreviousUpload[])=>{
   signal.throwIfAborted();const safe=previous.find(p=>p.uploadUrl&&safeTusUrl(p.uploadUrl,input.endpoint));
   if(safe)upload.resumeFromPreviousUpload(safe);upload.start();
  }).catch(error=>{cleanup();reject(error);});
 });
}
