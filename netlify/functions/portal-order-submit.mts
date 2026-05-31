import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolvePortalInvite } from "./_shared/portal-access.mts";
import { writePortalAuditEvent } from "./_shared/portal-audit.mts";
import { submitPortalSalesOrder } from "./_shared/portal-orders.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { buildExpiredPortalSessionCookie, buildPortalSessionCookie, readPortalSessionCookie } from "./_shared/portal-security.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const PORTAL_ORDER_ROW_MAX = 200;

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

    const mode = body?.mode === "confirm" ? "confirm" : "draft";
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return json({ error: "At least one row is required" }, 400);
    if (rows.length > PORTAL_ORDER_ROW_MAX) {
      return json({ error: `Basket is too large. Use ${PORTAL_ORDER_ROW_MAX} rows or fewer.` }, 400);
    }

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "submit", email);
    if (!rateLimit.allowed) {
      await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
        email,
        eventType: "portal_order_submit",
        status: "rate_limited",
        details: { mode, rowCount: rows.length },
      });
      return json({ error: "Too many basket submissions. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const { invite, sessionToken: nextSessionToken } = await resolvePortalInvite(supabaseUrl, serviceRoleKey, sessionSecret, {
      email,
      password,
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
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      organizationId: invite.organization_id,
      inviteId: invite.id,
      partyType: invite.party_type,
      email: invite.email,
      eventType: "portal_order_submit",
      status: "ok",
      details: { mode, rowCount: rows.length, orderId: result.orderId || "" },
    });
    return json({ ok: true, ...result }, 200, {
      "Set-Cookie": buildPortalSessionCookie(nextSessionToken),
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Portal order save failed");
    await writePortalAuditEvent(req, supabaseUrl, serviceRoleKey, {
      email: auditEmail,
      eventType: "portal_order_submit",
      status: "failed",
      details: { reason: message },
    });
    return json({ error: message }, 400, {
      ...(message === "Your session has expired. Sign in again." ? { "Set-Cookie": buildExpiredPortalSessionCookie() } : {}),
    });
  }
};

export const config: Config = {
  path: "/api/portal-order-submit",
  method: "POST",
};
