import { getJson, HttpRequestError, serviceRoleHeaders } from "./http.mts";
import { isTokenRevoked } from "./auth/session-revocation.mts";

export class AppAuthError extends Error {
  readonly status: 401 | 403;

  constructor(message: string, status: 401 | 403 = 401) {
    super(message);
    this.name = "AppAuthError";
    this.status = status;
  }
}

export function getAppAuthStatus(error: unknown): 401 | 403 | undefined {
  return error instanceof AppAuthError ? error.status : undefined;
}

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
    throw new AppAuthError("Your session has expired. Sign in again.");
  }

  let user: AuthUserResponse;
  try {
    user = await getJson<AuthUserResponse>(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 8_000,
    });
  } catch (error) {
    // Invalid/signed-out credentials are an Auth failure, not a malformed RPC.
    // Do not misclassify rate limits, network failures or upstream outages.
    if (error instanceof HttpRequestError && [401, 403].includes(error.status)) {
      throw new AppAuthError("Your session has expired. Sign in again.");
    }
    throw error;
  }

  const userId = String(user.id || "");
  if (!userId) {
    throw new AppAuthError("Your session has expired. Sign in again.");
  }

  type ProfileRow = {
    organization_id?: string | null;
    role?: string | null;
    department?: string | null;
    permissions?: Record<string, boolean> | null;
    customer_scope_mode?: string | null;
    is_active?: boolean | null;
    session_revoked_at?: string | null;
  };

  let profiles: ProfileRow[];
  try {
    profiles = await getJson<ProfileRow[]>(
      `${supabaseUrl}/rest/v1/profiles?select=organization_id,role,department,permissions,customer_scope_mode,is_active,session_revoked_at&id=eq.${encodeURIComponent(userId)}&limit=1`,
      {
        headers: serviceRoleHeaders(serviceRoleKey),
        timeoutMs: 8_000,
      },
    );
  } catch (error) {
    // Compatibility is ONLY for the absent optional column. A timeout,
    // outage or denied SELECT must not retry with revocation omitted.
    if (!(error instanceof HttpRequestError) ||
        !["42703", "PGRST204"].includes(error.code) ||
        !error.rawMessage.includes("session_revoked_at")) throw error;
    // Keep the application available while the session-revocation migration
    // is being rolled out. The active flag remains enforced; only the
    // optional revocation timestamp is unavailable on older schemas.
    profiles = await getJson<ProfileRow[]>(
      `${supabaseUrl}/rest/v1/profiles?select=organization_id,role,department,permissions,customer_scope_mode,is_active&id=eq.${encodeURIComponent(userId)}&limit=1`,
      {
        headers: serviceRoleHeaders(serviceRoleKey),
        timeoutMs: 8_000,
      },
    );
  }

  const profile = profiles[0];
  const organizationId = String(profile?.organization_id || "");
  if (!organizationId) {
    throw new AppAuthError("Your session has expired. Sign in again.");
  }
  if (profile.is_active !== true) {
    throw new AppAuthError("Your session has expired. Sign in again.");
  }
  if (isTokenRevoked(accessToken, profile.session_revoked_at || null)) {
    throw new AppAuthError("Your session has expired. Sign in again.");
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
