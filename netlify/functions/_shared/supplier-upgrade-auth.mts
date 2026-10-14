// Strict boundary for NEW supplier upgrade endpoints only. Do not change legacy
// login/fallback behavior. Token claims are used only AFTER Auth verifies token.
export class SupplierUpgradeError extends Error {
  constructor(readonly status: 401 | 403 | 503, message: string) { super(message); }
}
export const supplierUuid = (x: unknown): x is string => typeof x === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

// New secret keys are API keys, not JWT bearer tokens. Keep this change local
// to the opt-in upgrade boundary; do not alter legacy application auth.
export function supplierUpgradeServiceHeaders(key: string): Record<string, string> {
  return { apikey: key, "Content-Type": "application/json",
    ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }) };
}

export async function supplierUpgradeFetch(url: string, init: RequestInit, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    const data: unknown = await response.json().catch(() => null);
    return { response, data };
  } finally { clearTimeout(timer); }
}

export async function resolveSupplierUpgradeAdmin(req: Request, url: string, anon: string, service: string) {
  const match = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  if (!token || token.length > 8192) throw new SupplierUpgradeError(401, "Sign in again to continue.");
  let user: { id?: unknown };
  try {
    const result = await supplierUpgradeFetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    if ([401, 403].includes(result.response.status)) throw new SupplierUpgradeError(401, "Sign in again to continue.");
    if (!result.response.ok || !result.data || typeof result.data !== "object") throw Error("Auth unavailable");
    user = result.data;
  } catch (error) {
    if (error instanceof SupplierUpgradeError) throw error;
    throw new SupplierUpgradeError(503, "We could not verify your session. No action was submitted.");
  }
  if (!supplierUuid(user.id)) throw new SupplierUpgradeError(401, "Sign in again to continue.");
  let claims: Record<string, unknown>;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts.every(Boolean)) throw Error("Invalid token");
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!claims || typeof claims !== "object" || Array.isArray(claims)
      || claims.sub !== user.id || claims.role !== "authenticated" || claims.aud !== "authenticated"
      || claims.iss !== `${url}/auth/v1` || !supplierUuid(claims.session_id)
      || !Number.isSafeInteger(claims.iat) || Number(claims.iat) <= 0 || Number(claims.iat) > now + 30
      || !Number.isSafeInteger(claims.exp) || Number(claims.exp) <= now || Number(claims.exp) <= Number(claims.iat)
      || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || Number(claims.nbf) > now))
      || claims.is_anonymous === true) throw Error("Invalid claims");
  } catch { throw new SupplierUpgradeError(401, "Sign in again to continue."); }
  let profile: Record<string, unknown>;
  try {
    const result = await supplierUpgradeFetch(`${url}/rest/v1/profiles?select=id,organization_id,role,is_active,session_revoked_at&id=eq.${user.id}&limit=2`, {
      headers: supplierUpgradeServiceHeaders(service),
    });
    if (!result.response.ok || !Array.isArray(result.data) || result.data.length !== 1
      || !result.data[0] || typeof result.data[0] !== "object"
      || !Object.hasOwn(result.data[0], "session_revoked_at")) throw Error("Profile unavailable");
    profile = result.data[0];
    if (profile.session_revoked_at !== null && (typeof profile.session_revoked_at !== "string"
      || !Number.isFinite(Date.parse(profile.session_revoked_at)))) throw Error("Revocation unavailable");
  } catch { throw new SupplierUpgradeError(503, "We could not verify your permissions. No action was submitted."); }
  if (profile.id !== user.id || !supplierUuid(profile.organization_id) || profile.is_active !== true)
    throw new SupplierUpgradeError(401, "Sign in again to continue.");
  if (profile.role !== "admin" && profile.role !== "superadmin")
    throw new SupplierUpgradeError(403, "Only organization administrators can review supplier uploads.");
  if (profile.session_revoked_at !== null && Number(claims.iat) * 1000 <= Date.parse(String(profile.session_revoked_at)))
    throw new SupplierUpgradeError(401, "This session was revoked. Sign in again.");
  return { actorId: user.id, organizationId: profile.organization_id,
    authSessionId: claims.session_id as string, issuedAt: claims.iat as number, expiresAt: claims.exp as number };
}
