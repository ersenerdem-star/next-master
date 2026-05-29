import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { resolveCaller } from "./_shared/app-auth.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
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
    return json({ error: sanitizeUserFacingError(error, "Session details could not be loaded right now.") }, 401);
  }
};

export const config: Config = {
  path: "/api/app-session",
  method: "GET",
};
