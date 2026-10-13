import type { Config, Context } from "@netlify/functions";
import { getAppAuthStatus, resolveCaller } from "./_shared/app-auth.mts";
import { canAccessOperationsModules } from "./_shared/roles.mts";
import { exportJson, fetchExportJobById, runAdminPriceListExportJob, runCatalogExportJob, runCatalogMasterExportJob, toPublicExportJobStatus } from "./_shared/export-jobs.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import { dispatchV3PriceExportWorker, isProductionExportPaused, isV3ExportBridgeEnabled } from "./_shared/v3-export-bridge.mts";

function isStaleExportJob(jobStatus: string, jobUpdatedAt: string | null | undefined) {
  const updatedAt = Date.parse(String(jobUpdatedAt || ""));
  if (!Number.isFinite(updatedAt)) return true;
  const ageMs = Date.now() - updatedAt;
  if (jobStatus === "queued") return ageMs > 30_000;
  if (jobStatus === "running") return ageMs > 120_000;
  return false;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return exportJson({ error: "Method not allowed" }, 405);
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return exportJson({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    if (!canAccessOperationsModules(caller.role, caller.department, caller.permissions)) {
      return exportJson({ error: "This export is not enabled for your user." }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const jobId = String(body?.jobId || "").trim();
    if (!jobId) return exportJson({ error: "jobId is required." }, 400);
    const job = await fetchExportJobById(supabaseUrl, serviceRoleKey, caller.organizationId, jobId);
    if (!job) return exportJson({ error: "Export job not found." }, 404);
    if ((job.status === "queued" || job.status === "running") && isStaleExportJob(job.status, job.updated_at)) {
      if (job.export_type === "admin_price_list" && !(isV3ExportBridgeEnabled() && isProductionExportPaused())) {
        const retry = isV3ExportBridgeEnabled()
          ? dispatchV3PriceExportWorker(req, job.id)
          : runAdminPriceListExportJob(supabaseUrl, serviceRoleKey, job.id);
        context.waitUntil(retry.catch((error) => console.error("admin price export retry failed", job.id, error)));
      } else if (job.export_type === "catalog_export") {
        context.waitUntil(runCatalogExportJob(supabaseUrl, serviceRoleKey, job.id).catch((error) => console.error("catalog export retry failed", job.id, error)));
      } else if (job.export_type === "catalog_master") {
        context.waitUntil(runCatalogMasterExportJob(supabaseUrl, serviceRoleKey, job.id).catch((error) => console.error("master export retry failed", job.id, error)));
      }
    }
    return exportJson({ ok: true, job: toPublicExportJobStatus(job) });
  } catch (error) {
    const status = getAppAuthStatus(error) || 500;
    return exportJson({ error: sanitizeUserFacingError(error, "Export status could not be loaded.") }, status);
  }
};

export const config: Config = {
  path: "/api/admin-export-status",
};
