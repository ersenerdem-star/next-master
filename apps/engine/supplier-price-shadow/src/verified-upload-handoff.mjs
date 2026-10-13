// Trusted dedicated-worker boundary. NOT a browser endpoint; no publication.
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {parseNormalizedSupplierPriceRows} from './streaming-csv.mjs';
import {parseNormalizedSupplierPriceRowsFromXlsx} from './streaming-xlsx.mjs';
import {supabaseApiHeaders} from './supabase-headers.mjs';

export const VERIFIED_QUEUE='supplier-price-verified-shadow';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireUuid=x=>{if(!UUID.test(x||''))throw Error('VERIFIED_ID_INVALID');return x;};
const safeInt=(x,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(x)&&x>0&&x<=max;
const identity=id=>'supplier-price-verified:v1:'+requireUuid(id);

export async function verifySupplierPriceUpload({sessionId,organizationId,actorId,rpc,supabaseUrl,serviceRoleKey,
  fetchImpl=fetch,timeoutMs=60000}) {
  [sessionId,organizationId,actorId].forEach(requireUuid);
  if(typeof rpc!=='function'||!serviceRoleKey||!safeInt(timeoutMs,3600000))throw Error('VERIFIED_CONFIG_INVALID');
  const origin=new URL(supabaseUrl);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('VERIFIED_ORIGIN_INVALID');
  const scope={input_session_id:sessionId,input_organization_id:organizationId,input_actor_id:actorId};
  const c=await rpc('begin_supplier_price_upload_verification',scope);
  if(c?.session_id!==sessionId||c.organization_id!==organizationId||c.actor_id!==actorId
    ||!UUID.test(c.release_id||'')||!UUID.test(c.object_id||'')||c.storage_bucket!=='supplier-price-imports'
    ||!safeInt(Number(c.source_file_bytes),1073741824)||!/^[0-9a-f]{64}$/.test(c.source_file_sha256||'')
    ||typeof c.object_version!=='string'||!c.object_version||!Number.isFinite(Date.parse(c.object_updated_at)))throw Error('VERIFIED_CONTEXT_INVALID');
  const path=c.source_file_path;
  const prefix=`${organizationId}/supplier-price/${sessionId}/`;
  if(typeof path!=='string'||!path.startsWith(prefix)||path.slice(prefix.length).includes('/')
    ||path.split('/').some(x=>!x||x==='.'||x==='..')||/[\\\x00-\x1f\x7f]/.test(path)
    ||path.trim()!==path||! /\.(csv|tsv|txt|xlsx)$/i.test(path))throw Error('VERIFIED_PATH_INVALID');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  let dir,stream,parser,bytes=0,rows=0;
  const hash=createHash('sha256');
  try {
    const url=`${origin.origin}/storage/v1/object/${c.storage_bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response=await fetchImpl(url,{headers:supabaseApiHeaders(serviceRoleKey),redirect:'error',signal:controller.signal});
    if(!response.ok||!response.body){await response.body?.cancel?.().catch(()=>{});throw Error(`VERIFIED_DOWNLOAD_FAILED:${response.status}`);}
    stream=typeof response.body.getReader==='function'?Readable.fromWeb(response.body):response.body;
    dir=await mkdtemp(join(tmpdir(),'supplier-price-verify-'));
    const file=join(dir,/\.xlsx$/i.test(path)?'source.xlsx':'source.csv');
    await pipeline(stream,new Transform({transform(chunk,_encoding,done){
      bytes+=chunk.length;
      if(bytes>Number(c.source_file_bytes)){done(Error('VERIFIED_SIZE_EXCEEDED'));return;}
      hash.update(chunk);done(null,chunk);
    }}),createWriteStream(file),{signal:controller.signal});
    if(bytes!==Number(c.source_file_bytes))throw Error('VERIFIED_SIZE_MISMATCH');
    if(hash.digest('hex')!==c.source_file_sha256)throw Error('VERIFIED_CHECKSUM_MISMATCH');
    // Single streaming parse; never materialize a workbook/all rows in RAM.
    parser=/\.xlsx$/i.test(path)?parseNormalizedSupplierPriceRowsFromXlsx(file)
      :parseNormalizedSupplierPriceRows(createReadStream(file));
    for await(const row of parser){
      controller.signal.throwIfAborted();rows++;
      if(!safeInt(rows)||row.source_row_number!==rows)throw Error('VERIFIED_ROW_SEQUENCE_INVALID');
    }
    controller.signal.throwIfAborted();
    if(!safeInt(rows))throw Error('VERIFIED_EMPTY_SOURCE');
    // SQL rechecks live Storage fingerprint, actor, session and tenant before
    // atomically sealing completion + outbox. Lost response is UNKNOWN, not fail.
    let receipt;
    try {receipt=await rpc('complete_supplier_price_verified_upload',{...scope,input_object_id:c.object_id,
      input_object_version:c.object_version,input_object_updated_at:c.object_updated_at,
      input_source_bytes:bytes,input_source_sha256:c.source_file_sha256,input_total_rows:rows});}
    catch(error){throw new Error(`VERIFIED_COMPLETION_UNCONFIRMED:${sessionId}`,{cause:error});}
    if(receipt?.status!=='verified'||receipt.session_id!==sessionId||receipt.release_id!==c.release_id
      ||!UUID.test(receipt.handoff_id||'')||receipt.workflow_id!==identity(c.release_id)||receipt.queue_name!==VERIFIED_QUEUE
      ||Number(receipt.source_bytes)!==bytes||receipt.source_sha256!==c.source_file_sha256
      ||Number(receipt.total_rows)!==rows||receipt.published!==false)throw Error(`VERIFIED_RECEIPT_UNCONFIRMED:${sessionId}`);
    return receipt;
  } finally {
    clearTimeout(timer);controller.abort();stream?.destroy?.();
    await parser?.return?.().catch(()=>{});
    if(dir)await rm(dir,{recursive:true,force:true}); // Only this invocation's owned temp directory.
  }
}

export async function dispatchVerifiedSupplierPriceHandoff({rpc,startWorkflow,workerId,leaseSeconds=120,expectedReleaseId}) {
  if(typeof rpc!=='function'||typeof startWorkflow!=='function'||!workerId||workerId.trim()!==workerId
    ||workerId.length>200||!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600
    ||expectedReleaseId!==undefined&&!UUID.test(expectedReleaseId))throw Error('VERIFIED_DISPATCH_CONFIG');
  const job=await rpc('claim_supplier_price_verified_handoff',{input_worker_id:workerId,input_lease_seconds:leaseSeconds});
  if(job?.status==='empty')return {status:'empty',published:false};
  if(job?.status!=='claimed'||!UUID.test(job.handoff_id||'')||!UUID.test(job.release_id||'')
    ||!UUID.test(job.lease_token||'')||job.queue_name!==VERIFIED_QUEUE||job.workflow_id!==identity(job.release_id)
    ||!safeInt(job.attempt)||!Number.isFinite(Date.parse(job.lease_expires_at)))throw Error('VERIFIED_JOB_INVALID');
  // Fixed canonical arguments, no attempt/token/clock in workflow identity or input.
  if(expectedReleaseId!==undefined&&job.release_id!==expectedReleaseId)throw Error('VERIFIED_UNEXPECTED_RELEASE_NOT_ENQUEUED');
  const input={releaseId:job.release_id,handoffId:job.handoff_id};
  let handle;
  try {handle=await startWorkflow({workflowID:job.workflow_id,queueName:VERIFIED_QUEUE,input});}
  catch(error){throw new Error(`VERIFIED_ENQUEUE_UNCONFIRMED:${job.workflow_id}`,{cause:error});}
  if(handle?.workflowID!==job.workflow_id)throw Error(`VERIFIED_ENQUEUE_UNCONFIRMED:${job.workflow_id}`);
  const args={input_handoff_id:job.handoff_id,input_worker_id:workerId,input_lease_token:job.lease_token,input_workflow_id:job.workflow_id};
  let ack;
  try {ack=await rpc('ack_supplier_price_verified_handoff',args);}
  catch(error){throw new Error(`VERIFIED_ACK_UNCONFIRMED:${job.workflow_id}`,{cause:error});}
  if(ack?.status!=='enqueued'||ack.handoff_id!==job.handoff_id||ack.workflow_id!==job.workflow_id||ack.published!==false)throw Error('VERIFIED_ACK_INVALID');
  // Enqueued is NOT completed/validated/published. DBOS recovery remains responsible.
  return {...ack,input};
}
