import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildPortalFallbackSnapshot, buildPortalSnapshot, resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { buildExpiredPortalSessionCookie, buildPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import { getPortalRequestHostname, resolvePortalSellerTenant } from "./_shared/portal-tenant.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  let auditEmail = "";
  let auditOrganizationId: string | null = null;
  let auditAuthMethod: "password" | "session" | "unknown" = "unknown";
  const hostname = getPortalRequestHostname(req);
  const auditLocation = { ipAddress: _context.ip || null, countryCode: _context.geo?.country?.code || null, countrySource: "netlify_geo" as const };
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const body = await req.json();
    const email = String(body?.email || "").trim();
    auditEmail = email;
    const password = String(body?.password || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || readPortalSessionCookie(req) || "").trim();
    auditAuthMethod = !password && sessionToken ? "session" : password ? "password" : "unknown";
    if (!sessionToken && (!email || !password)) return json({ error: "Email and password are required" }, 400);

    // Failed attempts are scoped only by the verified seller domain. An email
    // supplied by a failed login must never establish organization ownership.
    try {
      auditOrganizationId = (await resolvePortalSellerTenant(supabaseUrl, serviceRoleKey, hostname, AbortSignal.timeout(2_500)))?.organization_id || null;
    } catch { /* Audit context lookup must not block the existing login flow. */ }

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "login", email);
    if (!rateLimit.allowed) {
      await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
        ...auditLocation,
        organizationId: auditOrganizationId,
        email,
        eventType: auditAuthMethod === "session" ? "portal_session_resume" : "portal_login",
        status: "rate_limited",
        details: { auth_method: auditAuthMethod, hostname },
      });
      return json({ error: "Too many portal login attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      password,
      sessionToken,
      hostname,
    });
    let snapshot;
    try {
      snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
    } catch {
      snapshot = await buildPortalFallbackSnapshot(supabaseUrl, serviceRoleKey, invite);
    }
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      ...auditLocation,
      organizationId: invite.organization_id,
      inviteId: invite.id,
      partyType: invite.party_type,
      email: invite.email,
      eventType: auditAuthMethod === "session" ? "portal_session_resume" : "portal_login",
      status: "ok",
      details: {
        auth_method: auditAuthMethod,
        hostname,
        party_name: invite.party_name,
        contact_name: invite.contact_name,
        customer_id: invite.customer_id,
      },
    });
    return json({ ok: true, snapshot }, 200, {
      "Set-Cookie": buildPortalSessionCookie(nextSessionToken),
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal login failed");
    const originalMessage = error instanceof Error ? error.message : String(error || "");
    const sessionRejection = auditAuthMethod !== "session" ? null
      : /^(?:Portal session expired\. Sign in again\.|Your session has expired\. Sign in again\.)$/.test(originalMessage) ? "invalid_or_expired"
      : originalMessage === "Portal session is no longer active." ? "session_no_longer_active"
      : originalMessage === "Portal session belongs to another seller domain. Sign in again." ? "session_domain_mismatch"
      : null;
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      ...auditLocation,
      organizationId: auditOrganizationId,
      email: auditEmail,
      eventType: sessionRejection ? "portal_session_rejected" : auditAuthMethod === "session" ? "portal_session_resume" : "portal_login",
      status: "failed",
      details: { reason: sessionRejection || message, auth_method: auditAuthMethod, hostname },
    });
    return json({ error: message }, 401, {
      ...(message === "Your session has expired. Sign in again." ? { "Set-Cookie": buildExpiredPortalSessionCookie() } : {}),
    });
  }
};

export const config: Config = {
  path: "/api/portal-login",
  method: "POST",
};
