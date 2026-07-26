import { createHash } from "node:crypto";
import { buildRestUrl } from "../http.mts";

export const ZF_STAGING_REVIEW_SCHEMA_VERSION = "catalog-zf-staging-review.v1";
export const ZF_STAGING_REVIEW_DEFAULT_LIMIT = 25;
export const ZF_STAGING_REVIEW_MAX_LIMIT = 50;
export const ZF_STAGING_REVIEW_VIEW =
  "catalog_zf_new_product_staging_review_v";

export const ZF_STAGING_REVIEW_BRANDS = Object.freeze([
  "ZF",
  "Sachs",
  "Lemforder",
  "TRW",
  "Wabco",
  "Boge",
]);

export const ZF_STAGING_REVIEW_EVENT_TYPES = Object.freeze([
  "STAGED",
  "QUARANTINED",
  "REVIEW_REQUESTED",
  "REJECTED",
  "DEFERRED",
  "SUPERSEDED",
  "CANCELLED",
]);

export const ZF_STAGING_REVIEW_COLUMNS = Object.freeze([
  "id",
  "organization_id",
  "brand_id",
  "brand",
  "proposed_display_code",
  "normalized_code",
  "official_source_display_code",
  "official_comparison_key",
  "description",
  "ean",
  "hs_code",
  "origin",
  "weight_kg",
  "oem_references",
  "vehicle_applications",
  "fitment_facts",
  "engine_facts",
  "lifecycle_status",
  "lifecycle_note",
  "replacement_candidates",
  "supersession_candidates",
  "official_image_candidate_url",
  "official_image_evidence_reference",
  "official_source_url",
  "observed_at",
  "evidence_hash",
  "payload_fingerprint",
  "observation_fingerprint",
  "candidate_version",
  "supersedes_candidate_id",
  "quarantine_class",
  "limitation_flags",
  "source_schema_version",
  "runtime_commit",
  "deploy_id",
  "created_at",
  "latest_event_type",
  "latest_event_version",
  "latest_event_reason_code",
  "latest_event_at",
  "run_id",
  "job_id",
  "source_id",
  "contract_version",
]);

const QUERY_FIELDS = new Set([
  "candidate_id",
  "run_id",
  "brand",
  "latest_event_type",
  "quarantine",
  "cursor",
  "limit",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_VERSION = 1;
const CURSOR_DOMAIN = "next-master:catalog-zf-staging-review:cursor:v1";
const MAX_CURSOR_LENGTH = 2048;
const MAX_SAFE_STRING_LENGTH = 4000;
const MAX_JSON_ARRAY_LENGTH = 500;
const MAX_JSON_OBJECT_KEYS = 100;
const MAX_JSON_DEPTH = 6;
const FORBIDDEN_TEXT_PATTERN =
  /(authorization|proxy-authorization|client[_-]?secret|private[_-]?key|api[_-]?key|password|set-cookie|cookie)\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.|-----begin\s+(rsa |ec |openssh )?private key-----/i;
const SENSITIVE_QUERY_KEY_PATTERN =
  /(^|[-_])(token|secret|signature|sig|key|credential|authorization)($|[-_])/i;
const SENSITIVE_JSON_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|token|access[_-]?token|id[_-]?token|refresh[_-]?token|secret|client[_-]?secret|private[_-]?key|api[_-]?key|credential)$/i;

export class CatalogZfStagingReviewError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CatalogZfStagingReviewError";
    this.status = status;
  }
}

export class CatalogZfStagingReviewDbError extends Error {
  constructor(kind) {
    super(kind === "CONTRACT_MISMATCH" ? "Projection contract mismatch" : "Projection unavailable");
    this.name = "CatalogZfStagingReviewDbError";
    this.kind = kind;
  }
}

export function parseCatalogZfStagingReviewQuery(requestUrl) {
  const url =
    requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl || ""));

  for (const key of url.searchParams.keys()) {
    if (!QUERY_FIELDS.has(key)) {
      throw badRequest(`Unknown query field: ${key}`);
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw badRequest(`Duplicate query field: ${key}`);
    }
  }

  const candidateId = optionalQueryValue(url, "candidate_id");
  const runId = optionalQueryValue(url, "run_id");
  const brand = optionalQueryValue(url, "brand");
  const latestEventType = optionalQueryValue(url, "latest_event_type");
  const quarantine =
    optionalQueryValue(url, "quarantine") || "all";
  const cursor = optionalQueryValue(url, "cursor");
  const rawLimit = optionalQueryValue(url, "limit");

  if (candidateId && !isUuid(candidateId)) {
    throw badRequest("candidate_id must be a UUID");
  }
  if (runId && !isUuid(runId)) {
    throw badRequest("run_id must be a UUID");
  }
  if (brand && !ZF_STAGING_REVIEW_BRANDS.includes(brand)) {
    throw badRequest(
      "brand must be one of ZF, Sachs, Lemforder, TRW, Wabco, or Boge",
    );
  }
  if (
    latestEventType &&
    !ZF_STAGING_REVIEW_EVENT_TYPES.includes(latestEventType)
  ) {
    throw badRequest("latest_event_type is not supported");
  }
  if (!["all", "eligible", "quarantined"].includes(quarantine)) {
    throw badRequest("quarantine must be all, eligible, or quarantined");
  }
  if (cursor && (cursor.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(cursor))) {
    throw badRequest("cursor is malformed");
  }

  const limit = rawLimit
    ? parsePositiveInteger(rawLimit, "limit")
    : ZF_STAGING_REVIEW_DEFAULT_LIMIT;
  if (limit > ZF_STAGING_REVIEW_MAX_LIMIT) {
    throw badRequest(
      `limit must be at most ${ZF_STAGING_REVIEW_MAX_LIMIT}`,
    );
  }

  return {
    candidate_id: candidateId,
    run_id: runId,
    brand,
    latest_event_type: latestEventType,
    quarantine,
    cursor,
    limit,
  };
}

export function createCatalogZfStagingReviewReadDb({
  supabaseUrl,
  supabaseAnonKey,
  accessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
}) {
  if (!supabaseUrl || !supabaseAnonKey || !accessToken) {
    throw new CatalogZfStagingReviewDbError("UNAVAILABLE");
  }
  if (typeof fetchImpl !== "function") {
    throw new CatalogZfStagingReviewDbError("UNAVAILABLE");
  }

  return {
    async list(input) {
      const url = buildRestUrl(
        supabaseUrl,
        ZF_STAGING_REVIEW_VIEW,
        buildCatalogZfStagingReviewRestParams(input),
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (isProjectionContractFailure(response.status, payload)) {
            throw new CatalogZfStagingReviewDbError("CONTRACT_MISMATCH");
          }
          throw new CatalogZfStagingReviewDbError("UNAVAILABLE");
        }
        if (!Array.isArray(payload)) {
          throw new CatalogZfStagingReviewDbError("CONTRACT_MISMATCH");
        }
        return payload;
      } catch (error) {
        if (error instanceof CatalogZfStagingReviewDbError) throw error;
        throw new CatalogZfStagingReviewDbError("UNAVAILABLE");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export async function buildCatalogZfStagingReviewResponse({
  db,
  organizationId,
  query,
}) {
  if (!isUuid(organizationId)) {
    throw new CatalogZfStagingReviewError(
      403,
      "Authorized tenant context is unavailable.",
    );
  }

  const cursorPosition = query.cursor
    ? decodeCatalogZfStagingReviewCursor({
        cursor: query.cursor,
        organizationId,
        query,
      })
    : null;

  let rows;
  try {
    rows = await db.list({
      organizationId,
      query,
      cursorPosition,
      fetchLimit: query.limit + 1,
    });
  } catch (error) {
    if (
      error instanceof CatalogZfStagingReviewDbError &&
      error.kind === "CONTRACT_MISMATCH"
    ) {
      throw new CatalogZfStagingReviewError(
        409,
        "Staging review projection contract is unavailable.",
      );
    }
    throw new CatalogZfStagingReviewError(
      503,
      "Staging review is temporarily unavailable.",
    );
  }

  if (!Array.isArray(rows) || rows.length > query.limit + 1) {
    throw new CatalogZfStagingReviewError(
      409,
      "Staging review projection contract is unavailable.",
    );
  }

  if (query.candidate_id && rows.length === 0) {
    throw new CatalogZfStagingReviewError(
      404,
      "Staging candidate was not found.",
    );
  }

  const pageRows = rows.slice(0, query.limit);
  const items = pageRows.map((row) =>
    validateAndProjectRow(row, organizationId),
  );
  const hasMore = rows.length > query.limit;
  const lastItem = items.at(-1) || null;
  const nextCursor =
    hasMore && lastItem
      ? encodeCatalogZfStagingReviewCursor({
          organizationId,
          query,
          createdAt: lastItem.created_at,
          id: lastItem.id,
        })
      : null;

  return {
    schema_version: ZF_STAGING_REVIEW_SCHEMA_VERSION,
    organization_id: organizationId,
    items,
    page: {
      limit: query.limit,
      cursor: query.cursor || null,
      next_cursor: nextCursor,
      has_more: hasMore,
      returned_count: items.length,
    },
  };
}

export function buildCatalogZfStagingReviewRestParams({
  organizationId,
  query,
  cursorPosition,
  fetchLimit,
}) {
  const params = {
    select: ZF_STAGING_REVIEW_COLUMNS.join(","),
    organization_id: `eq.${organizationId}`,
    order: "created_at.desc,id.desc",
    limit: String(fetchLimit),
  };

  if (query.candidate_id) params.id = `eq.${query.candidate_id}`;
  if (query.run_id) params.run_id = `eq.${query.run_id}`;
  if (query.brand) params.brand = `eq.${query.brand}`;
  if (query.latest_event_type) {
    params.latest_event_type = `eq.${query.latest_event_type}`;
  }
  if (query.quarantine === "eligible") {
    params.quarantine_class = "is.null";
  } else if (query.quarantine === "quarantined") {
    params.quarantine_class = "not.is.null";
  }
  if (cursorPosition) {
    params.or =
      `(created_at.lt.${cursorPosition.createdAt},` +
      `and(created_at.eq.${cursorPosition.createdAt},id.lt.${cursorPosition.id}))`;
  }

  return params;
}

export function encodeCatalogZfStagingReviewCursor({
  organizationId,
  query,
  createdAt,
  id,
}) {
  if (!isTimestamp(createdAt) || !isUuid(id)) {
    throw badRequest("cursor position is invalid");
  }

  const payload = {
    v: CURSOR_VERSION,
    t: createdAt,
    i: id,
    b: cursorBinding(organizationId, query),
  };
  const envelope = {
    p: payload,
    h: sha256(`${CURSOR_DOMAIN}:${stableJson(payload)}`),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decodeCatalogZfStagingReviewCursor({
  cursor,
  organizationId,
  query,
}) {
  try {
    if (
      !cursor ||
      cursor.length > MAX_CURSOR_LENGTH ||
      !CURSOR_PATTERN.test(cursor)
    ) {
      throw new Error("invalid encoding");
    }

    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) {
      throw new Error("non-canonical encoding");
    }
    const envelope = JSON.parse(decoded.toString("utf8"));
    const payload = envelope?.p;
    if (
      !hasExactKeys(envelope, ["p", "h"]) ||
      !payload ||
      !hasExactKeys(payload, ["v", "t", "i", "b"]) ||
      payload.v !== CURSOR_VERSION ||
      !isTimestamp(payload.t) ||
      !isUuid(payload.i) ||
      !SHA256_PATTERN.test(String(payload.b || "")) ||
      !SHA256_PATTERN.test(String(envelope.h || ""))
    ) {
      throw new Error("invalid payload");
    }
    if (
      envelope.h !== sha256(`${CURSOR_DOMAIN}:${stableJson(payload)}`) ||
      payload.b !== cursorBinding(organizationId, query)
    ) {
      throw new Error("binding mismatch");
    }
    return { createdAt: payload.t, id: payload.i };
  } catch {
    throw badRequest("cursor is invalid for this tenant or filter set");
  }
}

function validateAndProjectRow(row, organizationId) {
  if (!isPlainObject(row)) {
    throw projectionContractError();
  }
  const rowKeys = Object.keys(row).sort();
  const expectedKeys = [...ZF_STAGING_REVIEW_COLUMNS].sort();
  if (
    rowKeys.length !== expectedKeys.length ||
    rowKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw projectionContractError();
  }

  for (const field of [
    "id",
    "organization_id",
    "brand_id",
    "run_id",
    "job_id",
    "source_id",
  ]) {
    if (!isUuid(row[field])) throw projectionContractError();
  }
  if (
    row.organization_id !== organizationId ||
    !ZF_STAGING_REVIEW_BRANDS.includes(row.brand) ||
    row.brand === "TRW Engine Components" ||
    row.contract_version !== "1.0.0"
  ) {
    throw projectionContractError();
  }

  for (const field of [
    "proposed_display_code",
    "normalized_code",
    "official_source_display_code",
    "official_comparison_key",
    "official_source_url",
    "source_schema_version",
  ]) {
    assertRequiredSafeText(row[field]);
  }
  for (const field of [
    "description",
    "ean",
    "hs_code",
    "lifecycle_note",
    "official_image_evidence_reference",
    "quarantine_class",
    "deploy_id",
  ]) {
    assertOptionalSafeText(row[field]);
  }

  if (
    row.origin !== null &&
    !/^[A-Z]{2}$/.test(String(row.origin || ""))
  ) {
    throw projectionContractError();
  }
  if (
    row.weight_kg !== null &&
    (typeof row.weight_kg !== "number" ||
      !Number.isFinite(row.weight_kg) ||
      row.weight_kg <= 0)
  ) {
    throw projectionContractError();
  }
  if (!["active", "discontinued", "unknown"].includes(row.lifecycle_status)) {
    throw projectionContractError();
  }

  for (const field of [
    "oem_references",
    "vehicle_applications",
    "fitment_facts",
    "engine_facts",
    "replacement_candidates",
    "supersession_candidates",
    "limitation_flags",
  ]) {
    if (!Array.isArray(row[field])) throw projectionContractError();
    assertSafeJsonValue(row[field]);
  }

  if (
    !isPublicEvidenceUrl(row.official_source_url) ||
    !isOptionalPublicEvidenceUrl(row.official_image_candidate_url) ||
    !isTimestamp(row.observed_at) ||
    !isTimestamp(row.created_at) ||
    !SHA256_PATTERN.test(String(row.evidence_hash || "")) ||
    !SHA256_PATTERN.test(String(row.payload_fingerprint || "")) ||
    !SHA256_PATTERN.test(String(row.observation_fingerprint || "")) ||
    !COMMIT_PATTERN.test(String(row.runtime_commit || "")) ||
    !Number.isInteger(row.candidate_version) ||
    row.candidate_version < 1 ||
    (row.supersedes_candidate_id !== null &&
      !isUuid(row.supersedes_candidate_id))
  ) {
    throw projectionContractError();
  }

  if (row.latest_event_type === null) {
    if (
      row.latest_event_version !== null ||
      row.latest_event_reason_code !== null ||
      row.latest_event_at !== null
    ) {
      throw projectionContractError();
    }
  } else if (
    !ZF_STAGING_REVIEW_EVENT_TYPES.includes(row.latest_event_type) ||
    !Number.isInteger(row.latest_event_version) ||
    row.latest_event_version < 1 ||
    !isTimestamp(row.latest_event_at)
  ) {
    throw projectionContractError();
  } else {
    assertRequiredSafeText(row.latest_event_reason_code);
  }

  return Object.fromEntries(
    ZF_STAGING_REVIEW_COLUMNS.map((field) => [field, row[field]]),
  );
}

function cursorBinding(organizationId, query) {
  return sha256(
    stableJson({
      schema: ZF_STAGING_REVIEW_SCHEMA_VERSION,
      organization_id: organizationId,
      candidate_id: query.candidate_id || "",
      run_id: query.run_id || "",
      brand: query.brand || "",
      latest_event_type: query.latest_event_type || "",
      quarantine: query.quarantine || "all",
    }),
  );
}

function optionalQueryValue(url, field) {
  if (!url.searchParams.has(field)) return "";
  const value = String(url.searchParams.get(field) || "").trim();
  if (!value) throw badRequest(`${field} cannot be empty`);
  return value;
}

function parsePositiveInteger(value, field) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw badRequest(`${field} must be a positive integer`);
  }
  return Number(value);
}

function isProjectionContractFailure(status, payload) {
  const code = String(payload?.code || "").toUpperCase();
  const message = [
    payload?.message,
    payload?.details,
    payload?.hint,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  return (
    ["PGRST200", "PGRST204", "PGRST205", "42P01", "42703"].includes(code) ||
    (status === 404 && message.includes("schema cache")) ||
    message.includes("does not exist") ||
    message.includes("schema cache")
  );
}

function assertSafeJsonValue(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw projectionContractError();
  if (typeof value === "string") {
    assertRequiredSafeText(value);
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_LENGTH) throw projectionContractError();
    for (const item of value) assertSafeJsonValue(item, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_JSON_OBJECT_KEYS) throw projectionContractError();
    for (const [key, child] of entries) {
      if (SENSITIVE_JSON_KEY_PATTERN.test(key)) {
        throw projectionContractError();
      }
      assertRequiredSafeText(key);
      assertSafeJsonValue(child, depth + 1);
    }
    return;
  }
  throw projectionContractError();
}

function assertRequiredSafeText(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SAFE_STRING_LENGTH ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    throw projectionContractError();
  }
}

function assertOptionalSafeText(value) {
  if (value === null) return;
  assertRequiredSafeText(value);
}

function isPublicEvidenceUrl(value) {
  if (typeof value !== "string" || value.length > MAX_SAFE_STRING_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("169.254.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      return false;
    }
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) return false;
    }
    return !FORBIDDEN_TEXT_PATTERN.test(value);
  } catch {
    return false;
  }
}

function isOptionalPublicEvidenceUrl(value) {
  return value === null || isPublicEvidenceUrl(value);
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ""));
}

function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function badRequest(message) {
  return new CatalogZfStagingReviewError(400, message);
}

function projectionContractError() {
  return new CatalogZfStagingReviewError(
    409,
    "Staging review projection contract is unavailable.",
  );
}
