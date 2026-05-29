import { sendJson, serviceRoleHeaders } from "./http.mts";

type RateLimitRpcRow = {
  allowed?: boolean;
  retry_after_seconds?: number;
  remaining?: number;
  blocked_until?: string | null;
};

type PortalRateLimitConfig = {
  limit: number;
  windowSeconds: number;
  blockSeconds: number;
};

const PORTAL_RATE_LIMITS: Record<string, PortalRateLimitConfig> = {
  login: { limit: 12, windowSeconds: 600, blockSeconds: 1800 },
  branding: { limit: 30, windowSeconds: 600, blockSeconds: 900 },
  data: { limit: 60, windowSeconds: 600, blockSeconds: 900 },
  search: { limit: 90, windowSeconds: 300, blockSeconds: 900 },
  prepare: { limit: 45, windowSeconds: 600, blockSeconds: 900 },
  submit: { limit: 20, windowSeconds: 600, blockSeconds: 1200 },
  delete: { limit: 20, windowSeconds: 600, blockSeconds: 1200 },
  price_list: { limit: 10, windowSeconds: 600, blockSeconds: 1800 },
};

export type PortalRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
};

function firstHeaderValue(value: string | null) {
  return String(value || "")
    .split(",")[0]
    .trim();
}

function getClientIp(req: Request) {
  return (
    firstHeaderValue(req.headers.get("x-nf-client-connection-ip")) ||
    firstHeaderValue(req.headers.get("client-ip")) ||
    firstHeaderValue(req.headers.get("x-forwarded-for")) ||
    "unknown"
  );
}

function normalizeEmail(email: string | null | undefined) {
  return String(email || "").trim().toLowerCase();
}

export async function enforcePortalRateLimit(
  req: Request,
  supabaseUrl: string,
  serviceRoleKey: string,
  route: keyof typeof PORTAL_RATE_LIMITS,
  email?: string | null,
) {
  const policy = PORTAL_RATE_LIMITS[route];
  const clientIp = getClientIp(req);
  const normalizedEmail = normalizeEmail(email);
  const subject = normalizedEmail ? `${clientIp}|${normalizedEmail}` : clientIp;

  const data = await sendJson<RateLimitRpcRow[] | RateLimitRpcRow>(`${supabaseUrl}/rest/v1/rpc/check_portal_rate_limit`, {
    method: "POST",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_route: route,
      p_subject: subject,
      p_limit: policy.limit,
      p_window_seconds: policy.windowSeconds,
      p_block_seconds: policy.blockSeconds,
    }),
  });

  const row = (Array.isArray(data) ? data[0] : data) || {};
  return {
    allowed: Boolean(row.allowed),
    retryAfterSeconds: Number(row.retry_after_seconds || 0),
    remaining: Number(row.remaining || 0),
  } satisfies PortalRateLimitResult;
}
