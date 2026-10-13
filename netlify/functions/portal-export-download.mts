import type { Config } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { assertPortalExportJobCurrentContext, createExportArtifactSignedDownload, fetchExportJobById } from "./_shared/export-jobs.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { buildExpiredPortalSessionCookie, buildPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { getPortalRequestHostname } from "./_shared/portal-tenant.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  let auditEmail = "";
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "System configuration is incomplete." }, 500);

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim();
    auditEmail = email;
    const password = String(body?.password || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || readPortalSessionCookie(req) || "").trim();
    const jobId = String(body?.jobId || "").trim();
    if (!sessionToken && (!email || !password)) return json({ error: "Email and password are required" }, 400);
    if (!jobId) return json({ error: "jobId is required." }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "data", email);
    if (!rateLimit.allowed) return json({ error: "Too many portal refresh attempts. Try again later." }, 429, { "Retry-After": String(rateLimit.retryAfterSeconds) });
    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      password,
      sessionToken,
      hostname: getPortalRequestHostname(req),
    });
    const job = await fetchExportJobById(supabaseUrl, serviceRoleKey, invite.organization_id, jobId);
    if (!job) return json({ error: "Export job not found." }, 404, { "Set-Cookie": buildPortalSessionCookie(nextSessionToken) });
    await assertPortalExportJobCurrentContext(supabaseUrl, serviceRoleKey, job, invite);
    if (job.status !== "finalized") return json({ error: "Export file is not ready yet." }, 409, { "Set-Cookie": buildPortalSessionCookie(nextSessionToken) });

    const download = await createExportArtifactSignedDownload(supabaseUrl, serviceRoleKey, job);
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      organizationId: invite.organization_id,
      inviteId: invite.id,
      partyType: invite.party_type,
      email: invite.email,
      eventType: "portal_export_download",
      status: "ok",
      details: { jobId, rowCount: job.row_count },
    });
    return json({ ok: true, ...download, fallbackUrl: `/api/portal-export-file?jobId=${encodeURIComponent(job.id)}` }, 200, {
      "Cache-Control": "no-store",
      "Set-Cookie": buildPortalSessionCookie(nextSessionToken),
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal export file could not be downloaded.");
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      email: auditEmail,
      eventType: "portal_export_download",
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
  path: "/api/portal-export-download",
  method: "POST",
};
