import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildPortalFallbackSnapshot, buildPortalSnapshot, resolvePortalInvite } from "./_shared/portal-access.mts";
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
    const token = String(body?.token || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || "").trim();
    if (!sessionToken && (!email || !token)) return json({ error: "Email and invite token are required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "data", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many portal refresh attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      token,
      sessionToken,
    });
    let snapshot;
    try {
      snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
    } catch {
      snapshot = await buildPortalFallbackSnapshot(supabaseUrl, serviceRoleKey, invite);
    }
    return json({ ok: true, snapshot, sessionToken: nextSessionToken });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Portal data load failed") }, 401);
  }
};

export const config: Config = {
  path: "/api/portal-data",
  method: "POST",
};
