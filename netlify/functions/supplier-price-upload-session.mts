import type { Config, Context } from "@netlify/functions";
import { createHash } from "node:crypto";
import { getAppAuthStatus } from "./_shared/app-auth.mts";
import { json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { canAccessOperationsModules, isAdminLikeRole } from "./_shared/roles.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import { resolveSupplierUpgradeAdmin, supplierUpgradeServiceHeaders, SupplierUpgradeError } from "./_shared/supplier-upgrade-auth.mts";
import { supplierVerifiedUploadTargetEnabled, supplierUploadTargetPauseMessage } from './_shared/supplier-upload-target.mts';

type SessionRow = {
  session_id?: string;
  release_id?: string;
  status?: string;
  storage_bucket?: string;
  storage_object_path?: string;
  total_bytes?: number;
  uploaded_bytes?: number;
  expires_at?: string;
};

function text(value: unknown, max = 240) {
  if (value == null) return "";
  if (typeof value !== "string" || value.trim().length > max) return null;
  return value.trim();
}

const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!supplierVerifiedUploadTargetEnabled(req.url)) return json({error:supplierUploadTargetPauseMessage},503);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }
  // Explicit rollout boundary. The browser/TUS consumer and dedicated
  // verifier must be enabled together; legacy CSV import stays untouched.
  const verifiedAdmissionEnabled = Netlify.env.get("SUPPLIER_PRICE_UPLOAD_VERIFIED_ADMISSION_ENABLED") === "true";

  let attemptedKey: string | undefined;
  const unknownOutcome = (status: number) => json({
    error: "We could not confirm whether the upload session was created. Check upload status, then retry the same request and upload key; do not start a different upload.",
    outcome: "unknown",
    idempotencyKey: attemptedKey,
  }, status);
  try {
    const upgradeCaller = await resolveSupplierUpgradeAdmin(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    const caller = { id: upgradeCaller.actorId, organizationId: upgradeCaller.organizationId, role: "admin", department: "operations", permissions: { "supplier_prices.manage": true } };
    const explicitSupplierPermission = Object.prototype.hasOwnProperty.call(caller.permissions || {}, "supplier_prices.manage");
    const hasSupplierPermission = explicitSupplierPermission
      ? caller.permissions["supplier_prices.manage"] === true || isAdminLikeRole(caller.role, caller.department)
      : canAccessOperationsModules(caller.role, caller.department, caller.permissions);
    if (!hasSupplierPermission) {
      return json({ error: "Supplier price upload is not enabled for this user." }, 403);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "A valid upload request is required." }, 400);
    }
    const supplierId = text(body?.supplierId, 80);
    const brandId = text(body?.brandId, 80);
    const suppliedFileName = text(body?.fileName, 180);
    const suppliedContentType = text(body?.contentType, 160);
    const suppliedChecksum = text(body?.checksumSha256, 64);
    const suppliedMode = text(body?.mode, 20);
    const suppliedDate = text(body?.sourceDate, 10);
    const suppliedKey = text(body?.idempotencyKey, 200);
    if ([supplierId, brandId, suppliedFileName, suppliedContentType, suppliedChecksum, suppliedMode, suppliedDate, suppliedKey].includes(null)) {
      return json({ error: "Upload fields must be text and within their size limits." }, 400);
    }
    const fileName = suppliedFileName || "supplier-prices.csv";
    const contentType = suppliedContentType || "application/octet-stream";
    const checksumSha256 = (suppliedChecksum || "").toLowerCase();
    const mode = (suppliedMode || "replace").toLowerCase();
    const sourceDate = suppliedDate || null;
    const totalBytes = body?.totalBytes;
    if (!uuid(supplierId) || !uuid(brandId) || !/^[0-9a-f]{64}$/.test(checksumSha256)) {
      return json({ error: "supplierId, brandId and a SHA-256 checksum are required." }, 400);
    }
    if (typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > 1073741824) {
      return json({ error: "File size must be between 1 byte and 1 GiB." }, 400);
    }
    if (mode !== "replace") {
      return json({ error: "Verified supplier upload requires a complete replacement price list. Merge is not supported." }, 400);
    }
    if (sourceDate && !validDate(sourceDate)) return json({ error: "sourceDate must be a valid YYYY-MM-DD date." }, 400);
    if (suppliedKey && suppliedKey.length < 8) return json({ error: "Upload key must contain 8 to 200 characters." }, 400);
    const canonicalFileName = fileName.replace(/[^A-Za-z0-9._-]+/g, "_");
    if (canonicalFileName === "." || canonicalFileName === "..") return json({ error: "Select a valid file name." }, 400);
    const idempotencyKey = suppliedKey || "upload-v2:" + createHash("sha256").update(JSON.stringify([
      caller.organizationId, caller.id, supplierId?.toLowerCase(), brandId?.toLowerCase(),
      checksumSha256, totalBytes, canonicalFileName, contentType, mode, sourceDate,
    ])).digest("hex");
    attemptedKey = idempotencyKey;

    const rpcName = "start_supplier_price_verified_upload_session";
    const rows = await sendJson<SessionRow[] | SessionRow>(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
      method: "POST",
      headers: verifiedAdmissionEnabled ? supplierUpgradeServiceHeaders(serviceRoleKey) : serviceRoleHeaders(serviceRoleKey),
      body: JSON.stringify({
        input_organization_id: caller.organizationId,
        input_actor_id: caller.id,
        input_supplier_id: supplierId,
        input_brand_id: brandId,
        input_file_name: fileName,
        input_content_type: contentType,
        input_total_bytes: totalBytes,
        input_checksum_sha256: checksumSha256,
        input_idempotency_key: idempotencyKey,
        input_mode: mode,
        input_source_date: sourceDate,
      }),
      timeoutMs: 8_000,
    });
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : (!Array.isArray(rows) ? rows : undefined);
    if (!row || !uuid(row.session_id) || !uuid(row.release_id)
      || !["created", "uploading", "uploaded"].includes(row.status || "")
      || row.storage_bucket !== "supplier-price-imports"
      || row.storage_object_path !== `${caller.organizationId}/supplier-price/${row.session_id}/${canonicalFileName}`
      || row.total_bytes !== totalBytes || !Number.isSafeInteger(row.uploaded_bytes)
      || row.uploaded_bytes! < 0 || row.uploaded_bytes! > totalBytes
      || !Number.isFinite(Date.parse(row.expires_at || "")) || Date.parse(row.expires_at!) <= Date.now()) {
      return unknownOutcome(502);
    }
    return json({
      ok: true,
      data: {
        session_id: row.session_id,
        release_id: row.release_id,
        status: row.status,
        storage_bucket: row.storage_bucket,
        storage_object_path: row.storage_object_path,
        total_bytes: row.total_bytes,
        uploaded_bytes: row.uploaded_bytes,
        expires_at: row.expires_at,
        resumable: row.status !== "uploaded",
        upload_endpoint: `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/upload/resumable`,
        verification_required: verifiedAdmissionEnabled,
      },
    });
  } catch (error) {
    if (error instanceof SupplierUpgradeError) return json({ error: error.message }, error.status);
    const message = error instanceof Error ? error.message : String(error);
    const conflicts = [
      ["UPLOAD_REQUEST_CONFLICT", "This upload key is already assigned to a different request. Check the existing upload before continuing."],
      ["UPLOAD_SOURCE_ALREADY_REGISTERED", "This file is already registered for this supplier and brand. Check the existing upload before continuing."],
      ["UPLOAD_SESSION_NOT_RESUMABLE", "This upload session is closed or expired. Check its status before starting again."],
      ["UPLOAD_SESSION_INTEGRITY_CONFLICT", "This upload session needs review. Check its status before continuing."],
    ];
    const conflict = conflicts.find(([code]) => message.includes(code));
    if (conflict) return json({ error: conflict[1], code: conflict[0], outcome: "rejected" }, 409);
    if (/^(Supplier|Brand) is not in this organization$/.test(message)) {
      return json({ error: "Select a supplier and brand available to your organization.", outcome: "rejected" }, 403);
    }
    if (attemptedKey) return unknownOutcome(503);
    return json({ error: sanitizeUserFacingError(error, "Supplier upload session could not be started.") }, getAppAuthStatus(error) || 503);
  }
};

export const config: Config = {
  path: "/api/supplier-price-upload-session",
  method: "POST",
};
