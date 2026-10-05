// Durable pre-DBOS source verification. SQL owns intent/lease/retry; existing
// verified completion creates the SAME immutable DBOS handoff, never prices.
import {verifySupplierPriceUpload} from './verified-upload-handoff.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function consumeUploadVerification({rpc,workerId,supabaseUrl,serviceRoleKey,fetchImpl=fetch,
  leaseSeconds=120,timeoutMs=3600000,verify=verifySupplierPriceUpload}) {
  if(typeof rpc!=='function'||typeof verify!=='function'||!workerId||workerId.trim()!==workerId||workerId.length>200
    ||!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>3600)throw Error('UPLOAD_VERIFY_CONFIG');
  const job=await rpc('claim_supplier_price_upload_verification',{input_worker_id:workerId,input_lease_seconds:leaseSeconds});
  if(['empty','exhausted'].includes(job?.status)&&job.published===false)return job;
  if(job?.status!=='claimed'||job.published!==false||!Number.isInteger(job.attempt)||job.attempt<1||job.attempt>5
    ||![job.request_id,job.session_id,job.release_id,job.organization_id,job.actor_id,job.lease_token].every(x=>UUID.test(x||'')))throw Error('UPLOAD_VERIFY_JOB_INVALID');
  const fence={input_request_id:job.request_id,input_worker_id:workerId,input_lease_token:job.lease_token,input_lease_seconds:leaseSeconds};
  // No overlapping heartbeats. A lost renewal makes the final result unknown;
  // expired ownership must never be resurrected. Source completion is idempotent.
  let pending=Promise.resolve(),renewalError;
  const timer=setInterval(()=>{pending=pending.then(async()=>{
    if(renewalError)return;
    try{const r=await rpc('settle_supplier_price_upload_verification',{...fence,input_action:'heartbeat'});
      if(r?.request_id!==job.request_id||r.status!=='verifying'||r.published!==false)throw Error('UPLOAD_VERIFY_HEARTBEAT_INVALID');
    }catch(error){renewalError=error;}
  });},Math.floor(leaseSeconds*1000/3));
  let receipt,failure;
  try{receipt=await verify({sessionId:job.session_id,organizationId:job.organization_id,actorId:job.actor_id,
    rpc,supabaseUrl,serviceRoleKey,fetchImpl,timeoutMs});}catch(error){failure=error;}
  finally{clearInterval(timer);await pending;}
  if(renewalError)throw new Error(`UPLOAD_VERIFY_OWNERSHIP_UNCONFIRMED:${job.request_id}`,{cause:renewalError});
  if(!failure&&(receipt?.status!=='verified'||receipt.session_id!==job.session_id||receipt.release_id!==job.release_id||receipt.published!==false))
    failure=Error('VERIFIED_RECEIPT_UNCONFIRMED');
  if(failure){
    const message=String(failure.message||'');
    const permanent=/VERIFIED_(?:CHECKSUM_MISMATCH|SIZE_MISMATCH|SIZE_EXCEEDED|EMPTY_SOURCE|PATH_INVALID|SCOPE_DENIED|ACTOR_DENIED|UPLOAD_EXPIRED|REQUIRED|CONTEXT_INVALID)/.test(message);
    // Never persist raw network errors, URLs, keys or stack traces in the ledger.
    await rpc('settle_supplier_price_upload_verification',{...fence,input_action:permanent?'failed':'retry',
      input_error_code:permanent?'SOURCE_VERIFICATION_REJECTED':'SOURCE_VERIFICATION_UNCONFIRMED'});
    throw new Error(`UPLOAD_VERIFY_UNCONFIRMED:${job.request_id}`,{cause:failure});
  }
  const settled=await rpc('settle_supplier_price_upload_verification',{...fence,input_action:'verified'});
  if(settled?.request_id!==job.request_id||settled.session_id!==job.session_id||settled.release_id!==job.release_id
    ||settled.status!=='verified'||settled.published!==false)throw Error(`UPLOAD_VERIFY_SETTLE_UNCONFIRMED:${job.request_id}`);
  return settled;
}
