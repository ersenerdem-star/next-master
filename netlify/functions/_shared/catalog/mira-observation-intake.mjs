import { createHash } from "node:crypto";

/**
 * MIRA -> Next-Master Catalog observation-only handoff.
 *
 * This module is intentionally server-side. It prepares a typed candidate
 * batch and calls the service-role-only intake RPC. It never writes to
 * catalog_products and exposes no browser/client helper.
 */

export const MIRA_OBSERVATION_INTAKE_VERSION = "mira-observation-intake.v1";
export const MIRA_OBSERVATION_MAX_BATCH = 100;
export const MIRA_OBSERVATION_MAX_TEXT = 12_000;
export const MIRA_OBSERVATION_MAX_EVIDENCE_REFERENCE = 2_000;
export const MIRA_OBSERVATION_MAX_EVIDENCE_PAYLOAD_BYTES = 16_384;

export const MIRA_OBSERVATION_FIELD_FAMILIES = Object.freeze([
  "image_reference",
  "supplemental_description",
  "oem_reference",
  "technical_specification",
  "ean_reference",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SECRET_KEY_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|password|token|access[_-]?token|id[_-]?token|refresh[_-]?token|secret|client[_-]?secret|private[_-]?key|api[_-]?key|credential)$/i;
const SECRET_TEXT_PATTERN =
  /(bearer\s+[a-z0-9._~+/=-]+|eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.|-----begin\s+(rsa |ec |openssh )?private key-----|(?:password|secret|token|api[_-]?key|authorization|cookie)\s*[:=])/i;

export class MiraObservationIntakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MiraObservationIntakeError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new MiraObservationIntakeError(code, message, details);
}

function text(value) {
  return String(value ?? "").trim();
}

function isUuid(value) {
  return UUID_PATTERN.test(text(value));
}

function requiredUuid(name, value) {
  if (!isUuid(value)) fail("INVALID_SCOPE", `${name} must be a UUID`);
  return text(value);
}

function boundedText(name, value, max, required = true) {
  const normalized = text(value);
  if (required && !normalized) fail("INVALID_CANDIDATE", `${name} is required`);
  if (normalized.length > max) {
    fail("BOUND_EXCEEDED", `${name} exceeds the ${max}-character bound`, {
      field: name,
      max,
    });
  }
  return normalized;
}

function assertSafeEvidencePayload(value, path = "evidence_payload", depth = 0) {
  if (depth > 6) fail("BOUND_EXCEEDED", `${path} is too deeply nested`);
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length > MIRA_OBSERVATION_MAX_TEXT || SECRET_TEXT_PATTERN.test(value)) {
      fail("UNSAFE_EVIDENCE", `${path} contains disallowed or oversized text`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) fail("BOUND_EXCEEDED", `${path} contains too many items`);
    value.forEach((item, index) => assertSafeEvidencePayload(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 100) fail("BOUND_EXCEEDED", `${path} contains too many keys`);
    for (const [key, item] of entries) {
      if (SECRET_KEY_PATTERN.test(key)) fail("UNSAFE_EVIDENCE", `${path}.${key} is not allowed`);
      assertSafeEvidencePayload(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value !== "number" && typeof value !== "boolean") {
    fail("UNSAFE_EVIDENCE", `${path} contains an unsupported value`);
  }
}

function evidencePayloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
}

function sourceIsApproved(source) {
  if (!source || source.is_active !== true) return false;
  if (text(source.license_posture).toLowerCase() !== "allowed") return false;
  if (!["allowed", "not_applicable"].includes(text(source.robots_posture).toLowerCase())) return false;
  if (!["bounded", "restricted", "not_applicable"].includes(text(source.rate_limit_posture).toLowerCase())) return false;
  if (text(source.credential_boundary).toLowerCase() && text(source.credential_boundary).toLowerCase() !== "none") return false;
  const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  return metadata.automated_read_only_approved === true && metadata.internal_observation_allowed === true;
}

function requireScopeContext(input, context) {
  const source = context?.source;
  const trustProfile = context?.trustProfile;
  const job = context?.job;
  const brand = context?.brand;
  if (!source || !trustProfile || !job || !brand) {
    fail("SCOPE_CONTEXT_REQUIRED", "Server-side source, trust profile, job, and brand context are required");
  }
  if (text(source.organization_id) !== text(input.organization_id) || text(trustProfile.organization_id) !== text(input.organization_id) || text(job.organization_id) !== text(input.organization_id) || text(brand.organization_id) !== text(input.organization_id)) {
    fail("TENANT_MISMATCH", "Source, trust profile, job, and brand must belong to the supplied organization");
  }
  if (text(source.id) !== text(input.source_id) || text(trustProfile.source_id) !== text(input.source_id) || text(job.source_id) !== text(input.source_id) || text(job.trust_profile_id) !== text(input.trust_profile_id) || text(job.brand_id) !== text(input.brand_id) || text(brand.id) !== text(input.brand_id)) {
    fail("SCOPE_MISMATCH", "Source, trust profile, job, and brand do not describe one approved scope");
  }
  if (sourceIsApproved(source) === false) fail("SOURCE_POLICY_BLOCKED", "Source is not approved for automatic read-only observation");
  if (trustProfile.is_active !== true || job.status !== "active" || brand.is_active === false) {
    fail("SCOPE_INACTIVE", "Trust profile, job, and brand must be active");
  }
  return { source, trustProfile, job, brand };
}

function productIdentitySet(products) {
  if (!Array.isArray(products)) return null;
  return new Set(products.map((product) => `${text(product.brand_id)}|${text(product.normalized_code)}`));
}

function normalizeCandidate(candidate, index, scope, identitySet) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    fail("INVALID_CANDIDATE", `Observation ${index + 1} must be an object`, { index });
  }
  const normalizedCode = boundedText("normalized_code", candidate.normalized_code, 300);
  const productCode = boundedText("product_code", candidate.product_code, 300);
  const fieldFamily = boundedText("field_family", candidate.field_family, 80);
  if (!MIRA_OBSERVATION_FIELD_FAMILIES.includes(fieldFamily)) {
    fail("FIELD_FAMILY_BLOCKED", `Observation ${index + 1} uses an unsupported field family`, { index, fieldFamily });
  }
  const jobFamilies = Array.isArray(scope.job.allowed_field_families) ? scope.job.allowed_field_families : [];
  const trustFamilies = Array.isArray(scope.trustProfile.allowed_field_families) ? scope.trustProfile.allowed_field_families : [];
  if (!jobFamilies.includes(fieldFamily) || !trustFamilies.includes(fieldFamily)) {
    fail("FIELD_FAMILY_BLOCKED", `Observation ${index + 1} is outside the approved job/trust scope`, { index, fieldFamily });
  }
  if (identitySet && !identitySet.has(`${text(scope.brand.id)}|${normalizedCode}`)) {
    fail("PRODUCT_IDENTITY_MISSING", `Observation ${index + 1} product identity is not in the organization catalog`, { index, normalizedCode });
  }
  const evidenceUrl = boundedText("evidence_url", candidate.evidence_url, 2_000, false);
  if (evidenceUrl && !/^https:\/\/[^\s]+$/i.test(evidenceUrl)) fail("INVALID_EVIDENCE_URL", `Observation ${index + 1} evidence_url must use HTTPS`, { index });
  const confidence = candidate.confidence === undefined || candidate.confidence === null || candidate.confidence === "" ? 0.5 : Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail("INVALID_CONFIDENCE", `Observation ${index + 1} confidence must be between 0 and 1`, { index });
  const observedAt = candidate.observed_at ? new Date(candidate.observed_at) : new Date();
  if (Number.isNaN(observedAt.getTime())) fail("INVALID_TIMESTAMP", `Observation ${index + 1} observed_at is invalid`, { index });
  const evidencePayload = candidate.evidence_payload && typeof candidate.evidence_payload === "object" ? candidate.evidence_payload : {};
  assertSafeEvidencePayload(evidencePayload);
  if (evidencePayloadBytes(evidencePayload) > MIRA_OBSERVATION_MAX_EVIDENCE_PAYLOAD_BYTES) fail("BOUND_EXCEEDED", `Observation ${index + 1} evidence_payload is too large`, { index });
  const evidenceHash = boundedText("evidence_hash", candidate.evidence_hash, 128, false);
  if (evidenceHash && !SHA256_PATTERN.test(evidenceHash)) fail("INVALID_EVIDENCE_HASH", `Observation ${index + 1} evidence_hash must be SHA-256`, { index });
  const normalizedValue = boundedText("normalized_value", candidate.normalized_value, MIRA_OBSERVATION_MAX_TEXT);
  if (fieldFamily === "ean_reference" && !/^(?:\d{8}|\d{12,14})$/.test(normalizedValue)) {
    fail("INVALID_EAN", `Observation ${index + 1} EAN/GTIN must contain 8, 12, 13, or 14 digits`, { index });
  }
  return {
    product_code: productCode,
    normalized_code: normalizedCode,
    field_family: fieldFamily,
    field_name: boundedText("field_name", candidate.field_name, 160),
    raw_value: boundedText("raw_value", candidate.raw_value, MIRA_OBSERVATION_MAX_TEXT),
    normalized_value: normalizedValue,
    evidence_reference: boundedText("evidence_reference", candidate.evidence_reference, MIRA_OBSERVATION_MAX_EVIDENCE_REFERENCE),
    evidence_url: evidenceUrl || null,
    evidence_hash: evidenceHash || null,
    evidence_payload: evidencePayload,
    external_product_ref: boundedText("external_product_ref", candidate.external_product_ref, 300, false) || null,
    confidence,
    observed_at: observedAt.toISOString(),
  };
}

export function validateMiraObservationBatch(input, context = {}) {
  if (!input || typeof input !== "object") fail("INVALID_REQUEST", "MIRA intake request must be an object");
  const scopeInput = {
    organization_id: requiredUuid("organization_id", input.organization_id),
    source_id: requiredUuid("source_id", input.source_id),
    trust_profile_id: requiredUuid("trust_profile_id", input.trust_profile_id),
    job_id: requiredUuid("job_id", input.job_id),
    brand_id: requiredUuid("brand_id", input.brand_id),
  };
  const scope = requireScopeContext(scopeInput, context);
  const idempotencyKey = boundedText("idempotency_key", input.idempotency_key, 200);
  const requestFingerprint = boundedText("request_fingerprint", input.request_fingerprint, 256);
  if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > MIRA_OBSERVATION_MAX_BATCH) {
    fail("BOUND_EXCEEDED", `observations must contain 1-${MIRA_OBSERVATION_MAX_BATCH} items`);
  }
  const identitySet = productIdentitySet(context.products);
  const observations = input.observations.map((candidate, index) => normalizeCandidate(candidate, index, scope, identitySet));
  const canonical = observations.map((observation) => JSON.stringify(observation)).join("\n");
  const computedFingerprint = createHash("sha256").update(canonical).digest("hex");
  return {
    ...scopeInput,
    idempotency_key: idempotencyKey,
    request_fingerprint: requestFingerprint,
    observations,
    metadata: {
      ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
      mira_intake_protocol: MIRA_OBSERVATION_INTAKE_VERSION,
      candidate_payload_fingerprint: computedFingerprint,
      catalog_products_written: 0,
      apply_performed: false,
    },
    actor_id: isUuid(input.actor_id) ? text(input.actor_id) : null,
  };
}

export function buildMiraObservationRpcArgs(request) {
  return {
    input_organization_id: request.organization_id,
    input_source_id: request.source_id,
    input_trust_profile_id: request.trust_profile_id,
    input_job_id: request.job_id,
    input_brand_id: request.brand_id,
    input_idempotency_key: request.idempotency_key,
    input_request_fingerprint: request.request_fingerprint,
    input_observations: request.observations,
    input_actor_id: request.actor_id,
    input_metadata: request.metadata,
  };
}

async function postRpc(supabaseUrl, serviceRoleKey, functionName, args, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL(`/rest/v1/rpc/${functionName}`, supabaseUrl), {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) fail("RPC_FAILED", `MIRA observation intake RPC failed (${response.status})`, { response: body });
    return body;
  } catch (error) {
    if (error?.name === "AbortError") fail("RPC_TIMEOUT", `MIRA observation intake RPC timed out after ${timeoutMs}ms`);
    if (error instanceof MiraObservationIntakeError) throw error;
    fail("RPC_NETWORK_ERROR", "MIRA observation intake RPC could not be reached", { cause: String(error?.message || error) });
  } finally {
    clearTimeout(timeout);
  }
}

export function createMiraObservationIntakeClient({ supabaseUrl, serviceRoleKey, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error("MIRA intake client requires server-side Supabase URL and service-role key");
  return {
    async ingest(input, context) {
      const request = validateMiraObservationBatch(input, context);
      return postRpc(supabaseUrl, serviceRoleKey, "ingest_mira_catalog_observation_batch", buildMiraObservationRpcArgs(request), timeoutMs, fetchImpl);
    },
  };
}
