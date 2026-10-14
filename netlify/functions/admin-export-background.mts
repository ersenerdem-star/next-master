import type { Config } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { assertAdminExportWorkerRequest, fetchAdminExportWorkerJob } from "./_shared/admin-export-worker.mts";
import { runCatalogExportJob, runCatalogMasterExportJob, runSupplierPriceListExportJob } from "./_shared/export-jobs.mts";

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({})) as { jobId?: string };
    const jobId = String(body.jobId || "").trim();
    if (!jobId) return json({ error: "jobId is required." }, 400);
    assertAdminExportWorkerRequest(req, jobId);
    const supabaseUrl = Netlify.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const job = await fetchAdminExportWorkerJob(supabaseUrl, serviceRoleKey, jobId);
    if (!job || job.audience !== "admin" || !["queued", "running"].includes(String(job.status))) {
      return json({ ok: true, jobId, status: "ignored" }, 200);
    }
    if (job.export_type === "catalog_export") await runCatalogExportJob(supabaseUrl, serviceRoleKey, jobId);
    else if (job.export_type === "catalog_master") await runCatalogMasterExportJob(supabaseUrl, serviceRoleKey, jobId);
    else if (job.export_type === "supplier_price_list") await runSupplierPriceListExportJob(supabaseUrl, serviceRoleKey, jobId);
    else return json({ error: "Unsupported export type." }, 400);
    return json({ ok: true, jobId, status: "complete" }, 200);
  } catch (error) {
    console.error("admin export background worker failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config: Config = {
  background: true,
  path: "/api/admin-export-worker-background",
  method: "POST",
};
