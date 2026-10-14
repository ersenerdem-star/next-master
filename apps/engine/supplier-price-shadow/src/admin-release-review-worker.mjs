// Explicit admin decisions only. SQL owns durable acceptance, fencing and the
// atomic domain receipt. A lost response never creates a new decision ID.
import {randomUUID} from 'node:crypto';
import {requireSupplierPriceServiceTarget} from './worker-target.mjs';
import {supabaseApiHeaders} from './supabase-headers.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_ROLLBACK_CODES=new Set(['P0001','42501','57014','55P03','23505','23514']);
export function adminReleaseActionConfig(env){
 if(env.SUPPLIER_PRICE_RELEASE_ACTIONS_WORKER_ENABLED!=='1')return null;
 const target=requireSupplierPriceServiceTarget(env);
 const projectRef=new URL(target.origin).hostname.split('.')[0];
 if(!['kaxsqafdevabkxofwdod','zjgueqijumzlfioihnkt'].includes(projectRef)
  ||target.environment==='production'&&env.SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED!=='1'
  ||target.environment!=='production'&&env.SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED==='1'
  ||!env.SUPABASE_SERVICE_ROLE_KEY)throw Error('SERVICE_ADMIN_ACTION_TARGET_UNCONFIRMED');
 return {origin:target.origin,projectRef,key:env.SUPABASE_SERVICE_ROLE_KEY};
}

export function createAdminReleaseActionConsumer({env,fetchImpl=fetch,uuid=randomUUID}){
 const config=adminReleaseActionConfig(env);if(!config)return undefined;
 const rpc=async(name,args)=>{
  let response,data;
  try{
   response=await fetchImpl(`${config.origin}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',
    headers:supabaseApiHeaders(config.key,'application/json'),body:JSON.stringify({input_project_ref:config.projectRef,...args}),
    signal:AbortSignal.timeout(60000)});
   data=await response.json();
  }catch{throw Error('SERVICE_ADMIN_ACTION_OUTCOME_UNKNOWN');}
  if(!response.ok){
   // Only an authoritative PostgreSQL error response establishes rollback.
   // Proxy/network timeouts, unparseable bodies and gateway failures do not.
   const rolledBack=KNOWN_ROLLBACK_CODES.has(data?.code)&&typeof data?.message==='string'
    &&(data.code!=='P0001'||/^(ACTION_|REVIEW_|PRODUCTION_PUBLICATION_|STAGING_PUBLICATION_)[A-Z0-9_]+$/.test(data.message));
   throw Object.assign(Error('SERVICE_ADMIN_ACTION_RPC_UNCONFIRMED'),{rolledBack,
    failureCode:data?.code==='57014'?'ACTION_EXECUTION_TIMEOUT':'ACTION_EXECUTION_FAILED'});
  }
  return data;
 };
 const final=(receipt,claim)=>{
  if(receipt?.decisionId!==claim.decision_id||receipt?.releaseId!==claim.release_id
   ||!['published','rechecked_clear','review_required','rejected','failed'].includes(receipt?.status)
   ||typeof receipt.replayed!=='boolean'||receipt.published!==(receipt.status==='published'))
   throw Error('SERVICE_ADMIN_ACTION_RECEIPT_UNCONFIRMED');
  if(receipt.status==='published'&&(!UUID.test(receipt.publicationId||'')||!Number.isSafeInteger(receipt.version)||receipt.version<1))
   throw Error('SERVICE_ADMIN_ACTION_RECEIPT_UNCONFIRMED');
  if(claim.action==='review'&&(receipt.published!==false||!['recheck','reject'].includes(receipt.action))
   ||claim.action==='publish'&&(['rechecked_clear','rejected'].includes(receipt.status)||receipt.action!==undefined&&receipt.action!=='publish'))
   throw Error('SERVICE_ADMIN_ACTION_RECEIPT_UNCONFIRMED');
  return {status:receipt.status==='failed'?'failed':'completed',decisionId:claim.decision_id,releaseId:claim.release_id,published:receipt.published};
 };
 return async()=>{
  const owner=uuid();if(!UUID.test(owner))throw Error('SERVICE_ADMIN_ACTION_LEASE_INVALID');
  const claim=await rpc('claim_supplier_release_action',{input_lease_owner:owner});
  if(claim?.status==='empty')return {status:'empty',published:false};
  if(claim?.status!=='claimed'||!UUID.test(claim.decision_id||'')||!UUID.test(claim.release_id||'')
   ||claim.lease_owner!==owner||!['review','publish'].includes(claim.action))throw Error('SERVICE_ADMIN_ACTION_CLAIM_UNCONFIRMED');
  const args={input_decision_id:claim.decision_id,input_lease_owner:owner};
  try{return final(await rpc('execute_supplier_release_action',args),claim);}
  catch(error){
   if(error?.rolledBack===true){
    try{return final(await rpc('fail_supplier_release_action',{...args,input_error_code:error.failureCode}),claim);}
    catch{/* Settlement can also have an unknown outcome; lease/receipt is authoritative. */}
   }
   return {status:'pending',decisionId:claim.decision_id,releaseId:claim.release_id,published:null};
  }
 };
}
