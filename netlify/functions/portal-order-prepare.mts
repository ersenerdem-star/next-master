import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { validatePortalInvite } from "./_shared/portal-access.mts";
import { preparePortalOrderLines } from "./_shared/portal-orders.mts";

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
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!email || !token) return json({ error: "Email and invite token are required" }, 400);
    if (!rows.length) return json({ error: "At least one row is required" }, 400);

    const invite = await validatePortalInvite(supabaseUrl, serviceRoleKey, email, token);
    const prepared = await preparePortalOrderLines(supabaseUrl, serviceRoleKey, invite, rows);
    return json({ ok: true, ...prepared });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Portal order pricing failed" }, 400);
  }
};

export const config: Config = {
  path: "/api/portal-order-prepare",
  method: "POST",
};
