import type { Config } from "@netlify/functions";
import { getJson, json, serviceRoleHeaders } from "./_shared/http.mts";
import { dispatchV3PriceExportWorker, isProductionExportPaused, required } from "./_shared/v3-export-dispatch.mts";
import { prewarmPreparedPriceFile } from "./_shared/prepared-price-prewarm.mts";
import {
  isExactExportRecoveryTarget,
  recoverV3ExportJobs,
  recoveryTargetSiteUrl,
  type RecoveryJob,
} from "./_shared/v3-export-recovery.mts";

export default async (_request: Request) => {
  const target = {
    siteId: process.env.SITE_ID,
    siteUrl: process.env.URL,
    supabaseUrl: Netlify.env.get("SUPABASE_URL"),
    bridgeFlag: Netlify.env.get("NM_PRODUCTION_EXPORT_BRIDGE") === "1"
      || Netlify.env.get("NM_V3_EXPORT_BRIDGE") === "1" ? "1" : "0",
  };
  if (!isExactExportRecoveryTarget(target)) return json({ ok: true, status: "disabled" });
  if (isProductionExportPaused()) return json({ ok: true, status: "paused" });

  try {
    const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
    const siteUrl = recoveryTargetSiteUrl(target);
    if (!siteUrl) return json({ ok: true, status: "disabled" });
    const dispatchRequest = new Request(siteUrl);
    const result = await recoverV3ExportJobs({
      target,
      nowMs: Date.now(),
      listJobs: (url) => getJson<RecoveryJob[]>(url, {
        headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 10_000,
      }),
      dispatchJob: (jobId) => dispatchV3PriceExportWorker(dispatchRequest, jobId),
    });
    const preparedPrice = await prewarmPreparedPriceFile(target.supabaseUrl!, serviceRoleKey,
      (jobId) => dispatchV3PriceExportWorker(dispatchRequest, jobId));
    console.info("v3 export recovery tick", result);
    console.info("prepared price file tick", preparedPrice);
    return json({ ok: true, ...result, preparedPrice });
  } catch (error) {
    console.error("v3 export recovery tick failed", error);
    return json({ ok: false, error: "V3_EXPORT_RECOVERY_FAILED" }, 500);
  }
};

// Every minute is a fallback after the 30-second queued and 120-second lease
// gates; each invocation signs at most two background handoffs.
export const config: Config = { schedule: "* * * * *" };
