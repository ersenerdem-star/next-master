import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { deletePortalSalesOrder } from "./_shared/portal-orders.mts";
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
    const orderId = String(body?.orderId || "").trim();
    if (!sessionToken && (!email || !token)) return json({ error: "Email and invite token are required" }, 400);
    if (!orderId) return json({ error: "Order id is required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "delete", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many basket delete attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      token,
      sessionToken,
    });
    const result = await deletePortalSalesOrder(supabaseUrl, serviceRoleKey, invite, orderId);
    return json({ ok: true, ...result, sessionToken: nextSessionToken });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Portal draft delete failed") }, 400);
  }
};

export const config: Config = {
  path: "/api/portal-order-delete",
  method: "POST",
};
