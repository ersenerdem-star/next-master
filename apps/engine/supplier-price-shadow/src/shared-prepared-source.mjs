// Backend-only immutable Storage adapter. No publication or Storage metadata
// writes. A private SQL receipt records a verified full source compatibility scan.
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareSupplierPricePartitions,scanPreparedSupplierPriceBatch} from './prepared-partitions.mjs';
import {supabaseApiHeaders} from './supabase-headers.mjs';
import {validateCsvWithDuckDB,requirePublishableSupplierPriceValidation} from './duckdb-validation.mjs';
import {SUPPLIER_SOURCE_COMPATIBILITY_POLICY} from './streaming-csv.mjs';

export const PREPARED_BUCKET='supplier-price-prepared';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;
const MAX_MANIFEST=8*1024*1024,MAX_PART=32*1024*1024;
const PART_UPLOAD_CONCURRENCY=4;
const MAX_READ_ATTEMPTS=5,READ_BACKOFF_MS=250;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
function binding(release,batchSize){
 const path=release?.source_file_path;
 if(!UUID.test(release?.id||'')||!UUID.test(release?.handoff_id||'')||!SHA.test(release?.source_file_sha256||'')
  ||!positive(Number(release?.source_file_bytes),1073741824)||!positive(Number(release?.total_rows),10000000)
  ||!positive(batchSize,10000)||typeof path!=='string'||!UUID.test(path.split('/')[0]||'')
  ||path.trim()!==path||path.split('/').some(s=>!s||s==='.'||s==='..')||/[\\\x00-\x1f\x7f]/.test(path)
  ||! /\.(csv|tsv|txt|xlsx)$/i.test(path))throw Error('SHARED_PREPARED_BINDING_INVALID');
 const date=release.source_date?String(release.source_date).slice(0,10):null;
 if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('SHARED_PREPARED_DATE_INVALID');
 const context={contract:'supplier-price-normalized-parts-v2',release_id:release.id,handoff_id:release.handoff_id,
  source_path:path,source_sha256:release.source_file_sha256,source_bytes:Number(release.source_file_bytes),
  total_rows:Number(release.total_rows),source_date:date,batch_size:batchSize};
 const prefix=`${path.split('/')[0]}/${release.id}/${digest(JSON.stringify(context))}`;
 return {context,prefix,key:prefix+'/manifest.json'};
}
export function validateSharedPreparedManifest(manifest,release,batchSize){
 const {context,prefix,key}=binding(release,batchSize);
 if(!manifest||manifest.version!==1||Object.entries(context).some(([k,v])=>manifest[k]!==v)
  ||manifest.input_path!=null||!Array.isArray(manifest.partitions)
  ||manifest.partitions.length!==Math.ceil(context.total_rows/batchSize))throw Error('SHARED_PREPARED_MANIFEST_INVALID');
 let cursor=1;
 for(const [i,p] of manifest.partitions.entries()){
  const end=Math.min(context.total_rows,cursor+batchSize-1);
  const name=`part-${String(i+1).padStart(6,'0')}-${cursor}-${end}.jsonl`;
  if(p.batch_number!==i+1||p.cursor_start!==cursor||p.cursor_end!==end||p.row_count!==end-cursor+1
   ||p.path!==name||!SHA.test(p.sha256||''))throw Error('SHARED_PREPARED_COVERAGE_INVALID');
  cursor=end+1;
 }
 if(cursor!==context.total_rows+1)throw Error('SHARED_PREPARED_COVERAGE_INVALID');
 return {prefix,key};
}

export function createSharedPreparedSource({supabaseUrl,serviceRoleKey,fetchImpl=fetch,timeoutMs=60000}){
 const origin=new URL(supabaseUrl);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash
  ||!serviceRoleKey||typeof fetchImpl!=='function'||!positive(timeoutMs,3600000))throw Error('SHARED_PREPARED_CONFIG_INVALID');
 const objectUrl=(bucket,path)=>`${origin.origin}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
 async function request(url,options={}){
  return fetchImpl(url,{...options,headers:{...supabaseApiHeaders(serviceRoleKey),...options.headers},
   redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 }
 async function boundedBody(response,max){
  if(!response.body)throw Error('SHARED_PREPARED_BODY_MISSING');
  const chunks=[];let size=0;
  const stream=typeof response.body.getReader==='function'?Readable.fromWeb(response.body):response.body;
  try{for await(const bytes of stream){size+=bytes.length;if(size>max)throw Error('SHARED_PREPARED_SIZE_EXCEEDED');chunks.push(Buffer.from(bytes));}}
  finally{stream.destroy?.();}
  return Buffer.concat(chunks,size);
 }
 async function matchesBody(response,expected,max){
  if(!response.body)throw Error('SHARED_PREPARED_BODY_MISSING');
  const stream=typeof response.body.getReader==='function'?Readable.fromWeb(response.body):response.body;
  let offset=0,matches=true;
  try{for await(const bytes of stream){
   const end=offset+bytes.length;
   if(end>max)throw Error('SHARED_PREPARED_SIZE_EXCEEDED');
   if(end>expected.length||!expected.subarray(offset,end).equals(bytes))matches=false;
   offset=end;
  }}finally{stream.destroy?.();}
  return matches&&offset===expected.length;
 }
 const transientStatus=status=>status===408||status===425||status===429||status>=500&&status<=599;
 const transientError=error=>/AbortError|TimeoutError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR/i.test(String(error?.name||'')+' '+String(error?.code||''));
 async function get(path,max,expected){
  let lastStatus=null;
  for(let attempt=1;attempt<=MAX_READ_ATTEMPTS;attempt++){
   let r;
   try{r=await request(objectUrl(PREPARED_BUCKET,path));}
   catch(error){
    if(!transientError(error)||attempt===MAX_READ_ATTEMPTS)throw Error('SHARED_PREPARED_READ_FAILED:NETWORK');
    await delay(READ_BACKOFF_MS*2**(attempt-1));continue;
   }
   if(!r.ok){
    lastStatus=r.status;
    if(transientStatus(r.status)){
     await r.body?.cancel?.();
     if(attempt<MAX_READ_ATTEMPTS){await delay(READ_BACKOFF_MS*2**(attempt-1));continue;}
     throw Error(`SHARED_PREPARED_READ_FAILED:${r.status}`);
    }
    const raw=(await boundedBody(r,4096)).toString();let b;try{b=JSON.parse(raw);}catch{}
    // Storage can report object-not-found as HTTP 400 with an internal 404.
    // Never interpret auth, bucket-not-found or an arbitrary 400 as absence.
    if(r.status===404||r.status===400&&String(b?.statusCode)==='404'&&/Object not found|not_found|NoSuchKey/i.test(String(b?.error)+' '+String(b?.message)))return null;
    throw Error(`SHARED_PREPARED_READ_FAILED:${r.status}`);
   }
   try{return expected?await matchesBody(r,expected,max):await boundedBody(r,max);}
   catch(error){
    if(!transientError(error)||attempt===MAX_READ_ATTEMPTS)throw Error('SHARED_PREPARED_READ_FAILED:NETWORK');
    await delay(READ_BACKOFF_MS*2**(attempt-1));
   }
  }
  throw Error(`SHARED_PREPARED_READ_FAILED:${lastStatus||'NETWORK'}`);
 }
 async function privateBucket(){
  const r=await request(`${origin.origin}/storage/v1/bucket/${PREPARED_BUCKET}`);
  if(!r.ok){await r.body?.cancel?.();throw Error(`SHARED_PREPARED_BUCKET_UNAVAILABLE:${r.status}`);}
  const b=JSON.parse((await boundedBody(r,4096)).toString());
  if(b.id!==PREPARED_BUCKET||b.public!==false)throw Error('SHARED_PREPARED_BUCKET_NOT_PRIVATE');
 }
 async function recordCompatibility(context){
  const payload={input_release_id:context.release_id,input_handoff_id:context.handoff_id,
   input_source_sha256:context.source_sha256,input_total_rows:context.total_rows,
   input_policy:SUPPLIER_SOURCE_COMPATIBILITY_POLICY};
  let r,receipt;
  try{
   r=await request(`${origin.origin}/rest/v1/rpc/record_supplier_price_source_compatibility`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
   receipt=JSON.parse((await boundedBody(r,4096)).toString());
  }catch{throw Error('SHARED_PREPARED_SOURCE_COMPATIBILITY_UNCONFIRMED');}
  if(!r.ok||!['recorded','replayed'].includes(receipt?.status)
   ||receipt.release_id!==context.release_id||receipt.source_sha256!==context.source_sha256
   ||receipt.total_rows!==context.total_rows||receipt.policy!==SUPPLIER_SOURCE_COMPATIBILITY_POLICY)
   throw Error('SHARED_PREPARED_SOURCE_COMPATIBILITY_UNCONFIRMED');
 }
 async function putExact(path,bytes,type,max){
  if(!bytes.length||bytes.length>max)throw Error('SHARED_PREPARED_SIZE_EXCEEDED');
  // Exact streamed readback avoids a second whole-part buffer per uploader.
  const existing=await get(path,max,bytes);
  if(existing!==null){if(!existing)throw Error('SHARED_PREPARED_IMMUTABLE_CONFLICT');return;}
  let r;
  try{r=await request(objectUrl(PREPARED_BUCKET,path),{method:'POST',headers:{'content-type':type,'x-upsert':'false'},body:bytes});}
  catch(error){
   // Acceptance can be unknown. Same identity is recovered by exact readback.
   const recovered=await get(path,max,bytes);
   if(recovered===true)return;
   throw Error('SHARED_PREPARED_UPLOAD_UNCONFIRMED',{cause:error});
  }
  await r.body?.cancel?.();
  const actual=await get(path,max,bytes);
  if(actual!==true)throw Error(r.ok?'SHARED_PREPARED_READBACK_MISMATCH':`SHARED_PREPARED_UPLOAD_FAILED:${r.status}`);
 }
 async function load(release,batchSize,receipt){
  const {key}=binding(release,batchSize);
  if(receipt&&(receipt.key!==key||receipt.bucket!==PREPARED_BUCKET||!SHA.test(receipt.sha256||'')))throw Error('SHARED_PREPARED_RECEIPT_INVALID');
  const bytes=await get(key,MAX_MANIFEST);
  if(!bytes)return null;
  if(receipt&&digest(bytes)!==receipt.sha256)throw Error('SHARED_PREPARED_MANIFEST_CHECKSUM_MISMATCH');
  const manifest=JSON.parse(bytes.toString());validateSharedPreparedManifest(manifest,release,batchSize);
  return {manifest,receipt:{bucket:PREPARED_BUCKET,key,sha256:digest(bytes)}};
 }
 return {
  async prepare({release,batchSize}){
   const {context,prefix,key}=binding(release,batchSize);
   await privateBucket();
   const ready=await load(release,batchSize);
   const dir=await mkdtemp(join(tmpdir(),'supplier-price-shared-'));
   try{
    const file=join(dir,/\.xlsx$/i.test(context.source_path)?'source.xlsx':'source.csv');
    const r=await request(objectUrl('supplier-price-imports',context.source_path));
    if(!r.ok||!r.body){await r.body?.cancel?.();throw Error(`SHARED_PREPARED_SOURCE_FAILED:${r.status}`);}
    const input=typeof r.body.getReader==='function'?Readable.fromWeb(r.body):r.body;
    const hash=createHash('sha256');let bytes=0;
    await pipeline(input,new Transform({transform(chunk,_encoding,done){
     bytes+=chunk.length;if(bytes>context.source_bytes){done(Error('SHARED_PREPARED_SOURCE_SIZE_EXCEEDED'));return;}
     hash.update(chunk);done(null,chunk);
    }}),createWriteStream(file,{flags:'wx',mode:0o600}));
    if(bytes!==context.source_bytes||hash.digest('hex')!==context.source_sha256)throw Error('SHARED_PREPARED_SOURCE_MISMATCH');
    const validation=await validateCsvWithDuckDB({inputPath:file,sourceDate:context.source_date,
      memoryLimit:'512MB',threads:4,tempDirectory:dir});
    requirePublishableSupplierPriceValidation(validation,context.total_rows);
    // This runs only after downloading/checksumming and parsing ALL original
    // CSV/XLSX rows. A cached manifest or replayed DBOS step is not scan proof.
    // Retry uses the same immutable receipt identity; unknown outcomes stop.
    await recordCompatibility(context);
    if(ready)return {...ready.receipt,validation};
    const prepared=await prepareSupplierPricePartitions({inputPath:file,outputDir:join(dir,'parts'),batchSize,
     sourceDate:context.source_date,expectedRows:context.total_rows,expectedChecksum:context.source_sha256,
     releaseId:context.release_id,sourcePath:context.source_path});
    const {input_path:_local,...m}=prepared.manifest;
    const manifest={...m,...context};validateSharedPreparedManifest(manifest,release,batchSize);
    let nextPart=0,uploadError;
    const uploadParts=async()=>{
     while(!uploadError){
      const part=manifest.partitions[nextPart++];if(!part)return;
      try{
       const filePath=join(dir,'parts',part.path);
       if((await stat(filePath)).size>MAX_PART)throw Error('SHARED_PREPARED_PART_TOO_LARGE');
       const bytes=await readFile(filePath);
       if(digest(bytes)!==part.sha256)throw Error('SHARED_PREPARED_LOCAL_PART_CHANGED');
       await putExact(prefix+'/'+part.path,bytes,'application/x-ndjson',MAX_PART);
      }catch(error){uploadError??=error;return;}
     }
    };
    // Four workers hold at most four MAX_PART buffers. Stop assigning parts
    // on failure, but settle every in-flight read/upload before temp cleanup.
    await Promise.all(Array.from({length:Math.min(PART_UPLOAD_CONCURRENCY,manifest.partitions.length)},uploadParts));
    if(uploadError)throw uploadError;
    // Ready marker LAST. A partial upload cannot be used by the row worker.
    await putExact(key,Buffer.from(JSON.stringify(manifest)+'\n'),'application/json',MAX_MANIFEST);
    return {...(await load(release,batchSize)).receipt,validation};
   }finally{await rm(dir,{recursive:true,force:true});} // Only owned invocation tempfile.
  },
  async scan({release,claim,batchSize,receipt}){
   const ready=await load(release,batchSize,receipt);
   if(!ready)throw Error('SHARED_PREPARED_NOT_READY');
   const {prefix}=validateSharedPreparedManifest(ready.manifest,release,batchSize);
   if(!positive(claim?.cursor_start,ready.manifest.total_rows)||!positive(claim?.cursor_end,ready.manifest.total_rows)
    ||claim.cursor_end<claim.cursor_start||claim.cursor_end-claim.cursor_start+1>batchSize)throw Error('SHARED_PREPARED_CLAIM_INVALID');
   const dir=await mkdtemp(join(tmpdir(),'supplier-price-shared-scan-'));
   try{
    for(const part of ready.manifest.partitions){
     if(part.cursor_end<claim.cursor_start||part.cursor_start>claim.cursor_end)continue;
     const bytes=await get(prefix+'/'+part.path,MAX_PART);
     if(!bytes||digest(bytes)!==part.sha256)throw Error('SHARED_PREPARED_PART_CHECKSUM_MISMATCH');
     await writeFile(join(dir,part.path),bytes,{flag:'wx',mode:0o600});
    }
    const manifestPath=join(dir,'manifest.json');
    await writeFile(manifestPath,JSON.stringify(ready.manifest),{flag:'wx',mode:0o600});
    return await scanPreparedSupplierPriceBatch({release,claim,manifestPath,includeRows:true});
   }finally{await rm(dir,{recursive:true,force:true});}
  },
 };
}
