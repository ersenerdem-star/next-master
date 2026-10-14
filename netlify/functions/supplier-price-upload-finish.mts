// Short authenticated acceptance, NEVER file transfer/parsing/publication.
import { json as responseJson } from "./_shared/http.mts";
import { resolveSupplierUpgradeAdmin, supplierUpgradeFetch, supplierUpgradeServiceHeaders,
  SupplierUpgradeError, supplierUuid } from "./_shared/supplier-upgrade-auth.mts";
import {supplierVerifiedUploadTargetEnabled,supplierUploadTargetPauseMessage} from './_shared/supplier-upload-target.mts';

export default async function handler(req: Request) {
  const json = (data: unknown, status = 200) => responseJson(data, status, {"Cache-Control":"no-store"});
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if(!supplierVerifiedUploadTargetEnabled(req.url)) return json({error:supplierUploadTargetPauseMessage},503);
  const env = (name: string) => Netlify.env.get(name);
  if (env("SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED") !== "true")
    return json({ error: "Verified upload completion is not enabled." }, 503);
  const url = env("SUPABASE_URL")?.replace(/\/$/, ""), anon = env("SUPABASE_ANON_KEY"), service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !/^https:\/\/[^/?#@]+$/.test(url) || !anon || !service) return json({ error: "Upload verification is unavailable." }, 503);
  let submitted = false;
  let sessionId: string | undefined;
  try {
    // Enforce a streaming budget even with absent/forged Content-Length.
    const reader = req.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (!reader) return json({ error: "A sessionId is required." }, 400);
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 1024) { await reader.cancel(); return json({ error: "Request too large." }, 413); }
      chunks.push(value);
    } } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json({ error: "Invalid request." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !supplierUuid((body as {sessionId?: unknown}).sessionId))
      return json({ error: "Provide only the admitted upload sessionId." }, 400);
    sessionId = (body as {sessionId: string}).sessionId;
    const caller = await resolveSupplierUpgradeAdmin(req, url, anon, service);
    submitted = true;
    const {response, data} = await supplierUpgradeFetch(`${url}/rest/v1/rpc/request_supplier_price_upload_verification`, {
      method: "POST", headers: supplierUpgradeServiceHeaders(service), body: JSON.stringify({
        input_session_id: sessionId, input_actor_id: caller.actorId, input_organization_id: caller.organizationId,
        input_auth_session_id: caller.authSessionId, input_token_iat: caller.issuedAt, input_token_exp: caller.expiresAt,
      }),
    });
    if (!response.ok) {
      const code = String((data as {message?: unknown})?.message || "");
      if (/UPLOAD_REQUEST_SESSION_DENIED/.test(code)) return json({error:"Sign in again to continue."},401);
      if (/UPLOAD_REQUEST_ACTOR_DENIED|UPLOAD_VERIFY_SCOPE|UPLOAD_VERIFY_ACTOR/.test(code)) return json({error:"You cannot complete this upload."},403);
      if (/UPLOAD_VERIFY_|UPLOAD_REQUEST_BINDING/.test(code)) return json({error:"The admitted file is not ready for verification. Check upload status before retrying.",sessionId},409);
      throw Error("Completion acceptance unconfirmed");
    }
    const r = data as Record<string, unknown>;
    if (!r || r.session_id !== sessionId || !supplierUuid(r.request_id) || !supplierUuid(r.release_id)
      || !["queued", "verifying", "verified", "failed"].includes(String(r.status)) || r.published !== false)
      throw Error("Invalid acceptance receipt");
    return json({requestId:r.request_id,sessionId,releaseId:r.release_id,status:r.status,published:false,
      message:r.status === "verified" ? "Source verified. Price publication is still pending."
        : r.status === "failed" ? "Source verification needs attention. No prices were published."
        : "Source verification requested. Prices are not active yet."}, r.status === "queued" || r.status === "verifying" ? 202 : 200);
  } catch (error) {
    if (error instanceof SupplierUpgradeError) return json({error:error.message},error.status);
    return json({error:submitted ? "Verification acceptance could not be confirmed. Check this same upload session before retrying."
      : "Upload verification is unavailable. No action was submitted.", ...(sessionId ? {sessionId} : {}),
      outcome:submitted ? "unknown" : "not_submitted"},503);
  }
}
export const config = { path: "/api/supplier-price-upload-finish" };
