import { isAdminLikeRole } from "../roles.mts";

export const DECISION_COMMAND_SCHEMA_VERSION = "catalog-observation-review-decision.v1";
export const DECISION_TYPES = Object.freeze([
  "ACCEPT_RECOMMENDATION",
  "REJECT_RECOMMENDATION",
  "DEFER",
  "REQUEST_MORE_EVIDENCE",
]);
export const DECISION_REASON_CODES = Object.freeze({
  ACCEPT_RECOMMENDATION: [
    "EVIDENCE_SUFFICIENT",
    "VERIFIED_AGAINST_CURRENT_PRODUCT",
    "TRUSTED_OFFICIAL_SOURCE",
  ],
  REJECT_RECOMMENDATION: [
    "INCORRECT_OBSERVATION",
    "INSUFFICIENT_EVIDENCE",
    "CONFLICTS_WITH_CANONICAL_DATA",
    "WRONG_PRODUCT_MATCH",
    "FIELD_NOT_APPLICABLE",
  ],
  DEFER: [
    "NEEDS_SECOND_REVIEW",
    "WAITING_FOR_SOURCE_CONFIRMATION",
    "TEMPORARY_REVIEW_HOLD",
  ],
  REQUEST_MORE_EVIDENCE: [
    "MISSING_PRIMARY_SOURCE",
    "CONFLICTING_SOURCES",
    "LOW_CONFIDENCE",
    "INCOMPLETE_PRODUCT_MATCH",
  ],
});
export const REVERSAL_REASON_CODES = Object.freeze([
  "DECISION_ENTERED_IN_ERROR",
  "NEW_EVIDENCE_RECEIVED",
  "RECOMMENDATION_CHANGED",
  "PRODUCT_STATE_CHANGED",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_NOTE_LENGTH = 2000;
const MAX_FINGERPRINT_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const DECISION_FIELDS = new Set([
  "reviewItemId",
  "decisionType",
  "reasonCode",
  "reviewerNote",
  "expectedDecisionVersion",
  "expectedRecommendationFingerprint",
  "expectedReviewItemFingerprint",
  "expectedProductTargetFingerprint",
  "idempotencyKey",
]);
const REVERSAL_FIELDS = new Set([
  "reviewItemId",
  "targetDecisionEventId",
  "reasonCode",
  "reviewerNote",
  "expectedDecisionVersion",
  "idempotencyKey",
]);

export class CatalogObservationDecisionApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "CatalogObservationDecisionApiError";
    this.status = status;
    this.code = code;
  }
}

export async function parseJsonCommandBody(req) {
  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_BODY_TOO_LARGE", "Request body is too large.");
  }
  try {
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("body must be an object");
    }
    return body;
  } catch {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_JSON", "Request body must be valid JSON.");
  }
}

export function validateDecisionCommand(input) {
  assertKnownFields(input, DECISION_FIELDS);
  const reviewItemId = requiredReviewItemId(input.reviewItemId);
  const decisionType = requiredEnum(input.decisionType, DECISION_TYPES, "decisionType", "CATALOG_REVIEW_UNSUPPORTED_DECISION");
  const reasonCode = requiredEnum(input.reasonCode, DECISION_REASON_CODES[decisionType], "reasonCode", "CATALOG_REVIEW_UNSUPPORTED_REASON");
  return {
    reviewItemId,
    decisionType,
    reasonCode,
    reviewerNote: optionalNote(input.reviewerNote),
    expectedDecisionVersion: requiredExpectedVersion(input.expectedDecisionVersion),
    expectedRecommendationFingerprint: requiredFingerprint(input.expectedRecommendationFingerprint, "expectedRecommendationFingerprint"),
    expectedReviewItemFingerprint: requiredFingerprint(input.expectedReviewItemFingerprint, "expectedReviewItemFingerprint"),
    expectedProductTargetFingerprint: requiredFingerprint(input.expectedProductTargetFingerprint, "expectedProductTargetFingerprint"),
    idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
  };
}

export function validateReversalCommand(input) {
  assertKnownFields(input, REVERSAL_FIELDS);
  return {
    reviewItemId: requiredReviewItemId(input.reviewItemId),
    targetDecisionEventId: requiredUuid(input.targetDecisionEventId, "targetDecisionEventId"),
    reasonCode: requiredEnum(input.reasonCode, REVERSAL_REASON_CODES, "reasonCode", "CATALOG_REVIEW_UNSUPPORTED_REASON"),
    reviewerNote: optionalNote(input.reviewerNote),
    expectedDecisionVersion: requiredExpectedVersion(input.expectedDecisionVersion),
    idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
  };
}

export function authorizeDecisionCaller(caller) {
  if (!caller || !isAdminLikeRole(caller.role)) {
    throw new CatalogObservationDecisionApiError(403, "CATALOG_REVIEW_DECISION_FORBIDDEN", "Forbidden");
  }
}

export function createCatalogObservationDecisionCommandDb({ supabaseUrl, supabaseAnonKey, accessToken }) {
  return {
    async recordDecision(input) {
      return callRpc({
        supabaseUrl,
        supabaseAnonKey,
        accessToken,
        rpcName: "record_catalog_observation_review_decision",
        body: {
          input_review_item_id: input.reviewItemId,
          input_decision_type: input.decisionType,
          input_reason_code: input.reasonCode,
          input_reviewer_note: input.reviewerNote,
          input_expected_decision_version: input.expectedDecisionVersion,
          input_expected_recommendation_fingerprint: input.expectedRecommendationFingerprint,
          input_expected_review_item_fingerprint: input.expectedReviewItemFingerprint,
          input_expected_product_target_fingerprint: input.expectedProductTargetFingerprint,
          input_idempotency_key: input.idempotencyKey,
        },
      });
    },
    async reverseDecision(input) {
      return callRpc({
        supabaseUrl,
        supabaseAnonKey,
        accessToken,
        rpcName: "reverse_catalog_observation_review_decision",
        body: {
          input_review_item_id: input.reviewItemId,
          input_reversal_target_event_id: input.targetDecisionEventId,
          input_reason_code: input.reasonCode,
          input_reviewer_note: input.reviewerNote,
          input_expected_decision_version: input.expectedDecisionVersion,
          input_idempotency_key: input.idempotencyKey,
        },
      });
    },
  };
}

export function serializeDecisionResult(result, { action }) {
  const event = normalizeObject(result?.event);
  const currentState = normalizeObject(result?.current_state);
  return {
    schema_version: DECISION_COMMAND_SCHEMA_VERSION,
    success: true,
    action,
    replayed: Boolean(result?.idempotency_replay),
    event: {
      event_id: nullableString(event.event_id),
      review_item_id: nullableString(event.review_item_id),
      event_type: nullableString(event.event_type),
      decision_type: nullableString(event.decision_type),
      reason_code: nullableString(event.reason_code),
      decision_version: numberValue(event.resulting_decision_version),
      reviewer_user_id: nullableString(event.reviewer_user_id),
      reviewer_role: nullableString(event.reviewer_role),
      decided_at: nullableString(event.created_at),
      reversal_target_event_id: nullableString(event.reversal_target_event_id),
    },
    current_state: serializeCurrentState(currentState),
  };
}

export function serializeError(error) {
  if (error instanceof CatalogObservationDecisionApiError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  const mapped = mapDbError(error);
  if (mapped) return { status: mapped.status, body: { error: mapped.message, code: mapped.code } };
  return {
    status: 500,
    body: {
      error: "Catalog review decision could not be completed right now.",
      code: "CATALOG_REVIEW_DECISION_INTERNAL_ERROR",
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
  if (!response.ok) {
    const message = String(data?.message || data?.error || `RPC request failed: ${response.status}`);
    throw new Error(message);
  }
  return data;
}

function mapDbError(error) {
  const message = String(error?.message || error || "");
  const code = extractDbCode(message);
  if (!code) return null;
  const status = statusForDbCode(code);
  return { status, code, message: safeMessageForDbCode(code) };
}

function extractDbCode(message) {
  const match = message.match(/(CATALOG_REVIEW_[A-Z0-9_]+)/);
  return match?.[1] || "";
}

function statusForDbCode(code) {
  if (code === "CATALOG_REVIEW_DECISION_UNAUTHORIZED") return 403;
  if (code === "CATALOG_REVIEW_ITEM_MISSING") return 404;
  if (code === "CATALOG_REVIEW_DECISION_ORGANIZATION_MISMATCH") return 403;
  if (code === "CATALOG_REVIEW_DECISION_INVALID_REASON") return 400;
  if (code === "CATALOG_REVIEW_DECISION_INVALID_TRANSITION") return 409;
  return 409;
}

function safeMessageForDbCode(code) {
  if (code === "CATALOG_REVIEW_ITEM_MISSING") return "Review item was not found.";
  if (code === "CATALOG_REVIEW_DECISION_UNAUTHORIZED" || code === "CATALOG_REVIEW_DECISION_ORGANIZATION_MISMATCH") return "Forbidden";
  if (code === "CATALOG_REVIEW_DECISION_INVALID_REASON") return "Reason code is not allowed for this decision.";
  if (code === "CATALOG_REVIEW_DECISION_INVALID_TRANSITION") return "Decision state no longer allows this action.";
  if (code === "CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH") return "Idempotency key was reused with a different command.";
  return "This review item changed while you were reviewing it. Reload the latest state before deciding.";
}

function assertKnownFields(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_UNKNOWN_FIELD", `Unsupported field: ${key}`);
    }
  }
}

function requiredReviewItemId(value) {
  const text = requiredString(value, "reviewItemId");
  const parts = text.split(":");
  if (parts.length !== 4 || !isUuid(parts[0]) || !isUuid(parts[1]) || !isUuid(parts[2]) || !parts[3]) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_REVIEW_ITEM_ID", "reviewItemId is invalid.");
  }
  return text;
}

function requiredUuid(value, field) {
  const text = requiredString(value, field);
  if (!isUuid(text)) throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_UUID", `${field} must be a UUID.`);
  return text;
}

function requiredEnum(value, allowed, field, code) {
  const text = requiredString(value, field);
  if (!allowed.includes(text)) throw new CatalogObservationDecisionApiError(400, code, `${field} is not supported.`);
  return text;
}

function requiredExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_EXPECTED_VERSION", "expectedDecisionVersion must be a non-negative integer.");
  }
  return value;
}

function requiredFingerprint(value, field) {
  const text = requiredString(value, field);
  if (text.length > MAX_FINGERPRINT_LENGTH) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_FINGERPRINT", `${field} is too long.`);
  }
  return text;
}

function requiredIdempotencyKey(value) {
  const text = requiredString(value, "idempotencyKey");
  if (text.length > MAX_IDEMPOTENCY_KEY_LENGTH || !SAFE_IDEMPOTENCY_KEY_PATTERN.test(text)) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_IDEMPOTENCY_KEY", "idempotencyKey is invalid.");
  }
  return text;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_MISSING_REQUIRED_FIELD", `${field} is required.`);
  }
  return value.trim();
}

function optionalNote(value) {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_REVIEWER_NOTE", "reviewerNote must be a string.");
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new CatalogObservationDecisionApiError(400, "CATALOG_REVIEW_INVALID_REVIEWER_NOTE", "reviewerNote is too long.");
  }
  return value;
}

function serializeCurrentState(state) {
  return {
    organization_id: nullableString(state.organization_id),
    review_item_id: nullableString(state.review_item_id),
    current_decision: nullableString(state.current_decision),
    current_event_id: nullableString(state.current_event_id),
    reviewer_user_id: nullableString(state.reviewer_user_id),
    reviewer_role: nullableString(state.reviewer_role),
    decided_at: nullableString(state.decided_at),
    decision_version: numberValue(state.decision_version),
    is_reversed: Boolean(state.is_reversed),
    is_superseded: Boolean(state.is_superseded),
    is_invalidated: Boolean(state.is_invalidated),
    is_stale: Boolean(state.is_stale),
    requires_re_review: Boolean(state.requires_re_review),
    apply_eligible: Boolean(state.apply_eligible),
    apply_block_reasons: stringArray(state.apply_block_reasons),
  };
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || "").trim());
}
