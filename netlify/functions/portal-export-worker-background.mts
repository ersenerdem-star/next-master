import type { Config } from "@netlify/functions";
import { readJson, json } from "./_shared/http.mts";
import {
  assertV3PriceExportWorkerRequest,
  isV3ExportBridgeEnabled,
  runV3PriceExportJob,
} from "./_shared/v3-export-bridge.mts";

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
    await runV3PriceExportJob(jobId);
    return json({ ok: true, jobId }, 200);
  } catch (error) {
    console.error("portal export background worker failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config: Config = {
  path: "/api/portal-export-worker-background",
  method: "POST",
};
