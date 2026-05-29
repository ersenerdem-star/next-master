import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildPortalSnapshot, resolvePortalInvite } from "./_shared/portal-access.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing Netlify environment variables for portal access" }, 500);
  }

  try {
    const body = await req.json();
    const email = String(body?.email || "").trim();
    const token = String(body?.token || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || "").trim();
    if (!sessionToken && (!email || !token)) return json({ error: "Email and invite token are required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "login", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many portal login attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      token,
      sessionToken,
    });
    const snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
    return json({ ok: true, snapshot, sessionToken: nextSessionToken });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Portal login failed" }, 401);
  }
};

export const config: Config = {
  path: "/api/portal-login",
  method: "POST",
};
