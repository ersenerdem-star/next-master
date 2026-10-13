// Version 2 durable step order. Keep v1 pending workflows on their old version.
import {randomUUID} from 'node:crypto';
import {requireCompleteShadowScan,requireShadowStageReceipt,requireShadowHeartbeatReceipt,requireShadowDrainProgress} from './shadow-batch-contract.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first=x=>Array.isArray(x)?x[0]:x;
function stale(response,claim,releaseField='release_id'){
 const r=first(response);
 if(r?.status!=='stale')return false;
 if(Array.isArray(response)&&response.length!==1||r.batch_id!==claim.batch_id||r[releaseField]!==claim.release_id)
  throw Error('VERIFIED_STALE_RECEIPT_IDENTITY');
 return true;
}
export function createVerifiedReleaseWorkflow({DBOS,rpc,scanSource,requireMode,batchSize,leaseSeconds=120}){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>10000||!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600)
  throw Error('VERIFIED_WORKFLOW_CONFIG');
 return async input=>{
  requireMode();
  if(!uuid.test(input?.releaseId||'')||!uuid.test(input?.handoffId||''))throw Error('VERIFIED_WORKFLOW_INPUT');
  let previousCursor=0,staleCount=0;
  for(;;){
   // Unique attempt owner is nondeterministic I/O INSIDE a durable step. Its
   // value replays until this attempt ends; a reclaimed attempt gets a new one.
   const owner=await DBOS.runStep(()=>`verified:${input.handoffId}:${randomUUID()}`,{name:'verified-lease-owner-v2'});
   const claim=first(await DBOS.runStep(()=>rpc('claim_supplier_price_verified_release_batch',{
    input_release_id:input.releaseId,input_handoff_id:input.handoffId,input_worker_id:owner,
    input_batch_size:batchSize,input_lease_seconds:leaseSeconds}),{name:'verified-claim-v2'}));
   if(['busy','lock_waiting'].includes(claim?.status)){await DBOS.sleep(1000);continue;}
   if(claim?.status==='complete')return {status:'staged',releaseId:input.releaseId,handoffId:input.handoffId,published:false};
   if(claim?.status!=='claimed'||claim.release_id!==input.releaseId||!uuid.test(claim.batch_id||''))throw Error('VERIFIED_CLAIM_INVALID');
   const release=await DBOS.runStep(()=>rpc('get_supplier_price_verified_manifest',{
    input_release_id:input.releaseId,input_handoff_id:input.handoffId}),{name:'verified-manifest-v2'});
   if(release?.id!==input.releaseId||release.handoff_id!==input.handoffId)throw Error('VERIFIED_MANIFEST_IDENTITY');
   const scan=await DBOS.runStep(()=>scanSource({release,claim}),{name:'verified-scan-v2'});
   requireCompleteShadowScan(claim,scan,true);
   const staged=await DBOS.runStep(()=>rpc('stage_supplier_price_release_batch',{
    input_batch_id:claim.batch_id,input_worker_id:owner,input_rows:scan.rows}),{name:'verified-stage-v2'});
   if(stale(staged,claim,'release_id_result')){if(++staleCount>8)throw Error('VERIFIED_REPEATED_STALE_LEASE');continue;}
   requireShadowStageReceipt(staged,claim,scan.batchRows);
   const heartbeat=await DBOS.runStep(()=>rpc('heartbeat_supplier_price_release_batch',{
    input_batch_id:claim.batch_id,input_worker_id:owner,input_processed_rows:scan.batchRows,
    input_cursor:scan.cursorEnd,input_lease_seconds:leaseSeconds}),{name:'verified-heartbeat-v2'});
   // A cached claim/stage is NOT a current lease. Expiry is a durable receipt,
   // not a permanently cached failed step. Reclaim/rescan exact same batch.
   if(stale(heartbeat,claim)){if(++staleCount>8)throw Error('VERIFIED_REPEATED_STALE_LEASE');continue;}
   requireShadowHeartbeatReceipt(heartbeat,claim,scan);
   const finalized=await DBOS.runStep(()=>rpc('finalize_supplier_price_release_shadow_batch',{
    input_batch_id:claim.batch_id,input_worker_id:owner,input_processed_rows:scan.batchRows,input_cursor:scan.cursorEnd,
    input_accepted_rows:scan.acceptedRows,input_warning_rows:scan.warningRows,input_rejected_rows:scan.rejectedRows}),{name:'verified-finalize-v2'});
   if(stale(finalized,claim)){if(++staleCount>8)throw Error('VERIFIED_REPEATED_STALE_LEASE');continue;}
   const final=first(finalized);
   if(final?.release_id!==input.releaseId||final.batch_id!==claim.batch_id)throw Error('VERIFIED_FINALIZE_IDENTITY');
   const progress=requireShadowDrainProgress({claim,finalized},previousCursor);
   if(progress.complete)return {status:'staged',releaseId:input.releaseId,handoffId:input.handoffId,published:false};
   previousCursor=progress.cursor;staleCount=0;
  }
 };
}
