// Operational evidence outside durable workflows. Never changes a workflow's
// step order, restarts a job or writes commercial prices.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE=new Set(['PENDING','ENQUEUED','DELAYED']);
const FAILED=new Set(['ERROR','MAX_RECOVERY_ATTEMPTS_EXCEEDED']);
const ELIGIBLE=new Set(['uploaded','parsing','staged','validating']);
export const WORKFLOW_HISTORY_LIMIT=100;
const canonical=id=>`supplier-price-verified:v1:${id}`;
function inputIdentity(workflow){
 const input=workflow?.input;
 if(!Array.isArray(input)||input.length!==1||!UUID.test(input[0]?.releaseId||'')||!UUID.test(input[0]?.handoffId||''))return null;
 return {releaseId:input[0].releaseId,handoffId:input[0].handoffId};
}
const key=input=>`${input.releaseId}:${input.handoffId}`;
const abort=signal=>signal?.throwIfAborted();
function knownFailureLineage(workflow,input,byId){
 const main=canonical(input.releaseId),seen=new Set();
 let current=workflow;
 while(current&&seen.size<WORKFLOW_HISTORY_LIMIT){
  const currentInput=inputIdentity(current);
  if(!currentInput||key(currentInput)!==key(input)||seen.has(current.workflowID))return false;
  if(current.workflowID===main||current.forkedFrom===main)return true;
  seen.add(current.workflowID);current=byId.get(current.forkedFrom);
 }
 return false;
}

export async function observeFailedVerifiedWorkflows({rpc,failed,busy,workflowName,applicationVersion,signal,now=Date.now}){
 if(typeof rpc!=='function'||!Array.isArray(failed)||!Array.isArray(busy))throw Error('SERVICE_FAILURE_OBSERVER_INPUT');
 const summary={marked:0,skipped:0,incomplete:false};
 // An absence in a truncated/malformed active list is not proof that recovery
 // is idle. Do not write any marker from an incomplete history snapshot.
 if(failed.length>=WORKFLOW_HISTORY_LIMIT||busy.length>=WORKFLOW_HISTORY_LIMIT
  ||busy.some(w=>!inputIdentity(w)||!ACTIVE.has(w.status)||w.workflowName!==workflowName||w.applicationVersion!==applicationVersion))
  return {...summary,incomplete:true};
 const active=new Set(busy.map(w=>key(inputIdentity(w))));
 const byId=new Map(failed.map(w=>[w?.workflowID,w]));
 if(byId.size!==failed.length)return {...summary,incomplete:true};
 const candidates=new Map();
 for(const workflow of failed){
  const input=inputIdentity(workflow),failedAt=workflow?.completedAt??workflow?.updatedAt;
  if(!input||!FAILED.has(workflow.status)||workflow.workflowName!==workflowName||workflow.applicationVersion!==applicationVersion
   ||typeof workflow.workflowID!=='string'||!Number.isSafeInteger(failedAt)||failedAt<=0||failedAt>now()+30000
   ||!knownFailureLineage(workflow,input,byId)){
   summary.incomplete=true;continue;
  }
  if(active.has(key(input))){summary.skipped++;continue;}
  const previous=candidates.get(key(input));
  if(!previous||failedAt>previous.failedAt)candidates.set(key(input),{...input,failedAt});
 }
 // Unknown terminal identities may be another recovery generation. Preserve
 // fail-closed behavior rather than marking from a partial interpretation.
 if(summary.incomplete||!candidates.size)return summary;
 abort(signal);
 const contexts=await rpc('get_supplier_price_workflow_failure_context',{
  input_release_ids:[...new Set([...candidates.values()].map(w=>w.releaseId))],
 });
 abort(signal);
 if(!Array.isArray(contexts)||contexts.length>candidates.size)throw Error('SERVICE_FAILURE_CONTEXT_RESPONSE');
 const seen=new Set();
 for(const row of contexts){
  const candidate=candidates.get(`${row?.id}:${row?.handoff_id}`);
  if(!candidate||seen.has(row.id)||row.workflow_id!==canonical(row.id)||typeof row.status!=='string'
   ||!Number.isSafeInteger(row.current_cursor)||row.current_cursor<0||!Number.isSafeInteger(row.processed_rows)||row.processed_rows<0
   ||row.error_code!==null&&(typeof row.error_code!=='string'||! /^[A-Z0-9_]{1,80}$/.test(row.error_code))
   ||typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at)))throw Error('SERVICE_FAILURE_CONTEXT_RESPONSE');
  seen.add(row.id);
 }
 for(const row of contexts){
  const candidate=candidates.get(`${row.id}:${row.handoff_id}`);
  if(!ELIGIBLE.has(row.status)||row.error_code!==null||Date.parse(row.updated_at)>candidate.failedAt){summary.skipped++;continue;}
  abort(signal);
  const result=await rpc('mark_supplier_price_processing_interrupted',{
   input_release_id:row.id,input_handoff_id:row.handoff_id,input_workflow_id:row.workflow_id,
   input_expected_cursor:row.current_cursor,input_expected_updated_at:row.updated_at,
   input_failed_at:new Date(candidate.failedAt).toISOString(),
  });
  if(!result||!['marked','already_marked','skipped'].includes(result.status)||result.release_id!==row.id||result.published!==false)
   throw Error('SERVICE_FAILURE_MARKER_RESPONSE');
  if(result.status==='marked')summary.marked++;else summary.skipped++;
 }
 return summary;
}
