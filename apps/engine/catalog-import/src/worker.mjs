import { DBOS } from "@dbos-inc/dbos-sdk";
import { runCatalogStorageImport } from "./catalog-worker.mjs";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const EXPECTED_STAGING_TARGET = "kaxsqafdevabkxofwdod";
const WORKER_ID = String(process.env.CATALOG_IMPORT_WORKER_ID || `catalog-storage:${process.pid}`);
const QUEUE_NAME = "catalog-import-storage";
const APP_VERSION = "0.1.0-catalog-storage";
const POLL_MS = Math.max(2_000, Math.min(60_000, Number(process.env.CATALOG_IMPORT_POLL_MS || 10_000)));

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
  const query = new URLSearchParams({ select: "id,organization_id,input_scope,created_by", id: `eq.${runId}`, limit: "1" });
  const rows = await supabaseJson(`/rest/v1/catalog_import_runs?${query}`);
  return Array.isArray(rows) ? rows[0] : null;
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
  const claimed = await callRpc("claim_catalog_import_storage_source_system", {
    input_source_id: source.id,
    input_organization_id: source.organization_id,
    input_actor_id: source.created_by,
    input_worker_id: WORKER_ID,
    input_lease_seconds: 3600,
  });
  const claim = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!claim?.claimed) return { status: claim?.status || "busy", sourceId: source.id };
  const run = await getRun(claim.run_id);
  if (!run) throw new Error("CATALOG_IMPORT_RUN_NOT_FOUND");
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
      console.log(JSON.stringify(await pollCatalogImportSources()));
      return;
    }
    while (true) {
      console.log(JSON.stringify({ worker: "catalog-import", status: "polling", workerId: WORKER_ID }));
      await pollCatalogImportSources();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await DBOS.shutdown({ deregister: false, workflowCompletionTimeoutMS: 10_000 });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => { console.error(JSON.stringify({ worker: "catalog-import", status: "failed", errorCode: String(error?.message || "CATALOG_WORKER_FAILED") })); process.exitCode = 1; });
}
