import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { validatePortalInvite } from "./_shared/portal-access.mts";
import { deletePortalSalesOrder } from "./_shared/portal-orders.mts";

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
    const orderId = String(body?.orderId || "").trim();
    if (!email || !token) return json({ error: "Email and invite token are required" }, 400);
    if (!orderId) return json({ error: "Order id is required" }, 400);

    const invite = await validatePortalInvite(supabaseUrl, serviceRoleKey, email, token);
    const result = await deletePortalSalesOrder(supabaseUrl, serviceRoleKey, invite, orderId);
    return json({ ok: true, ...result });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Portal draft delete failed" }, 400);
  }
};

export const config: Config = {
  path: "/api/portal-order-delete",
  method: "POST",
};
