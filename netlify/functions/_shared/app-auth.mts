import { getJson, serviceRoleHeaders } from "./http.mts";

export type AppCaller = {
  id: string;
  email: string;
  organizationId: string;
  role: string;
  department: string;
  permissions: Record<string, boolean>;
  customerScopeMode: "all" | "assigned";
};

type AuthUserResponse = {
  id?: string;
  email?: string;
};

export function getBearerToken(req: Request) {
  const header = String(req.headers.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export async function resolveCaller(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
  serviceRoleKey: string,
) {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    throw new Error("Missing session token");
  }

  const user = await getJson<AuthUserResponse>(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 8_000,
  });

  const userId = String(user.id || "");
  if (!userId) {
    throw new Error("Session user not found");
  }

  const profiles = await getJson<Array<{ organization_id?: string | null; role?: string | null; department?: string | null; permissions?: Record<string, boolean> | null; customer_scope_mode?: string | null }>>(
    `${supabaseUrl}/rest/v1/profiles?select=organization_id,role,department,permissions,customer_scope_mode&id=eq.${encodeURIComponent(userId)}&limit=1`,
    {
      headers: serviceRoleHeaders(serviceRoleKey),
      timeoutMs: 8_000,
    },
  );

  const profile = profiles[0] || {};
  const organizationId = String(profile.organization_id || "");
  if (!organizationId) {
    throw new Error("No organization found for current user");
  }

  return {
    id: userId,
    email: String(user.email || ""),
    organizationId,
    role: String(profile.role || ""),
    department: String(profile.department || "viewer"),
    permissions: profile.permissions && typeof profile.permissions === "object" ? profile.permissions : {},
    customerScopeMode: profile.customer_scope_mode === "assigned" ? "assigned" : "all",
  } satisfies AppCaller;
}
