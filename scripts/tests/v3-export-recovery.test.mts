import test from "node:test";
import assert from "node:assert/strict";
import {
  isExactExportRecoveryTarget,
  isExactProductionRecoveryTarget,
  isExactV3RecoveryTarget,
  recoverV3ExportJobs,
  recoveryQueryUrls,
  recoverStagingV3ExportJobs,
  recoveryTargetSiteUrl,
  V3_EXPORT_PRODUCTION_SITE_ID,
  V3_EXPORT_PRODUCTION_SITE_URL,
  selectRecoverableJobs,
  V3_EXPORT_STAGING_SITE_ID,
  V3_EXPORT_STAGING_SITE_URL,
  type RecoveryJob,
} from "../../netlify/functions/_shared/v3-export-recovery.mts";

const nowMs = Date.parse("2026-10-13T12:00:00.000Z");
const target = {
  siteId: V3_EXPORT_STAGING_SITE_ID,
  siteUrl: V3_EXPORT_STAGING_SITE_URL,
  supabaseUrl: "https://kaxsqafdevabkxofwdod.supabase.co",
  bridgeFlag: "1",
};

function job(id: number, patch: Partial<RecoveryJob> = {}): RecoveryJob {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    audience: "portal", export_type: "portal_price_list", status: "queued",
    updated_at: new Date(nowMs - 90_000).toISOString(),
    expires_at: new Date(nowMs + 3_600_000).toISOString(),
    worker_lease_expires_at: null,
    ...patch,
  };
}

test("recovery runs only on the exact staging site and database", async () => {
  for (const changed of [
    { siteId: "other-site" },
    { siteUrl: "https://portal.next-master.com" },
    { supabaseUrl: "https://zjgueqijumzlfioihnkt.supabase.co" },
    { bridgeFlag: "0" },
  ]) {
    let reads = 0;
    let dispatches = 0;
    const result = await recoverStagingV3ExportJobs({
      target: { ...target, ...changed }, nowMs,
      listJobs: async () => { reads += 1; return [job(1)]; },
      dispatchJob: async () => { dispatches += 1; },
    });
    assert.equal(result.status, "disabled");
    assert.equal(reads, 0);
    assert.equal(dispatches, 0);
  }
  assert.equal(isExactV3RecoveryTarget(target), true);
  assert.equal(isExactExportRecoveryTarget(target), true);
});

test("production recovery is allow-listed to the production site and database", async () => {
  const production = {
    siteId: V3_EXPORT_PRODUCTION_SITE_ID,
    siteUrl: V3_EXPORT_PRODUCTION_SITE_URL,
    supabaseUrl: "https://zjgueqijumzlfioihnkt.supabase.co",
    bridgeFlag: "1",
  };
  assert.equal(isExactProductionRecoveryTarget(production), true);
  assert.equal(recoveryTargetSiteUrl(production), V3_EXPORT_PRODUCTION_SITE_URL);
  assert.equal(isExactExportRecoveryTarget(production), true);
  let reads = 0;
  let dispatched = 0;
  const result = await recoverV3ExportJobs({
    target: production,
    nowMs,
    listJobs: async (url) => {
      reads += 1;
      assert.equal(new URL(url).origin, "https://zjgueqijumzlfioihnkt.supabase.co");
      return [job(1)];
    },
    dispatchJob: async () => { dispatched += 1; },
  });
  assert.equal(reads, 4);
  assert.equal(dispatched, 1);
  assert.equal(result.status, "checked");
});

test("recovery queries only stale, unexpired portal and admin price jobs with released leases", () => {
  const urls = recoveryQueryUrls(nowMs).map((url) => new URL(url));
  assert.equal(urls.length, 4);
  assert.deepEqual(urls.map((url) => [url.searchParams.get("audience"), url.searchParams.get("export_type"), url.searchParams.get("status")]), [
    ["eq.portal", "eq.portal_price_list", "eq.queued"],
    ["eq.portal", "eq.portal_price_list", "eq.running"],
    ["eq.admin", "eq.admin_price_list", "eq.queued"],
    ["eq.admin", "eq.admin_price_list", "eq.running"],
  ]);
  for (const url of urls) {
    assert.equal(url.origin, target.supabaseUrl);
    assert.equal(url.searchParams.get("limit"), "2");
    assert.match(url.searchParams.get("or") || "", /worker_lease_expires_at\.is\.null/);
    assert.equal(url.searchParams.get("expires_at"), `gt.${new Date(nowMs).toISOString()}`);
  }
  assert.equal(urls[0].searchParams.get("updated_at"), `lte.${new Date(nowMs - 30_000).toISOString()}`);
  assert.equal(urls[1].searchParams.get("updated_at"), `lte.${new Date(nowMs - 120_000).toISOString()}`);
});

test("recovery skips active leases, fresh and expired jobs, and caps signed dispatches", async () => {
  const eligible = [
    job(1, { updated_at: new Date(nowMs - 300_000).toISOString() }),
    job(2, { audience: "admin", export_type: "admin_price_list", status: "running",
      updated_at: new Date(nowMs - 200_000).toISOString(),
      worker_lease_expires_at: new Date(nowMs - 10_000).toISOString() }),
    job(3),
  ];
  const ignored = [
    job(4, { worker_lease_expires_at: new Date(nowMs + 60_000).toISOString() }),
    job(5, { updated_at: new Date(nowMs - 10_000).toISOString() }),
    job(6, { status: "running", updated_at: new Date(nowMs - 60_000).toISOString() }),
    job(7, { expires_at: new Date(nowMs - 1).toISOString() }),
    job(8, { export_type: "catalog_export" }),
  ];
  assert.deepEqual(selectRecoverableJobs([...eligible, ...ignored], nowMs).map((row) => row.id), [eligible[0].id, eligible[1].id]);
  const dispatched: string[] = [];
  const result = await recoverStagingV3ExportJobs({
    target, nowMs,
    listJobs: async () => [...eligible, ...ignored],
    dispatchJob: async (id) => { dispatched.push(id); },
  });
  assert.equal(result.status, "checked");
  assert.equal(result.dispatched, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(dispatched, [eligible[0].id, eligible[1].id]);
});
