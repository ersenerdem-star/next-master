// Workflow names and application versions are durable protocol identities.
export function verifiedWorkflowVersion({compact=false,sharedPrepared=false,commercialFields=false}={}){
 if(commercialFields){
  if(!compact||!sharedPrepared)throw Error('SERVICE_COMMERCIAL_FIELDS_CONFIG');
  return {applicationVersion:'0.10.0-commercial-fields',workflowName:'supplier-price-verified-release-v6'};
 }
 if(compact)return {applicationVersion:'0.9.0-compact-history',workflowName:'supplier-price-verified-release-v5'};
 return sharedPrepared
  ?{applicationVersion:'0.8.0-verified-integrity',workflowName:'supplier-price-verified-release-v4'}
  :{applicationVersion:'0.6.0-verified-recovery',workflowName:'supplier-price-verified-release-v2'};
}
export function requireCompactHistoryConfig(env){
 const commercial=env.SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED;
 if(commercial!==undefined&&!['0','1'].includes(commercial)
  ||commercial==='1'&&(env.SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED!=='1'||env.SUPPLIER_PRICE_SHARED_PREPARED_ENABLED!=='1'))
  throw Error('SERVICE_COMMERCIAL_FIELDS_CONFIG');
 const value=env.SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED;
 if(value!==undefined&&!['0','1'].includes(value))throw Error('SERVICE_COMPACT_HISTORY_CONFIG');
 if(value==='1'&&env.SUPPLIER_PRICE_SHARED_PREPARED_ENABLED!=='1')throw Error('SERVICE_COMPACT_HISTORY_CONFIG');
 if(env.SUPPLIER_PRICE_TARGET_ENVIRONMENT==='production'&&value!=='1')
  throw Object.assign(Error('SERVICE_OPT_IN_REQUIRED'),{configKey:'SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED'});
}
export async function startVersionedVerifiedWorkflow({DBOS,workflow,version,workflowID,queueName,input}){
 const existing=await DBOS.getWorkflowStatus(workflowID);
 if(existing&&(existing.workflowName!==version.workflowName||existing.applicationVersion!==version.applicationVersion))
  throw Error('VERIFIED_VERSION_DRAIN_REQUIRED');
 return DBOS.startWorkflow(workflow,{workflowID,queueName})(input);
}

// Run through a read-only DBOSClient BEFORE launch can recover or dequeue v5/v6.
// The SQL outbox may already be acknowledged, so per-dispatch checks alone
// cannot discover an old pending workflow. No old history is changed here.
export async function requireCompactHistoryDrained(history,{commercialFields=false}={}){
 for(const version of commercialFields?[1,2,3,4,5]:[1,2,3,4]){
  let active;
  try{
   active=await history.listWorkflows({workflowName:`supplier-price-verified-release-v${version}`,
    status:['PENDING','ENQUEUED','DELAYED'],limit:1,loadInput:false,loadOutput:false});
  }catch(error){
   // A new private database has no SDK tables until its first DBOS launch.
   // Other schema drift, permissions, timeouts and network failures block boot.
   if(error?.code==='42P01'&&error.message==='relation "dbos.workflow_status" does not exist')return;
   throw error;
  }
  if(!Array.isArray(active))throw Error('VERIFIED_HISTORY_DRAIN_UNCONFIRMED');
  if(active.length)throw Error('VERIFIED_VERSION_DRAIN_REQUIRED');
 }
}
