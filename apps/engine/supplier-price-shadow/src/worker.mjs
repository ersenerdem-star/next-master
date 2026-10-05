import { DBOS } from "@dbos-inc/dbos-sdk";
import { fetchReleaseMetadata, scanSupplierPriceStorageBatch } from "./storage-scan.mjs";
import { scanPreparedSupplierPriceBatch } from "./prepared-partitions.mjs";
import { supabaseApiHeaders } from "./supabase-headers.mjs";
import { requireRecoveryTestHook, pauseRecoveryTestAfterStage } from "./shadow-recovery-test-hook.mjs";
import { requireExpiryTestHook, expiryTestLeaseSeconds, pauseExpiryTestAfterStage } from "./shadow-expiry-test-hook.mjs";
import { shadowWorkerQueueName } from "./shadow-worker-queue.mjs";
import {dispatchVerifiedSupplierPriceHandoff,VERIFIED_QUEUE} from "./verified-upload-handoff.mjs";
import {createVerifiedReleaseWorkflow} from "./verified-release-workflow.mjs";
import {createSharedPreparedSource} from "./shared-prepared-source.mjs";
import {createPartitionedVerifiedWorkflow} from "./partitioned-verified-workflow.mjs";
import {consumeUploadVerification} from './upload-verification-consumer.mjs';
import {serviceConfig,servicePreflight,serviceLogger,serviceStartupFailure,createWorkerService,startServiceHealth,SERVICE_QUEUE_LIMITS,SERVICE_RPC_NAMES} from './worker-service.mjs';
import { requireShadowStagingHost, requireCompleteShadowScan, requireShadowStageReceipt,
  requireShadowHeartbeatReceipt, requireShadowDrainProgress } from "./shadow-batch-contract.mjs";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const WORKER_ID = String(process.env.SUPPLIER_PRICE_WORKER_ID || `dbos-shadow:${process.pid}`);
const BATCH_SIZE = Math.min(10000, Math.max(1, Number(process.env.SUPPLIER_PRICE_SHADOW_BATCH_SIZE || 1000)));
const STORAGE_BUCKET = String(process.env.SUPPLIER_PRICE_STORAGE_BUCKET || "supplier-price-imports");
const PERSIST_SHADOW_ROWS = String(process.env.SUPPLIER_PRICE_SHADOW_PERSIST || "") === "1";
const PREPARED_PARTITION_MANIFEST = String(process.env.SUPPLIER_PRICE_SHADOW_PARTITION_MANIFEST || "").trim();
const SHARED_PREPARED = process.env.SUPPLIER_PRICE_SHARED_PREPARED_ENABLED === "1";

function requireVerifiedMode() {
  if(process.env.SUPPLIER_PRICE_VERIFIED_HANDOFF_ENABLED !== "1" || !PERSIST_SHADOW_ROWS
    || PREPARED_PARTITION_MANIFEST || process.env.SUPPLIER_PRICE_EXPIRY_TEST_ROLE
    || process.env.SUPPLIER_PRICE_RECOVERY_TEST_PAUSE_AFTER_STAGE === "1")throw Error("VERIFIED_HANDOFF_DISABLED_OR_UNSAFE_CONFIG");
  requireShadowStagingHost(SUPABASE_URL);
}

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function callRpc(name, args) {
  const serviceMode=process.argv[2]==='--service';
  if(serviceMode&&!SERVICE_RPC_NAMES.has(name))throw Error('SERVICE_RPC_DENIED');
  const response = await fetch(`${requireEnv("SUPABASE_URL", SUPABASE_URL)}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: supabaseApiHeaders(
      requireEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY),
      "application/json",
    ),
    body: JSON.stringify(args),
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  const rawBody = await response.text();
  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = { raw: rawBody.slice(0, 500) };
  }
  if (!response.ok) {
    if(serviceMode)throw Error(`SERVICE_RPC_HTTP_${response.status}`);
    const detail = [body?.message, body?.error, body?.hint, body?.details]
      .filter(Boolean)
      .join(" | ");
    throw new Error(`${name} failed HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return body;
}

async function claimReleaseBatch(releaseId, handoffId, workerId = WORKER_ID) {
  return callRpc(handoffId ? "claim_supplier_price_verified_release_batch" : "claim_supplier_price_release_batch", {
    input_release_id: releaseId,
    ...(handoffId ? {input_handoff_id:handoffId} : {}),
    input_worker_id: workerId,
    input_batch_size: BATCH_SIZE,
    input_lease_seconds: expiryTestLeaseSeconds(),
  });
}

async function recordShadowHeartbeat(batch, processedRows, cursor, workerId = WORKER_ID) {
  return callRpc("heartbeat_supplier_price_release_batch", {
    input_batch_id: batch.batch_id,
    input_worker_id: workerId,
    input_processed_rows: processedRows,
    input_cursor: cursor,
    input_lease_seconds: 120,
  });
}

async function finalizeShadowBatch(batch, scan, workerId = WORKER_ID) {
  return callRpc("finalize_supplier_price_release_shadow_batch", {
    input_batch_id: batch.batch_id,
    input_worker_id: workerId,
    input_processed_rows: scan.batchRows,
    input_cursor: scan.cursorEnd,
    input_accepted_rows: scan.acceptedRows,
    input_warning_rows: scan.warningRows,
    input_rejected_rows: scan.rejectedRows,
  });
}

async function stageShadowRows(batch, rows, workerId = WORKER_ID) {
  return callRpc("stage_supplier_price_release_batch", {
    input_batch_id: batch.batch_id,
    input_worker_id: workerId,
    input_rows: rows,
  });
}

// Shadow mode scans and closes its batch. Row persistence and commercial
// publication are separate phases.
async function shadowSupplierRelease(input) {
  const workerId = input.handoffId ? `verified:${input.handoffId}` : WORKER_ID;
  const claim = await DBOS.runStep(() => claimReleaseBatch(input.releaseId, input.handoffId, workerId), {
    name: `claim:${input.releaseId}`,
  });
  // Supabase table-returning RPCs arrive as a one-row array. Normalize it
  // before inspecting the lease status so a claimed batch continues through
  // scan and heartbeat instead of returning immediately after the claim.
  const claimRow = Array.isArray(claim) ? claim[0] : claim;
  // Guarded claim reacquires unfinished batches before reporting complete.
  // Complete is already finalized; do not invoke the legacy recovery RPC.
  if (claimRow?.status !== "claimed") return { mode: "shadow", claim: claimRow || claim };
  const release = await DBOS.runStep(() => input.handoffId
    ? callRpc("get_supplier_price_verified_manifest",{input_release_id:input.releaseId,input_handoff_id:input.handoffId})
    : fetchReleaseMetadata({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    releaseId: input.releaseId,
  }), {
    name: `release:${input.releaseId}`,
  });
  const scan = await DBOS.runStep(() => PREPARED_PARTITION_MANIFEST
    ? scanPreparedSupplierPriceBatch({ release, claim: claimRow, manifestPath: PREPARED_PARTITION_MANIFEST, includeRows: PERSIST_SHADOW_ROWS })
    : scanSupplierPriceStorageBatch({
      release,
      claim: claimRow,
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      bucket: STORAGE_BUCKET,
      includeRows: PERSIST_SHADOW_ROWS,
  }), {
    name: `scan:${claimRow.batch_id}`,
  });
  requireCompleteShadowScan(claimRow, scan, PERSIST_SHADOW_ROWS);
  let staged = null;
  if (PERSIST_SHADOW_ROWS) {
    requireShadowStagingHost(SUPABASE_URL);
    staged = await DBOS.runStep(() => stageShadowRows(claimRow, scan.rows || [], workerId), {
      name: `stage:${claimRow.batch_id}`,
    });
    requireShadowStageReceipt(staged, claimRow, scan.batchRows);
    await pauseRecoveryTestAfterStage(input.releaseId, claimRow, scan.batchRows);
    await pauseExpiryTestAfterStage(input.releaseId, claimRow, scan, operation => {
      if (operation === "stage") return stageShadowRows(claimRow, scan.rows || []);
      if (operation === "heartbeat") return recordShadowHeartbeat(claimRow, scan.batchRows, scan.cursorEnd);
      if (operation === "finalize") return finalizeShadowBatch(claimRow, scan);
      throw new Error("EXPIRY_UNKNOWN_PROBE_OPERATION");
    });
  }
  const heartbeat = await DBOS.runStep(() => recordShadowHeartbeat(claimRow, scan.batchRows, scan.cursorEnd, workerId), {
    name: `heartbeat:${claimRow.batch_id}`,
  });
  requireShadowHeartbeatReceipt(heartbeat, claimRow, scan);
  const finalized = await DBOS.runStep(() => finalizeShadowBatch(claimRow, scan, workerId), {
    name: `finalize:${claimRow.batch_id}`,
  });
  const finalizedRow = Array.isArray(finalized) ? finalized[0] : finalized;
  if (finalizedRow?.status !== "finalized") {
    throw new Error(`SHADOW_FINALIZATION_INCOMPLETE:${finalizedRow?.status || "missing"}`);
  }
  return { mode: "shadow", claim: claimRow, release, scan: { ...scan, ...(scan.rows ? { rows: undefined } : {}) }, staged, heartbeat, finalized, published: false };
}

const shadowWorkflow = DBOS.registerWorkflow(shadowSupplierRelease, {
  name: "supplier-price-shadow-release",
});

// Separate workflow/version/queue: source verification never auto-publishes.
const verifiedWorkflow = DBOS.registerWorkflow(async input => {
  requireVerifiedMode();
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuid.test(input?.releaseId||'')||!uuid.test(input?.handoffId||''))throw Error("VERIFIED_WORKFLOW_INPUT");
  let previousCursor=0;
  for(;;){
    const result=await shadowSupplierRelease(input);
    if(['busy','lock_waiting'].includes(result?.claim?.status)){await DBOS.sleep(1000);continue;}
    const progress=requireShadowDrainProgress(result,previousCursor);
    if(progress.complete)return {status:'staged',releaseId:input.releaseId,handoffId:input.handoffId,published:false};
    previousCursor=progress.cursor;
  }
},{name:'supplier-price-verified-release-v1'});

// New durable step order requires a separate application/workflow version.
// Do not resume an old 0.5.0 execution under v2 or rewrite its recorded steps.
const VERIFIED_APP_VERSION=SHARED_PREPARED?'0.7.0-shared-prepared':'0.6.0-verified-recovery';
const VERIFIED_WORKFLOW_NAME=SHARED_PREPARED?'supplier-price-verified-release-v3':'supplier-price-verified-release-v2';
const verifiedRecoveryWorkflow=DBOS.registerWorkflow(createVerifiedReleaseWorkflow({DBOS,rpc:callRpc,
  requireMode:requireVerifiedMode,batchSize:BATCH_SIZE,
  scanSource:({release,claim})=>scanSupplierPriceStorageBatch({release,claim,supabaseUrl:SUPABASE_URL,
    serviceRoleKey:SERVICE_ROLE_KEY,bucket:STORAGE_BUCKET,includeRows:true})
}),{name:'supplier-price-verified-release-v2'});
// Separate v3 step history: preparation is durable and precedes SQL batch leases.
// Provision private bucket/client-deny policy first; never activate by default.
const verifiedPartitionedWorkflow=DBOS.registerWorkflow(async input=>{
  requireVerifiedMode();
  if(!SHARED_PREPARED)throw Error('SHARED_PREPARED_DISABLED');
  const source=createSharedPreparedSource({supabaseUrl:SUPABASE_URL,serviceRoleKey:SERVICE_ROLE_KEY});
  return createPartitionedVerifiedWorkflow({DBOS,rpc:callRpc,source,requireMode:requireVerifiedMode,batchSize:BATCH_SIZE})(input);
},{name:'supplier-price-verified-release-v3'});

async function main() {
  const operatorRecovery = process.argv[2] === "--operator-recover";
  const releaseId = operatorRecovery
    ? String(process.env.SUPPLIER_PRICE_OPERATOR_RECOVERY_RELEASE_ID || "").trim()
    : String(process.argv[2] || "").trim();
  const handoffId = operatorRecovery
    ? String(process.env.SUPPLIER_PRICE_OPERATOR_RECOVERY_HANDOFF_ID || "").trim()
    : "";
  const serviceMode=releaseId==='--service';
  const config=serviceMode?serviceConfig(process.env):null;
  if(serviceMode&&process.argv.length!==3)throw Error('SERVICE_ARGUMENTS');
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(operatorRecovery && (!uuid.test(releaseId) || !uuid.test(handoffId)))
    throw Error('OPERATOR_RECOVERY_RELEASE_AND_HANDOFF_REQUIRED');
  const verified = serviceMode || releaseId === "--verified-handoff" || operatorRecovery;
  if(verified)requireVerifiedMode();
  if(serviceMode)await servicePreflight({origin:config.origin,key:SERVICE_ROLE_KEY});
  if (!releaseId) throw new Error("Usage: npm start -- <release-id> | --check-only");
  const expiryRole = process.env.SUPPLIER_PRICE_EXPIRY_TEST_ROLE || "";
  const queueName = verified ? VERIFIED_QUEUE : shadowWorkerQueueName({ expiryRole, releaseId });
  DBOS.setConfig({
    name: "next-master-supplier-price-shadow",
    applicationVersion: verified ? VERIFIED_APP_VERSION : PERSIST_SHADOW_ROWS ? "0.4.0-shadow-recovery" : "0.3.0-shadow-recovery-scan",
    systemDatabaseUrl: requireEnv("DBOS_SYSTEM_DATABASE_URL", process.env.DBOS_SYSTEM_DATABASE_URL),
    ...(process.env.SUPPLIER_PRICE_EXECUTOR_ID ? { executorID: process.env.SUPPLIER_PRICE_EXECUTOR_ID } : {}),
    // Legacy workers must never accidentally consume the separately gated queue.
    listenQueues: [queueName],
    ...(serviceMode?{systemDatabasePoolSize:5,systemDatabasePollingConcurrency:2,
      maxConcurrentQueueDispatches:1,logLevel:'error',logger:serviceLogger()} : {}),
  });
  let launched = false;
  let service,closeHealth,stop,shutdownDeadline;
  try {
    requireRecoveryTestHook({ enabled: process.env.SUPPLIER_PRICE_RECOVERY_TEST_PAUSE_AFTER_STAGE === "1",
      releaseId, supabaseUrl: SUPABASE_URL, canSend: typeof process.send === "function" });
    requireExpiryTestHook({ role: process.env.SUPPLIER_PRICE_EXPIRY_TEST_ROLE || "",
      releaseId, supabaseUrl: SUPABASE_URL, canSend: typeof process.send === "function" });
    if (PERSIST_SHADOW_ROWS) requireShadowStagingHost(SUPABASE_URL);
    await DBOS.launch();
    launched = true;
    await DBOS.registerQueue(queueName,serviceMode?SERVICE_QUEUE_LIMITS:undefined);
    if (operatorRecovery) {
      // DBOS ERROR workflows are terminal and cannot be resumed in place.
      // Use a new, explicit operator identity so the verified SQL lease RPC
      // can reclaim only the expired batch for this exact handoff. This path
      // never publishes commercial data.
      const workflowId = `supplier-price-operator-recovery:v1:${releaseId}:${Date.now()}`;
      const handle = await DBOS.startWorkflow(verifiedPartitionedWorkflow, {
        workflowID: workflowId,
        queueName: VERIFIED_QUEUE,
      })({ releaseId, handoffId });
      const result = await handle.getResult();
      console.log(JSON.stringify({
        mode: "operator-recovery",
        workflowId,
        releaseId,
        handoffId,
        result,
        published: false,
      }));
      return;
    }
    if(serviceMode){
      service=createWorkerService({pollMs:config.pollMs,
        verify:()=>consumeUploadVerification({rpc:callRpc,workerId:config.executorId+':verify',
          supabaseUrl:SUPABASE_URL,serviceRoleKey:SERVICE_ROLE_KEY}),
        dispatch:()=>dispatchVerifiedSupplierPriceHandoff({rpc:callRpc,workerId:config.executorId+':dispatch',
          startWorkflow:async({workflowID,queueName,input})=>{
            const existing=await DBOS.getWorkflowStatus(workflowID);
            if(existing&&(existing.workflowName!==VERIFIED_WORKFLOW_NAME||existing.applicationVersion!==VERIFIED_APP_VERSION))
              throw Error('VERIFIED_VERSION_DRAIN_REQUIRED');
            return DBOS.startWorkflow(verifiedPartitionedWorkflow,{workflowID,queueName})(input);
          }}),
      probe:async()=>{
          const scope={workflowName:VERIFIED_WORKFLOW_NAME,applicationVersion:VERIFIED_APP_VERSION,limit:100,loadInput:true};
          const busy=await DBOS.listWorkflows({...scope,status:['PENDING','ENQUEUED','DELAYED']});
          const failed=await DBOS.listWorkflows({...scope,status:['ERROR','MAX_RECOVERY_ATTEMPTS_EXCEEDED']});
          // A terminal DBOS error remains in history after an explicit operator
          // recovery succeeds. Keep the audit trail, but do not leave the
          // intake service degraded when that exact release is already staged.
          const failedReleaseIds=[...new Set(failed.map(workflow=>workflow.input?.[0]?.releaseId)
            .filter(value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||'')))];
          let unresolvedFailed=failed;
          if(failedReleaseIds.length){
            const response=await fetch(`${SUPABASE_URL}/rest/v1/supplier_price_releases?id=in.(${failedReleaseIds.join(',')})&select=id,status`,{
              headers:supabaseApiHeaders(SERVICE_ROLE_KEY),redirect:'error',signal:AbortSignal.timeout(15000),
            });
            if(!response.ok)throw Error('SERVICE_RELEASE_STATUS_UNCONFIRMED');
            const rows=await response.json();
            const resolved=new Set((Array.isArray(rows)?rows:[])
              .filter(row=>['staged','published'].includes(row?.status)).map(row=>row.id));
            unresolvedFailed=failed.filter(workflow=>!resolved.has(workflow.input?.[0]?.releaseId));
          }
          return {busy:busy.length>0,failed:unresolvedFailed.length>0};
        }});
      closeHealth=await startServiceHealth({service,port:config.port});
      stop=()=>{
        service.stop();
        // Stop intake immediately; allow bounded completion. If source I/O or
        // shutdown stalls, exit non-successfully and preserve SQL leases/history
        // for the SAME executor/database to recover. Never reset/re-upload.
        shutdownDeadline??=setTimeout(()=>process.exit(1),config.shutdownMs+5000);
        shutdownDeadline.unref();
      };
      process.on('SIGINT',stop);process.on('SIGTERM',stop);
      console.log(JSON.stringify({stage:'worker-service',status:'started',applicationVersion:VERIFIED_APP_VERSION,
        executionLimit:1,batchSize:config.batchSize,published:false}));
      await service.run();
      return;
    }
    if(verified){
      let queuedHandle;
      const receipt=await dispatchVerifiedSupplierPriceHandoff({rpc:callRpc,workerId:WORKER_ID,
        expectedReleaseId:process.env.SUPPLIER_PRICE_EXPECTED_RELEASE_ID||undefined,
        startWorkflow:async ({workflowID,queueName,input})=>{
          const existing=await DBOS.getWorkflowStatus(workflowID);
          // Never attach a new step order to an old pending/history identity.
          if(existing&&(existing.workflowName!==VERIFIED_WORKFLOW_NAME||existing.applicationVersion!==VERIFIED_APP_VERSION))
            throw Error('VERIFIED_VERSION_DRAIN_REQUIRED');
          queuedHandle=await DBOS.startWorkflow(SHARED_PREPARED?verifiedPartitionedWorkflow:verifiedRecoveryWorkflow,{workflowID,queueName})(input);
          return queuedHandle;
        }});
      console.log(JSON.stringify(receipt));
      if(queuedHandle)console.log(JSON.stringify(await queuedHandle.getResult()));
      // An acknowledged outbox can be empty while DBOS has re-enqueued this
      // executor's interrupted workflows on its internal recovery queue. Do
      // not shut the queue runner down until those accepted jobs have settled.
      for(;;){
        const recovering=await DBOS.listWorkflows({workflowName:VERIFIED_WORKFLOW_NAME,
          applicationVersion:VERIFIED_APP_VERSION,executorId:process.env.SUPPLIER_PRICE_EXECUTOR_ID||'local',
          status:['PENDING','ENQUEUED'],limit:100,loadInput:true});
        if(!recovering.length)break;
        for(const workflow of recovering){
          const input=workflow.input?.[0];
          if(workflow.workflowID!==`supplier-price-verified:v1:${input?.releaseId}`
            ||!input?.handoffId)throw Error('VERIFIED_RECOVERY_IDENTITY');
          console.log(JSON.stringify(await DBOS.retrieveWorkflow(workflow.workflowID).getResult()));
        }
      }
      return;
    }
    if (releaseId === "--check-only") {
      console.log(JSON.stringify({ status: "dbos-ready", mode: "shadow" }));
      return;
    }
    const drain = process.env.SUPPLIER_PRICE_SHADOW_DRAIN === "1";
    const baseWorkflowId = String(
      process.env.SUPPLIER_PRICE_WORKFLOW_ID || `supplier-price-shadow:${releaseId}`,
    ).trim();
    let previousCursor = 0;
    for (let run = 1; ; run += 1) {
      const workflowId = drain ? `${baseWorkflowId}:batch-${run}` : baseWorkflowId;
      console.log(`DBOS workflow: ${workflowId}`);
      const handle = await DBOS.startWorkflow(shadowWorkflow, {
        workflowID: workflowId,
        queueName,
      })({ releaseId });
      const result = await handle.getResult();
      console.log(JSON.stringify(result));
      const progress = requireShadowDrainProgress(result, previousCursor);
      if (result?.release?.total_rows) {
        console.log(JSON.stringify({ stage: PERSIST_SHADOW_ROWS ? "persistence" : "scan",
          processedRows: progress.cursor, totalRows: result.release.total_rows,
          percent: Number((100 * progress.cursor / result.release.total_rows).toFixed(2)), published: false }));
      }
      if (progress.complete) break;
      if (!drain) break;
      previousCursor = progress.cursor;
    }
  } finally {
    if(stop){process.off('SIGINT',stop);process.off('SIGTERM',stop);}
    service?.stop();
    if (launched) await DBOS.shutdown({ deregister: !serviceMode, workflowCompletionTimeoutMS: config?.shutdownMs||5000 });
    if(closeHealth)await closeHealth();
    clearTimeout(shutdownDeadline);
  }
}

main().catch((error) => {
  if(process.argv[2]==='--service'){
    console.error(JSON.stringify(serviceStartupFailure(error)));
    console.error('Supplier staging worker service stopped; check private operational status. No publication enabled.');
  }
  else console.error("supplier price shadow worker failed", error);
  process.exitCode = 1;
});
