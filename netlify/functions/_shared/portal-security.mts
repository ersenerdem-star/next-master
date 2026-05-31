function encodeHex(input: ArrayBuffer) {
  return Array.from(new Uint8Array(input))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function encodeBase64Url(input: string) {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encodeHex(signature);
}

export async function hashPortalToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token || "")));
  return encodeHex(digest);
}

export function isPortalInviteExpired(expiresAt: string | null | undefined) {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry.getTime() < Date.now();
}

type PortalSessionPayload = {
  invite_id: string;
  email: string;
  exp: number;
};

type PortalPasswordResetPayload = {
  purpose: "portal_password_reset";
  invite_id: string;
  email: string;
  updated_at: string;
  exp: number;
};

const PORTAL_SESSION_TTL_SECONDS = 12 * 60 * 60;
const PORTAL_PASSWORD_RESET_TTL_SECONDS = 60 * 60;

export async function createPortalSessionToken(secret: string, inviteId: string, email: string) {
  const payload: PortalSessionPayload = {
    invite_id: String(inviteId || ""),
    email: String(email || "").trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + PORTAL_SESSION_TTL_SECONDS,
  };
  const payloadText = JSON.stringify(payload);
  const payloadPart = encodeBase64Url(payloadText);
  const signature = await hmacSha256(secret, payloadPart);
  return `${payloadPart}.${signature}`;
}

export async function verifyPortalSessionToken(secret: string, token: string) {
  const [payloadPart, signature] = String(token || "").split(".");
  if (!payloadPart || !signature) return null;

  const expectedSignature = await hmacSha256(secret, payloadPart);
  if (expectedSignature !== signature) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart)) as PortalSessionPayload;
    if (!payload?.invite_id || !payload?.email || !payload?.exp) return null;
    if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createPortalPasswordResetToken(secret: string, inviteId: string, email: string, updatedAt: string) {
  const payload: PortalPasswordResetPayload = {
    purpose: "portal_password_reset",
    invite_id: String(inviteId || ""),
    email: String(email || "").trim().toLowerCase(),
    updated_at: String(updatedAt || ""),
    exp: Math.floor(Date.now() / 1000) + PORTAL_PASSWORD_RESET_TTL_SECONDS,
  };
  const payloadText = JSON.stringify(payload);
  const payloadPart = encodeBase64Url(payloadText);
  const signature = await hmacSha256(secret, payloadPart);
  return `${payloadPart}.${signature}`;
}

export async function verifyPortalPasswordResetToken(secret: string, token: string) {
  const [payloadPart, signature] = String(token || "").split(".");
  if (!payloadPart || !signature) return null;

  const expectedSignature = await hmacSha256(secret, payloadPart);
  if (expectedSignature !== signature) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart)) as PortalPasswordResetPayload;
    if (payload?.purpose !== "portal_password_reset") return null;
    if (!payload?.invite_id || !payload?.email || !payload?.updated_at || !payload?.exp) return null;
    if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
