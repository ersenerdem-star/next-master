export type ReviewAction = 'recheck' | 'reject';
export type ReviewReason = 'comparison_repaired' | 'wrong_brand_file' | 'wrong_source_file';
export type ReviewCommand = {
  releaseId:string; decisionId:string; action:ReviewAction; reason:ReviewReason;
  expectedRevision:number; expectedStatus:string; expectedError:string|null; expectedAudit:Record<string,unknown>|null;
};
export type PublishCommand = {releaseId:string; decisionId:string; expectedReviewRevision:number; expectedPreviousPublicationId:string|null};
export type ActionKind = 'review' | 'publish';
export type ActionReceipt = {
  releaseId:string; decisionId:string; status:'queued'|'running'|'rechecked_clear'|'review_required'|'rejected'|'published';
  published:boolean; replayed:boolean; action?:ReviewAction|'publish'; reviewRevision?:number;
  publicationId?:string; version?:number; expectedPreviousPublicationId?:string|null; isCurrent?:boolean; errorCode?:string|null;
};
export type ReleaseOperation = {
  decisionId:string; status:'queued'|'running'|'completed'|'failed'; receipt:ActionReceipt|null; errorCode:string|null;
};
export type ReleaseActionEvidence = {
  actorId:string; organizationId:string; releaseId:string; supplierId:string; brandId:string; supplier:string; brand:string;
  mode:string; status:string; reviewRevision:number; errorCode:string|null; brandIdentityAudit:Record<string,unknown>|null;
  totalRows:number; processedRows:number; acceptedRows:number; rejectedRows:number; warningRows:number; conflictRows:number;
  sourceVerified:boolean; currentPublicationId:string|null; currentReleaseId:string|null; currentPublicationVersion:number|null;
  isCurrent:boolean; canReview:boolean; canPublish:boolean; reviewOperation:ReleaseOperation|null; publishOperation:ReleaseOperation|null;
};
export type ActionScope = {origin:string; actorId:string; organizationId:string; releaseId:string};
export type DurableAction = {
  schema:1; kind:ActionKind; scope:ActionScope; command:ReviewCommand|PublishCommand;
  phase:'pending'|'unknown'|'completed'|'failed'; receipt:ActionReceipt|null; errorCode:string|null;
};
export type ReceiptStorage = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const uuid=(v:unknown):v is string=>typeof v==='string'&&UUID.test(v);
const nullableUuid=(v:unknown)=>v===null||uuid(v);
const code=(v:unknown)=>v===null||typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,159}$/.test(v);
const audit=(v:unknown)=>v===null||record(v)!==null&&JSON.stringify(v).length<=32000;
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));

export function releaseActionsTargetEnabled(config:{enabled?:string;productionEnabled?:string;productionTarget?:string;supabaseUrl?:string;origin?:string}) {
  if(config.enabled!=='true')return false;
  if(config.supabaseUrl==='https://kaxsqafdevabkxofwdod.supabase.co')return config.origin==='https://next-master-v3-staging-20261006.netlify.app'
    &&!config.productionTarget&&config.productionEnabled!=='1';
  return config.supabaseUrl==='https://zjgueqijumzlfioihnkt.supabase.co'&&config.origin==='https://portal.next-master.com'
    &&config.productionTarget==='zjgueqijumzlfioihnkt'&&config.productionEnabled==='1';
}

export function parseActionReceipt(value:unknown, releaseId:string, decisionId:string):ActionReceipt {
  const r=record(value);
  if(!r||r.releaseId!==releaseId||r.decisionId!==decisionId||typeof r.published!=='boolean'||typeof r.replayed!=='boolean'
    ||!['queued','running','rechecked_clear','review_required','rejected','published'].includes(String(r.status)))throw new Error('ACTION_RECEIPT_INVALID');
  if(r.status==='published'&&(!r.published||!uuid(r.publicationId)||!count(r.version)||!count(r.reviewRevision)
    ||!nullableUuid(r.expectedPreviousPublicationId)||typeof r.isCurrent!=='boolean'))throw new Error('ACTION_RECEIPT_INVALID');
  if(r.status!=='published'&&r.published!==false)throw new Error('ACTION_RECEIPT_INVALID');
  if(r.reviewRevision!==undefined&&!count(r.reviewRevision)||r.errorCode!==undefined&&!code(r.errorCode))throw new Error('ACTION_RECEIPT_INVALID');
  if(r.action!==undefined&&!['recheck','reject','publish'].includes(String(r.action)))throw new Error('ACTION_RECEIPT_INVALID');
  // Persist only the decision receipt; never copy arbitrary server fields.
  const result:ActionReceipt={releaseId,decisionId,status:r.status as ActionReceipt['status'],published:r.published,replayed:r.replayed};
  for(const key of ['action','reviewRevision','publicationId','version','expectedPreviousPublicationId','isCurrent','errorCode'] as const)
    if(r[key]!==undefined)(result as unknown as Record<string,unknown>)[key]=r[key];
  return result;
}

function parseOperation(v:unknown,releaseId:string):ReleaseOperation|null {
  if(v===null)return null;
  const r=record(v);
  if(!r||!uuid(r.decisionId)||!['queued','running','completed','failed'].includes(String(r.status))||!code(r.errorCode))throw new Error('ACTION_EVIDENCE_INVALID');
  const receipt=r.receipt===null?null:parseActionReceipt(r.receipt,releaseId,r.decisionId);
  if(r.status==='completed'&&(!receipt||['queued','running'].includes(receipt.status)))throw new Error('ACTION_EVIDENCE_INVALID');
  return {decisionId:r.decisionId,status:r.status as ReleaseOperation['status'],receipt,errorCode:r.errorCode as string|null};
}

export function parseReleaseActionEvidence(value:unknown,releaseId:string):ReleaseActionEvidence {
  const e=record(value);
  if(!e||e.releaseId!==releaseId||![e.actorId,e.organizationId,e.releaseId,e.supplierId,e.brandId].every(uuid)
    ||![e.supplier,e.brand,e.status,e.mode].every(v=>typeof v==='string'&&v.length>0&&v.length<=240)
    ||!['sourceVerified','isCurrent','canReview','canPublish'].every(k=>typeof e[k]==='boolean')
    ||!['reviewRevision','totalRows','processedRows','acceptedRows','rejectedRows','warningRows','conflictRows'].every(k=>count(e[k]))
    ||!code(e.errorCode)||!audit(e.brandIdentityAudit)||!nullableUuid(e.currentPublicationId)||!nullableUuid(e.currentReleaseId)
    ||!(e.currentPublicationVersion===null||count(e.currentPublicationVersion)))throw new Error('ACTION_EVIDENCE_INVALID');
  return {...clone(e),reviewOperation:parseOperation(e.reviewOperation,releaseId),publishOperation:parseOperation(e.publishOperation,releaseId)} as ReleaseActionEvidence;
}

export function releasePublicationReady(e:ReleaseActionEvidence|null) {
  return Boolean(e&&e.canPublish===true&&e.sourceVerified===true&&e.status==='validated'&&e.mode==='replace'
    &&e.errorCode===null&&e.totalRows>0&&e.processedRows===e.totalRows&&e.acceptedRows===e.totalRows&&e.rejectedRows===0&&e.conflictRows===0
    &&e.brandIdentityAudit?.checked===true&&e.brandIdentityAudit?.review_required===false
    &&![e.reviewOperation,e.publishOperation].some(op=>op&&['queued','running'].includes(op.status)));
}
export function publicationConfirmationKey(e:ReleaseActionEvidence) {
  return JSON.stringify([e.actorId,e.organizationId,e.releaseId,e.supplierId,e.brandId,e.supplier,e.brand,e.mode,e.totalRows,
    e.reviewRevision,e.status,e.errorCode,e.brandIdentityAudit,e.currentPublicationId,e.currentPublicationVersion,e.canPublish,e.sourceVerified]);
}
export function actionScope(e:ReleaseActionEvidence,origin:string):ActionScope {
  if(!['https://portal.next-master.com','https://next-master-v3-staging-20261006.netlify.app'].includes(origin))throw new Error('ACTION_SCOPE_INVALID');
  return {origin,actorId:e.actorId,organizationId:e.organizationId,releaseId:e.releaseId};
}
function receiptKey(scope:ActionScope,kind:ActionKind) {
  return `nm:supplier-release-action:v1:${encodeURIComponent(scope.origin)}:${scope.organizationId}:${scope.actorId}:${scope.releaseId}:${kind}`;
}
function validCommand(v:unknown,kind:ActionKind,releaseId:string):v is ReviewCommand|PublishCommand {
  const r=record(v);if(!r||r.releaseId!==releaseId||!uuid(r.decisionId))return false;
  const keys=kind==='publish'?['releaseId','decisionId','expectedReviewRevision','expectedPreviousPublicationId']
    :['releaseId','decisionId','action','reason','expectedRevision','expectedStatus','expectedError','expectedAudit'];
  if(Object.keys(r).length!==keys.length||Object.keys(r).some(k=>!keys.includes(k)))return false;
  if(kind==='publish')return count(r.expectedReviewRevision)&&nullableUuid(r.expectedPreviousPublicationId);
  return count(r.expectedRevision)&&typeof r.expectedStatus==='string'&&r.expectedStatus.length<=80&&code(r.expectedError)&&audit(r.expectedAudit)
    &&(r.action==='recheck'&&r.reason==='comparison_repaired'||r.action==='reject'&&['wrong_brand_file','wrong_source_file'].includes(String(r.reason)));
}
export function readDurableAction(storage:ReceiptStorage,scope:ActionScope,kind:ActionKind):DurableAction|null {
  const raw=storage.getItem(receiptKey(scope,kind));if(raw===null)return null;
  let r:Record<string,unknown>|null=null;try{r=record(JSON.parse(raw));}catch{throw new Error('ACTION_RECEIPT_STORAGE_INVALID');}
  if(raw.length>40000||!r||r.schema!==1||r.kind!==kind||JSON.stringify(r.scope)!==JSON.stringify(scope)
    ||!validCommand(r.command,kind,scope.releaseId)||!['pending','unknown','completed','failed'].includes(String(r.phase))||!code(r.errorCode))throw new Error('ACTION_RECEIPT_STORAGE_INVALID');
  const receipt=r.receipt===null?null:parseActionReceipt(r.receipt,scope.releaseId,r.command.decisionId);
  return {schema:1,kind,scope,command:clone(r.command),phase:r.phase as DurableAction['phase'],receipt,errorCode:r.errorCode as string|null};
}
export function saveDurableAction(storage:ReceiptStorage,r:DurableAction) {
  const raw=JSON.stringify(r);if(raw.length>40000)throw new Error('ACTION_RECEIPT_STORAGE_UNAVAILABLE');
  storage.setItem(receiptKey(r.scope,r.kind),raw);
  if(storage.getItem(receiptKey(r.scope,r.kind))!==raw)throw new Error('ACTION_RECEIPT_STORAGE_UNAVAILABLE');
  return r;
}
export function prepareDurableAction(storage:ReceiptStorage,scope:ActionScope,kind:ActionKind,command:ReviewCommand|PublishCommand) {
  if(!validCommand(command,kind,scope.releaseId))throw new Error('ACTION_COMMAND_INVALID');
  const existing=readDurableAction(storage,scope,kind);
  if(existing&&['pending','unknown'].includes(existing.phase))return existing;
  return saveDurableAction(storage,{schema:1,scope,kind,command:clone(command),phase:'pending',receipt:null,errorCode:null});
}
export function updateDurableAction(storage:ReceiptStorage,r:DurableAction,result:{receipt?:ActionReceipt;errorCode?:string;unknown?:boolean}):DurableAction {
  const receipt=result.receipt?parseActionReceipt(result.receipt,r.scope.releaseId,r.command.decisionId):null;
  return saveDurableAction(storage,{...r,receipt,errorCode:result.errorCode||null,
    phase:receipt?(['queued','running'].includes(receipt.status)?'pending':'completed'):result.unknown?'unknown':'failed'});
}
export function reconcileDurableAction(storage:ReceiptStorage,r:DurableAction,e:ReleaseActionEvidence):DurableAction {
  if(e.actorId!==r.scope.actorId||e.organizationId!==r.scope.organizationId||e.releaseId!==r.scope.releaseId)throw new Error('ACTION_ACTOR_CHANGED');
  if(!['pending','unknown'].includes(r.phase))return r;
  const op=r.kind==='review'?e.reviewOperation:e.publishOperation;
  if(!op||op.decisionId!==r.command.decisionId)return r;
  if(op.status==='completed'&&op.receipt)return updateDurableAction(storage,r,{receipt:op.receipt});
  if(op.status==='failed')return updateDurableAction(storage,r,{errorCode:op.errorCode||'ACTION_FAILED'});
  return r;
}
export function reviewCommand(e:ReleaseActionEvidence,reason:ReviewReason,decisionId:string):ReviewCommand {
  return {releaseId:e.releaseId,decisionId,action:reason==='comparison_repaired'?'recheck':'reject',reason,
    expectedRevision:e.reviewRevision,expectedStatus:e.status,expectedError:e.errorCode,expectedAudit:clone(e.brandIdentityAudit)};
}
export function publishCommand(e:ReleaseActionEvidence,decisionId:string):PublishCommand {
  return {releaseId:e.releaseId,decisionId,expectedReviewRevision:e.reviewRevision,expectedPreviousPublicationId:e.currentPublicationId};
}
