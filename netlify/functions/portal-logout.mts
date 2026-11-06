import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildExpiredPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { getPortalRequestHostname } from "./_shared/portal-tenant.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  const sessionToken = readPortalSessionCookie(req);
  if (supabaseUrl && serviceRoleKey && sessionSecret && sessionToken) {
    try {
      const hostname = getPortalRequestHostname(req);
      const { invite } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
        sessionToken, hostname, touchSession: false, signal: AbortSignal.timeout(3_000),
      });
      await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
        ipAddress: _context.ip || null,
        countryCode: _context.geo?.country?.code || null,
        countrySource: "netlify_geo",
        organizationId: invite.organization_id,
        inviteId: invite.id,
        partyType: invite.party_type,
        email: invite.email,
        eventType: "portal_logout",
        status: "ok",
        details: { auth_method: "session", reason: "explicit_logout", hostname,
          party_name: invite.party_name, contact_name: invite.contact_name, customer_id: invite.customer_id },
      });
    } catch {
      // Clear even an expired/revoked cookie. It cannot prove an actor, so do
      // not manufacture a successful logout record from unverified claims.
    }
  }
  return json({ ok: true }, 200, {
    "Set-Cookie": buildExpiredPortalSessionCookie(),
  });
};

export const config: Config = {
  path: "/api/portal-logout",
  method: "POST",
};
