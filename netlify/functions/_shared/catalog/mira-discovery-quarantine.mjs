import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  MIRA_OBSERVATION_FIELD_FAMILIES,
  MIRA_OBSERVATION_INTAKE_VERSION,
  MIRA_OBSERVATION_MAX_BATCH,
  MiraObservationIntakeError,
} from "./mira-observation-intake.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SECRET_TEXT_PATTERN = /(bearer\s+[a-z0-9._~+/=-]+|eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.|-----begin\s+(rsa |ec |openssh )?private key-----|(?:password|secret|token|api[_-]?key|authorization|cookie)\s*[:=])/i;

export const MIRA_DISCOVERY_QUARANTINE_CODES = Object.freeze([
  "SOURCE_MAPPING_MISSING",
  "TRUST_MAPPING_MISSING",
  "BRAND_MAPPING_MISSING",
  "JOB_MAPPING_MISSING",
  "PRODUCT_IDENTITY_MISSING",
  "SOURCE_POLICY_BLOCKED",
  "FIELD_FAMILY_BLOCKED",
  "SCOPE_INACTIVE",
  "SCOPE_MISMATCH",
  "CANONICAL_STAGING_BLOCKED",
]);

const QUARANTINE_CODES = new Set(MIRA_DISCOVERY_QUARANTINE_CODES);

function fail(code, message, details = {}) {
  throw new MiraObservationIntakeError(code, message, details);
}

function text(value) {
  return String(value ?? "").trim();
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function privateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] >= 224;
}

function publicHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    fail("INVALID_EVIDENCE_URL", `${label} must be a public HTTPS URL`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")
    || isIP(hostname) === 6 || privateIpv4(hostname)) {
    fail("INVALID_EVIDENCE_URL", `${label} must use a public HTTPS origin without credentials or a custom port`);
  }
  return url.href;
}

function safePayload(value, path = "evidence_payload", depth = 0) {
  if (depth > 6) fail("BOUND_EXCEEDED", `${path} is too deeply nested`);
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length > 12_000 || SECRET_TEXT_PATTERN.test(value)) fail("UNSAFE_EVIDENCE", `${path} contains secret-like or oversized text`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail("BOUND_EXCEEDED", `${path} contains too many items`);
    value.forEach((item, index) => safePayload(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 100) fail("BOUND_EXCEEDED", `${path} contains too many keys`);
    for (const [key, item] of entries) {
      if (/password|passcode|secret|token|authorization|cookie|credential|private[_-]?key|api[_-]?key/i.test(key)) {
        fail("UNSAFE_EVIDENCE", `${path}.${key} is forbidden`);
      }
      safePayload(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value !== "number" && typeof value !== "boolean") fail("UNSAFE_EVIDENCE", `${path} contains an unsupported value`);
}

function bounded(value, max, label, required = true) {
  const result = text(value);
  if (required && !result) fail("INVALID_DISCOVERY_OBSERVATION", `${label} is required`);
  if (result.length > max) fail("BOUND_EXCEEDED", `${label} exceeds ${max} characters`);
  if (SECRET_TEXT_PATTERN.test(result)) fail("UNSAFE_EVIDENCE", `${label} contains secret-like text`);
  return result;
}

export function quarantineReasonForResultIntake(resultIntake) {
  if (text(resultIntake?.sourceKey).toLowerCase() === "unresolved") return "SOURCE_MAPPING_MISSING";
  if (text(resultIntake?.brand).toLowerCase() === "unresolved") return "BRAND_MAPPING_MISSING";
  if ((resultIntake?.observations ?? []).some((item) => !text(item?.product_code) || !text(item?.normalized_code))) {
    return "PRODUCT_IDENTITY_MISSING";
  }
  return null;
}

export function isMiraQuarantineEligibleError(error) {
  return error instanceof MiraObservationIntakeError && QUARANTINE_CODES.has(text(error.code));
}

export function normalizeMiraDiscoveryQuarantineBatch(resultIntake) {
  if (!resultIntake || typeof resultIntake !== "object" || Array.isArray(resultIntake)) {
    fail("INVALID_DISCOVERY_BATCH", "MIRA discovery intake must be an object");
  }
  const sourceKey = bounded(resultIntake.sourceKey, 120, "sourceKey").toLowerCase();
  const brand = bounded(resultIntake.brand, 120, "brand");
  const observations = resultIntake.observations;
  if (!Array.isArray(observations) || observations.length < 1 || observations.length > MIRA_OBSERVATION_MAX_BATCH) {
    fail("BOUND_EXCEEDED", `MIRA discovery observations must contain 1-${MIRA_OBSERVATION_MAX_BATCH} items`);
  }
  const normalized = observations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.writeDisposition !== "observation-staging-only") {
      fail("WRITE_DISPOSITION_BLOCKED", `Observation ${index + 1} must remain observation-staging-only`);
    }
    const fieldFamily = bounded(item.field_family, 80, `observations[${index}].field_family`);
    const fieldName = bounded(item.field_name, 160, `observations[${index}].field_name`);
    if (!MIRA_OBSERVATION_FIELD_FAMILIES.includes(fieldFamily) || !FIELD_NAME_PATTERN.test(fieldName)) {
      fail("INVALID_DISCOVERY_OBSERVATION", `Observation ${index + 1} field is invalid`);
    }
    const productCode = bounded(item.product_code, 300, `observations[${index}].product_code`, false);
    const normalizedCode = bounded(item.normalized_code, 300, `observations[${index}].normalized_code`, false);
    const externalProductRef = bounded(item.external_product_ref, 300, `observations[${index}].external_product_ref`, false);
    if (!productCode && !normalizedCode && !externalProductRef) fail("PRODUCT_IDENTITY_MISSING", `Observation ${index + 1} has no source product identity`);
    const normalizedValue = bounded(item.normalized_value, 12_000, `observations[${index}].normalized_value`);
    if (fieldFamily === "ean_reference" && !/^(?:\d{8}|\d{12,14})$/.test(normalizedValue)) fail("INVALID_EAN", `Observation ${index + 1} EAN/GTIN is invalid`);
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail("INVALID_CONFIDENCE", `Observation ${index + 1} confidence is invalid`);
    const observedAt = new Date(text(item.observed_at));
    if (Number.isNaN(observedAt.valueOf())) fail("INVALID_TIMESTAMP", `Observation ${index + 1} observed_at is invalid`);
    const evidencePayload = item.evidence_payload ?? {};
    safePayload(evidencePayload);
    if (jsonBytes(evidencePayload) > 16_384) fail("BOUND_EXCEEDED", `Observation ${index + 1} evidence_payload is too large`);
    const evidenceHash = bounded(item.evidence_hash, 64, `observations[${index}].evidence_hash`, false).toLowerCase();
    if (evidenceHash && !SHA256_PATTERN.test(evidenceHash)) fail("INVALID_EVIDENCE_HASH", `Observation ${index + 1} evidence_hash is invalid`);
    return {
      ...(productCode ? { product_code: productCode } : {}),
      ...(normalizedCode ? { normalized_code: normalizedCode } : {}),
      ...(externalProductRef ? { external_product_ref: externalProductRef } : {}),
      field_family: fieldFamily,
      field_name: fieldName,
      raw_value: bounded(item.raw_value, 12_000, `observations[${index}].raw_value`),
      normalized_value: normalizedValue,
      evidence_reference: bounded(item.evidence_reference, 2_000, `observations[${index}].evidence_reference`),
      evidence_url: publicHttpsUrl(item.evidence_url, `observations[${index}].evidence_url`),
      ...(evidenceHash ? { evidence_hash: evidenceHash } : {}),
      evidence_payload: evidencePayload,
      confidence,
      observed_at: observedAt.toISOString(),
      writeDisposition: "observation-staging-only",
    };
  });
  return { protocolVersion: MIRA_OBSERVATION_INTAKE_VERSION, sourceKey, brand, observations: normalized };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function postRpc({ supabaseUrl, serviceRoleKey, args, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(new URL("/rest/v1/rpc/ingest_mira_catalog_discovery_batch", supabaseUrl), {
      method: "POST",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) fail("DISCOVERY_QUARANTINE_RPC_FAILED", `MIRA discovery quarantine RPC failed (${response.status})`, { status: response.status });
    return payload;
  } catch (error) {
    if (error instanceof MiraObservationIntakeError) throw error;
    if (error?.name === "AbortError") fail("DISCOVERY_QUARANTINE_TIMEOUT", "MIRA discovery quarantine timed out");
    fail("DISCOVERY_QUARANTINE_NETWORK_ERROR", "MIRA discovery quarantine could not be reached");
  } finally {
    clearTimeout(timeout);
  }
}

export async function stageMiraDiscoveryQuarantine({
  supabaseUrl,
  serviceRoleKey,
  organizationId,
  missionId,
  resultIntake,
  reason,
  fetchImpl = fetch,
}) {
  if (!UUID_PATTERN.test(text(organizationId)) || !UUID_PATTERN.test(text(missionId))) fail("INVALID_SCOPE", "MIRA discovery quarantine requires organization and mission UUIDs");
  if (!QUARANTINE_CODES.has(text(reason))) fail("INVALID_QUARANTINE_REASON", "MIRA discovery quarantine reason is not allowed");
  const normalized = normalizeMiraDiscoveryQuarantineBatch(resultIntake);
  const canonical = JSON.stringify({ sourceKey: normalized.sourceKey, brand: normalized.brand, reason, observations: normalized.observations });
  const receipt = await postRpc({
    supabaseUrl,
    serviceRoleKey,
    fetchImpl,
    args: {
      input_organization_id: organizationId,
      input_mission_id: missionId,
      input_source_key: normalized.sourceKey,
      input_brand: normalized.brand,
      input_idempotency_key: `mira:${missionId}:discovery-quarantine:v1`,
      input_request_fingerprint: sha256(canonical),
      input_quarantine_reason: reason,
      input_observations: normalized.observations,
      input_metadata: { mission_id: missionId, intake_protocol: MIRA_OBSERVATION_INTAKE_VERSION },
    },
  });
  return {
    protocolVersion: MIRA_OBSERVATION_INTAKE_VERSION,
    status: "quarantined",
    intakeStatus: text(receipt?.status) || "completed_with_warnings",
    reviewStatus: text(receipt?.review_status) || "pending_scope_review",
    reason: text(receipt?.quarantine_reason) || reason,
    quarantinedCount: Number.isInteger(receipt?.quarantined_count) ? receipt.quarantined_count : 0,
    dedupedCount: Number.isInteger(receipt?.deduped_count) ? receipt.deduped_count : 0,
    idempotent: receipt?.idempotent === true,
    catalogProductsWritten: 0,
    applyPerformed: false,
  };
}
