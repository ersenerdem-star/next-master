import type { Config } from "@netlify/functions";
import { getJson, json, serviceRoleHeaders } from "./_shared/http.mts";
import { dispatchV3PriceExportWorker, required } from "./_shared/v3-export-dispatch.mts";
import {
  isExactV3RecoveryTarget,
  recoverStagingV3ExportJobs,
  V3_EXPORT_STAGING_SITE_URL,
  type RecoveryJob,
} from "./_shared/v3-export-recovery.mts";

export default async (_request: Request) => {
  const target = {
    siteId: process.env.SITE_ID,
    siteUrl: process.env.URL,
    supabaseUrl: Netlify.env.get("SUPABASE_URL"),
    bridgeFlag: Netlify.env.get("NM_V3_EXPORT_BRIDGE"),
  };
  if (!isExactV3RecoveryTarget(target)) return json({ ok: true, status: "disabled" });

  try {
    const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
    const dispatchRequest = new Request(V3_EXPORT_STAGING_SITE_URL);
    const result = await recoverStagingV3ExportJobs({
      target,
      nowMs: Date.now(),
      listJobs: (url) => getJson<RecoveryJob[]>(url, {
        headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 10_000,
      }),
      dispatchJob: (jobId) => dispatchV3PriceExportWorker(dispatchRequest, jobId),
    });
    console.info("v3 export recovery tick", result);
    return json({ ok: true, ...result });
  } catch (error) {
    console.error("v3 export recovery tick failed", error);
    return json({ ok: false, error: "V3_EXPORT_RECOVERY_FAILED" }, 500);
  }
};

// Every minute is a fallback after the 30-second queued and 120-second lease
// gates; each invocation signs at most two background handoffs.
export const config: Config = { schedule: "* * * * *" };
