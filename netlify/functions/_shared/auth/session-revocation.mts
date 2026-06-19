function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function getJwtIssuedAtSeconds(token: string) {
  const raw = String(token || "").trim();
  if (!raw) return 0;
  const parts = raw.split(".");
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    const iat = Number(payload?.iat || 0);
    return Number.isFinite(iat) ? iat : 0;
  } catch {
    return 0;
  }
}

export function isTokenRevoked(token: string, revokedAtIso: string | null | undefined) {
  const revokedAt = revokedAtIso ? Date.parse(revokedAtIso) : 0;
  if (!revokedAt) return false;
  const issuedAtSeconds = getJwtIssuedAtSeconds(token);
  if (!issuedAtSeconds) return false;
  return issuedAtSeconds * 1000 < revokedAt;
}
