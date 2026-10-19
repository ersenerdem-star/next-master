import {json as responseJson} from './_shared/http.mts';
import {resolveSupplierUpgradeAdmin,supplierUpgradeFetch,supplierUpgradeServiceHeaders,SupplierUpgradeError,supplierUuid} from './_shared/supplier-upgrade-auth.mts';
import {supplierVerifiedUploadTargetEnabled,supplierUploadTargetPauseMessage} from './_shared/supplier-upload-target.mts';

// Read-only poll. No file transfer, completion request or publication here.
export default async function handler(req:Request) {
 const json=(data:unknown,status=200)=>responseJson(data,status,{'Cache-Control':'no-store'});
 if(req.method!=='GET') return json({error:'Method not allowed'},405);
 if(!supplierVerifiedUploadTargetEnabled(req.url)) return json({error:supplierUploadTargetPauseMessage},503);
 const env=(key:string)=>Netlify.env.get(key);
 if(env('SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED')!=='true') return json({error:'Upload status is not enabled.'},503);
 const url=env('SUPABASE_URL')?.replace(/\/$/,''),anon=env('SUPABASE_ANON_KEY'),service=env('SUPABASE_SERVICE_ROLE_KEY');
 if(!url||!/^https:\/\/[^/?#@]+$/.test(url)||!anon||!service) return json({error:'Upload status is unavailable.'},503);
 const params=new URL(req.url).searchParams,sessionId=params.get('sessionId');
 if(!supplierUuid(sessionId)||[...params.keys()].length!==1) return json({error:'Provide only one sessionId.'},400);
 try {
  const caller=await resolveSupplierUpgradeAdmin(req,url,anon,service);
  const {response,data}=await supplierUpgradeFetch(`${url}/rest/v1/rpc/get_supplier_price_upload_status`,{
   method:'POST',headers:supplierUpgradeServiceHeaders(service),body:JSON.stringify({input_session_id:sessionId,
    input_actor_id:caller.actorId,input_organization_id:caller.organizationId,input_auth_session_id:caller.authSessionId,
    input_token_iat:caller.issuedAt,input_token_exp:caller.expiresAt})});
  if(!response.ok) {
   if(String((data as {message?:unknown})?.message||'').includes('UPLOAD_STATUS_DENIED')) return json({error:'This upload status is not available to your session.'},403);
   throw Error('Status unavailable');
  }
  const r=data as Record<string,unknown>;
  if(!r||r.session_id!==sessionId||!supplierUuid(r.release_id)||r.published!==false
   ||!['created','uploading','uploaded','aborted','expired','failed'].includes(String(r.upload_status))
   ||!['not_requested','queued','verifying','verified','failed'].includes(String(r.verification_status))
   ||typeof r.transfer_ready!=='boolean'||!Number.isSafeInteger(r.total_bytes)||Number(r.total_bytes)<1
   ||!Number.isSafeInteger(r.total_rows)||Number(r.total_rows)<0||!Number.isSafeInteger(r.processed_rows)||Number(r.processed_rows)<0
   ||typeof r.release_status!=='string'||r.error_code!==null&&(typeof r.error_code!=='string'||! /^[A-Z0-9_]{1,80}$/.test(r.error_code))
   ||!Number.isFinite(Date.parse(String(r.release_updated_at)))||!Number.isFinite(Date.parse(String(r.expires_at)))
   ||!Number.isFinite(Date.parse(String(r.updated_at)))) throw Error('Invalid status');
  return json({sessionId,releaseId:r.release_id,uploadStatus:r.upload_status,verificationStatus:r.verification_status,
   transferReady:r.transfer_ready,totalBytes:r.total_bytes,totalRows:r.total_rows,processedRows:r.processed_rows,
   releaseStatus:r.release_status,errorCode:r.error_code,releaseUpdatedAt:r.release_updated_at,
   failureReason:typeof r.failure_reason==='string'&&/^SUPPLIER_FAILURE_(VALIDATION_DATABASE_TIMEOUT|PROCESSING_DATABASE_TIMEOUT|SERVICE_UNAVAILABLE|SOURCE_VALIDATION_FAILED|SOURCE_UNAVAILABLE)$/.test(r.failure_reason)?r.failure_reason:null,
   expiresAt:r.expires_at,updatedAt:r.updated_at,published:false});
 }catch(error){
  if(error instanceof SupplierUpgradeError) return json({error:error.message},error.status);
  return json({error:'Upload status could not be confirmed. Keep the same upload session and check again.',sessionId},503);
 }
}
export const config={path:'/api/supplier-price-upload-status'};
