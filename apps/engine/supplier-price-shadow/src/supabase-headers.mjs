export function supabaseApiHeaders(apiKey, contentType) {
  const key = String(apiKey || "");
  const headers = { apikey: key };
  if (contentType) headers["Content-Type"] = contentType;
  // New Supabase secret keys are opaque and must not be sent as Bearer JWTs.
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}
