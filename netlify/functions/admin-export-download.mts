import type { Config } from "@netlify/functions";
import { getAppAuthStatus, resolveCaller } from "./_shared/app-auth.mts";
import { canAccessOperationsModules } from "./_shared/roles.mts";
import { createExportArtifactSignedDownload, exportJson, fetchExportJobById } from "./_shared/export-jobs.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request) => {
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
    if (job.status !== "finalized") return exportJson({ error: "Export file is not ready yet." }, 409);
    const download = await createExportArtifactSignedDownload(supabaseUrl, serviceRoleKey, job);
    return exportJson({ ok: true, ...download }, 200);
  } catch (error) {
    const status = getAppAuthStatus(error) || 500;
    return exportJson({ error: sanitizeUserFacingError(error, "Export file could not be downloaded.") }, status);
  }
};

export const config: Config = {
  path: "/api/admin-export-download",
};
