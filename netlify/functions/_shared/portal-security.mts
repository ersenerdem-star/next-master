function encodeHex(input: ArrayBuffer) {
  return Array.from(new Uint8Array(input))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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
