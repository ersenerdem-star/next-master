import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { preparePortalOrderLines } from "./_shared/portal-orders.mts";
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
    const password = String(body?.password || "").trim();
    const sessionToken = String(body?.sessionToken || body?.session_token || "").trim();
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!sessionToken && (!email || !password)) return json({ error: "Email and password are required" }, 400);
    if (!rows.length) return json({ error: "At least one row is required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "prepare", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many basket pricing attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      password,
      sessionToken,
    });
    const prepared = await preparePortalOrderLines(supabaseUrl, serviceRoleKey, invite, rows);
    return json({ ok: true, ...prepared, sessionToken: nextSessionToken });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Portal order pricing failed") }, 400);
  }
};

export const config: Config = {
  path: "/api/portal-order-prepare",
  method: "POST",
};
