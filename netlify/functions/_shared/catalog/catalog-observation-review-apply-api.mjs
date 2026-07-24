import { isAdminLikeRole } from "../roles.mts";

export const APPLY_COMMAND_SCHEMA_VERSION = "catalog-observation-review-apply.v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_FINGERPRINT_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const APPLY_FIELDS = new Set([
  "reviewItemId",
  "decisionEventId",
  "expectedDecisionVersion",
  "expectedReviewItemFingerprint",
  "expectedProductTargetFingerprint",
  "idempotencyKey",
]);

export class CatalogObservationApplyApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function parseJsonApplyCommandBody(req) {
  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_BODY_TOO_LARGE", "Request body is too large.");
  }
  try {
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
    return body;
  } catch {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function validateApplyCommand(input) {
  assertKnownFields(input);
  return {
    reviewItemId: requiredReviewItemId(input.reviewItemId),
    decisionEventId: requiredUuid(input.decisionEventId, "decisionEventId"),
    expectedDecisionVersion: requiredExpectedVersion(input.expectedDecisionVersion),
    expectedReviewItemFingerprint: requiredFingerprint(input.expectedReviewItemFingerprint, "expectedReviewItemFingerprint"),
    expectedProductTargetFingerprint: requiredFingerprint(input.expectedProductTargetFingerprint, "expectedProductTargetFingerprint"),
    idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
  };
}

export function authorizeApplyCaller(caller) {
  if (!caller || !isAdminLikeRole(caller.role)) {
    throw new CatalogObservationApplyApiError(403, "CATALOG_REVIEW_APPLY_FORBIDDEN", "Forbidden");
  }
}

export function createCatalogObservationApplyCommandDb({ supabaseUrl, supabaseAnonKey, accessToken }) {
  return {
    async applyImage(input) {
      return callRpc({
        supabaseUrl,
        supabaseAnonKey,
        accessToken,
        rpcName: "apply_catalog_observation_review_image",
        body: {
          input_review_item_id: input.reviewItemId,
          input_decision_event_id: input.decisionEventId,
          input_expected_decision_version: input.expectedDecisionVersion,
          input_expected_review_item_fingerprint: input.expectedReviewItemFingerprint,
          input_expected_product_target_fingerprint: input.expectedProductTargetFingerprint,
          input_idempotency_key: input.idempotencyKey,
        },
      });
    },
  };
}

export function serializeApplyResult(result) {
  const event = normalizeObject(result?.event);
  return {
    schema_version: APPLY_COMMAND_SCHEMA_VERSION,
    success: true,
    action: "apply_canonical_image",
    replayed: Boolean(result?.idempotency_replay),
    event: {
      apply_event_id: nullableString(event.apply_event_id),
      review_item_id: nullableString(event.review_item_id),
      decision_event_id: nullableString(event.decision_event_id),
      observation_id: nullableString(event.observation_id),
      catalog_product_id: nullableString(event.catalog_product_id),
      field_family: nullableString(event.field_family),
      target_field: nullableString(event.target_field),
      decision_version: numberValue(event.decision_version),
      apply_authorizer_user_id: nullableString(event.apply_authorizer_user_id),
      outcome: nullableString(event.outcome),
      applied_at: nullableString(event.created_at),
      downstream_revalidation_requested_at: nullableString(event.downstream_revalidation_requested_at),
    },
  };
}

export function serializeApplyError(error) {
  if (error instanceof CatalogObservationApplyApiError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  const code = extractDbCode(String(error?.message || error || ""));
  if (code) return { status: statusForDbCode(code), body: { error: safeMessageForDbCode(code), code } };
  return {
    status: 500,
    body: {
      error: "Catalog image Apply could not be completed right now.",
      code: "CATALOG_REVIEW_APPLY_INTERNAL_ERROR",
    },
  };
}

async function callRpc({ supabaseUrl, supabaseAnonKey, accessToken, rpcName, body }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.message || data?.error || `RPC request failed: ${response.status}`));
  return data;
}

function assertKnownFields(input) {
  for (const key of Object.keys(input)) {
    if (!APPLY_FIELDS.has(key)) {
      throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_UNKNOWN_FIELD", `Unsupported field: ${key}`);
    }
  }
}

function requiredReviewItemId(value) {
  const text = requiredString(value, "reviewItemId");
  const parts = text.split(":");
  if (parts.length !== 4 || !isUuid(parts[0]) || !isUuid(parts[1]) || !isUuid(parts[2]) || parts[3] !== "image_reference") {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_INVALID_REVIEW_ITEM_ID", "reviewItemId is invalid.");
  }
  return text;
}

function requiredUuid(value, field) {
  const text = requiredString(value, field);
  if (!isUuid(text)) throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_INVALID_UUID", `${field} must be a UUID.`);
  return text;
}

function requiredExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_INVALID_EXPECTED_VERSION", "expectedDecisionVersion must be a positive integer.");
  }
  return value;
}

function requiredFingerprint(value, field) {
  const text = requiredString(value, field);
  if (text.length > MAX_FINGERPRINT_LENGTH) {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_INVALID_FINGERPRINT", `${field} is too long.`);
  }
  return text;
}

function requiredIdempotencyKey(value) {
  const text = requiredString(value, "idempotencyKey");
  if (text.length > MAX_IDEMPOTENCY_KEY_LENGTH || !SAFE_IDEMPOTENCY_KEY_PATTERN.test(text)) {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_INVALID_IDEMPOTENCY_KEY", "idempotencyKey is invalid.");
  }
  return text;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CatalogObservationApplyApiError(400, "CATALOG_REVIEW_APPLY_MISSING_REQUIRED_FIELD", `${field} is required.`);
  }
  return value.trim();
}

function isUuid(value) {
  return UUID_PATTERN.test(value);
}

function extractDbCode(message) {
  return message.match(/(CATALOG_REVIEW_APPLY_[A-Z0-9_]+)/)?.[1] || "";
}

function statusForDbCode(code) {
  if (code === "CATALOG_REVIEW_APPLY_UNAUTHORIZED" || code === "CATALOG_REVIEW_APPLY_ORGANIZATION_MISMATCH" || code === "CATALOG_REVIEW_APPLY_AUTHORIZATION_BLOCKED") return 403;
  if (code === "CATALOG_REVIEW_APPLY_ITEM_MISSING") return 404;
  return 409;
}

function safeMessageForDbCode(code) {
  if (code === "CATALOG_REVIEW_APPLY_ITEM_MISSING") return "Review item was not found.";
  if (code === "CATALOG_REVIEW_APPLY_UNAUTHORIZED" || code === "CATALOG_REVIEW_APPLY_ORGANIZATION_MISMATCH" || code === "CATALOG_REVIEW_APPLY_AUTHORIZATION_BLOCKED") return "Forbidden";
  if (code === "CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH") return "Idempotency key was reused with a different Apply command.";
  return "This review item changed or is no longer eligible. Reload the latest state before applying.";
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
