import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../netlify/functions/import-processing-worker.mts";

const supplierPause = "LEGACY_SUPPLIER_IMPORT_PROCESSING_PAUSED";
const catalogPause = "LEGACY_CATALOG_IMPORT_PROCESSING_PAUSED";
const historicalRuns = [
  { id: "a489b42c-0448-4164-85f4-3817790dfa3f", organization_id: "org", brand_id: "sachs", created_by: "actor",
    status: "finalized", catalog_sync_status: "succeeded", processing_queued_at: "2026-09-02T13:04:06Z" },
  { id: "43726b8b-84de-4eab-be5a-3086cced9ba3", organization_id: "org", brand_id: "zf", created_by: "actor",
    status: "finalized", catalog_sync_status: "succeeded", processing_queued_at: "2026-09-02T13:14:04Z" },
  { id: "036319e0-cf24-4943-a941-26e89dcc25e4", organization_id: "org", brand_id: "sachs", created_by: "actor",
    status: "running", catalog_sync_status: "pending", processing_queued_at: "2026-09-29T16:26:58Z" },
];
type Call = { url: URL; method: string; body: any };

async function invoke(flags: Record<string, string> = {}, options: { catalogRun?: boolean; target?: string; runningSupplier?: boolean } = {}) {
  const originalFetch = globalThis.fetch;
  const originalNetlify = (globalThis as any).Netlify;
  const originalInfo = console.info;
  const originalError = console.error;
  const calls: Call[] = [];
  const errors: unknown[][] = [];
  const transportFailures: string[] = [];
  const supplierRows = structuredClone(historicalRuns);
  const before = structuredClone(supplierRows);
  const tasks: Promise<unknown>[] = [];
  const base = `https://${options.target || "zjgueqijumzlfioihnkt"}.supabase.co`;
  const env = { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-key", ...flags };
  (globalThis as any).Netlify = { env: { get: (key: string) => env[key as keyof typeof env] } };
  console.info = () => {};
  console.error = (...args) => { errors.push(args); };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const reply = (data: unknown) => Response.json(data);
    if (url.origin !== base) {
      transportFailures.push(`Unexpected origin ${url.origin}`);
      throw new Error("Synthetic transport rejected an unexpected origin");
    }
    if (url.pathname === "/rest/v1/catalog_import_sources" && method === "GET") {
      assert.equal(url.searchParams.get("status"), "eq.completed");
      return reply([{ id: "completed-source", storage_bucket: "catalog-imports", storage_object_path: "org/completed.csv", storage_object_id: "object" }]);
    }
    if (url.pathname === "/storage/v1/object/catalog-imports/org/completed.csv" && method === "DELETE") return reply({});
    if (url.pathname === "/rest/v1/catalog_import_sources" && method === "PATCH") {
      assert.equal(url.searchParams.get("id"), "eq.completed-source");
      assert.equal(body.storage_object_id, null);
      return reply({});
    }
    if (url.pathname === "/rest/v1/catalog_import_runs") {
      if (method === "PATCH") {
        assert.ok(["eq.terminal-catalog", "eq.active-catalog"].includes(url.searchParams.get("id") || ""));
        assert.deepEqual(body, { processing_queued_at: null, processing_queued_by: null });
        return reply({});
      }
      const states = url.searchParams.get("status") || "";
      if (states.includes("validation_failed")) return reply([{ id: "terminal-catalog", status: "finalized" }]);
      assert.equal(states, "in.(running,validated,finalizing)");
      return reply(options.catalogRun ? [{ id: "active-catalog", organization_id: "org", created_by: "actor", status: "running" }] : []);
    }
    if (url.pathname === "/rest/v1/supplier_price_import_runs") {
      if (method === "PATCH") {
        const row = supplierRows.find(row => `eq.${row.id}` === url.searchParams.get("id"));
        assert.ok(row);
        Object.assign(row, body);
        return reply({});
      }
      if (url.searchParams.has("catalog_sync_status")) return reply([]);
      return reply([supplierRows[options.runningSupplier ? 2 : 0]]);
    }
    if (url.pathname === "/rest/v1/rpc/validate_catalog_import_system") return reply({ status: "validated" });
    if (url.pathname === "/rest/v1/rpc/finalize_catalog_import_batch_system") return reply({ status: "finalized", has_more: false });
    if (url.pathname === "/rest/v1/rpc/finalize_supplier_price_import_batch_system") return reply({ status: "finalized", has_more: false });
    if (url.pathname === "/rest/v1/rpc/sync_supplier_price_catalog_batch_system") return reply({ catalog_sync_status: "succeeded", has_more: false });
    if (url.pathname === "/rest/v1/rpc/refresh_supplier_price_rollups_for_brand") return reply(1);
    transportFailures.push(`Unexpected request ${method} ${url.pathname}`);
    throw new Error("Synthetic transport rejected an unexpected endpoint");
  };
  try {
    const response = await worker(new Request("https://portal.next-master.com/.netlify/functions/import-processing-worker"), {
      requestId: "synthetic-worker-pause-test", waitUntil: (task: Promise<unknown>) => { tasks.push(task); },
    } as any);
    assert.equal(response.status, 200);
    await Promise.all(tasks);
    assert.deepEqual(transportFailures, []);
    // The handler catches deferred errors; make unexpected fixture failures
    // fail the test instead of looking like a successful maintenance pass.
    assert.ok(errors.every(args => args[0] === "import processing pause flag invalid; branch paused"), JSON.stringify(errors));
    return { calls, supplierRows, before, errors };
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as any).Netlify = originalNetlify;
    console.info = originalInfo;
    console.error = originalError;
  }
}

function assertMaintenance(calls: Call[]) {
  assert.ok(calls.some(c => c.method === "DELETE" && c.url.pathname.startsWith("/storage/v1/object/")));
  assert.ok(calls.some(c => c.method === "PATCH" && c.url.pathname === "/rest/v1/catalog_import_sources"));
  assert.ok(calls.some(c => c.method === "PATCH" && c.url.searchParams.get("id") === "eq.terminal-catalog"));
}
function activeCatalogCalls(calls: Call[]) {
  return calls.filter(c => c.url.pathname === "/rest/v1/catalog_import_runs" && c.url.searchParams.get("status") === "in.(running,validated,finalizing)"
    || c.url.pathname.includes("/rpc/") && c.url.pathname.includes("catalog_import"));
}

test("both branches paused preserve all historical supplier runs and perform only maintenance on production and V3", async () => {
  for (const target of ["zjgueqijumzlfioihnkt", "kaxsqafdevabkxofwdod"]) {
    const r = await invoke({ [supplierPause]: "1", [catalogPause]: "1" }, { target, catalogRun: true });
    assertMaintenance(r.calls);
    assert.equal(activeCatalogCalls(r.calls).length, 0);
    assert.ok(!r.calls.some(c => c.url.pathname.includes("supplier") || c.url.pathname.includes("/rpc/")));
    assert.deepEqual(r.supplierRows, r.before);
    assert.equal(r.errors.length, 0);
  }
});

test("supplier pause skips queue and both sync selectors while small catalog processing continues", async () => {
  const r = await invoke({ [supplierPause]: "1" }, { catalogRun: true });
  assertMaintenance(r.calls);
  assert.ok(!r.calls.some(c => c.url.pathname.includes("supplier")));
  assert.deepEqual(r.supplierRows, r.before);
  assert.deepEqual(r.calls.filter(c => c.url.pathname.includes("/rpc/")).map(c => c.url.pathname), [
    "/rest/v1/rpc/validate_catalog_import_system", "/rest/v1/rpc/finalize_catalog_import_batch_system",
  ]);
  assert.ok(r.calls.some(c => c.method === "PATCH" && c.url.searchParams.get("id") === "eq.active-catalog"));
});

test("catalog pause leaves small catalog queue untouched without changing explicitly enabled supplier behavior", async () => {
  const r = await invoke({ [catalogPause]: "1", [supplierPause]: "0" }, { catalogRun: true, runningSupplier: true });
  assertMaintenance(r.calls);
  assert.equal(activeCatalogCalls(r.calls).length, 0);
  assert.ok(!r.calls.some(c => c.url.searchParams.get("id") === "eq.active-catalog"));
  assert.deepEqual(r.calls.filter(c => c.url.pathname.includes("/rpc/")).map(c => c.url.pathname), [
    "/rest/v1/rpc/finalize_supplier_price_import_batch_system",
    "/rest/v1/rpc/sync_supplier_price_catalog_batch_system",
    "/rest/v1/rpc/refresh_supplier_price_rollups_for_brand",
  ]);
  assert.equal(r.supplierRows[2].processing_queued_at, null);
  assert.deepEqual(r.supplierRows.slice(0, 2), r.before.slice(0, 2));
});

test("unset and explicit zero flags preserve existing supplier selection, sync, refresh, then marker clear", async () => {
  for (const flags of [{}, { [catalogPause]: "0", [supplierPause]: "0" }]) {
    const r = await invoke(flags);
    assertMaintenance(r.calls);
    assert.equal(r.calls.filter(c => c.method === "GET" && c.url.pathname === "/rest/v1/supplier_price_import_runs").length, 3);
    const mutations = r.calls.filter(c => c.url.pathname.includes("/rpc/") || c.method === "PATCH" && c.url.pathname.includes("supplier"));
    assert.deepEqual(mutations.map(c => c.url.pathname), [
      "/rest/v1/rpc/sync_supplier_price_catalog_batch_system",
      "/rest/v1/rpc/refresh_supplier_price_rollups_for_brand", "/rest/v1/supplier_price_import_runs",
    ]);
    assert.equal(r.supplierRows[0].processing_queued_at, null);
    assert.deepEqual(r.supplierRows.slice(1), r.before.slice(1));
  }
});

test("invalid explicit pause values fail closed without blocking maintenance or exposing their values", async () => {
  const r = await invoke({ [catalogPause]: "invalid-catalog-value", [supplierPause]: "invalid-supplier-value" });
  assertMaintenance(r.calls);
  assert.equal(activeCatalogCalls(r.calls).length, 0);
  assert.ok(!r.calls.some(c => c.url.pathname.includes("supplier") || c.url.pathname.includes("/rpc/")));
  assert.deepEqual(r.supplierRows, r.before);
  assert.equal(r.errors.length, 2);
  assert.doesNotMatch(JSON.stringify(r.errors), /invalid-catalog-value|invalid-supplier-value/);
});
