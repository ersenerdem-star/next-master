import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildPortalFallbackSnapshot, buildPortalSnapshot, resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { buildExpiredPortalSessionCookie, buildPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
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
    if (!sessionToken && (!email || !password)) return json({ error: "Email and password are required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "login", email);
    if (!rateLimit.allowed) {
      await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
        email,
        eventType: "portal_login",
        status: "rate_limited",
      });
      return json({ error: "Too many portal login attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      password,
      sessionToken,
    });
    let snapshot;
    try {
      snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
    } catch {
      snapshot = await buildPortalFallbackSnapshot(supabaseUrl, serviceRoleKey, invite);
    }
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      organizationId: invite.organization_id,
      inviteId: invite.id,
      partyType: invite.party_type,
      email: invite.email,
      eventType: "portal_login",
      status: "ok",
    });
    return json({ ok: true, snapshot }, 200, {
      "Set-Cookie": buildPortalSessionCookie(nextSessionToken),
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal login failed");
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      email: auditEmail,
      eventType: "portal_login",
      status: "failed",
      details: { reason: message },
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
