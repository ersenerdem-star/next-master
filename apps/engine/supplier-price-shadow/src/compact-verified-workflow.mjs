// v5 has its own durable history. Never replay v2/v4 under this step order.
import {randomUUID} from 'node:crypto';
import {requireCompleteShadowScan,requireShadowStageReceipt,requireShadowHeartbeatReceipt,
  requireShadowDrainProgress} from './shadow-batch-contract.mjs';
import {requirePublishableSupplierPriceValidation} from './supplier-price-validation-gate.mjs';
import {retryCompactRpcStep} from './compact-rpc-retry.mjs';

export const COMPACT_CHECKPOINT_MAX_BYTES=4096;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;
const positive=(value,max)=>Number.isSafeInteger(value)&&value>0&&value<=max;
const single=response=>{
 if(Array.isArray(response)){
  if(response.length!==1)throw Error('VERIFIED_RECEIPT_CARDINALITY');
  return response[0];
 }
 return response;
};
function bounded(value){
 if(Buffer.byteLength(JSON.stringify(value))>COMPACT_CHECKPOINT_MAX_BYTES)throw Error('VERIFIED_CHECKPOINT_TOO_LARGE');
 return value;
}
function manifest(response,input){
 const r=single(response);
 if(r?.id!==input.releaseId||r.handoff_id!==input.handoffId)throw Error('VERIFIED_MANIFEST_IDENTITY');
 if(!SHA.test(r.source_file_sha256||'')||!positive(Number(r.source_file_bytes),1073741824)
  ||!positive(Number(r.total_rows),10000000)||typeof r.source_file_path!=='string'
  ||r.source_file_path.length>2048||!UUID.test(r.source_file_path.split('/')[0]||'')
  ||r.source_date!=null&&(typeof r.source_date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r.source_date)))
  throw Error('VERIFIED_MANIFEST_INVALID');
 return {id:r.id,handoff_id:r.handoff_id,source_file_path:r.source_file_path,
  source_file_sha256:r.source_file_sha256,source_file_bytes:Number(r.source_file_bytes),
  total_rows:Number(r.total_rows),source_date:r.source_date??null};
}
function preparedReceipt(response,release){
 const validation=requirePublishableSupplierPriceValidation(response?.validation,release.total_rows);
 const prefix=release.source_file_path.split('/')[0]+'/'+release.id+'/';
 const suffix='/manifest.json';
 if(response.bucket!=='supplier-price-prepared'||typeof response.key!=='string'
  ||!response.key.startsWith(prefix)||!response.key.endsWith(suffix)
  ||!SHA.test(response.key.slice(prefix.length,-suffix.length))||!SHA.test(response.sha256||'')
  ||validation.currencyCount!==1)throw Error('VERIFIED_PREPARED_RECEIPT_INVALID');
 // Validation examples, source rows and provider diagnostics never enter history.
 return {bucket:response.bucket,key:response.key,sha256:response.sha256,
  validation:{engine:'duckdb',totalRows:validation.totalRows,currencyCount:1,publishable:true}};
}
function compactClaim(response,release,batchSize){
 const r=single(response);
 if(['busy','lock_waiting'].includes(r?.status))return {status:r.status};
 if(r?.release_id!==release.id)throw Error('VERIFIED_CLAIM_INVALID');
 if(r.status==='complete')return {status:'complete',release_id:r.release_id};
 const start=Number(r.cursor_start),end=Number(r.cursor_end);
 if(r.status!=='claimed'||!UUID.test(r.batch_id||'')||!positive(start,release.total_rows)
  ||!positive(end,release.total_rows)||!positive(end-start+1,batchSize))throw Error('VERIFIED_CLAIM_INVALID');
 return {status:'claimed',release_id:r.release_id,batch_id:r.batch_id,cursor_start:start,cursor_end:end};
}
function staleReceipt(response,claim,releaseField='release_id'){
 const r=single(response);
 if(r?.status!=='stale')return null;
 if(r.batch_id!==claim.batch_id||r[releaseField]!==claim.release_id)throw Error('VERIFIED_STALE_RECEIPT_IDENTITY');
 return {status:'stale',batch_id:r.batch_id,[releaseField]:r[releaseField]};
}
function scanSummary(scan,claim,release,receipt){
 requireCompleteShadowScan(claim,scan,false);
 if(![scan.batchRows,scan.acceptedRows,scan.warningRows,scan.rejectedRows]
   .every(value=>Number.isSafeInteger(value)&&value>=0&&value<=10000)
  ||scan.checksum!==release.source_file_sha256)throw Error('VERIFIED_SCAN_INTEGRITY');
 return {cursorEnd:scan.cursorEnd,batchRows:scan.batchRows,acceptedRows:scan.acceptedRows,
  warningRows:scan.warningRows,rejectedRows:scan.rejectedRows,checksum:scan.checksum,
  preparedManifestSha256:receipt.sha256};
}
// Exported for exact SDK serialization sizing. Only these scalar fields can
// cross the DBOS boundary; rows exist solely inside the scan+stage callback.
export function compactVerifiedStageCheckpoint({scan,claim,release,receipt,stageReceipt}){
 const summary=scanSummary(scan,claim,release,receipt);
 const stale=staleReceipt(stageReceipt,claim,'release_id_result');
 if(stale)return bounded({...summary,stageReceipt:stale});
 const staged=single(stageReceipt);
 requireShadowStageReceipt(staged,claim,scan.batchRows);
 return bounded({...summary,stageReceipt:{status:'staged',batch_id:staged.batch_id,
  release_id_result:staged.release_id_result,staged_rows:Number(staged.staged_rows)}});
}

export function createCompactVerifiedWorkflow({DBOS,rpc,source,requireMode,batchSize,leaseSeconds=120,commercialFields=false}){
 if(!positive(batchSize,10000)||!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600
  ||typeof source?.prepare!=='function'||typeof source?.scan!=='function')throw Error('VERIFIED_WORKFLOW_CONFIG');
 const step=(name,fn)=>DBOS.runStep(async()=>bounded(await retryCompactRpcStep(fn)),{name:commercialFields?name.replace(/-v5$/,'-v6'):name});
 return async input=>{
  requireMode();
  if(!UUID.test(input?.releaseId||'')||!UUID.test(input?.handoffId||''))throw Error('VERIFIED_WORKFLOW_INPUT');
  const getManifest=async()=>manifest(await rpc('get_supplier_price_verified_manifest',{
   input_release_id:input.releaseId,input_handoff_id:input.handoffId}),input);
  const release=await step('compact-source-manifest-v5',getManifest);
  const receipt=await step('compact-source-prepare-v5',async()=>preparedReceipt(await source.prepare({release,batchSize}),release));
  let previousCursor=0,staleCount=0;
  const retryStale=()=>{if(++staleCount>8)throw Error('VERIFIED_REPEATED_STALE_LEASE');};
  for(;;){
   const owner=await step('compact-lease-owner-v5',()=>`verified:${input.handoffId}:${randomUUID()}`);
   const claim=await step('compact-claim-v5',async()=>compactClaim(await rpc('claim_supplier_price_verified_release_batch',{
    input_release_id:input.releaseId,input_handoff_id:input.handoffId,input_worker_id:owner,
    input_batch_size:batchSize,input_lease_seconds:leaseSeconds}),release,batchSize));
   if(['busy','lock_waiting'].includes(claim.status)){await DBOS.sleep(1000);continue;}
   if(claim.status==='complete')break;
   const current=await step('compact-manifest-v5',getManifest);
   if(JSON.stringify(current)!==JSON.stringify(release))throw Error('VERIFIED_MANIFEST_CHANGED');
   const scan=await step('compact-scan-stage-v5',async()=>{
    const rows=await source.scan({release:current,claim,batchSize,receipt});
    requireCompleteShadowScan(claim,rows,true);
    scanSummary(rows,claim,release,receipt);
    if(rows.prepared!==true||rows.sourceRows!==release.total_rows)throw Error('VERIFIED_SCAN_INTEGRITY');
    // SQL checks the active lease and exact existing row contents before its
    // idempotent INSERT. A commit before DBOS checkpoint safely rescans the same
    // immutable partition; an expired owner receives stale and must reclaim.
    const staged=await rpc(commercialFields?'stage_supplier_price_release_batch_v2':'stage_supplier_price_release_batch',{
     input_batch_id:claim.batch_id,input_worker_id:owner,input_rows:rows.rows});
    return compactVerifiedStageCheckpoint({scan:rows,claim,release,receipt,stageReceipt:staged});
   });
   scanSummary(scan,claim,release,receipt);
   if(scan.preparedManifestSha256!==receipt.sha256)throw Error('VERIFIED_SCAN_INTEGRITY');
   if(staleReceipt(scan.stageReceipt,claim,'release_id_result')){retryStale();continue;}
   requireShadowStageReceipt(scan.stageReceipt,claim,scan.batchRows);
   const heartbeat=await step('compact-heartbeat-v5',async()=>{
    const response=await rpc('heartbeat_supplier_price_release_batch',{
     input_batch_id:claim.batch_id,input_worker_id:owner,input_processed_rows:scan.batchRows,
     input_cursor:scan.cursorEnd,input_lease_seconds:leaseSeconds});
    const stale=staleReceipt(response,claim);if(stale)return stale;
    const r=single(response);requireShadowHeartbeatReceipt(r,claim,scan);
    if(r.release_id!==release.id)throw Error('VERIFIED_HEARTBEAT_IDENTITY');
    return {status:'heartbeat',batch_id:r.batch_id,release_id:r.release_id,
     current_cursor:Number(r.current_cursor),processed_rows:Number(r.processed_rows)};
   });
   if(staleReceipt(heartbeat,claim)){retryStale();continue;}
   const finalized=await step('compact-finalize-v5',async()=>{
    const response=await rpc('finalize_supplier_price_release_shadow_batch',{
     input_batch_id:claim.batch_id,input_worker_id:owner,input_processed_rows:scan.batchRows,input_cursor:scan.cursorEnd,
     input_accepted_rows:scan.acceptedRows,input_warning_rows:scan.warningRows,input_rejected_rows:scan.rejectedRows});
    const stale=staleReceipt(response,claim);if(stale)return stale;
    const r=single(response);
    if(r?.release_id!==release.id||r.batch_id!==claim.batch_id||!['parsing','staged','validated'].includes(r.release_status))
     throw Error('VERIFIED_FINALIZE_IDENTITY');
    requireShadowDrainProgress({claim,finalized:r},previousCursor);
    return {status:'finalized',batch_id:r.batch_id,release_id:r.release_id,
     release_status:r.release_status,current_cursor:Number(r.current_cursor)};
   });
   if(staleReceipt(finalized,claim)){retryStale();continue;}
   const progress=requireShadowDrainProgress({claim,finalized},previousCursor);
   if(progress.complete)break;
   previousCursor=progress.cursor;staleCount=0;
  }
  const completed=await step('compact-duckdb-completion-v5',async()=>{
   const row=single(await rpc('complete_supplier_price_release_duckdb_validation',{
    input_release_id:input.releaseId,input_total_rows:receipt.validation.totalRows,
    input_accepted_rows:receipt.validation.totalRows,input_rejected_rows:0,input_warning_rows:0,
    input_conflict_rows:0,input_missing_price_rows:0,input_duplicate_rows:0,
    input_currency_count:receipt.validation.currencyCount}));
   if(row?.status!=='validated'||row.release_id!==input.releaseId)throw Error('VERIFIED_VALIDATION_COMPLETION_UNCONFIRMED');
   return {status:'validated',release_id:row.release_id,publishable:row.publishable===true};
  });
  return {status:'validated',releaseId:input.releaseId,handoffId:input.handoffId,
   publishable:completed.publishable,published:false};
 };
}
