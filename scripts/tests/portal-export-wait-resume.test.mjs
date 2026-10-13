import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PortalExportStillPreparingError,
  waitForPortalExportJob,
} from "../../apps/web/src/infrastructure/api/portalOrderApi.ts";

const initialJob = {
  id: "00000000-0000-4000-8000-000000000001",
  exportType: "portal_price_list",
  status: "queued",
  fileName: null,
  rowCount: 0,
  byteSize: 0,
  progressDone: 0,
  progressTotal: null,
  progressMessage: "Queued",
  errorMessage: null,
  createdAt: "2026-10-13T12:00:00Z",
  updatedAt: "2026-10-13T12:00:00Z",
  finalizedAt: null,
  cached: false,
};

async function withStatusAtElapsed(elapsedMs, status, callback) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let clockReads = 0;
  let statusReads = 0;
  globalThis.window = {
    setTimeout(callback, ms) {
      if (ms === 1_500) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  };
  Date.now = () => clockReads++ === 0 ? 0 : elapsedMs;
  globalThis.fetch = async (path) => {
    assert.equal(path, "/api/portal-export-status");
    statusReads += 1;
    return new Response(JSON.stringify({ job: { ...initialJob, status } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await callback();
    assert.equal(statusReads, 1);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}

test("portal export keeps waiting after ten minutes and accepts a finalized status", async () => {
  await withStatusAtElapsed(11 * 60_000, "finalized", async () => {
    const result = await waitForPortalExportJob({ sessionToken: "test" }, initialJob);
    assert.equal(result.status, "finalized");
  });
});

test("portal export timeout at thirty minutes remains resumable, not failed", async () => {
  await withStatusAtElapsed(31 * 60_000, "running", async () => {
    await assert.rejects(
      waitForPortalExportJob({ sessionToken: "test" }, initialJob),
      (error) => error instanceof PortalExportStillPreparingError
        && error.job.id === initialJob.id && error.job.status === "running",
    );
  });
});

test("portal export checks for a just-finalized job before reporting a timeout", async () => {
  await withStatusAtElapsed(31 * 60_000, "finalized", async () => {
    const result = await waitForPortalExportJob({ sessionToken: "test" }, initialJob);
    assert.equal(result.status, "finalized");
  });
});
