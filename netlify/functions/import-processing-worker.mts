import type { Config, Context } from "@netlify/functions";
import { json, getJson, sendJson, serviceRoleHeaders } from "./_shared/http.mts";

type QueuedCatalogRun = {
  id: string;
  organization_id: string;
  created_by: string | null;
  status: string;
};

type QueuedSupplierRun = {
  id: string;
  organization_id: string;
  brand_id: string;
  created_by: string | null;
  status: string;
  catalog_sync_status: string | null;
};

const CATALOG_BATCH_SIZE = 100;
const SUPPLIER_BATCH_SIZE = 500;
const CATALOG_SYNC_BATCH_SIZE = 1000;
// Keep a scheduled invocation bounded. The cron runs every two minutes; doing
// several long batches in one invocation lets invocations overlap and turns a
// transient lock into a database-wide timeout storm.
const MAX_CATALOG_BATCHES = 2;
const MAX_SUPPLIER_BATCHES = 2;
const MAX_CATALOG_SYNC_BATCHES = 2;
const MAX_RUNS_PER_TICK = 1;

async function clearQueueMarker(supabaseUrl: string, serviceRoleKey: string, table: string, runId: string) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  url.searchParams.set("id", `eq.${runId}`);
  await sendJson<unknown>(url.toString(), {
    method: "PATCH",
    headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify({ processing_queued_at: null, processing_queued_by: null }),
    timeoutMs: 12_000,
  });
}

async function processCatalogRun(supabaseUrl: string, serviceRoleKey: string, run: QueuedCatalogRun) {
  let status = run.status;

  if (status === "running") {
    const validation = await sendJson<{ status?: string }>(`${supabaseUrl}/rest/v1/rpc/validate_catalog_import_system`, {
      method: "POST",
      headers: serviceRoleHeaders(serviceRoleKey),
      body: JSON.stringify({
        input_run_id: run.id,
        input_organization_id: run.organization_id,
        input_actor_id: run.created_by,
      }),
      timeoutMs: 55_000,
    });
    status = String(validation?.status || "");
  }

  if (status !== "validated" && status !== "finalizing") return { runId: run.id, status };

  let latest: { status?: string; has_more?: boolean } | null = null;
  for (let index = 0; index < MAX_CATALOG_BATCHES; index += 1) {
    latest = await sendJson<{ status?: string; has_more?: boolean }>(`${supabaseUrl}/rest/v1/rpc/finalize_catalog_import_batch_system`, {
      method: "POST",
      headers: serviceRoleHeaders(serviceRoleKey),
      body: JSON.stringify({
        input_run_id: run.id,
        input_organization_id: run.organization_id,
        input_actor_id: run.created_by,
        input_batch_size: CATALOG_BATCH_SIZE,
      }),
      timeoutMs: 55_000,
    });
    if (latest?.status === "finalized" || latest?.has_more === false) {
      await clearQueueMarker(supabaseUrl, serviceRoleKey, "catalog_import_runs", run.id);
      break;
    }
  }

  return { runId: run.id, status: latest?.status || "finalizing", hasMore: latest?.has_more !== false };
}

async function processSupplierRun(supabaseUrl: string, serviceRoleKey: string, run: QueuedSupplierRun) {
  let status = run.status;
  let latest: { status?: string; has_more?: boolean } | null = null;

  if (status === "running" || status === "finalizing") {
    for (let index = 0; index < MAX_SUPPLIER_BATCHES; index += 1) {
      latest = await sendJson<{ status?: string; has_more?: boolean }>(`${supabaseUrl}/rest/v1/rpc/finalize_supplier_price_import_batch_system`, {
        method: "POST",
        headers: serviceRoleHeaders(serviceRoleKey),
        body: JSON.stringify({
          input_run_id: run.id,
          input_organization_id: run.organization_id,
          input_actor_id: run.created_by,
          input_batch_size: SUPPLIER_BATCH_SIZE,
        }),
        timeoutMs: 55_000,
      });
      status = String(latest?.status || status);
      if (latest?.status === "finalized" || latest?.status === "succeeded" || latest?.has_more === false) break;
    }
  }

  if (status === "finalized" || status === "succeeded") {
    let catalogSyncStatus = String(run.catalog_sync_status || "pending");
    let catalogSync: { status?: string; has_more?: boolean; catalog_sync_status?: string; worker_state?: string } | null = null;
    for (let index = 0; index < MAX_CATALOG_SYNC_BATCHES; index += 1) {
      catalogSync = await sendJson<{ status?: string; has_more?: boolean; catalog_sync_status?: string }>(`${supabaseUrl}/rest/v1/rpc/sync_supplier_price_catalog_batch_system`, {
        method: "POST",
        headers: serviceRoleHeaders(serviceRoleKey),
        body: JSON.stringify({
          input_run_id: run.id,
          input_organization_id: run.organization_id,
          input_actor_id: run.created_by,
          input_batch_size: CATALOG_SYNC_BATCH_SIZE,
        }),
        timeoutMs: 55_000,
      });
      catalogSyncStatus = String(catalogSync?.catalog_sync_status || catalogSync?.status || catalogSyncStatus);
      if (catalogSyncStatus === "succeeded" || catalogSync?.has_more === false) break;
    }

    if (catalogSyncStatus !== "succeeded") {
      return { runId: run.id, status, catalogSyncStatus, hasMore: true, workerState: catalogSync?.worker_state || "running" };
    }

    // An import changes one brand. A full-organization rollup here keeps a
    // long transaction open and contends with the next worker tick, which
    // surfaces as statement/lock timeouts. Refresh only the affected brand.
    await sendJson<unknown>(`${supabaseUrl}/rest/v1/rpc/refresh_supplier_price_rollups_for_brand`, {
      method: "POST",
      headers: serviceRoleHeaders(serviceRoleKey),
      body: JSON.stringify({ p_organization_id: run.organization_id, p_brand_id: run.brand_id }),
      timeoutMs: 55_000,
    });
    await clearQueueMarker(supabaseUrl, serviceRoleKey, "supplier_price_import_runs", run.id);
  }

  return { runId: run.id, status, hasMore: latest?.has_more === true };
}

export default async (_request: Request, context: Context) => {
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "System configuration is incomplete." }, 500);

  const headers = serviceRoleHeaders(serviceRoleKey);
  const catalogUrl = new URL("/rest/v1/catalog_import_runs", supabaseUrl);
  catalogUrl.searchParams.set("select", "id,organization_id,created_by,status");
  catalogUrl.searchParams.set("processing_queued_at", "not.is.null");
  catalogUrl.searchParams.set("status", "in.(running,validated,finalizing)");
  catalogUrl.searchParams.set("order", "processing_queued_at.asc");
  catalogUrl.searchParams.set("limit", String(MAX_RUNS_PER_TICK));

  const supplierUrl = new URL("/rest/v1/supplier_price_import_runs", supabaseUrl);
  supplierUrl.searchParams.set("select", "id,organization_id,brand_id,created_by,status,catalog_sync_status");
  supplierUrl.searchParams.set("processing_queued_at", "not.is.null");
  supplierUrl.searchParams.set("status", "in.(running,finalizing,finalized,succeeded)");
  supplierUrl.searchParams.set("order", "processing_queued_at.asc");
  supplierUrl.searchParams.set("limit", String(MAX_RUNS_PER_TICK));

  const catalogSyncRunningUrl = new URL("/rest/v1/supplier_price_import_runs", supabaseUrl);
  catalogSyncRunningUrl.searchParams.set("select", "id,organization_id,brand_id,created_by,status,catalog_sync_status");
  catalogSyncRunningUrl.searchParams.set("status", "in.(finalized,succeeded)");
  catalogSyncRunningUrl.searchParams.set("catalog_sync_status", "eq.running");
  catalogSyncRunningUrl.searchParams.set("order", "catalog_sync_started_at.asc.nullsfirst");
  catalogSyncRunningUrl.searchParams.set("limit", String(MAX_RUNS_PER_TICK));

  const catalogSyncPendingUrl = new URL("/rest/v1/supplier_price_import_runs", supabaseUrl);
  catalogSyncPendingUrl.searchParams.set("select", "id,organization_id,brand_id,created_by,status,catalog_sync_status");
  catalogSyncPendingUrl.searchParams.set("status", "in.(finalized,succeeded)");
  catalogSyncPendingUrl.searchParams.set("catalog_sync_status", "eq.pending");
  // New finalized imports should not sit behind months-old backlog.
  catalogSyncPendingUrl.searchParams.set("order", "started_at.desc");
  catalogSyncPendingUrl.searchParams.set("limit", String(MAX_RUNS_PER_TICK));

  const task = (async () => {
    const catalogRuns = await getJson<QueuedCatalogRun[]>(catalogUrl.toString(), { headers, timeoutMs: 12_000 });
    const supplierRuns = await getJson<QueuedSupplierRun[]>(supplierUrl.toString(), { headers, timeoutMs: 12_000 });
    const [catalogSyncRunningRuns, catalogSyncPendingRuns] = await Promise.all([
      getJson<QueuedSupplierRun[]>(catalogSyncRunningUrl.toString(), { headers, timeoutMs: 12_000 }),
      getJson<QueuedSupplierRun[]>(catalogSyncPendingUrl.toString(), { headers, timeoutMs: 12_000 }),
    ]);
    const seenSupplierRuns = new Set<string>();
    const pendingSupplierRuns = [...(supplierRuns || []), ...(catalogSyncRunningRuns || []), ...(catalogSyncPendingRuns || [])].filter((run) => {
      if (seenSupplierRuns.has(run.id)) return false;
      seenSupplierRuns.add(run.id);
      return true;
    }).sort((left, right) => {
      const rank = (run: QueuedSupplierRun) => {
        if (run.status === "running" || run.status === "finalizing") return 0;
        if (run.catalog_sync_status === "running") return 1;
        return 2;
      };
      return rank(left) - rank(right);
    }).slice(0, MAX_RUNS_PER_TICK);
    const results: unknown[] = [];
    let importRunClaimed = false;
    for (const run of (catalogRuns || []).slice(0, MAX_RUNS_PER_TICK)) {
      importRunClaimed = true;
      try { results.push(await processCatalogRun(supabaseUrl, serviceRoleKey, run)); }
      catch (error) { console.error("catalog import worker deferred", run.id, error); }
      break;
    }
    // A tick owns at most one import run in total. Previously the catalog and
    // supplier loops each had their own one-run limit, which still allowed a
    // catalog finalizer and supplier sync to execute back-to-back in the same
    // invocation during heavy traffic. Keeping one owner per tick makes the
    // queue predictable and leaves headroom for auth/portal requests.
    if (!importRunClaimed) {
      for (const run of pendingSupplierRuns.slice(0, MAX_RUNS_PER_TICK)) {
        importRunClaimed = true;
        try { results.push(await processSupplierRun(supabaseUrl, serviceRoleKey, run)); }
        catch (error) { console.error("supplier import worker deferred", run.id, error); }
        break;
      }
    }
    console.info("import processing worker completed", { results });
    return results;
  })().catch((error) => console.error("import processing worker failed", error));

  context.waitUntil(task);
  return json({ ok: true, data: { queued: true, worker_id: `netlify:${context.requestId || crypto.randomUUID()}` } });
};

export const config: Config = { schedule: "*/2 * * * *" };
