import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { assertPortalExportJobCurrentContext, assertPortalExportJobCurrentContract, failOrphanSharedPortalFollower, fetchExportJobById, isExportJobUnexpired, runPortalPriceListExportJob, toPublicExportJobStatus } from "./_shared/export-jobs.mts";
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
      touchSession: false,
    });
    let job = await fetchExportJobById(supabaseUrl, serviceRoleKey, invite.organization_id, jobId);
    if (!job) return json({ error: "Export job not found." }, 404, { "Set-Cookie": buildPortalSessionCookie(nextSessionToken) });
    // Status is polled while a large export is being built.  Recomputing the
    // full pricing/data-version fingerprint here turns every status poll into a
    // full-table operation and can exceed the Netlify gateway timeout.  The
    // worker performs the full source/context fence before writing snapshot
    // rows; this request only needs the cheap tenant/job ownership check.
    assertPortalExportJobCurrentContract(job, invite);
    const sharedLeaderId = String(job.scope?.sharedLeaderJobId || "");
    let leader = sharedLeaderId && (job.status === "queued" || job.status === "running")
      ? await fetchExportJobById(supabaseUrl, serviceRoleKey, invite.organization_id, sharedLeaderId) : null;
    if (sharedLeaderId && (job.status === "queued" || job.status === "running") && (!leader || !isExportJobUnexpired(leader) || !["queued","running"].includes(leader.status))) {
      job = await failOrphanSharedPortalFollower(supabaseUrl, serviceRoleKey, invite.organization_id, job.id)
        || await fetchExportJobById(supabaseUrl, serviceRoleKey, invite.organization_id, job.id);
      if (!job) throw new Error("Export job not found.");
      assertPortalExportJobCurrentContract(job, invite);
      leader = null;
    }
    if (sharedLeaderId && job.status === "finalized") await assertPortalExportJobCurrentContext(supabaseUrl, serviceRoleKey, job, invite);
    if (sharedLeaderId && (job.status === "queued" || job.status === "running") && (!leader || leader.scope?.sharedLeaderJobId
      || leader.audience !== "portal" || leader.export_type !== "portal_price_list"
      || leader.scope?.brandId !== job.scope?.brandId || leader.scope?.sourceVersion !== job.scope?.sourceVersion
      || leader.scope?.priceListType !== job.scope?.priceListType || leader.scope?.marginPercent !== job.scope?.marginPercent
      || leader.scope?.currency !== job.scope?.currency)) throw new Error("Shared price file is unavailable. Please retry.");
    const work = leader || job;
    if (isExportJobUnexpired(work) && (work.status === "queued" || work.status === "running") && isStaleExportJob(work.status, work.updated_at)
      && !(isV3ExportBridgeEnabled() && isProductionExportPaused())) {
      context.waitUntil(
        (isV3ExportBridgeEnabled()
          ? dispatchV3PriceExportWorker(req, work.id)
          : runPortalPriceListExportJob(supabaseUrl, serviceRoleKey, work.id)
        ).catch((error) => {
          console.error("portal export retry failed", job.id, error);
        }),
      );
    }
    // Polling is intentionally not written to the audit table.  A 3s poll
    // interval would create thousands of audit writes for one download and
    // add another remote round-trip to the hot status path.
    const display = leader && (leader.status === "queued" || leader.status === "running")
      ? { ...job, status: leader.status, progress_done: leader.progress_done, progress_total: leader.progress_total,
          row_count: leader.row_count, progress_message: leader.progress_message } : job;
    return json({ ok: true, job: toPublicExportJobStatus(display) }, 200, {
      "Set-Cookie": buildPortalSessionCookie(nextSessionToken),
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal export status could not be loaded.");
    void writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
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
