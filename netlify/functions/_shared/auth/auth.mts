import { buildRestUrl, getJson, serviceRoleHeaders } from "../core/http.mts";
import { isTokenRevoked } from "./session-revocation.mts";

export type CallerProfile = {
  id: string;
  role: string;
  is_active: boolean;
  organization_id: string;
  email?: string;
};

export async function requireCallerProfile(req: Request, allowedRoles: string[]) {
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error("Missing Netlify environment variables for Supabase");
  }

  const authHeader = req.headers.get("authorization") || "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!callerToken) {
    return { error: "Missing caller token", status: 401 as const };
  }

  const caller = await getJson<{ id: string; email?: string }>(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${callerToken}`,
    },
  });

  let rows: Array<CallerProfile & { session_revoked_at?: string | null }> = [];
  try {
    rows = await getJson<Array<CallerProfile & { session_revoked_at?: string | null }>>(
      buildRestUrl(supabaseUrl, "profiles", {
        select: "id,role,is_active,organization_id,email,session_revoked_at",
        id: `eq.${caller.id}`,
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );
  } catch {
    rows = await getJson<Array<CallerProfile>>(
      buildRestUrl(supabaseUrl, "profiles", {
        select: "id,role,is_active,organization_id,email",
        id: `eq.${caller.id}`,
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );
  }

  const profile = rows[0];
  if (!profile?.is_active || !allowedRoles.includes(profile.role)) {
    return { error: "Forbidden", status: 403 as const };
  }
  if (isTokenRevoked(callerToken, profile.session_revoked_at || null)) {
    return { error: "Session revoked. Sign in again.", status: 401 as const };
  }

  return {
    profile: {
      ...profile,
      id: caller.id,
      email: caller.email || profile.email || "",
    },
    supabaseUrl,
    supabaseAnonKey,
    serviceRoleKey,
  };
}
