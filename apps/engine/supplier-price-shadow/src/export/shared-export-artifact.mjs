// C2b server-only completed artifact adapter. No provisioning, signing or UI access.
import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createExportPartsStore,EXPORT_PARTS_V3_URL} from './shared-export-parts.mjs';
import {exportSpec,exportBinding} from './partitioned-price-export.mjs';
import {supabaseApiHeaders} from '../supabase-headers.mjs';
import {transferExportFile,EXPORT_TUS_CHUNK} from './resumable-export-transfer.mjs';

export const EXPORT_ARTIFACT_BUCKET='app-exports';
const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fail=code=>{throw Error(`EXPORT_ARTIFACT_${code}`);};
const hash=value=>createHash('sha256').update(value).digest('hex');
function parse(text){try{return JSON.parse(text);}catch{fail('INVALID_JSON');}}
async function boundedText(response){
  if(Number(response.headers.get('content-length'))>131072){await response.body?.cancel();fail('RESPONSE_TOO_LARGE');}
  if(!response.body)return '';
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>131072)fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks).toString('utf8');
}
function classified(reply,status,errors){
  if(![400,status].includes(reply.status))return false;
  const body=parse(reply.text);return String(body.statusCode)===String(status)&&errors.includes(body.error);
}
export function createExportArtifactStore({
  supabaseUrl,serviceRoleKey,input,fetchImpl=fetch,timeoutMs=120000,maxBytes=1024*1024*1024,
  expectedSupabaseUrl=EXPORT_PARTS_V3_URL,
  expectedProjectRef='kaxsqafdevabkxofwdod',
  targetError='EXACT_TARGET_REQUIRED',
}) {
  // Reuse exact-target/key/scope checks and private receipt namespace from C2a.
  const parts=createExportPartsStore({supabaseUrl,serviceRoleKey,input,fetchImpl,timeoutMs,
    expectedSupabaseUrl,expectedProjectRef,targetError});
  const spec=exportSpec(input),binding=exportBinding(input);
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024*1024)fail('BYTE_BUDGET_INVALID');
  const prefix=`${spec.tenantId}/price-export-v1/${binding}/`;
  const objectPath=sha=>`${prefix}${sha}.xlsx`;
  let initialized=false;
  async function request(path,init={},read=boundedText){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(`${supabaseUrl}${path}`,{...init,
        headers:{...supabaseApiHeaders(serviceRoleKey),...init.headers},redirect:'error',cache:'no-store',signal:controller.signal});
      return await read(response);
    }catch(error){
      if(/^EXPORT_(ARTIFACT|STORAGE)_/.test(error?.message))throw error;
      fail(controller.signal.aborted?'REQUEST_TIMEOUT':'REQUEST_FAILED');
    }finally{clearTimeout(timer);}
  }
  async function initialize(){
    if(initialized)return;
    await parts.initialize();
    const body=await request(`/storage/v1/bucket/${EXPORT_ARTIFACT_BUCKET}`,{},async response=>{
      if(response.status!==200){await response.body?.cancel();fail(`BUCKET_HTTP_${response.status}`);}
      return parse(await boundedText(response));
    });
    if(body.id!==EXPORT_ARTIFACT_BUCKET||body.public!==false)fail('PRIVATE_BUCKET_REQUIRED');
    initialized=true;
  }
  function validate(value){
    const keys=['schema','binding','bucket','path','rows','sheets','bytes','sha256','contentType'];
    if(!value||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))
      ||value.schema!=='shared-price-export-ready-v1'||value.binding!==binding||value.bucket!==EXPORT_ARTIFACT_BUCKET
      ||!/^[0-9a-f]{64}$/.test(value.sha256)||value.path!==objectPath(value.sha256)
      ||value.rows!==spec.expectedRows||value.sheets!==Math.ceil(spec.expectedRows/spec.sheetRows)
      ||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>maxBytes||value.contentType!==MIME)fail('RECEIPT_INVALID');
    return Object.freeze(value);
  }
  async function remoteHash(receipt){
    return request(`/storage/v1/object/${EXPORT_ARTIFACT_BUCKET}/${receipt.path}`,{},async response=>{
      if(response.status!==200){
        const reply={status:response.status,text:await boundedText(response)};
        if(classified(reply,404,['not_found','Not Found']))return null;
        fail(`READ_HTTP_${response.status}`);
      }
      const length=response.headers.get('content-length');
      if(length!=null&&(!/^\d+$/.test(length)||Number(length)!==receipt.bytes)){
        await response.body?.cancel();fail('FILE_SIZE_MISMATCH');
      }
      const digest=createHash('sha256');let bytes=0;
      if(!response.body)fail('EMPTY_FILE');
      // Streaming readback: never accumulate a million-row workbook in memory.
      for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>receipt.bytes)fail('FILE_SIZE_MISMATCH');digest.update(chunk);}
      if(bytes!==receipt.bytes||digest.digest('hex')!==receipt.sha256)fail('FILE_HASH_MISMATCH');
      return receipt;
    });
  }
  async function readReceipt(name){
    await initialize();
    const envelope=await parts.readJson(name);if(envelope==null)return null;
    const value=validate(envelope.payload);
    if(envelope.sha256!==hash(JSON.stringify(value)))fail('RECEIPT_HASH_MISMATCH');
    if(!await remoteHash(value))fail('READY_FILE_MISSING');
    return value;
  }
  const readReady=()=>readReceipt('artifact-ready.json');
  async function putReceipt(name,candidate){
    const envelope={payload:candidate,sha256:hash(JSON.stringify(candidate))};
    try{await parts.putJsonOnce(name,envelope);}
    catch(error){
      // Concurrent ZIP timestamps may differ. Only accept verified winner.
      if(error.message!=='EXPORT_STORAGE_IMMUTABLE_WRITE_CONFLICT')throw error;
      const winner=await readReceipt(name);if(!winner)throw error;return winner;
    }
    const verified=await readReceipt(name);if(!verified)fail('READY_COMMIT_MISSING');return verified;
  }
  async function resumeUploaded(){
    const ready=await readReady();if(ready)return ready;
    const uploaded=await readReceipt('artifact-uploaded.json');
    return uploaded?putReceipt('artifact-ready.json',uploaded):null;
  }
  async function commit({file,receipt,afterFile,afterReady,afterTransfer,progress}){
    const ready=await resumeUploaded();if(ready)return ready;
    if(!receipt||receipt.binding!==binding)fail('LOCAL_RECEIPT_BINDING_MISMATCH');
    const candidate=validate({schema:'shared-price-export-ready-v1',binding,bucket:EXPORT_ARTIFACT_BUCKET,
      path:objectPath(receipt.sha256),rows:receipt.rows,sheets:receipt.sheets,bytes:receipt.bytes,sha256:receipt.sha256,contentType:MIME});
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==candidate.bytes)fail('LOCAL_FILE_INVALID');
    const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);
    if(digest.digest('hex')!==candidate.sha256)fail('LOCAL_HASH_MISMATCH');
    if(!await remoteHash(candidate)){
      if(candidate.bytes>EXPORT_TUS_CHUNK){
        await transferExportFile({file,receipt:candidate,partsStore:parts,serviceRoleKey,fetchImpl,timeoutMs,
          checkpoint:afterTransfer,progress});
      }else{
      const stream=createReadStream(file);
      let reply;
      try{reply=await request(`/storage/v1/object/${EXPORT_ARTIFACT_BUCKET}/${candidate.path}`,{
        method:'POST',headers:{'Content-Type':MIME,'Content-Length':String(candidate.bytes),'x-upsert':'false'},body:stream,duplex:'half',
      },async response=>({status:response.status,text:await boundedText(response)}));}
      finally{stream.destroy();}
      if(![200,201].includes(reply.status)&&!classified(reply,409,['Duplicate','Conflict']))fail(`WRITE_HTTP_${reply.status}`);
      }
      if(!await remoteHash(candidate))fail('WRITE_READBACK_MISSING');
    }
    // This worker-private candidate checkpoint prevents rebuilding a completed
    // verified ZIP when killed before the final ready decision. It grants no URL.
    const uploaded=await putReceipt('artifact-uploaded.json',candidate);
    await afterFile?.(uploaded);
    const verified=await putReceipt('artifact-ready.json',uploaded);
    await afterReady?.(verified);
    return verified;
  }
  return Object.freeze({binding,bucket:EXPORT_ARTIFACT_BUCKET,initialize,readReady,resumeUploaded,commit});
}

export function createV3ExportArtifactStore(options) {
  return createExportArtifactStore({
    ...options,
    expectedSupabaseUrl: EXPORT_PARTS_V3_URL,
    expectedProjectRef: 'kaxsqafdevabkxofwdod',
    targetError: 'EXACT_V3_REQUIRED',
  });
}
