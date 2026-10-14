// Trusted service operator only. Never imported or invoked by worker.mjs.
// This attributes the reviewed decision to an active administrator; it does
// not pretend that a service key is an end-user authenticated session.
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {PRODUCTION_SUPABASE_HOST,requireSupplierPriceServiceTarget,requireProductionServiceCredential} from './worker-target.mjs';
import {supabaseApiHeaders} from './supabase-headers.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectRef=PRODUCTION_SUPABASE_HOST.split('.')[0];
const fail=code=>{throw Error('PRODUCTION_PUBLICATION_'+code);};
export function productionPublicationRequest(env,argument) {
  if(argument!=='--publish-reviewed')fail('EXPLICIT_COMMAND_REQUIRED');
  const target=requireSupplierPriceServiceTarget(env);
  if(target.environment!=='production')fail('TARGET_REQUIRED');
  if(env.SUPPLIER_PRICE_PRODUCTION_PUBLICATION_ENABLED!=='1')fail('OPERATOR_OPT_IN_REQUIRED');
  requireProductionServiceCredential(env.SUPABASE_SERVICE_ROLE_KEY,PRODUCTION_SUPABASE_HOST);
  const fields={input_release_id:'RELEASE_ID',input_organization_id:'ORGANIZATION_ID',input_supplier_id:'SUPPLIER_ID',
    input_brand_id:'BRAND_ID',input_actor_id:'ACTOR_ID',input_decision_id:'DECISION_ID'};
  const body={input_project_ref:projectRef};
  for(const [field,suffix] of Object.entries(fields)) {
    const value=env['SUPPLIER_PRICE_PUBLICATION_'+suffix];
    if(!UUID.test(value||''))fail('INPUT_REQUIRED');
    body[field]=value.toLowerCase();
  }
  const revision=env.SUPPLIER_PRICE_PUBLICATION_REVIEW_REVISION;
  if(!/^(0|[1-9][0-9]*)$/.test(revision||'')||!Number.isSafeInteger(Number(revision)))fail('REVIEW_REVISION_REQUIRED');
  body.input_expected_review_revision=Number(revision);
  const previous=env.SUPPLIER_PRICE_PUBLICATION_EXPECTED_PREVIOUS_ID;
  // "none" is an explicit first-publication assertion; omission is unsafe.
  if(previous!=='none'&&!UUID.test(previous||''))fail('PREVIOUS_POINTER_REQUIRED');
  body.input_expected_previous_publication_id=previous==='none'?null:previous.toLowerCase();
  return {origin:target.origin,key:env.SUPABASE_SERVICE_ROLE_KEY,body};
}

export async function runProductionPublicationOperator({env=process.env,argument,fetchImpl=fetch}) {
  const {origin,key,body}=productionPublicationRequest(env,argument);
  const response=await fetchImpl(origin+'/rest/v1/rpc/publish_supplier_price_release_production',{
    method:'POST',headers:supabaseApiHeaders(key,'application/json'),redirect:'error',
    signal:AbortSignal.timeout(60000),body:JSON.stringify(body),
  });
  const receipt=await response.json().catch(()=>null);
  if(!response.ok) {
    const code=receipt?.message;
    if(/^PRODUCTION_PUBLICATION_[A-Z_]+$/.test(code||''))throw Error(code);
    fail('OPERATION_UNCONFIRMED');
  }
  if(receipt?.published===false&&receipt?.status==='review_required')fail('REVIEW_REQUIRED');
  if(receipt?.status!=='published'||receipt.published!==true
    ||receipt.release_id!==body.input_release_id||receipt.decision_id!==body.input_decision_id
    ||receipt.actor_id!==body.input_actor_id||receipt.review_revision!==body.input_expected_review_revision
    ||receipt.expected_previous_publication_id!==body.input_expected_previous_publication_id
    ||!UUID.test(receipt.publication_id||'')||!Number.isSafeInteger(receipt.version)||receipt.version<1
    ||typeof receipt.replayed!=='boolean'||typeof receipt.is_current!=='boolean')fail('RECEIPT_UNCONFIRMED');
  return {mode:'explicit-production-publication',...Object.fromEntries([
    'status','release_id','publication_id','version','actor_id','decision_id','review_revision',
    'expected_previous_publication_id','is_current','replayed','published',
  ].map(field=>[field,receipt[field]]))};
}

export function productionReversalRequest(env,argument) {
  if(argument!=='--reverse-reviewed')throw Error('PRODUCTION_REVERSAL_EXPLICIT_COMMAND_REQUIRED');
  const target=requireSupplierPriceServiceTarget(env);
  if(target.environment!=='production')throw Error('PRODUCTION_REVERSAL_TARGET_REQUIRED');
  if(env.SUPPLIER_PRICE_PRODUCTION_REVERSAL_ENABLED!=='1')throw Error('PRODUCTION_REVERSAL_OPERATOR_OPT_IN_REQUIRED');
  requireProductionServiceCredential(env.SUPABASE_SERVICE_ROLE_KEY,PRODUCTION_SUPABASE_HOST);
  const fields={input_organization_id:'ORGANIZATION_ID',input_supplier_id:'SUPPLIER_ID',input_brand_id:'BRAND_ID',
    input_actor_id:'ACTOR_ID',input_decision_id:'DECISION_ID',input_target_decision_id:'TARGET_DECISION_ID',
    input_expected_current_publication_id:'EXPECTED_CURRENT_ID'};
  const body={input_project_ref:projectRef};
  for(const [field,suffix] of Object.entries(fields)) {
    const value=env['SUPPLIER_PRICE_REVERSAL_'+suffix];
    if(!UUID.test(value||''))throw Error('PRODUCTION_REVERSAL_INPUT_REQUIRED');
    body[field]=value.toLowerCase();
  }
  const revision=env.SUPPLIER_PRICE_REVERSAL_RESTORE_REVIEW_REVISION;
  if(revision!=='none'&&(!/^(0|[1-9][0-9]*)$/.test(revision||'')||!Number.isSafeInteger(Number(revision))))
    throw Error('PRODUCTION_REVERSAL_REVIEW_REVISION_REQUIRED');
  body.input_expected_restored_review_revision=revision==='none'?null:Number(revision);
  return {origin:target.origin,key:env.SUPABASE_SERVICE_ROLE_KEY,body};
}

export async function runProductionReversalOperator({env=process.env,argument,fetchImpl=fetch}) {
  const {origin,key,body}=productionReversalRequest(env,argument);
  const response=await fetchImpl(origin+'/rest/v1/rpc/reverse_supplier_price_publication_production',{
    method:'POST',headers:supabaseApiHeaders(key,'application/json'),redirect:'error',
    signal:AbortSignal.timeout(60000),body:JSON.stringify(body),
  });
  const receipt=await response.json().catch(()=>null);
  if(!response.ok) {
    if(/^PRODUCTION_REVERSAL_[A-Z_]+$/.test(receipt?.message||''))throw Error(receipt.message);
    throw Error('PRODUCTION_REVERSAL_OPERATION_UNCONFIRMED');
  }
  if(receipt?.status==='review_required'&&receipt.reversed===false)throw Error('PRODUCTION_REVERSAL_REVIEW_REQUIRED');
  if(receipt?.status!=='reversed'||receipt.reversed!==true||receipt.published!==false
    ||receipt.actor_id!==body.input_actor_id||receipt.decision_id!==body.input_decision_id
    ||receipt.target_decision_id!==body.input_target_decision_id
    ||receipt.reversed_publication_id!==body.input_expected_current_publication_id
    ||receipt.expected_restored_review_revision!==body.input_expected_restored_review_revision
    ||(receipt.restored_publication_id!==null&&!UUID.test(receipt.restored_publication_id||''))
    ||(receipt.restored_release_id!==null&&!UUID.test(receipt.restored_release_id||''))
    ||((receipt.restored_publication_id===null)!==(receipt.restored_release_id===null))
    ||typeof receipt.replayed!=='boolean'||typeof receipt.is_restored_current!=='boolean')
    throw Error('PRODUCTION_REVERSAL_RECEIPT_UNCONFIRMED');
  return {mode:'explicit-production-publication-reversal',...Object.fromEntries([
    'status','actor_id','decision_id','target_decision_id','reversed_publication_id','restored_publication_id',
    'restored_release_id','expected_restored_review_revision','is_restored_current','replayed','reversed','published',
  ].map(field=>[field,receipt[field]]))};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3) {
    console.error(JSON.stringify({status:'failed',errorCode:'PRODUCTION_PUBLICATION_EXPLICIT_COMMAND_REQUIRED',published:false}));
    process.exitCode=1;
  } else (process.argv[2]==='--reverse-reviewed'?runProductionReversalOperator:runProductionPublicationOperator)({argument:process.argv[2]})
    .then(receipt=>console.log(JSON.stringify(receipt)))
    .catch(error=>{
      const message=String(error?.message||'');
      const known=/^(PRODUCTION_(PUBLICATION|REVERSAL)_[A-Z_]+|SERVICE_[A-Z_]+|SHADOW_PERSIST_STAGING_HOST_REQUIRED)$/.test(message);
      console.error(JSON.stringify({status:'failed',errorCode:known?message:'PRODUCTION_PUBLICATION_OPERATION_UNCONFIRMED',published:false}));
      process.exitCode=1;
    });
}
