import type { Config } from "@netlify/functions";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { assertPortalExportJobCurrentContract, downloadExportArtifact, fetchExportJobById } from "./_shared/export-jobs.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { buildExpiredPortalSessionCookie, buildPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { getPortalRequestHostname } from "./_shared/portal-tenant.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  if (!supabaseUrl || !serviceRoleKey) return new Response("System configuration is incomplete.", { status: 500 });

  try {
    const jobId = new URL(req.url).searchParams.get("jobId")?.trim() || "";
    const sessionToken = readPortalSessionCookie(req);
    if (!jobId || !sessionToken) return new Response("Portal session expired. Sign in again.", { status: 401 });

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email: "",
      password: "",
      sessionToken,
      hostname: getPortalRequestHostname(req),
    });
    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "data", invite.email);
    if (!rateLimit.allowed) return new Response("Too many portal refresh attempts. Try again later.", { status: 429 });
    const job = await fetchExportJobById(supabaseUrl, serviceRoleKey, invite.organization_id, jobId);
    if (!job) return new Response("Export job not found.", { status: 404 });
    // See portal-export-download: the worker fences the immutable artifact;
    // keep the same-origin fallback bounded to the cheap scope check.
    assertPortalExportJobCurrentContract(job, invite);
    if (job.status !== "finalized") return new Response("Export file is not ready yet.", { status: 409 });

    const response = await downloadExportArtifact(supabaseUrl, serviceRoleKey, job);
    void writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      organizationId: invite.organization_id,
      inviteId: invite.id,
      partyType: invite.party_type,
      email: invite.email,
      eventType: "portal_export_download",
      status: "ok",
      details: { jobId, rowCount: job.row_count, transport: "same_origin" },
    });

    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Set-Cookie", buildPortalSessionCookie(nextSessionToken));
    return response;
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal export file could not be downloaded.");
    return new Response(message, {
      status: message === "Your session has expired. Sign in again." || message === "Portal session expired. Sign in again." ? 401 : 400,
      headers: message === "Your session has expired. Sign in again." || message === "Portal session expired. Sign in again."
        ? { "Set-Cookie": buildExpiredPortalSessionCookie() }
        : undefined,
    });
  }
};

export const config: Config = {
  path: "/api/portal-export-file",
  method: "GET",
};
