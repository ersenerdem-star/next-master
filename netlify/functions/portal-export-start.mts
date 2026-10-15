import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { buildExpiredPortalSessionCookie, buildPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { getPortalRequestHostname } from "./_shared/portal-tenant.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import { runPortalPriceListExportJob, startPortalPriceListExport, toPublicExportJobStatus } from "./_shared/export-jobs.mts";
import { dispatchV3PriceExportWorker, isProductionExportPaused, isV3ExportBridgeEnabled } from "./_shared/v3-export-dispatch.mts";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  let auditEmail = "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const body = await req.json();
    const email = String(body?.email || "").trim();
    auditEmail = email;
    const password = String(body?.password || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || readPortalSessionCookie(req) || "").trim();
    const exportType = String(body?.exportType || "portal_price_list").trim();
    const brand = String(body?.brand || "").trim();
    if (!sessionToken && (!email || !password)) return json({ error: "Email and password are required" }, 400);
    if (exportType !== "portal_price_list") return json({ error: "Unsupported portal export type." }, 400);
    if (!brand) return json({ error: "Select a brand before downloading the price list." }, 400);
    if (isV3ExportBridgeEnabled() && isProductionExportPaused()) {
      return json({ error: "V3 export bridge is temporarily paused while the production safety gate is closed." }, 503, { "Retry-After": "300" });
    }

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "price_list", email);
    if (!rateLimit.allowed) {
      await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
        email,
        eventType: "portal_export_start",
        status: "rate_limited",
        details: { brand, exportType },
      });
      return json({ error: "Too many price list downloads. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      password,
      sessionToken,
      hostname: getPortalRequestHostname(req),
    });
    const { job, cached } = await startPortalPriceListExport(supabaseUrl, serviceRoleKey, invite, { brand });
    if (job.status === "queued") {
      if (isV3ExportBridgeEnabled()) {
        context.waitUntil(dispatchV3PriceExportWorker(req, job.id).catch((error) => {
          console.error("portal export worker dispatch failed", job.id, error);
        }));
      } else {
        context.waitUntil(runPortalPriceListExportJob(supabaseUrl, serviceRoleKey, job.id).catch((error) => {
          console.error("portal export job failed", job.id, error);
        }));
      }
    }

    void writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      organizationId: invite.organization_id,
      inviteId: invite.id,
      partyType: invite.party_type,
      email: invite.email,
      eventType: "portal_export_start",
      status: "ok",
      details: { brand, exportType, jobId: job.id, cached },
    });
    return json({ ok: true, job: toPublicExportJobStatus(job, cached) }, 200, {
      "Set-Cookie": buildPortalSessionCookie(nextSessionToken),
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal export could not be started.");
    void writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      email: auditEmail,
      eventType: "portal_export_start",
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
  path: "/api/portal-export-start",
  method: "POST",
};
