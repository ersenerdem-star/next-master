import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { validatePortalInvite } from "./_shared/portal-access.mts";
import { submitPortalSalesOrder } from "./_shared/portal-orders.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing Netlify environment variables for portal access" }, 500);
  }

  try {
    const body = await req.json();
    const email = String(body?.email || "").trim();
    const token = String(body?.token || "").trim();
    if (!email || !token) return json({ error: "Email and invite token are required" }, 400);

    const mode = body?.mode === "confirm" ? "confirm" : "draft";
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return json({ error: "At least one row is required" }, 400);

    const invite = await validatePortalInvite(supabaseUrl, serviceRoleKey, email, token);
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
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Portal order save failed" }, 400);
  }
};

export const config: Config = {
  path: "/api/portal-order-submit",
  method: "POST",
};
