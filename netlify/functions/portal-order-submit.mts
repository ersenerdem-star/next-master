import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { submitPortalSalesOrder } from "./_shared/portal-orders.mts";
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

    const mode = body?.mode === "confirm" ? "confirm" : "draft";
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return json({ error: "At least one row is required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "submit", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many basket submissions. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      token,
      sessionToken,
    });
    const result = await submitPortalSalesOrder(supabaseUrl, serviceRoleKey, invite, {
      orderId: body?.orderId ? String(body.orderId) : undefined,
      salesOrderNo: body?.salesOrderNo ? String(body.salesOrderNo) : undefined,
      mode,
      deliveryTerm: body?.deliveryTerm ? String(body.deliveryTerm) : "",
      paymentTerms: body?.paymentTerms ? String(body.paymentTerms) : "",
      packingDetails: body?.packingDetails ? String(body.packingDetails) : "",
      notes: body?.notes ? String(body.notes) : "",
      rows,
    });
    return json({ ok: true, ...result, sessionToken: nextSessionToken });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Portal order save failed" }, 400);
  }
};

export const config: Config = {
  path: "/api/portal-order-submit",
  method: "POST",
};
