// Operational lifecycle only. Reuses the verified v3 workflow and SQL outbox;
// never publishes, creates fixtures, alters profiles or resets DBOS history.
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {requireShadowStagingHost} from './shadow-batch-contract.mjs';
import {supabaseApiHeaders} from './supabase-headers.mjs';

export const SERVICE_QUEUE_LIMITS = Object.freeze({globalConcurrency:1,workerConcurrency:1});
export function serviceLogger(log=console.error) {
  const emit=level=>()=>log(JSON.stringify({stage:'dbos-service',level,errorCode:'DBOS_OPERATION_REQUIRES_REVIEW',published:false}));
  return {debug(){},info(){},warn:emit('warn'),error:emit('error')};
}
export const SERVICE_RPC_NAMES = new Set([
  'claim_supplier_price_upload_verification','settle_supplier_price_upload_verification',
  'begin_supplier_price_upload_verification','complete_supplier_price_verified_upload',
  'claim_supplier_price_verified_handoff','ack_supplier_price_verified_handoff',
  'get_supplier_price_verified_manifest','claim_supplier_price_verified_release_batch',
  'stage_supplier_price_release_batch','heartbeat_supplier_price_release_batch',
  'finalize_supplier_price_release_shadow_batch',
]);

export function serviceConfig(env) {
  const url=new URL(env.SUPABASE_URL||'https://invalid.invalid');
  requireShadowStagingHost(url.href);
  if(url.pathname!=='/'||url.search||url.hash)throw Error('SERVICE_STAGING_ORIGIN');
  for(const name of ['SUPPLIER_PRICE_SERVICE_ENABLED','SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED',
    'SUPPLIER_PRICE_VERIFIED_HANDOFF_ENABLED','SUPPLIER_PRICE_SHARED_PREPARED_ENABLED',
    'SUPPLIER_PRICE_SHADOW_PERSIST','SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED']) {
    if(env[name]!=='1')throw Error('SERVICE_OPT_IN_REQUIRED');
  }
  if(!/^sb_secret_[A-Za-z0-9_-]+$/.test(env.SUPABASE_SERVICE_ROLE_KEY||''))throw Error('SERVICE_STAGING_SECRET_REQUIRED');
  const executorId=env.SUPPLIER_PRICE_EXECUTOR_ID||'';
  if(!/^[a-z][a-z0-9-]{5,79}$/.test(executorId)||executorId==='local')throw Error('SERVICE_STABLE_EXECUTOR_REQUIRED');
  if(env.SUPPLIER_PRICE_EXPECTED_RELEASE_ID||env.SUPPLIER_PRICE_WORKFLOW_ID||env.SUPPLIER_PRICE_EXPIRY_TEST_ROLE
    ||env.SUPPLIER_PRICE_SHADOW_PARTITION_MANIFEST||env.SUPPLIER_PRICE_RECOVERY_TEST_PAUSE_AFTER_STAGE==='1'
    ||env.SUPPLIER_PRICE_SHADOW_DRAIN==='1')throw Error('SERVICE_CANARY_CONFIG_DENIED');
  const database=new URL(env.DBOS_SYSTEM_DATABASE_URL||'https://invalid.invalid');
  if(!['postgres:','postgresql:'].includes(database.protocol)||!database.hostname||!database.username
    ||!database.password||database.pathname.length<2||database.hash
    ||database.hostname.includes('zjgueqijumzlfioihnkt'))throw Error('SERVICE_PRIVATE_HISTORY_REQUIRED');
  const batchSize=Number(env.SUPPLIER_PRICE_SHADOW_BATCH_SIZE||1000);
  const port=Number(env.PORT||3000);
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>1000)throw Error('SERVICE_BATCH_LIMIT');
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('SERVICE_PORT');
  return Object.freeze({executorId,port,batchSize,pollMs:10000,shutdownMs:30000,origin:url.origin});
}

// Same exact non-mutating service privilege probe as the real staging canary.
// An HTTP 200 at the API root is insufficient and does not validate a secret.
export async function servicePreflight({origin,key,fetchImpl=fetch}) {
  const response=await fetchImpl(origin+'/rest/v1/rpc/inspect_supplier_price_staging_fixture',{
    method:'POST',headers:supabaseApiHeaders(key,'application/json'),redirect:'error',
    body:JSON.stringify({input_run_id:'00000000-0000-0000-0000-000000000000'}),signal:AbortSignal.timeout(15000),
  });
  const data=await response.json().catch(()=>null);
  if(response.status!==400||data?.message!=='STAGING_FIXTURE_NOT_FOUND')throw Error('SERVICE_CAPABILITY_NOT_CONFIRMED');
}

export function createWorkerService({verify,dispatch,probe,wait=delay,log=console.log,now=Date.now,pollMs=10000}) {
  const controller=new AbortController();
  const state={phase:'starting',ready:false,stopping:false,completedCycles:0,lastSuccessAt:null,errorCode:null};
  const snapshot=()=>({...state,published:false});
  const stop=()=>{state.stopping=true;state.ready=false;state.phase='stopping';controller.abort();};
  async function cycle() {
    if(state.stopping)return;
    state.ready=false;
    state.phase='checking-history';
    const history=await probe();
    if(typeof history?.busy!=='boolean'||typeof history?.failed!=='boolean')throw Error('SERVICE_HISTORY_RESPONSE');
    if(state.stopping)return;
    if(history.failed)throw Error('SERVICE_WORKFLOW_REQUIRES_REVIEW');
    // Backpressure: one accepted v3 workflow at a time, including recovered work.
    // Do not start another large-source parse while that workflow is active.
    if(history.busy){state.phase='processing';}
    else {
      state.phase='verifying-source';
      const verified=await verify();
      if(!['empty','exhausted','verified'].includes(verified?.status)||verified.published!==false)
        throw Error('SERVICE_VERIFICATION_RESPONSE');
      if(state.stopping)return;
      state.phase='dispatching';
      const receipt=await dispatch();
      if(!['empty','enqueued'].includes(receipt?.status)||receipt.published!==false)throw Error('SERVICE_DISPATCH_RESPONSE');
      state.phase=receipt.status==='enqueued'?'enqueued':'idle'; // NEVER staged/published from ACK.
    }
    state.lastSuccessAt=now();state.completedCycles++;state.errorCode=null;state.ready=true;
  }
  async function run() {
    try {
      while(!state.stopping) {
        try{await cycle();}
        catch(error){
          state.ready=false;state.phase='degraded';
          state.errorCode=error?.message==='SERVICE_WORKFLOW_REQUIRES_REVIEW'?'WORKFLOW_REQUIRES_REVIEW':'WORKER_CYCLE_UNCONFIRMED';
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
