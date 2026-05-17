import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildPortalSnapshot, validatePortalInvite } from "./_shared/portal-access.mts";

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

    const invite = await validatePortalInvite(supabaseUrl, serviceRoleKey, email, token);
    const snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
    return json({ ok: true, snapshot });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Portal login failed" }, 401);
  }
};

export const config: Config = {
  path: "/api/portal-login",
  method: "POST",
};
