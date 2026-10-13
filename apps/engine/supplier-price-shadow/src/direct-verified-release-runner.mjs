import {requireCompleteShadowScan,requireShadowDrainProgress,requireShadowStageReceipt,requireShadowHeartbeatReceipt} from './shadow-batch-contract.mjs';
const input_validation_missing=value=>Number(value?.missingPriceRows||0);
const first=value=>Array.isArray(value)?value[0]:value;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Direct staging runner. Supabase leases are the recovery boundary; DBOS is not
// required to admit or advance a supplier release.
export async function runDirectVerifiedRelease({rpc,source,releaseId,handoffId,workerId,batchSize=1000,leaseSeconds=120}){
 if(typeof rpc!=='function'||typeof source?.prepare!=='function'||typeof source?.scan!=='function'||!UUID.test(releaseId||'')||!UUID.test(handoffId||''))throw Error('DIRECT_RUNNER_INPUT');
 const manifest=await rpc('get_supplier_price_verified_manifest',{input_release_id:releaseId,input_handoff_id:handoffId});
 if(manifest?.id!==releaseId||manifest.handoff_id!==handoffId)throw Error('DIRECT_RUNNER_MANIFEST');
 const prepared=await source.prepare({release:manifest,batchSize,validateExisting:true});
 if(prepared?.validation){
  const missing=input_validation_missing(prepared.validation);
  await rpc('complete_supplier_price_release_duckdb_validation',{input_release_id:releaseId,input_total_rows:prepared.validation.totalRows,input_accepted_rows:prepared.validation.totalRows-missing,input_rejected_rows:missing,input_warning_rows:0,input_conflict_rows:prepared.validation.duplicateRows,input_missing_price_rows:missing,input_duplicate_rows:prepared.validation.duplicateRows,input_currency_count:prepared.validation.currencyCount});
 }
 let previousCursor=0;
 for(;;){
  const claim=first(await rpc('claim_supplier_price_verified_release_batch',{input_release_id:releaseId,input_handoff_id:handoffId,input_worker_id:workerId,input_batch_size:batchSize,input_lease_seconds:leaseSeconds}));
  if(['busy','lock_waiting'].includes(claim?.status)){await new Promise(r=>setTimeout(r,1000));continue;}
  if(claim?.status==='complete')return {status:'staged',releaseId,handoffId,published:false};
  if(claim?.status!=='claimed'||claim.release_id!==releaseId)throw Error('DIRECT_RUNNER_CLAIM');
  const scan=await source.scan({release:manifest,claim,batchSize,receipt:prepared});
  requireCompleteShadowScan(claim,scan,true);
  const staged=await rpc('stage_supplier_price_release_batch',{input_batch_id:claim.batch_id,input_worker_id:workerId,input_rows:scan.rows});
  if(first(staged)?.status==='stale')continue;
  requireShadowStageReceipt(staged,claim,scan.batchRows);
  const heartbeat=await rpc('heartbeat_supplier_price_release_batch',{input_batch_id:claim.batch_id,input_worker_id:workerId,input_processed_rows:scan.batchRows,input_cursor:scan.cursorEnd,input_lease_seconds:leaseSeconds});
  if(first(heartbeat)?.status==='stale')continue;
  requireShadowHeartbeatReceipt(heartbeat,claim,scan);
  const finalized=await rpc('finalize_supplier_price_release_shadow_batch',{input_batch_id:claim.batch_id,input_worker_id:workerId,input_processed_rows:scan.batchRows,input_cursor:scan.cursorEnd,input_accepted_rows:scan.acceptedRows,input_warning_rows:scan.warningRows,input_rejected_rows:scan.rejectedRows});
  if(first(finalized)?.status==='stale')continue;
  const progress=requireShadowDrainProgress({claim,finalized},previousCursor);
  if(progress.complete)return {status:'staged',releaseId,handoffId,published:false};
  previousCursor=progress.cursor;
 }
}
