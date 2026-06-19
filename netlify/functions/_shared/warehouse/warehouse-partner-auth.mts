type PartnerClientSecurity = {
  require_hmac?: boolean | null;
  allowed_ip_list?: string | null;
};

function encodeHex(input: ArrayBuffer) {
  return Array.from(new Uint8Array(input))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

export function readPartnerApiKey(req: Request) {
  const headerValue = normalizeText(req.headers.get("x-api-key"));
  if (headerValue) return headerValue;
  const authHeader = normalizeText(req.headers.get("authorization"));
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return normalizeText(match?.[1]);
}

export function readPartnerClientIp(req: Request) {
  const forwarded = normalizeText(req.headers.get("x-forwarded-for"));
  if (forwarded.includes(",")) return forwarded.split(",")[0].trim();
  return forwarded || normalizeText(req.headers.get("client-ip"));
}

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return encodeHex(digest);
}

async function hmacSha256Hex(secret: string, input: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return encodeHex(signature);
}

function canonicalizeSearchParams(url: URL) {
  const pairs = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
    return leftValue.localeCompare(rightValue);
  });
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function parseTimestamp(raw: string) {
  const text = normalizeText(raw);
  if (!text) return NaN;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return text.length === 13 ? numeric : numeric * 1000;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? NaN : parsed.getTime();
}

function parseIpRules(raw: string) {
  return raw
    .split(/[\n,;]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function ipToInt(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0)) >>> 0;
}

function matchesIpv4Cidr(ip: string, rule: string) {
  const [baseIp, prefixRaw] = rule.split("/");
  const prefix = Number(prefixRaw);
  const ipInt = ipToInt(ip);
  const baseInt = ipToInt(baseIp);
  if (ipInt == null || baseInt == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function matchesIpRule(ip: string, rule: string) {
  if (!ip || !rule) return false;
  if (rule.includes("/")) return matchesIpv4Cidr(ip, rule);
  if (rule.endsWith("*")) return ip.startsWith(rule.slice(0, -1));
  return ip === rule;
}

export function isPartnerClientIpAllowed(clientIp: string, allowedIpList: string | null | undefined) {
  const ip = normalizeText(clientIp);
  const rules = parseIpRules(normalizeText(allowedIpList));
  if (!rules.length) return true;
  if (!ip) return false;
  return rules.some((rule) => matchesIpRule(ip, rule));
}

export async function verifyPartnerRequestSignature(req: Request, apiKey: string, bodyText = "") {
  const timestampHeader = normalizeText(req.headers.get("x-timestamp"));
  const signatureHeader = normalizeText(req.headers.get("x-signature")).toLowerCase();
  if (!timestampHeader || !signatureHeader) {
    return { ok: false as const, error: "Signed request headers are missing." };
  }

  const timestampMs = parseTimestamp(timestampHeader);
  if (!Number.isFinite(timestampMs)) {
    return { ok: false as const, error: "Signed request timestamp is invalid." };
  }
  if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return { ok: false as const, error: "Signed request timestamp is outside the allowed window." };
  }

  const url = new URL(req.url);
  const canonical = [
    req.method.toUpperCase(),
    url.pathname,
    canonicalizeSearchParams(url),
    timestampHeader,
    await sha256Hex(bodyText),
  ].join("\n");

  const expectedSignature = await hmacSha256Hex(apiKey, canonical);
  if (expectedSignature !== signatureHeader) {
    return { ok: false as const, error: "Signed request signature is invalid." };
  }
  return { ok: true as const };
}

export async function enforcePartnerRequestSecurity(
  req: Request,
  client: PartnerClientSecurity,
  apiKey: string,
  bodyText = "",
) {
  const clientIp = readPartnerClientIp(req);
  if (!isPartnerClientIpAllowed(clientIp, client.allowed_ip_list)) {
    return { ok: false as const, error: "Request IP is not allowlisted for this API client.", clientIp };
  }

  if (client.require_hmac !== false) {
    const signatureResult = await verifyPartnerRequestSignature(req, apiKey, bodyText);
    if (!signatureResult.ok) {
      return { ok: false as const, error: signatureResult.error, clientIp };
    }
  }

  return { ok: true as const, clientIp };
}
