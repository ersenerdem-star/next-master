import { DBOS } from "@dbos-inc/dbos-sdk";
import { runCatalogStorageImport } from "./catalog-worker.mjs";
import { requireCatalogWorkerTarget } from "./catalog-target-config.mjs";
import { isTransientCatalogTransportError, readCatalogQueue, runCatalogPollLoop } from "./catalog-poll-loop.mjs";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const WORKER_ID = String(process.env.CATALOG_IMPORT_WORKER_ID || `catalog-storage:${process.pid}`);
const QUEUE_NAME = "catalog-import-storage";
const APP_VERSION = "0.1.0-catalog-storage";
const POLL_MS = Math.max(2_000, Math.min(60_000, Number(process.env.CATALOG_IMPORT_POLL_MS || 10_000)));
const FINALIZE_BATCH_SIZE = Math.max(100, Math.min(1000, Number(process.env.CATALOG_IMPORT_FINALIZE_BATCH_SIZE || 1000)));
const MAX_FINALIZATION_BATCHES = Math.max(1, Math.min(50, Number(process.env.CATALOG_IMPORT_MAX_FINALIZATION_BATCHES || 12)));

function requireConfig() {
  requireCatalogWorkerTarget(process.env);
}

function headers(contentType = "application/json") {
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": contentType };
}

function isTransientCatalogError(error) {
  if (isTransientCatalogTransportError(error)) return true;
  const code = String(error?.code || error?.message || "").toLowerCase();
  return code.includes("fetch") || code.includes("network") || code.includes("timeout")
    || code.includes("connection") || /catalog_(supabase_)?http_(408|425|429|5\d\d)/.test(code)
    || code.includes("temporarily unavailable") || code.includes("lease_fence")
    || code === "catalog_storage_source_not_ready";
}

async function supabaseJson(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    redirect: "error",
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body.slice(0, 500) }; }
  if (!response.ok) {
    // Preserve known lease/readiness fences and all-null schema probe rejection.
    // Arbitrary database messages never enter logs.
    if (response.status === 400 && (data?.message === "CATALOG_STORAGE_LEASE_FENCE"
      || (data?.code === "P0001" && ["CATALOG_STORAGE_READ_INPUT_INVALID", "CATALOG_STORAGE_SOURCE_NOT_READY"].includes(data?.message)))) throw new Error(data.message);
    throw new Error(`CATALOG_SUPABASE_HTTP_${response.status}`);
  }
  return data;
}

async function listSources(signal) {
  const query = new URLSearchParams({
    select: "id,run_id,organization_id,storage_bucket,storage_object_path,total_bytes,checksum_sha256,created_by,status,cursor_row,lease_expires_at,updated_at",
    status: "in.(uploaded,processing,staged)",
    order: "created_at.asc",
    limit: "4",
  });
  return readCatalogQueue("sources", () => supabaseJson(`/rest/v1/catalog_import_sources?${query}`, { signal }), { signal });
}

async function getRun(runId) {
  const query = new URLSearchParams({ select: "id,organization_id,input_scope,created_by,status,processing_queued_at", id: `eq.${runId}`, limit: "1" });
  const rows = await supabaseJson(`/rest/v1/catalog_import_runs?${query}`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function listQueuedFinalizationRuns(signal) {
  const query = new URLSearchParams({
    select: "id,organization_id,created_by,status,processing_queued_at,input_scope",
    processing_queued_at: "not.is.null",
    status: "in.(running,validating,validated,finalizing)",
    order: "processing_queued_at.asc",
    limit: "4",
  });
  return readCatalogQueue("finalization", () => supabaseJson(`/rest/v1/catalog_import_runs?${query}`, { signal }), { signal });
}

async function catalogFinalizationSourceReady(run, signal) {
  const query = new URLSearchParams({
    select: "id,run_id,organization_id,created_by,status,cursor_row,rows_parsed,rows_staged,read_completed_at,read_complete_rows",
    run_id: `eq.${run.id}`, organization_id: `eq.${run.organization_id}`, limit: "2",
  });
  const sources = await readCatalogQueue("finalization-source", () =>
    supabaseJson(`/rest/v1/catalog_import_sources?${query}`, { signal }), { signal });
  if (!Array.isArray(sources) || sources.length > 1) throw new Error("CATALOG_FINALIZATION_SOURCE_RESPONSE_INVALID");
  const scope = run.input_scope && typeof run.input_scope === "object" ? run.input_scope : {};
  const source = sources[0];
  // Source-less browser imports retain their existing finalization path. A
  // storage run cannot become a browser run because its source read was absent.
  if (!source) return scope.source_kind !== "storage_csv" && !scope.source_id && !scope.storage_object_path;
  if (source.run_id !== run.id || source.organization_id !== run.organization_id
      || source.created_by !== run.created_by || (scope.source_id && scope.source_id !== source.id)) return false;
  const total = Number(source.read_complete_rows);
  // The queue marker also admits ingestion. Only the durable full-file read
  // acknowledgement makes a staged source eligible; DBOS recovery runs in
  // parallel with this poll after launch. SQL rechecks this under row locks.
  return source.status === "staged" && typeof source.read_completed_at === "string"
    && Number.isFinite(Date.parse(source.read_completed_at))
    && Number.isSafeInteger(total) && total > 0
    && Number(source.cursor_row) === total - 1
    && Number(source.rows_parsed) === total && Number(source.rows_staged) === total;
}

async function clearRunQueueMarker(runId) {
  const query = new URLSearchParams({ id: `eq.${runId}` });
  await supabaseJson(`/rest/v1/catalog_import_runs?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ processing_queued_at: null, processing_queued_by: null }),
  });
}

async function callRpc(name, args) {
  return supabaseJson(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

export async function requireCatalogReadCompletionContract() {
  const probes = [
    ["complete_catalog_import_storage_read_system", {
      input_run_id: null, input_organization_id: null, input_actor_id: null,
      input_worker_id: null, input_lease_token: null, input_lease_generation: null, input_total_rows: null,
    }],
    ["get_catalog_import_storage_read_completion_system", {
      input_run_id: null, input_organization_id: null, input_actor_id: null,
      input_source_id: null, input_source_sha256: null, input_source_bytes: null,
    }],
  ];
  for (const [name, args] of probes) {
    try {
      await callRpc(name, args);
    } catch (error) {
      if (error?.message === "CATALOG_STORAGE_READ_INPUT_INVALID") continue;
      throw new Error("CATALOG_STORAGE_READ_CONTRACT_UNAVAILABLE");
    }
    throw new Error("CATALOG_STORAGE_READ_CONTRACT_UNAVAILABLE");
  }
}

export const catalogWorkflow = DBOS.registerWorkflow(async (input) => {
  return DBOS.runStep(
    () => runCatalogStorageImport({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      runId: input.runId,
      organizationId: input.organizationId,
      actorId: input.actorId,
      resumeAfter: input.resumeAfter,
      source: input.source,
      lease: input.lease,
      fallbackBrand: input.fallbackBrand,
      fallbackMarketSegment: input.fallbackMarketSegment,
      rpc: callRpc,
    }),
    { name: `catalog-source:${input.runId}` },
  );
}, { name: "catalog-import-storage-v1" });

export function catalogWorkflowId(claim) {
  const generation = Number(claim?.lease_generation);
  if (!claim?.run_id || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("CATALOG_STORAGE_LEASE_CONTEXT_REQUIRED");
  }
  // The SQL claim returns lease_generation, not attempt_count. Falling back to
  // attempt-1 reattached every retry to the first terminal DBOS failure.
  // Old workflow IDs/history remain untouched; each new claim gets its own ID.
  return `catalog-storage:${claim.run_id}:lease-${generation}`;
}

async function dispatchSource(source) {
  const run = await getRun(source.run_id);
  const terminalStatuses = new Set(["failed", "cancelled", "finalized", "finalize_failed", "validation_failed", "succeeded"]);
  if (!run || terminalStatuses.has(String(run.status || ""))) {
    return { status: "terminal", sourceId: source.id };
  }
  // A staged source with a missing queue marker is the explicit recovery case:
  // staging committed but the queue handoff response was lost. Other sources
  // require the durable queue marker before they may be claimed.
  if (!run.processing_queued_at && source.status !== "staged") {
    return { status: "awaiting-queue", sourceId: source.id };
  }
  const claimed = await callRpc("claim_catalog_import_storage_source_system", {
    input_source_id: source.id,
    input_organization_id: source.organization_id,
    input_actor_id: source.created_by,
    input_worker_id: WORKER_ID,
    input_lease_seconds: 3600,
  });
  const claim = Array.isArray(claimed) ? claimed[0] : claimed;
  if (claim?.status === "terminal" || claim?.status === "finalized" || claim?.status === "succeeded") {
    return { status: "terminal", sourceId: source.id };
  }
  if (!claim?.claimed) return { status: claim?.status || "busy", sourceId: source.id };
  const scope = run.input_scope && typeof run.input_scope === "object" ? run.input_scope : {};
  const workflowId = catalogWorkflowId(claim);
  try {
    const existing = await DBOS.getWorkflowStatus(workflowId);
    if (existing && ["PENDING", "ENQUEUED", "RUNNING", "SUCCESS"].includes(existing.status)) return { status: "already-dispatched", workflowId };
    const handle = await DBOS.startWorkflow(catalogWorkflow, { workflowID: workflowId, queueName: QUEUE_NAME })({
      runId: claim.run_id,
      organizationId: claim.organization_id,
      actorId: claim.created_by,
      resumeAfter: Number(claim.cursor_row ?? -1),
      source: {
        sourcePath: claim.storage_object_path,
        sourceBytes: Number(claim.total_bytes),
        ...(claim.checksum_sha256 ? { sourceSha256: claim.checksum_sha256 } : {}),
      },
      fallbackBrand: String(scope.brand || scope.brand_name || ""),
      fallbackMarketSegment: String(scope.market_segment || scope.marketSegment || ""),
      lease: {
        sourceId: claim.source_id,
        workerId: claim.lease_owner,
        leaseToken: claim.lease_token,
        leaseGeneration: Number(claim.lease_generation),
        leaseSeconds: 3600,
      },
    });
    return { status: "started", workflowId, result: await handle.getResult() };
  } catch (error) {
    try {
      const release = isTransientCatalogError(error);
      await callRpc(release ? "release_catalog_import_storage_source_system" : "fail_catalog_import_storage_source_system", {
        input_source_id: claim.source_id,
        input_organization_id: claim.organization_id,
        input_actor_id: claim.created_by,
        input_worker_id: claim.lease_owner,
        input_lease_token: claim.lease_token,
        input_lease_generation: claim.lease_generation,
        input_error_code: String(error?.code || error?.message || "CATALOG_STORAGE_WORKER_FAILED").slice(0, 120),
        input_error_message: String(error?.message || "Catalog storage worker failed").slice(0, 1000),
      });
    } catch (failureError) {
      console.error(JSON.stringify({ worker: "catalog-import", status: "source-failure-record-deferred", sourceId: claim.source_id, errorCode: String(failureError?.message || "SOURCE_FAILURE_RECORD_FAILED").slice(0, 120) }));
    }
    throw error;
  }
}

export async function pollCatalogImportSources({ signal } = {}) {
  const sources = await listSources(signal);
  const results = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (signal?.aborted) break;
    try { results.push(await dispatchSource(source)); }
    catch (error) { results.push({ status: "failed", sourceId: source.id, errorCode: String(error?.message || "CATALOG_SOURCE_WORKFLOW_FAILED").slice(0, 120) }); }
  }
  return results;
}

async function finalizeQueuedCatalogRun(run) {
  let status = String(run?.status || "");
  if (status === "running" || status === "validating") {
    let validation = null;
    for (let index = 0; index < MAX_FINALIZATION_BATCHES; index += 1) {
      validation = await callRpc("validate_catalog_import_storage_batch_system", {
        input_run_id: run.id,
        input_organization_id: run.organization_id,
        input_actor_id: run.created_by,
        input_batch_size: FINALIZE_BATCH_SIZE,
      });
      const value = Array.isArray(validation) ? validation[0] : validation;
      status = String(value?.status || status);
      if (status !== "validating") break;
    }
    if (status === "validation_failed") {
      await clearRunQueueMarker(run.id);
      return { runId: run.id, status, hasMore: false };
    }
  }

  if (status !== "validated" && status !== "finalizing") {
    if (["failed", "cancelled", "finalized", "succeeded", "validation_failed", "finalize_failed"].includes(status)) {
      await clearRunQueueMarker(run.id);
    }
    return { runId: run.id, status };
  }

  let latest = null;
  for (let index = 0; index < MAX_FINALIZATION_BATCHES; index += 1) {
    latest = await callRpc("finalize_catalog_import_batch_system", {
      input_run_id: run.id,
      input_organization_id: run.organization_id,
      input_actor_id: run.created_by,
      input_batch_size: FINALIZE_BATCH_SIZE,
    });
    const value = Array.isArray(latest) ? latest[0] : latest;
    status = String(value?.status || status);
    if (value?.has_more === false || ["failed", "cancelled", "finalized", "succeeded", "validation_failed", "finalize_failed"].includes(status)) {
      await clearRunQueueMarker(run.id);
      break;
    }
  }
  const value = Array.isArray(latest) ? latest[0] : latest;
  return { runId: run.id, status: String(value?.status || status), hasMore: value?.has_more !== false };
}

export async function pollCatalogFinalization({ signal } = {}) {
  const runs = await listQueuedFinalizationRuns(signal);
  let waiting;
  for (const run of Array.isArray(runs) ? runs : []) {
    if (signal?.aborted) break;
    if (!await catalogFinalizationSourceReady(run, signal)) {
      waiting ??= { runId: run.id, status: "awaiting-source-completion" };
      continue;
    }
    if (signal?.aborted) break;
    try {
      return await finalizeQueuedCatalogRun(run);
    } catch (error) {
      // Leave the durable queue marker intact. The next poll retries the same
      // run; deterministic RPC failures already transition the run terminally.
      return { runId: run.id, status: "deferred", errorCode: String(error?.message || "CATALOG_FINALIZATION_DEFERRED").slice(0, 160) };
    }
  }
  return waiting || { status: "idle" };
}

async function main() {
  requireConfig();
  // Invalid all-null input is rejected before locks/writes. Never claim a new
  // source or recover an old step against a DB missing the EOF safety guard.
  await requireCatalogReadCompletionContract();
  DBOS.setConfig({
    name: "next-master-catalog-import",
    applicationVersion: APP_VERSION,
    systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
    listenQueues: [QUEUE_NAME],
    executorID: WORKER_ID,
    logLevel: "error",
  });
  await DBOS.launch();
  await DBOS.registerQueue(QUEUE_NAME, { globalConcurrency: 1, workerConcurrency: 1 });
  const controller = new AbortController();
  let shutdownDeadline;
  const stop = () => {
    controller.abort();
    // Stop queue reads/sleeps immediately. Active workflows retain their
    // durable receipts and leases; bound shutdown below Render's 30s deadline.
    shutdownDeadline ??= setTimeout(() => process.exit(1), 25_000);
    shutdownDeadline.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (process.argv.includes("--once")) {
      const ingestion = await pollCatalogImportSources({ signal: controller.signal });
      controller.signal.throwIfAborted();
      const finalization = await pollCatalogFinalization({ signal: controller.signal });
      console.log(JSON.stringify({ ingestion, finalization }));
      return;
    }
    await runCatalogPollLoop({ signal: controller.signal, pollMs: POLL_MS,
      log: (event) => console.log(JSON.stringify({ worker: "catalog-import", workerId: WORKER_ID, ...event })),
      poll: async (signal) => {
        console.log(JSON.stringify({ worker: "catalog-import", status: "polling", workerId: WORKER_ID }));
        const ingestion = await pollCatalogImportSources({ signal });
        for (const source of ingestion) {
          if (source.status === "failed") console.error(JSON.stringify({ worker: "catalog-import", status: "source-failed", sourceId: source.sourceId, errorCode: source.errorCode }));
        }
        if (signal.aborted) return;
        const finalization = await pollCatalogFinalization({ signal });
        if (finalization?.status !== "idle") {
          console.log(JSON.stringify({ worker: "catalog-import", status: "finalization", ...finalization }));
        }
      },
    });
  } finally {
    try {
      await DBOS.shutdown({ deregister: false, workflowCompletionTimeoutMS: 10_000 });
    } finally {
      clearTimeout(shutdownDeadline);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => { console.error(JSON.stringify({ worker: "catalog-import", status: "failed", errorCode: String(error?.message || "CATALOG_WORKER_FAILED") })); process.exitCode = 1; });
}
