const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseTimestamp(value: string | null) {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function canonicalQuery(requestUrl: string) {
  const url = new URL(requestUrl);
  return [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export async function verifyMiraBridgeRequest(request: Request, bodyText: string, secret: string) {
  const timestampHeader = request.headers.get("x-mira-timestamp");
  const signatureHeader = request.headers.get("x-mira-signature")?.trim().toLowerCase() || "";
  const bridgeId = request.headers.get("x-mira-bridge-id")?.trim() || "";
  const timestamp = parseTimestamp(timestampHeader);

  if (!timestamp || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    return { ok: false as const, error: "MIRA bridge timestamp is missing or expired." };
  }
  if (!/^([A-Za-z0-9._:-]){1,100}$/.test(bridgeId)) {
    return { ok: false as const, error: "MIRA bridge identifier is invalid." };
  }
  if (!/^[a-f0-9]{64}$/.test(signatureHeader)) {
    return { ok: false as const, error: "MIRA bridge signature is invalid." };
  }

  const canonical = [
    request.method.toUpperCase(),
    new URL(request.url).pathname,
    canonicalQuery(request.url),
    timestampHeader,
    await sha256Hex(bodyText),
  ].join("\n");
  const expected = await hmacHex(secret, canonical);

  if (!constantTimeEqual(expected, signatureHeader)) {
    return { ok: false as const, error: "MIRA bridge signature is invalid." };
  }

  return { ok: true as const, bridgeId, timestamp: timestampHeader };
}
