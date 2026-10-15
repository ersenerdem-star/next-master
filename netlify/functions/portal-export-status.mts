import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { assertPortalExportJobCurrentContract, fetchExportJobById, isExportJobUnexpired, runPortalPriceListExportJob, toPublicExportJobStatus } from "./_shared/export-jobs.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { buildExpiredPortalSessionCookie, buildPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { getPortalRequestHostname } from "./_shared/portal-tenant.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import { dispatchV3PriceExportWorker, isProductionExportPaused, isV3ExportBridgeEnabled } from "./_shared/v3-export-dispatch.mts";

function isStaleExportJob(jobStatus: string, jobUpdatedAt: string | null | undefined) {
  const updatedAt = Date.parse(String(jobUpdatedAt || ""));
  if (!Number.isFinite(updatedAt)) return true;
  const ageMs = Date.now() - updatedAt;
  if (jobStatus === "queued") return ageMs > 30_000;
  if (jobStatus === "running") return ageMs > 120_000;
  return false;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  let auditEmail = "";
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "System configuration is incomplete." }, 500);

  try {
    const body = await req.json();
    const email = String(body?.email || "").trim();
    auditEmail = email;
    const password = String(body?.password || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || readPortalSessionCookie(req) || "").trim();
    const jobId = String(body?.jobId || "").trim();
    if (!sessionToken && (!email || !password)) return json({ error: "Email and password are required" }, 400);
    if (!jobId) return json({ error: "jobId is required." }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "export_status", email);
    if (!rateLimit.allowed) return json({ error: "Too many portal refresh attempts. Try again later." }, 429, { "Retry-After": String(rateLimit.retryAfterSeconds) });
    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      password,
      sessionToken,
      hostname: getPortalRequestHostname(req),
    });
    const job = await fetchExportJobById(supabaseUrl, serviceRoleKey, invite.organization_id, jobId);
    if (!job) return json({ error: "Export job not found." }, 404, { "Set-Cookie": buildPortalSessionCookie(nextSessionToken) });
    // Status is polled while a large export is being built.  Recomputing the
    // full pricing/data-version fingerprint here turns every status poll into a
    // full-table operation and can exceed the Netlify gateway timeout.  The
    // worker performs the full source/context fence before writing snapshot
    // rows; this request only needs the cheap tenant/job ownership check.
    assertPortalExportJobCurrentContract(job, invite);
    if (isExportJobUnexpired(job) && (job.status === "queued" || job.status === "running") && isStaleExportJob(job.status, job.updated_at)
      && !(isV3ExportBridgeEnabled() && isProductionExportPaused())) {
      context.waitUntil(
        (isV3ExportBridgeEnabled()
          ? dispatchV3PriceExportWorker(req, job.id)
          : runPortalPriceListExportJob(supabaseUrl, serviceRoleKey, job.id)
        ).catch((error) => {
          console.error("portal export retry failed", job.id, error);
        }),
      );
    }
    // Polling is intentionally not written to the audit table.  A 3s poll
    // interval would create thousands of audit writes for one download and
    // add another remote round-trip to the hot status path.
    return json({ ok: true, job: toPublicExportJobStatus(job) }, 200, {
      "Set-Cookie": buildPortalSessionCookie(nextSessionToken),
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal export status could not be loaded.");
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      email: auditEmail,
      eventType: "portal_export_status",
      status: "failed",
      details: { reason: message },
    });
    return json({ error: message }, 400, {
      ...(message === "Your session has expired. Sign in again." || message === "Portal session expired. Sign in again."
        ? { "Set-Cookie": buildExpiredPortalSessionCookie() }
        : {}),
    });
  }
};

export const config: Config = {
  path: "/api/portal-export-status",
  method: "POST",
};
