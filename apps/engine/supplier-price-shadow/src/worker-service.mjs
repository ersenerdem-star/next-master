// Operational lifecycle only. Reuses the versioned verified workflow and SQL outbox;
// Admin decisions use a separately enabled, fenced SQL queue. Intake itself
// never publishes, creates fixtures, alters profiles or resets DBOS history.
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {PRODUCTION_SUPABASE_HOST,requireSupplierPriceServiceTarget,requireProductionServiceCredential} from './worker-target.mjs';
import {supabaseApiHeaders} from './supabase-headers.mjs';
import {requireCompactHistoryConfig} from './verified-workflow-version.mjs';
import {SOURCE_COMMERCIAL_FAILURE_CODES} from './upload-verification-consumer.mjs';

export const SERVICE_QUEUE_LIMITS = Object.freeze({globalConcurrency:1,workerConcurrency:1});
const SERVICE_OPT_INS = ['SUPPLIER_PRICE_SERVICE_ENABLED','SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED',
  'SUPPLIER_PRICE_VERIFIED_HANDOFF_ENABLED','SUPPLIER_PRICE_SHARED_PREPARED_ENABLED',
  'SUPPLIER_PRICE_SHADOW_PERSIST','SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED'];
const LOGGABLE_OPT_INS=[...SERVICE_OPT_INS,'SUPPLIER_PRICE_PRODUCTION_ENABLED','SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED','SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED'];
const STARTUP_CODES = new Set(['SHADOW_PERSIST_STAGING_HOST_REQUIRED','SERVICE_STAGING_ORIGIN',
  'SERVICE_OPT_IN_REQUIRED','SERVICE_STAGING_SECRET_REQUIRED','SERVICE_STABLE_EXECUTOR_REQUIRED',
  'SERVICE_CANARY_CONFIG_DENIED','SERVICE_PRIVATE_HISTORY_REQUIRED','SERVICE_BATCH_LIMIT',
  'SERVICE_PORT','SERVICE_ARGUMENTS','SERVICE_CAPABILITY_NOT_CONFIRMED',
  'SERVICE_TARGET_ENVIRONMENT_REQUIRED','SERVICE_PRODUCTION_TARGET_REQUIRED',
  'SERVICE_PRODUCTION_SERVICE_REQUIRED','SERVICE_PRODUCTION_SECRET_REQUIRED',
  'SERVICE_PRODUCTION_HISTORY_REQUIRED','SERVICE_PRODUCTION_EXECUTOR_REQUIRED','SERVICE_COMPACT_HISTORY_CONFIG','SERVICE_COMMERCIAL_FIELDS_CONFIG',
  'VERIFIED_VERSION_DRAIN_REQUIRED','VERIFIED_HISTORY_DRAIN_UNCONFIRMED']);
// Fixed codes and known nonsecret flag names only. Never serialize an Error,
// provider message, stack, connection URL or environment value into host logs.
export function serviceStartupFailure(error) {
  const code=STARTUP_CODES.has(error?.message)?error.message:'SERVICE_STARTUP_UNCONFIRMED';
  return {stage:'worker-service',status:'startup-failed',errorCode:code,
    ...(code==='SERVICE_OPT_IN_REQUIRED'&&LOGGABLE_OPT_INS.includes(error?.configKey)?{configKey:error.configKey}:{}),
    published:false};
}
export function serviceLogger(log=console.error) {
  const emit=level=>()=>log(JSON.stringify({stage:'dbos-service',level,errorCode:'DBOS_OPERATION_REQUIRES_REVIEW',published:false}));
  return {debug(){},info(){},warn:emit('warn'),error:emit('error')};
}
export const SERVICE_RPC_NAMES = new Set([
  'claim_supplier_price_upload_verification','settle_supplier_price_upload_verification',
  'begin_supplier_price_upload_verification','complete_supplier_price_verified_upload',
  'claim_supplier_price_verified_handoff','ack_supplier_price_verified_handoff',
  'get_supplier_price_verified_manifest','claim_supplier_price_verified_release_batch',
  'get_supplier_price_release_status',
  'get_supplier_price_workflow_failure_context','mark_supplier_price_processing_interrupted',
  'stage_supplier_price_release_batch','stage_supplier_price_release_batch_v2','heartbeat_supplier_price_release_batch',
  'finalize_supplier_price_release_shadow_batch',
  'complete_supplier_price_release_duckdb_validation',
]);

const RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Staged alone is not enough: the final persisted-row integrity gate may have
// failed after staging. Only validation or publication clears failed history.
const TERMINAL_RELEASE_STATUSES = new Set(['validated', 'published']);

// DBOS history is private and can outlive a Supabase staging target.  The
// status RPC is executed against the worker's current target; a successful
// lookup with no matching row therefore identifies an orphan from a previous
// target, not an unresolved release in the current target.  Keep malformed
// history fail-closed, and let RPC errors propagate so an outage never clears
// review backpressure.
export function reconcileFailedWorkflowHistory(failed, releaseStatusRows) {
  const statusByRelease = new Map((Array.isArray(releaseStatusRows) ? releaseStatusRows : [])
    .filter(row => RELEASE_ID.test(row?.id || ''))
    .map(row => [row.id.toLowerCase(), row.status]));
  return (Array.isArray(failed) ? failed : []).filter(workflow => {
    const releaseId = workflow?.input?.[0]?.releaseId;
    if (!RELEASE_ID.test(releaseId || '')) return true;
    const status = statusByRelease.get(releaseId.toLowerCase());
    return status !== undefined && !TERMINAL_RELEASE_STATUSES.has(status);
  });
}

export function serviceConfig(env) {
  const target=requireSupplierPriceServiceTarget(env);
  for(const name of SERVICE_OPT_INS) {
    if(env[name]!=='1')throw Object.assign(Error('SERVICE_OPT_IN_REQUIRED'),{configKey:name});
  }
  requireCompactHistoryConfig(env);
  if(target.environment==='production')requireProductionServiceCredential(env.SUPABASE_SERVICE_ROLE_KEY,target.expectedHost);
  else if(!/^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_SERVICE_ROLE_KEY||''))throw Error('SERVICE_STAGING_SECRET_REQUIRED');
  const executorId=env.SUPPLIER_PRICE_EXECUTOR_ID||'';
  if(!/^[a-z][a-z0-9-]{5,79}$/.test(executorId)||executorId==='local')throw Error('SERVICE_STABLE_EXECUTOR_REQUIRED');
  if(target.environment==='production'&&!/^supplier-price-production-[a-z0-9-]+$/.test(executorId))
    throw Error('SERVICE_PRODUCTION_EXECUTOR_REQUIRED');
  if(env.SUPPLIER_PRICE_EXPECTED_RELEASE_ID||env.SUPPLIER_PRICE_WORKFLOW_ID||env.SUPPLIER_PRICE_EXPIRY_TEST_ROLE
    ||env.SUPPLIER_PRICE_SHADOW_PARTITION_MANIFEST||env.SUPPLIER_PRICE_RECOVERY_TEST_PAUSE_AFTER_STAGE==='1'
    ||env.SUPPLIER_PRICE_SHADOW_DRAIN==='1'||env.SUPPLIER_PRICE_OPERATOR_RECOVERY_RELEASE_ID
    ||env.SUPPLIER_PRICE_OPERATOR_RECOVERY_HANDOFF_ID||env.SUPPLIER_PRICE_EXPIRY_TEST_PAUSE)throw Error('SERVICE_CANARY_CONFIG_DENIED');
  const database=new URL(env.DBOS_SYSTEM_DATABASE_URL||'https://invalid.invalid');
  if(!['postgres:','postgresql:'].includes(database.protocol)||!database.hostname||!database.username
    ||!database.password||database.pathname.length<2||database.hash
    ||database.hostname.includes('zjgueqijumzlfioihnkt'))throw Error('SERVICE_PRIVATE_HISTORY_REQUIRED');
  if(target.environment==='production'&&(database.pathname!=='/nm_supplier_production_history'
    ||database.username!=='nm_supplier_production_worker'||database.search
    ||/(^|\.)supabase\.(co|com)$/.test(database.hostname)))throw Error('SERVICE_PRODUCTION_HISTORY_REQUIRED');
  const batchSize=Number(env.SUPPLIER_PRICE_SHADOW_BATCH_SIZE||1000);
  const port=Number(env.PORT||3000);
  // This service is hard-bound to its explicitly selected Supabase target.
  // The verified workflow validates its own persisted rows. Do not silently run the
  // legacy SQL-only validator on an old staged release after an upgrade.
  const autoValidate=false;
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>1000)throw Error('SERVICE_BATCH_LIMIT');
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('SERVICE_PORT');
  // Disk-backed Render services use the default 30s termination window.
  // Leave 10s for cleanup; the CLI hard deadline remains below that window.
  return Object.freeze({executorId,port,batchSize,autoValidate,pollMs:10000,shutdownMs:20000,
    origin:target.origin,environment:target.environment});
}

// Same exact non-mutating service privilege probe as the real staging canary.
// An HTTP 200 at the API root is insufficient and does not validate a secret.
export async function servicePreflight({origin,key,environment='staging',fetchImpl=fetch,commercialFields=false}) {
  if(typeof commercialFields!=='boolean')throw Error('SERVICE_COMMERCIAL_FIELDS_CONFIG');
  const parsed = new URL(origin);
  if(!['staging','production'].includes(environment))throw Error('SERVICE_TARGET_ENVIRONMENT_REQUIRED');
  requireSupplierPriceServiceTarget({SUPABASE_URL:origin,SUPPLIER_PRICE_TARGET_ENVIRONMENT:environment,
    SUPPLIER_PRICE_PRODUCTION_ENABLED:environment==='production'?'1':undefined,
    SUPPLIER_PRICE_EXPECTED_HOST:environment==='production'?PRODUCTION_SUPABASE_HOST:parsed.hostname});
  const verified = parsed.hostname === 'kaxsqafdevabkxofwdod.supabase.co'
    ||environment==='production'&&parsed.hostname===PRODUCTION_SUPABASE_HOST;
  if(environment==='production'&&parsed.origin!=='https://'+PRODUCTION_SUPABASE_HOST)
    throw Error('SERVICE_PRODUCTION_TARGET_REQUIRED');
  if(environment!=='production'&&parsed.hostname===PRODUCTION_SUPABASE_HOST)
    throw Error('SERVICE_PRODUCTION_TARGET_REQUIRED');
  const rpc = verified ? 'get_supplier_price_verified_manifest' : 'inspect_supplier_price_staging_fixture';
  const body = verified
    ? {input_release_id:'00000000-0000-0000-0000-000000000000',input_handoff_id:'00000000-0000-0000-0000-000000000000'}
    : {input_run_id:'00000000-0000-0000-0000-000000000000'};
  const response=await fetchImpl(origin+'/rest/v1/rpc/'+rpc,{
    method:'POST',headers:supabaseApiHeaders(key,'application/json'),redirect:'error',
    body:JSON.stringify(body),signal:AbortSignal.timeout(15000),
  });
  const data=await response.json().catch(()=>null);
  if (verified) {
    if(response.status!==400||data?.code!=='P0001'||data?.message!=='UPLOAD_HANDOFF_NOT_READY')
      throw Error('SERVICE_CAPABILITY_NOT_CONFIRMED');
  } else if(response.status!==400||data?.message!=='STAGING_FIXTURE_NOT_FOUND') {
    throw Error('SERVICE_CAPABILITY_NOT_CONFIRMED');
  }
  if(commercialFields){
    // NULL input stops both functions at their validation gates, before any
    // advisory/row lock or mutation. Feature enablement requires the new SQL.
    if(!verified)throw Error('SERVICE_CAPABILITY_NOT_CONFIRMED');
    for(const [name,payload,message] of [
      ['record_supplier_price_source_compatibility_v2',{input_release_id:null,input_handoff_id:null,
        input_source_sha256:null,input_total_rows:null,input_policy:null},'SOURCE_COMPATIBILITY_INPUT_INVALID'],
      ['stage_supplier_price_release_batch_v2',{input_batch_id:null,input_worker_id:null,input_rows:null},'Invalid supplier shadow staging input'],
    ]){
      const response=await fetchImpl(origin+'/rest/v1/rpc/'+name,{method:'POST',
        headers:supabaseApiHeaders(key,'application/json'),redirect:'error',body:JSON.stringify(payload),
        signal:AbortSignal.timeout(15000)});
      const data=await response.json().catch(()=>null);
      if(response.status!==400||data?.code!=='P0001'||data?.message!==message)
        throw Error('SERVICE_CAPABILITY_NOT_CONFIRMED');
    }
  }
}

export function createWorkerService({verify,dispatch,probe,validate,consumeAdminAction,wait=delay,log=console.log,now=Date.now,pollMs=10000,historyTimeoutMs=5000}) {
  const controller=new AbortController();
  const state={phase:'starting',ready:false,stopping:false,completedCycles:0,lastSuccessAt:null,errorCode:null};
  const snapshot=()=>({...state,published:false});
  const stop=()=>{state.stopping=true;state.ready=false;state.phase='stopping';controller.abort();};
  async function cycle() {
    if(state.stopping)return;
    state.ready=false;
    let validationDegraded=false,intakeIdle=false;
    // Intake is protected by SQL claim/lease RPCs and immutable workflow IDs.
    // Do not make it depend on a DBOS history read: one orphaned or slow history
    // query must never starve every later upload. Existing DBOS work remains
    // durable and the queue limit still bounds execution.
    if(state.stopping)return;
    {
      // Always drain source-verification first. A validation lookup or review
      // failure must never prevent a newly completed upload from being claimed.
      state.phase='verifying-source';
      const verified=await verify();
      if(!['empty','exhausted','verified','rejected'].includes(verified?.status)||verified.published!==false
        ||verified.status==='rejected'&&(![verified.requestId,verified.sessionId,verified.releaseId].every(id=>RELEASE_ID.test(id||''))
          ||!SOURCE_COMMERCIAL_FAILURE_CODES.includes(verified.errorCode)))
        throw Error('SERVICE_VERIFICATION_RESPONSE');
      if(verified.status==='rejected')log(JSON.stringify({stage:'source-verification',status:'rejected',
        releaseId:verified.releaseId,errorCode:verified.errorCode,published:false}));
      if(state.stopping)return;
      state.phase='dispatching';
      const receipt=await dispatch();
      if(!['empty','enqueued'].includes(receipt?.status)||receipt.published!==false)throw Error('SERVICE_DISPATCH_RESPONSE');
      intakeIdle=verified.status!=='verified'&&receipt.status==='empty';
      state.phase=receipt.status==='enqueued'?'enqueued':'idle'; // NEVER staged/published from ACK.
      // Only when no source/handoff work was found may the service advance a
      // staged release through idempotent validation. Errors are observable
      // but non-blocking: the next verification cycle remains available.
      if(verified.status!=='verified' && receipt.status==='empty' && typeof validate==='function'){
        state.phase='validating-release';
        try{
          const validation=await validate();
          if(validation?.status==='validated') state.phase='validated';
          else if(validation?.status!=='empty') state.errorCode='SERVICE_VALIDATION_RESPONSE';
        }catch{
          state.errorCode='SERVICE_VALIDATION_UNCONFIRMED';
          validationDegraded=true;
          log(JSON.stringify({stage:'worker-service',status:'validation-degraded',errorCode:state.errorCode,published:false}));
        }
      }
    }
    // Probe after intake, so a history lookup cannot hold up new uploads. It
    // still determines readiness: unresolved durable failures are not healthy.
    const historyTimer=new AbortController();
    let history;
    try{
      history=await Promise.race([
        probe({signal:historyTimer.signal}),delay(historyTimeoutMs,undefined,{signal:historyTimer.signal})
          .then(()=>{throw Error('SERVICE_HISTORY_TIMEOUT');}),
      ]);
    }finally{historyTimer.abort();}
    if(!history||typeof history.busy!=='boolean'||typeof history.failed!=='boolean')
      throw Error('SERVICE_HISTORY_RESPONSE');
    // A failed historical upload must not starve explicit admin review for a
    // different release. Keep the idle/busy gate and all per-action SQL checks;
    // readiness remains degraded below until those historical errors resolve.
    // The optional action consumer runs only while verified ingestion is idle.
    // Its SQL queue persists the admin's exact decision and survives shutdown.
    if(intakeIdle&&!history.busy&&!state.stopping&&typeof consumeAdminAction==='function'){
      state.phase='admin-release-action';
      const action=await consumeAdminAction();
      if(!['empty','completed','failed','pending'].includes(action?.status)
        ||action.status==='pending'&&action.published!==null
        ||action.status!=='pending'&&typeof action.published!=='boolean')throw Error('SERVICE_ADMIN_ACTION_RESPONSE');
      if(action.status!=='empty')log(JSON.stringify({stage:'admin-release-action',status:action.status,
        decisionId:action.decisionId,releaseId:action.releaseId,published:action.published}));
      state.phase=action.status==='empty'?'idle':`admin-action-${action.status}`;
    }
    if(history.failed)throw Error('SERVICE_WORKFLOW_REQUIRES_REVIEW');
    if(state.stopping)return;
    state.completedCycles++;
    if(validationDegraded){state.phase='validation-degraded';return;}
    state.lastSuccessAt=now();state.errorCode=null;state.ready=true;
  }
  async function run() {
    try {
      while(!state.stopping) {
        try{await cycle();}
        catch(error){
          state.ready=false;state.phase='degraded';
          const message=String(error?.message||'');
          const knownCode=message.match(/^(SERVICE_[A-Z0-9_]+|UPLOAD_[A-Z0-9_]+|VERIFIED_[A-Z0-9_]+|WORKFLOW_[A-Z0-9_]+)/)?.[1];
          state.errorCode=message==='SERVICE_WORKFLOW_REQUIRES_REVIEW'?'WORKFLOW_REQUIRES_REVIEW':knownCode||'WORKER_CYCLE_UNCONFIRMED';
          // Never emit raw provider bodies/credentials/customer data or stacks.
          log(JSON.stringify({stage:'worker-service',status:'degraded',errorCode:state.errorCode,published:false}));
        }
        if(!state.stopping)await wait(pollMs,undefined,{signal:controller.signal}).catch(error=>{
          if(!controller.signal.aborted)throw error;
        });
      }
    }finally{state.ready=false;state.phase='stopped';}
  }
  return {run,cycle,stop,snapshot};
}

export async function startServiceHealth({service,port,host='0.0.0.0'}) {
  const server=createServer((request,response)=>{
    const route=request.url,known=route==='/healthz'||route==='/readyz';
    const state=service.snapshot();
    const ok=route==='/healthz'?!state.stopping:state.ready&&!state.stopping;
    response.setHeader('Content-Type','application/json');response.setHeader('Cache-Control','no-store');
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
    response.writeHead(known?(ok?200:503):404);
    // Internal infrastructure probe, not a customer API or a publication receipt.
    response.end(request.method==='HEAD'?undefined:JSON.stringify(known?{
      status:ok?'ok':'unavailable',phase:state.phase,published:false,
    }:{status:'not-found'}));
  });
  server.requestTimeout=5000;server.headersTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  const close=()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  close.port=server.address().port;
  return close;
}
