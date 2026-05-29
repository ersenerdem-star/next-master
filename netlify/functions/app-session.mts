import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolveCaller } from "./_shared/app-auth.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "Missing Netlify environment variables for app session" }, 500);
  }

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    return json({
      ok: true,
      user: {
        id: caller.id,
        email: caller.email,
      },
      profile: {
        organization_id: caller.organizationId,
        role: caller.role,
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "App session lookup failed" }, 401);
  }
};

export const config: Config = {
  path: "/api/app-session",
  method: "GET",
};
