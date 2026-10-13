import type { Config } from "@netlify/functions";
import { readJson, json } from "./_shared/http.mts";
import {
  assertV3PriceExportWorkerRequest,
  dispatchV3PriceExportWorker,
  isV3ExportBridgeEnabled,
} from "./_shared/v3-export-dispatch.mts";
import { runV3PriceExportJob } from "./_shared/v3-export-bridge.mts";

/**
 * Durable staging/production-gated worker for large V3 exports. Netlify
 * treats the `-background` function as asynchronous (up to 15 minutes), so
 * the caller is not required to keep a browser request open for the whole
 * XLSX build.
 */
export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isV3ExportBridgeEnabled()) return json({ error: "EXPORT_BRIDGE_DISABLED" }, 503);

  try {
    const body = await readJson<{ jobId?: string }>(req);
    const jobId = String(body.jobId || "").trim();
    if (!jobId) return json({ error: "jobId is required." }, 400);
    assertV3PriceExportWorkerRequest(req, jobId);
    const result = await runV3PriceExportJob(jobId);
    if (result.status === "continuation") {
      // The first invocation committed a page checkpoint and released its
      // lease. Re-enter through the same signed background handoff. If this
      // network call fails, the authenticated status poll remains a retry path.
      try {
        await dispatchV3PriceExportWorker(req, jobId);
      } catch (error) {
        console.error("portal export continuation dispatch failed", jobId, error);
      }
    }
    return json({ ok: true, jobId, status: result.status }, 200);
  } catch (error) {
    console.error("portal export background worker failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config: Config = {
  path: "/api/portal-export-worker-background",
  method: "POST",
};
