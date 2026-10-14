// Dedicated admin boundary. No privileged RPC is exposed through app-rpc.
import {json as responseJson} from './http.mts';
import {resolveSupplierUpgradeAdmin,supplierUpgradeFetch,supplierUpgradeServiceHeaders,SupplierUpgradeError,supplierUuid}
 from './supplier-upgrade-auth.mts';

const STAGING='kaxsqafdevabkxofwdod',PRODUCTION='zjgueqijumzlfioihnkt';
const STAGING_ORIGIN='https://next-master-v3-staging-20261006.netlify.app',PRODUCTION_ORIGIN='https://portal.next-master.com';
const BODY_LIMIT=24576,AUDIT_LIMIT=16384;
type RecordValue=Record<string,unknown>;
type Kind='evidence'|'review'|'publish';
const record=(v:unknown):v is RecordValue=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const nullableUuid=(v:unknown)=>v===null||supplierUuid(v);
const code=(v:unknown)=>v===null||typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,159}$/.test(v);
const boundedAudit=(v:unknown)=>v===null||record(v)&&Buffer.byteLength(JSON.stringify(v),'utf8')<=AUDIT_LIMIT;
const exactKeys=(v:RecordValue,keys:string[])=>Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
class ActionError extends Error{constructor(readonly status:number,readonly code:string){super(code);}}

export function supplierReleaseActionTarget(requestUrl:string,read:(key:string)=>string|undefined=name=>Netlify.env.get(name)){
 if(read('SUPPLIER_PRICE_RELEASE_ACTIONS_ENABLED')!=='true')return null;
 let origin:string;try{origin=new URL(requestUrl).origin;}catch{return null;}
 const url=read('SUPABASE_URL');
 if(url===`https://${STAGING}.supabase.co`&&origin===STAGING_ORIGIN&&!read('NM_PRODUCTION_TARGET')
  &&read('SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED')!=='1')return {url,projectRef:STAGING};
 if(url===`https://${PRODUCTION}.supabase.co`&&origin===PRODUCTION_ORIGIN&&read('NM_PRODUCTION_TARGET')===PRODUCTION
  &&!read('NM_FULL_STAGING_TARGET')&&read('SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED')==='1')return {url,projectRef:PRODUCTION};
 return null;
}

export async function readSupplierReleaseActionBody(req:Request,kind:'review'|'publish'){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))throw new ActionError(400,'ACTION_INPUT_INVALID');
 const reader=req.body?.getReader();if(!reader)throw new ActionError(400,'ACTION_INPUT_INVALID');
 let bytes=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
  if(bytes>BODY_LIMIT){await reader.cancel();throw new ActionError(413,'ACTION_INPUT_TOO_LARGE');}chunks.push(value);
 }}finally{reader.releaseLock();}
 let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ActionError(400,'ACTION_INPUT_INVALID');}
 const keys=kind==='review'?['releaseId','decisionId','action','reason','expectedRevision','expectedStatus','expectedError','expectedAudit']
  :['releaseId','decisionId','expectedReviewRevision','expectedPreviousPublicationId'];
 if(!record(body)||!exactKeys(body,keys)||!supplierUuid(body.releaseId)||!supplierUuid(body.decisionId))
  throw new ActionError(400,'ACTION_INPUT_INVALID');
 if(kind==='review'){
  if(!count(body.expectedRevision)||typeof body.expectedStatus!=='string'||!['staged','validated','superseded'].includes(body.expectedStatus)
   ||!code(body.expectedError)||typeof body.expectedError==='string'&&body.expectedError.length>100||!boundedAudit(body.expectedAudit)
   ||!(body.action==='recheck'&&body.reason==='comparison_repaired'||body.action==='reject'&&['wrong_brand_file','wrong_source_file'].includes(String(body.reason))))
   throw new ActionError(400,'ACTION_INPUT_INVALID');
 }else if(!count(body.expectedReviewRevision)||!nullableUuid(body.expectedPreviousPublicationId))throw new ActionError(400,'ACTION_INPUT_INVALID');
 return body;
}

function safeReceipt(value:unknown,releaseId:string,decisionId:string):RecordValue{
 if(!record(value)||value.releaseId!==releaseId||value.decisionId!==decisionId||typeof value.replayed!=='boolean'
  ||typeof value.published!=='boolean'||!['queued','running','rechecked_clear','review_required','rejected','published','failed'].includes(String(value.status)))
  throw Error('ACTION_RECEIPT_INVALID');
 if(value.status==='published'){
  if(value.published!==true||!supplierUuid(value.publicationId)||!count(value.version)||value.version<1
   ||!count(value.reviewRevision)||!nullableUuid(value.expectedPreviousPublicationId)||typeof value.isCurrent!=='boolean')throw Error('ACTION_RECEIPT_INVALID');
 }else if(value.published!==false)throw Error('ACTION_RECEIPT_INVALID');
 if(value.action!==undefined&&!['recheck','reject','publish'].includes(String(value.action)))throw Error('ACTION_RECEIPT_INVALID');
 if(value.status==='failed'&&typeof value.errorCode!=='string')throw Error('ACTION_RECEIPT_INVALID');
 if(['queued','running'].includes(String(value.status))&&!['recheck','reject','publish'].includes(String(value.action)))throw Error('ACTION_RECEIPT_INVALID');
 if(['rechecked_clear','rejected'].includes(String(value.status))&&(!count(value.reviewRevision)||!['recheck','reject'].includes(String(value.action))))throw Error('ACTION_RECEIPT_INVALID');
 if(value.reviewRevision!==undefined&&!count(value.reviewRevision)||value.errorCode!==undefined&&!code(value.errorCode))throw Error('ACTION_RECEIPT_INVALID');
 const result:RecordValue={releaseId,decisionId,status:value.status,published:value.published,replayed:value.replayed};
 for(const key of ['action','reviewRevision','publicationId','version','expectedPreviousPublicationId','isCurrent','errorCode'])if(value[key]!==undefined)result[key]=value[key];
 return result;
}
function safeOperation(value:unknown,releaseId:string,kind:'review'|'publish'){
 if(value===null)return null;
 if(!record(value)||!supplierUuid(value.decisionId)||!['queued','running','completed','failed'].includes(String(value.status))||!code(value.errorCode))throw Error('ACTION_EVIDENCE_INVALID');
 const receipt=value.receipt===null?null:safeReceipt(value.receipt,releaseId,value.decisionId);
 if(receipt&&(kind==='review'&&(receipt.published!==false||!['recheck','reject'].includes(String(receipt.action)))
  ||kind==='publish'&&(['rechecked_clear','rejected'].includes(String(receipt.status))||receipt.action!==undefined&&receipt.action!=='publish')))
  throw Error('ACTION_EVIDENCE_INVALID');
 if(value.status==='completed'&&(!receipt||['queued','running','failed'].includes(String(receipt.status))))throw Error('ACTION_EVIDENCE_INVALID');
 if(value.status==='failed'&&typeof value.errorCode!=='string')throw Error('ACTION_EVIDENCE_INVALID');
 return {decisionId:value.decisionId,status:value.status,receipt,errorCode:value.errorCode};
}
export function safeSupplierReleaseEvidence(value:unknown,releaseId:string,caller:{actorId:string;organizationId:string}){
 if(!record(value)||value.releaseId!==releaseId||value.actorId!==caller.actorId||value.organizationId!==caller.organizationId
  ||![value.supplierId,value.brandId].every(supplierUuid)||!['supplier','brand','mode','status'].every(k=>typeof value[k]==='string'&&String(value[k]).length>0&&String(value[k]).length<=240)
  ||!['reviewRevision','totalRows','processedRows','acceptedRows','rejectedRows','warningRows','conflictRows'].every(k=>count(value[k]))
  ||!['sourceVerified','isCurrent','canReview','canPublish'].every(k=>typeof value[k]==='boolean')||!code(value.errorCode)||!boundedAudit(value.brandIdentityAudit)
  ||!nullableUuid(value.currentPublicationId)||!nullableUuid(value.currentReleaseId)||!(value.currentPublicationVersion===null||count(value.currentPublicationVersion)))throw Error('ACTION_EVIDENCE_INVALID');
 const publicationBlocker=value.publicationBlocker??null;
 if(publicationBlocker!==null&&(typeof publicationBlocker!=='string'||!['SOURCE_COMPATIBILITY_REQUIRED','LEGACY_COMMERCIAL_FIELDS_UNSUPPORTED'].includes(publicationBlocker))
  ||publicationBlocker!==null&&value.canPublish!==false)throw Error('ACTION_EVIDENCE_INVALID');
 const result:RecordValue={publicationBlocker};
 for(const key of ['actorId','organizationId','releaseId','supplierId','brandId','supplier','brand','mode','status','reviewRevision','errorCode','brandIdentityAudit',
  'totalRows','processedRows','acceptedRows','rejectedRows','warningRows','conflictRows','sourceVerified','currentPublicationId','currentReleaseId','currentPublicationVersion','isCurrent','canReview','canPublish'])result[key]=clone(value[key]);
 return {...result,reviewOperation:safeOperation(value.reviewOperation,releaseId,'review'),publishOperation:safeOperation(value.publishOperation,releaseId,'publish')};
}

function rpcDenial(data:unknown):ActionError|null{
 if(!record(data)||data.code!=='P0001'||typeof data.message!=='string'||!code(data.message))return null;
 const value=data.message;
 // Domain exception names are bounded public codes; never return SQL detail,
 // provider text, stack, key or arbitrary messages to the browser.
 if(!/^(ACTION_|REVIEW_|PRODUCTION_PUBLICATION_|STAGING_PUBLICATION_)[A-Z0-9_]+$/.test(value))return null;
 if(/SESSION/.test(value))return new ActionError(401,value);
 if(/ACTOR|SCOPE|SERVICE_REQUIRED/.test(value))return new ActionError(403,value);
 if(/INPUT/.test(value))return new ActionError(400,value);
 if(/NOT_ENABLED|DISABLED|TARGET/.test(value))return new ActionError(503,value);
 return new ActionError(409,value);
}

export async function handleSupplierReleaseAction(req:Request,kind:Kind){
 const json=(data:unknown,status=200)=>responseJson(data,status,{'Cache-Control':'no-store'});
 if(req.method!==(kind==='evidence'?'GET':'POST'))return json({error:'Method not allowed',code:'ACTION_METHOD_INVALID'},405);
 const target=supplierReleaseActionTarget(req.url);
 if(!target)return json({error:'Supplier release actions are not enabled.',code:'ACTION_NOT_ENABLED',outcome:'not_submitted'},503);
 if(req.headers.has('origin')&&req.headers.get('origin')!==new URL(req.url).origin)
  return json({error:'This request origin is not allowed.',code:'ACTION_ORIGIN_DENIED',outcome:'not_submitted'},403);
 const anon=Netlify.env.get('SUPABASE_ANON_KEY'),service=Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!anon||!service)return json({error:'Supplier release actions are unavailable.',code:'ACTION_UNAVAILABLE',outcome:'not_submitted'},503);
 let body:RecordValue|undefined,releaseId:string|undefined,decisionId:string|undefined,submitted=false;
 try{
  const params=new URL(req.url).searchParams;
  if(kind==='evidence'){
   const id=params.get('releaseId');if(!supplierUuid(id)||[...params.keys()].length!==1)throw new ActionError(400,'ACTION_INPUT_INVALID');releaseId=id;
  }else{
   if([...params.keys()].length)throw new ActionError(400,'ACTION_INPUT_INVALID');
   body=await readSupplierReleaseActionBody(req,kind);releaseId=body.releaseId as string;decisionId=body.decisionId as string;
  }
  const caller=await resolveSupplierUpgradeAdmin(req,target.url,anon,service);
  const proof={input_project_ref:target.projectRef,input_actor_id:caller.actorId,input_organization_id:caller.organizationId,
   input_auth_session_id:caller.authSessionId,input_token_iat:caller.issuedAt,input_token_exp:caller.expiresAt};
  const rpc=kind==='evidence'?'get_supplier_release_action_evidence':'request_supplier_release_action';
  const args=kind==='evidence'?{...proof,input_release_id:releaseId}:{...proof,input_action:kind,input_request:body};
  submitted=kind!=='evidence';
  // Acceptance/evidence only; neither endpoint waits for the full row audit.
  const {response,data}=await supplierUpgradeFetch(`${target.url}/rest/v1/rpc/${rpc}`,{
   method:'POST',headers:supplierUpgradeServiceHeaders(service),body:JSON.stringify(args)},8000);
  if(!response.ok){const denial=rpcDenial(data);if(denial)throw denial;throw Error('ACTION_RESPONSE_UNCONFIRMED');}
  if(kind==='evidence')return json(safeSupplierReleaseEvidence(data,releaseId,caller));
  const receipt=safeReceipt(data,releaseId,decisionId!);
  if(kind==='review'&&(receipt.action!==body!.action||receipt.published!==false
    ||!['queued','running','rechecked_clear','review_required','rejected','failed'].includes(String(receipt.status))))throw Error('ACTION_RECEIPT_INVALID');
  if(kind==='publish'&&(['rechecked_clear','rejected'].includes(String(receipt.status))
    ||receipt.action!==undefined&&receipt.action!=='publish'))throw Error('ACTION_RECEIPT_INVALID');
  if(receipt.status==='failed')return json({error:'This action failed. Refresh its evidence before deciding again.',code:receipt.errorCode||'ACTION_FAILED',outcome:'not_submitted',releaseId,decisionId},409);
  return json(receipt,['queued','running'].includes(String(receipt.status))?202:200);
 }catch(error){
  if(error instanceof SupplierUpgradeError)return json({error:error.message,code:'ACTION_AUTH_DENIED',outcome:'not_submitted',releaseId,decisionId},error.status);
  if(error instanceof ActionError)return json({error:error.status===409?'The release or decision has changed. Refresh its evidence.':'This release action is unavailable for this request.',code:error.code,outcome:'not_submitted',releaseId,decisionId},error.status);
  return json({error:submitted?'Acceptance could not be confirmed. Check this same decision before retrying.':'Release evidence could not be verified.',
   code:submitted?'ACTION_OUTCOME_UNKNOWN':'ACTION_UNAVAILABLE',outcome:submitted?'unknown':'not_submitted',releaseId,decisionId},503);
 }
}
