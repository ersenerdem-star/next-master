import {maintainIndexes} from './elring-completion-maintenance.mjs';
import {setTimeout as sleep} from 'node:timers/promises';
export async function verifySlowFitmentAcknowledgement({request,health,run,row,evidence,wait=sleep,maintenance=maintainIndexes}){
 // No more Product writes until the acknowledged row, health and separate
 // maintenance have been checked. The acknowledged write is never replayed.
 await wait(5000);await health();
 const job=(await request(`/rest/v1/catalog_elring_completion_jobs?run_id=eq.${run}&phase=eq.fitment&select=*`)).data[0];
 const receipts=(await request(`/rest/v1/catalog_elring_completion_events?run_id=eq.${run}&phase=eq.fitment&row_index=eq.${row}&select=after_fields,evidence_fingerprint`)).data;
 if(!job||job.cursor<row||receipts.length!==1||receipts[0].after_fields.evidence_manifest_sha256!==evidence.evidence_manifest_sha256
  ||receipts[0].evidence_fingerprint!==evidence.stage_fingerprint)throw Error('SLOW_FITMENT_RECEIPT_MISMATCH');
 await maintenance({request,health,run});await health();return{row,cursor:job.cursor,result:'slow_acknowledgement_health_and_receipt_verified'};
}
// This RPC has an exact row/evidence replay key. A batch-advance RPC must never
// use this recovery path: a replay there could process an unintended next batch.
export async function applyConfirmedFitment({request,health,run,row,evidence,onRecovery=async()=>{},maintenance=maintainIndexes}){
 const body={input_run_id:run,input_row_index:row,input_evidence:evidence};
 for(let attempt=0;attempt<2;attempt++){
  try{return await request('/rest/v1/rpc/apply_elring_complete_vehicle_fitment',body);}
  catch(e){
   if(attempt||!(['TypeError','TimeoutError','AbortError'].includes(e.name)||/"code":"(57014|55P03)"/.test(e.message)))throw e;
   await health();const job=(await request(`/rest/v1/catalog_elring_completion_jobs?run_id=eq.${run}&phase=eq.fitment&select=*`)).data[0];
   const receipts=(await request(`/rest/v1/catalog_elring_completion_events?run_id=eq.${run}&phase=eq.fitment&row_index=eq.${row}&select=after_fields,evidence_fingerprint`)).data;
   if(job?.cursor>=row&&receipts.length===1&&receipts[0].after_fields.evidence_manifest_sha256===evidence.evidence_manifest_sha256
     &&receipts[0].evidence_fingerprint===evidence.stage_fingerprint){await onRecovery({row,cursor:job.cursor,result:'committed_receipt_verified'});return{data:job,ms:0};}
   if(job?.cursor!==row-1||receipts.length)throw Error('FITMENT_AMBIGUOUS_CHECKPOINT');
   await onRecovery({row,cursor:job.cursor,result:'unchanged_checkpoint_verified_before_exact_replay'});
   await maintenance({request,health,run});
  }
 }
}
