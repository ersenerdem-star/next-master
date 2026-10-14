import assert from "node:assert/strict";
import test from "node:test";
import { claimRemainingExportJob, assertAndTouchExportJobLease } from "../../netlify/functions/_shared/admin-export-worker.mts";
import { runSupplierPriceListExportJob, type ExportJobRow } from "../../netlify/functions/_shared/export-jobs.mts";

const sourceUrl = "https://export-lease.example.invalid";
const serviceKey = "test-key";

function makeJob(patch: Partial<ExportJobRow> = {}): ExportJobRow {
  const now = new Date().toISOString();
  return {
    id: "lease-job", organization_id: "org-1", requested_by: "admin-1",
    audience: "admin", export_type: "supplier_price_list", status: "queued",
    scope: { supplierId: "supplier-1", supplierName: "Supplier", brandId: "brand-1", brandName: "Clevite", format: "csv" },
    cache_key: "lease-cache", data_version: "version-1", file_name: null,
    content_type: null, storage_bucket: null, storage_path: null,
    row_count: 0, byte_size: 0, progress_total: null, progress_done: 0,
    progress_message: null, error_message: null, started_at: null,
    finalized_at: null, failed_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: now, updated_at: now,
    ...patch,
  };
}

type PatchAttempt = { patch: Partial<ExportJobRow>; accepted: boolean; filters: URLSearchParams };

async function withCasStore(
  job: ExportJobRow,
  scenario: { takeOverAt?: "source" | "upload" },
  check: (state: { patches: PatchAttempt[]; getCount: () => number; sourceCount: () => number; uploadCount: () => number; takeoverToken: () => string | null }) => Promise<void>,
) {
  const previousFetch = globalThis.fetch;
  const patches: PatchAttempt[] = [];
  let gets = 0;
  let sources = 0;
  let uploads = 0;
  let takeoverToken: string | null = null;
  function takeOver() {
    assert.ok(job.started_at);
    takeoverToken = new Date(Date.parse(job.started_at) + 1000).toISOString();
    Object.assign(job, {
      status: "running", started_at: takeoverToken, updated_at: new Date().toISOString(),
      progress_done: 777, row_count: 777, progress_message: "New worker owns this job.",
    });
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, sourceUrl);
    if (url.pathname === "/rest/v1/app_export_jobs") {
      if (init?.method !== "PATCH") {
        gets += 1;
        return Response.json([{ ...job }]);
      }
      const patch = JSON.parse(String(init.body)) as Partial<ExportJobRow>;
      const accepted = ["id", "status", "updated_at", "started_at"].every((key) => {
        const filter = url.searchParams.get(key);
        return filter == null || filter === `eq.${job[key as keyof ExportJobRow]}`;
      });
      patches.push({ patch, accepted, filters: url.searchParams });
      if (!accepted) return Response.json([]);
      Object.assign(job, patch);
      return Response.json([{ ...job }]);
    }
    if (url.pathname === "/rest/v1/rpc/cloud_supplier_price_export_chunk_v3") {
      sources += 1;
      if (scenario.takeOverAt === "source") takeOver();
      return Response.json([{
        total_count: 1, price_id: "00000000-0000-4000-8000-000000000001", product_code: "SKU-1",
        brand: "Clevite", buy_price: 12.34, currency: "EUR",
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/get_supplier_price_export_version") return Response.json("version-1");
    if (url.pathname.startsWith("/storage/v1/object/")) {
      uploads += 1;
      if (scenario.takeOverAt === "upload") takeOver();
      return Response.json({ Key: "unpublished-old-attempt" });
    }
    throw new Error(`Unexpected lease test request: ${url.pathname}`);
  };
  try {
    await check({ patches, getCount: () => gets, sourceCount: () => sources, uploadCount: () => uploads, takeoverToken: () => takeoverToken });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("two concurrent workers using the same queued snapshot cannot both claim it", async () => {
  const job = makeJob();
  const snapshot = { ...job };
  await withCasStore(job, {}, async ({ patches }) => {
    const claims = await Promise.all([
      claimRemainingExportJob(sourceUrl, serviceKey, snapshot),
      claimRemainingExportJob(sourceUrl, serviceKey, snapshot),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(patches.filter((attempt) => attempt.accepted).length, 1);
    assert.equal(patches.length, 2);
    for (const attempt of patches) {
      assert.equal(attempt.filters.get("status"), "eq.queued");
      assert.equal(attempt.filters.get("updated_at"), `eq.${snapshot.updated_at}`);
    }
    assert.equal(job.status, "running");
    assert.ok(job.started_at);
  });
});

test("a fresh running export never claims again or executes a source page", async () => {
  const job = makeJob({ status: "running", started_at: new Date().toISOString() });
  await withCasStore(job, {}, async ({ patches, getCount, sourceCount, uploadCount }) => {
    await runSupplierPriceListExportJob(sourceUrl, serviceKey, job.id);
    assert.equal(getCount(), 1);
    assert.equal(patches.length, 0);
    assert.equal(sourceCount(), 0);
    assert.equal(uploadCount(), 0);
  });
});

test("a stale claim receives a new fence and the previous worker cannot renew its lease", async () => {
  const staleTime = new Date(Date.now() - 300_000).toISOString();
  const job = makeJob({ status: "running", started_at: staleTime, updated_at: staleTime });
  await withCasStore(job, {}, async ({ patches }) => {
    const claimed = await claimRemainingExportJob(sourceUrl, serviceKey, { ...job });
    assert.ok(claimed?.started_at);
    assert.notEqual(claimed.started_at, staleTime);
    await assert.rejects(assertAndTouchExportJobLease(sourceUrl, serviceKey, job.id, staleTime), /LEASE_LOST/);
    await assertAndTouchExportJobLease(sourceUrl, serviceKey, job.id, claimed.started_at);
    assert.equal(patches[1].accepted, false);
    assert.equal(patches[1].filters.get("started_at"), `eq.${staleTime}`);
    assert.equal(patches[2].accepted, true);
    assert.equal(job.started_at, claimed.started_at);
  });
});

for (const takeOverAt of ["source", "upload"] as const) {
  test(`an old worker cannot ${takeOverAt === "source" ? "update progress" : "finalize"} after its lease is taken over`, async (t) => {
    // Failure recording is also fenced; its expected rejection is logged by the worker.
    const logger = t.mock.method(console, "error", () => {});
    const job = makeJob();
    await withCasStore(job, { takeOverAt }, async ({ patches, sourceCount, uploadCount, takeoverToken }) => {
      await assert.rejects(runSupplierPriceListExportJob(sourceUrl, serviceKey, job.id), /LEASE_LOST/);
      assert.equal(sourceCount(), 1);
      assert.equal(uploadCount(), takeOverAt === "source" ? 0 : 1);
      assert.equal(job.status, "running");
      assert.equal(job.started_at, takeoverToken());
      assert.equal(job.progress_done, 777);
      assert.equal(job.row_count, 777);
      assert.equal(job.storage_path, null);
      assert.equal(job.finalized_at, null);
      assert.equal(job.failed_at, null);
      assert.equal(patches.some((attempt) => attempt.accepted && ["failed", "finalized"].includes(attempt.patch.status || "")), false);
      const rejectedWrite = patches.find((attempt) => !attempt.accepted && (takeOverAt === "source" ? attempt.patch.progress_done === 1 : attempt.patch.status === "finalized"));
      assert.ok(rejectedWrite);
      assert.notEqual(rejectedWrite.filters.get("started_at"), `eq.${takeoverToken()}`);
      assert.equal(logger.mock.calls.length, 1);
    });
  });
}
