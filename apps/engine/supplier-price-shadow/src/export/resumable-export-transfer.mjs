// Worker-only TUS transport using the pinned client. No public capability/signing.
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {Upload} from 'tus-js-client';
import {supabaseApiHeaders} from '../supabase-headers.mjs';

export const EXPORT_TUS_ENDPOINT='https://kaxsqafdevabkxofwdod.storage.supabase.co/storage/v1/upload/resumable';
export const EXPORT_TUS_CHUNK=6*1024*1024;
const fail=code=>{throw Error(`EXPORT_TUS_${code}`);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function safeExportTusUrl(value){
  try{
    const u=new URL(value),e=new URL(EXPORT_TUS_ENDPOINT);
    return u.origin===e.origin&&!u.username&&!u.password&&!u.search&&!u.hash
      &&u.pathname.startsWith(e.pathname+'/')&&u.pathname.length>e.pathname.length+1
      &&u.pathname.length<2048&&!/%2f|%5c|%2e/i.test(u.pathname)&&!u.pathname.includes('//');
  }catch{return false;}
}
function int(value){if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))fail('OFFSET_INVALID');return Number(value);}
function errorCode(error){
  for(let e=error;e;e=e.causingError)if(/^EXPORT_(TUS|STORAGE)_/.test(e.message??''))return e.message;
  return 'EXPORT_TUS_REQUEST_FAILED';
}
async function responseText(response){
  if(Number(response.headers.get('content-length'))>131072){await response.body?.cancel();fail('RESPONSE_TOO_LARGE');}
  const chunks=[];let bytes=0;
  if(response.body)for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>131072)fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks).toString('utf8');
}
export async function transferExportFile({file,receipt,partsStore,serviceRoleKey,fetchImpl=fetch,timeoutMs=120000,
  checkpoint=()=>{},progress=()=>{}}){
  if(partsStore.binding!==receipt.binding||receipt.bucket!=='app-exports'
    ||!/^[0-9a-f]{64}$/.test(receipt.sha256)||!receipt.path.endsWith(`/${receipt.sha256}.xlsx`))fail('BINDING_MISMATCH');
  const name=attempt=>`tus-${receipt.sha256}-${String(attempt).padStart(4,'0')}.json`;
  let latest=null,attempt=0;
  async function mark(stage,value){try{await checkpoint(stage,value);}catch{fail('CHECKPOINT_INTERRUPTED');}}
  function validate(record,index){
    const p=record?.payload;
    if(!p||record.sha256!==digest(p)||p.schema!=='price-export-tus-v1'||p.binding!==receipt.binding
      ||p.path!==receipt.path||p.bucket!==receipt.bucket||p.bytes!==receipt.bytes||p.sha256!==receipt.sha256
      ||p.attempt!==index||!safeExportTusUrl(p.uploadUrl))fail('SESSION_INVALID');
    return p;
  }
  for(let index=1;index<=3;index++){
    const record=await partsStore.readJson(name(index));if(!record)break;
    latest=validate(record,index);attempt=index;
  }
  // TUS SDK's default HEAD error behavior creates new uploads even after auth
  // failures. Our bounded, URL-fenced stack rejects those before SDK handling.
  const httpStack={getName:()=> 'BoundedExportFetch',createRequest(method,url){
    if(!['HEAD','POST','PATCH'].includes(method)
      ||(method==='POST'?url!==EXPORT_TUS_ENDPOINT:!safeExportTusUrl(url)))fail('URL_INVALID');
    const headers={},controller=new AbortController();
    return {getMethod:()=>method,getURL:()=>url,getHeader:key=>headers[key],setHeader:(key,value)=>{headers[key]=value;},
      setProgressHandler:()=>{},getUnderlyingObject:()=>null,abort:async()=>controller.abort(),
      async send(body=null){
        if(method==='POST'&&attempt>=3)fail('SESSION_ATTEMPTS_EXHAUSTED');
        const timer=setTimeout(()=>controller.abort(),timeoutMs);let response,text;
        try{
          response=await fetchImpl(url,{method,headers:{...supabaseApiHeaders(serviceRoleKey),...headers,'x-upsert':'false',
            ...(Number.isSafeInteger(body?.size)?{'Content-Length':String(body.size)}:{})},
            ...(body?{body,duplex:'half'}:{}),redirect:'error',cache:'no-store',signal:controller.signal});
          text=await responseText(response);
        }catch(error){
          if(method==='PATCH'&&!controller.signal.aborted)await mark('patch-response-lost',{offset:int(headers['Upload-Offset'])});
          if(/^EXPORT_TUS_/.test(error?.message))throw error;
          fail(controller.signal.aborted?'REQUEST_TIMEOUT':'REQUEST_FAILED');
        }finally{clearTimeout(timer);}
        const status=response.status;
        if(method==='HEAD'&&[404,410].includes(status))return reply(); // bounded new attempt
        if(status<200||status>299)fail(`HTTP_${status}`);
        if(response.headers.get('Tus-Resumable')!=='1.0.0')fail('VERSION_INVALID');
        if(method==='HEAD'){
          if(int(response.headers.get('Upload-Length'))!==receipt.bytes||int(response.headers.get('Upload-Offset'))>receipt.bytes)fail('HEAD_LENGTH_MISMATCH');
        }else if(method==='POST'){
          if(status!==201)fail('CREATE_STATUS_INVALID');
          const location=response.headers.get('Location');
          const uploadUrl=location?new URL(location,EXPORT_TUS_ENDPOINT).href:'';
          if(!safeExportTusUrl(uploadUrl))fail('URL_INVALID');
          const payload={schema:'price-export-tus-v1',binding:receipt.binding,bucket:receipt.bucket,path:receipt.path,
            bytes:receipt.bytes,sha256:receipt.sha256,uploadUrl,attempt:attempt+1};
          await partsStore.putJsonOnce(name(attempt+1),{payload,sha256:digest(payload)});
          latest=payload;attempt++;
        }else{
          const start=int(headers['Upload-Offset']),offset=int(response.headers.get('Upload-Offset'));
          // FileSource's fs stream.size is the requested SDK slice length.
          if(status!==204||!Number.isSafeInteger(body?.size)||offset!==start+body.size||offset>receipt.bytes)fail('PATCH_OFFSET_INVALID');
          await progress({stage:'transferring',bytes:offset,totalBytes:receipt.bytes});
          await mark('after-patch',{offset,totalBytes:receipt.bytes});
        }
        return reply();
        function reply(){return {getStatus:()=>status,getHeader:key=>response.headers.get(key),getBody:()=>text,getUnderlyingObject:()=>null};}
      },
    };
  }};
  const source=createReadStream(file);
  let upload;
  try{
    await new Promise((resolve,reject)=>{
      upload=new Upload(source,{endpoint:EXPORT_TUS_ENDPOINT,uploadUrl:latest?.uploadUrl??null,uploadSize:receipt.bytes,
        httpStack,chunkSize:EXPORT_TUS_CHUNK,parallelUploads:1,uploadDataDuringCreation:false,
        storeFingerprintForResuming:false,removeFingerprintOnSuccess:false,retryDelays:[100,500],
        metadata:{bucketName:receipt.bucket,objectName:receipt.path,contentType:receipt.contentType,cacheControl:'0'},
        onShouldRetry:error=>/^EXPORT_TUS_(REQUEST_(FAILED|TIMEOUT)|HTTP_(408|429|5\d\d))$/.test(errorCode(error)),
        onError:error=>reject(Error(errorCode(error))),onSuccess:()=>resolve(),
      });
      upload.start();
    });
  }finally{await upload?.abort(false);source.destroy();}
  return {bytes:receipt.bytes}; // never return private upload URL to DBOS/UI
}
