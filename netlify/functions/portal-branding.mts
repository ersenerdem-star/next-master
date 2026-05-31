import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildPortalBranding, resolvePortalInvitePreview } from "./_shared/portal-access.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const body = await req.json();
    const email = String(body?.email || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || "").trim();
    if (!sessionToken && !email) return json({ error: "Email is required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "branding", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many portal preview attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite } = await resolvePortalInvitePreview(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      sessionToken,
    });
    let branding;
    try {
      branding = await buildPortalBranding(supabaseUrl, serviceRoleKey, invite);
    } catch {
      branding = {
        companyProfile: null,
        portalLabel: invite.party_type === "customer" ? "Customer Portal" : "Vendor Portal",
        partyName: String(invite.party_name || invite.email || ""),
      };
    }
    return json({ ok: true, branding });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Portal branding load failed") }, 401);
  }
};

export const config: Config = {
  path: "/api/portal-branding",
  method: "POST",
};
