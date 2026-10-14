import { DBOS } from "@dbos-inc/dbos-sdk";
import { runCatalogStorageImport } from "./catalog-worker.mjs";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const EXPECTED_STAGING_TARGET = "kaxsqafdevabkxofwdod";
const WORKER_ID = String(process.env.CATALOG_IMPORT_WORKER_ID || `catalog-storage:${process.pid}`);
const QUEUE_NAME = "catalog-import-storage";
const APP_VERSION = "0.1.0-catalog-storage";
const POLL_MS = Math.max(2_000, Math.min(60_000, Number(process.env.CATALOG_IMPORT_POLL_MS || 10_000)));
const FINALIZE_BATCH_SIZE = Math.max(100, Math.min(1000, Number(process.env.CATALOG_IMPORT_FINALIZE_BATCH_SIZE || 1000)));
const MAX_FINALIZATION_BATCHES = Math.max(1, Math.min(50, Number(process.env.CATALOG_IMPORT_MAX_FINALIZATION_BATCHES || 12)));

function requireConfig() {
  if (!/^https:\/\//.test(SUPABASE_URL)) throw new Error("CATALOG_SUPABASE_URL_REQUIRED");
  if (new URL(SUPABASE_URL).hostname !== `${EXPECTED_STAGING_TARGET}.supabase.co` && process.env.CATALOG_IMPORT_ALLOW_PRODUCTION !== "1") throw new Error("CATALOG_STAGING_TARGET_REQUIRED");
  if (!SERVICE_ROLE_KEY) throw new Error("CATALOG_SUPABASE_SERVICE_ROLE_REQUIRED");
  if (!process.env.DBOS_SYSTEM_DATABASE_URL) throw new Error("CATALOG_DBOS_SYSTEM_DATABASE_REQUIRED");
}

function headers(contentType = "application/json") {
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": contentType };
}

function isTransientCatalogError(error) {
  const code = String(error?.code || error?.message || "").toLowerCase();
  return code.includes("fetch") || code.includes("network") || code.includes("timeout")
    || code.includes("connection") || /catalog_(supabase_)?http_(408|425|429|5\d\d)/.test(code)
    || code.includes("temporarily unavailable") || code.includes("lease_fence");
}

async function supabaseJson(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body.slice(0, 500) }; }
  if (!response.ok) throw new Error(`CATALOG_SUPABASE_HTTP_${response.status}`);
  return data;
}

async function listSources() {
  const query = new URLSearchParams({
    select: "id,run_id,organization_id,storage_bucket,storage_object_path,total_bytes,checksum_sha256,created_by,status,cursor_row,lease_expires_at,updated_at",
    status: "in.(uploaded,processing,staged)",
    order: "created_at.asc",
    limit: "4",
  });
  return supabaseJson(`/rest/v1/catalog_import_sources?${query}`);
}

async function getRun(runId) {
  const query = new URLSearchParams({ select: "id,organization_id,input_scope,created_by,status,processing_queued_at", id: `eq.${runId}`, limit: "1" });
  const rows = await supabaseJson(`/rest/v1/catalog_import_runs?${query}`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function listQueuedFinalizationRuns() {
  const query = new URLSearchParams({
    select: "id,organization_id,created_by,status,processing_queued_at",
    processing_queued_at: "not.is.null",
    status: "in.(running,validated,finalizing)",
    order: "processing_queued_at.asc",
    limit: "1",
  });
  return supabaseJson(`/rest/v1/catalog_import_runs?${query}`);
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

const catalogWorkflow = DBOS.registerWorkflow(async (input) => {
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
  const workflowId = `catalog-storage:${claim.run_id}:attempt-${Number(claim.attempt_count || 1)}`;
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
  try {
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

export async function pollCatalogImportSources() {
  const sources = await listSources();
  const results = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    try { results.push(await dispatchSource(source)); }
    catch (error) { results.push({ status: "failed", sourceId: source.id, errorCode: String(error?.message || "CATALOG_SOURCE_WORKFLOW_FAILED").slice(0, 120) }); }
  }
  return results;
}

async function finalizeQueuedCatalogRun(run) {
  let status = String(run?.status || "");
  if (status === "running") {
    const validation = await callRpc("validate_catalog_import_system", {
      input_run_id: run.id,
      input_organization_id: run.organization_id,
      input_actor_id: run.created_by,
    });
    status = String((Array.isArray(validation) ? validation[0] : validation)?.status || "");
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

async function pollCatalogFinalization() {
  const runs = await listQueuedFinalizationRuns();
  const run = Array.isArray(runs) ? runs[0] : null;
  if (!run) return { status: "idle" };
  try {
    return await finalizeQueuedCatalogRun(run);
  } catch (error) {
    // Leave the durable queue marker intact. The next poll retries the same
    // run; deterministic RPC failures already transition the run terminally.
    return { runId: run.id, status: "deferred", errorCode: String(error?.message || "CATALOG_FINALIZATION_DEFERRED").slice(0, 160) };
  }
}

async function main() {
  requireConfig();
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
  try {
    if (process.argv.includes("--once")) {
      const ingestion = await pollCatalogImportSources();
      const finalization = await pollCatalogFinalization();
      console.log(JSON.stringify({ ingestion, finalization }));
      return;
    }
    while (true) {
      console.log(JSON.stringify({ worker: "catalog-import", status: "polling", workerId: WORKER_ID }));
      await pollCatalogImportSources();
      await pollCatalogFinalization();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await DBOS.shutdown({ deregister: false, workflowCompletionTimeoutMS: 10_000 });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => { console.error(JSON.stringify({ worker: "catalog-import", status: "failed", errorCode: String(error?.message || "CATALOG_WORKER_FAILED") })); process.exitCode = 1; });
}
