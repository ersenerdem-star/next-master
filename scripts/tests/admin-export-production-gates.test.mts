import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import start from "../../netlify/functions/admin-export-start.mts";
import status from "../../netlify/functions/admin-export-status.mts";
import download from "../../netlify/functions/admin-export-download.mts";
import background from "../../netlify/functions/admin-export-background.mts";
import { remainingAdminExportsEnabled } from "../../netlify/functions/_shared/admin-export-target.mts";

const production = {
  SUPABASE_URL: "https://zjgueqijumzlfioihnkt.supabase.co",
  SUPABASE_ANON_KEY: "test-anon", SUPABASE_SERVICE_ROLE_KEY: "test-service",
  NM_PRODUCTION_TARGET: "zjgueqijumzlfioihnkt",
  NM_PRODUCTION_ADMIN_EXPORT_ENABLED: "1", NM_PRODUCTION_EXPORT_PAUSED: "0",
};
const types = ["catalog_export", "catalog_master", "supplier_price_list"];

test("production admin exports stay closed unless every target and activation check passes", () => {
  const enabled = (env: Record<string, string | undefined>) => remainingAdminExportsEnabled(key => env[key]);
  assert.equal(enabled(production), true);
  for (const patch of [
    { NM_PRODUCTION_TARGET: undefined }, { NM_PRODUCTION_TARGET: "another" },
    { NM_PRODUCTION_ADMIN_EXPORT_ENABLED: undefined }, { NM_PRODUCTION_ADMIN_EXPORT_ENABLED: "0" },
    { NM_PRODUCTION_EXPORT_PAUSED: undefined }, { NM_PRODUCTION_EXPORT_PAUSED: "1" },
    { NM_FULL_STAGING_TARGET: "kaxsqafdevabkxofwdod" },
    { SUPABASE_URL: "http://zjgueqijumzlfioihnkt.supabase.co" },
    { SUPABASE_URL: "https://zjgueqijumzlfioihnkt.supabase.co.evil.invalid" },
    { SUPABASE_URL: "https://user@zjgueqijumzlfioihnkt.supabase.co" },
  ]) assert.equal(enabled({ ...production, ...patch }), false);
  assert.equal(enabled({ SUPABASE_URL: "https://kaxsqafdevabkxofwdod.supabase.co" }), true);
  assert.equal(enabled({ SUPABASE_URL: "https://kaxsqafdevabkxofwdod.supabase.co", NM_FULL_STAGING_TARGET: "zjgueqijumzlfioihnkt" }), false);
  assert.equal(enabled({ ...production, SUPABASE_URL: "https://kaxsqafdevabkxofwdod.supabase.co" }), false);
  assert.equal(enabled({ SUPABASE_URL: "https://unknown.supabase.co" }), false);
});

async function fixture(env: Record<string, string | undefined>, jobType: string, scenario: (state: { calls: string[]; waits: Promise<unknown>[] }) => Promise<void>, jobStatus = "finalized") {
  const oldFetch = globalThis.fetch, oldNetlify = (globalThis as any).Netlify;
  const calls: string[] = [], waits: Promise<unknown>[] = [];
  (globalThis as any).Netlify = { env: { get: (key: string) => env[key] } };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method || "GET"} ${url.pathname}`);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "admin-1" });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ organization_id: "org-1", role: "superadmin", is_active: true, permissions: {} }]);
    if (url.pathname === "/rest/v1/app_export_jobs" && !init?.method) return Response.json([{
      id: "job-1", organization_id: "org-1", audience: "admin", export_type: jobType,
      status: jobStatus, updated_at: "2000-01-01T00:00:00Z", expires_at: new Date(Date.now()+60000).toISOString(),
      scope: {}, row_count: 1, byte_size: 1,
    }]);
    throw new Error(`Unexpected work after gate: ${url.pathname}`);
  };
  try { await scenario({ calls, waits }); }
  finally { globalThis.fetch = oldFetch; (globalThis as any).Netlify = oldNetlify; }
}
const request = (path: string, body: object) => new Request(`https://portal.next-master.com/api/${path}`, {
  method: "POST", headers: { Authorization: "Bearer test-access-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("paused authenticated starts never create a job or dispatch any of the three export types", async () => {
  for (const exportType of types) await fixture({ ...production, NM_PRODUCTION_EXPORT_PAUSED: "1" }, exportType, async ({ calls, waits }) => {
    const response = await start(request("admin-export-start", { exportType }), { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "300");
    assert.deepEqual(calls, ["GET /auth/v1/user", "GET /rest/v1/profiles"]);
    assert.equal(waits.length, 0);
  });
});

test("pause prevents new download signatures for already finalized artifacts", async () => {
  for (const exportType of types) await fixture({ ...production, NM_PRODUCTION_EXPORT_PAUSED: "1" }, exportType, async ({ calls }) => {
    const response = await download(request("admin-export-download", { jobId: "job-1" }));
    assert.equal(response.status, 503);
    assert.equal(calls.filter(c => c.includes("/storage/")).length, 0);
  });
});

test("status remains readable during pause without dispatching retries", async () => {
  for (const exportType of types) await fixture({ ...production, NM_PRODUCTION_EXPORT_PAUSED: "1" }, exportType, async ({ waits }) => {
    const response = await status(request("admin-export-status", { jobId: "job-1" }), { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any);
    assert.equal(response.status, 200);
    assert.equal(waits.length, 0);
  }, "running");
});

test("an authenticated background handoff cannot bypass the production pause", async () => {
  await fixture({ ...production, NM_PRODUCTION_EXPORT_PAUSED: "1" }, "catalog_master", async ({ calls }) => {
    const timestamp = String(Date.now()), jobId = "job-1";
    const signature = createHmac("sha256", production.SUPABASE_SERVICE_ROLE_KEY).update(`admin-export-worker.v1\n${jobId}\n${timestamp}`).digest("hex");
    const response = await background(new Request("https://portal.next-master.com/api/admin-export-worker-background", {
      method: "POST", headers: { "x-admin-export-worker-time": timestamp, "x-admin-export-worker-signature": signature }, body: JSON.stringify({ jobId }),
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(calls, []);
  });
});
