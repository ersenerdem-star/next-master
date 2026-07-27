import type {
  CatalogZfStagingReviewFilters,
  CatalogZfStagingReviewItem,
  CatalogZfStagingReviewJsonValue,
  CatalogZfStagingReviewResponse,
} from "../../types/catalogZfStagingReview";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { supabaseClient } from "./supabaseClient";

export const CATALOG_ZF_STAGING_REVIEW_SCHEMA_VERSION = "catalog-zf-staging-review.v1";
export const CATALOG_ZF_STAGING_REVIEW_DEFAULT_LIMIT = 25;
export const CATALOG_ZF_STAGING_REVIEW_MAX_LIMIT = 50;

export class CatalogZfStagingReviewReadError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = "CATALOG_ZF_STAGING_REVIEW_READ_FAILED") {
    super(message);
    this.name = "CatalogZfStagingReviewReadError";
    this.status = status;
    this.code = code;
  }
}

type ErrorResponse = { error?: string; code?: string };

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    throw new CatalogZfStagingReviewReadError(
      sanitizeUserFacingMessage(error.message, "Your session has expired. Sign in again."),
      401,
      "SESSION_UNAVAILABLE",
    );
  }
  const token = String(data.session?.access_token || "");
  if (!token) {
    throw new CatalogZfStagingReviewReadError("Your session has expired. Sign in again.", 401, "SESSION_UNAVAILABLE");
  }
  return token;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return String(value ?? "");
}

function nullableString(value: unknown) {
  const text = stringValue(value).trim();
  return text || null;
}

function numberValue(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumber(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((entry) => stringValue(entry).trim()).filter(Boolean) : [];
}

function jsonArray(value: unknown): CatalogZfStagingReviewJsonValue[] {
  return Array.isArray(value) ? (value as CatalogZfStagingReviewJsonValue[]) : [];
}

function mapItem(value: unknown): CatalogZfStagingReviewItem {
  const row = objectValue(value);
  return {
    id: stringValue(row.id),
    organization_id: stringValue(row.organization_id),
    brand_id: stringValue(row.brand_id),
    brand: stringValue(row.brand),
    proposed_display_code: stringValue(row.proposed_display_code),
    normalized_code: stringValue(row.normalized_code),
    official_source_display_code: stringValue(row.official_source_display_code),
    official_comparison_key: stringValue(row.official_comparison_key),
    description: nullableString(row.description),
    ean: nullableString(row.ean),
    hs_code: nullableString(row.hs_code),
    origin: nullableString(row.origin),
    weight_kg: nullableNumber(row.weight_kg),
    oem_references: stringArray(row.oem_references),
    vehicle_applications: jsonArray(row.vehicle_applications),
    fitment_facts: stringArray(row.fitment_facts),
    engine_facts: stringArray(row.engine_facts),
    lifecycle_status: stringValue(row.lifecycle_status),
    lifecycle_note: nullableString(row.lifecycle_note),
    replacement_candidates: jsonArray(row.replacement_candidates),
    supersession_candidates: jsonArray(row.supersession_candidates),
    official_image_candidate_url: nullableString(row.official_image_candidate_url),
    official_image_evidence_reference: nullableString(row.official_image_evidence_reference),
    official_source_url: nullableString(row.official_source_url),
    observed_at: nullableString(row.observed_at),
    evidence_hash: stringValue(row.evidence_hash),
    payload_fingerprint: stringValue(row.payload_fingerprint),
    observation_fingerprint: stringValue(row.observation_fingerprint),
    candidate_version: numberValue(row.candidate_version),
    supersedes_candidate_id: nullableString(row.supersedes_candidate_id),
    quarantine_class: nullableString(row.quarantine_class),
    limitation_flags: stringArray(row.limitation_flags),
    source_schema_version: stringValue(row.source_schema_version),
    runtime_commit: nullableString(row.runtime_commit),
    deploy_id: nullableString(row.deploy_id),
    created_at: stringValue(row.created_at),
    latest_event_type: nullableString(row.latest_event_type),
    latest_event_version: nullableNumber(row.latest_event_version),
    latest_event_reason_code: nullableString(row.latest_event_reason_code),
    latest_event_at: nullableString(row.latest_event_at),
    run_id: stringValue(row.run_id),
    job_id: stringValue(row.job_id),
    source_id: stringValue(row.source_id),
    contract_version: stringValue(row.contract_version),
  };
}

function mapResponse(value: unknown): CatalogZfStagingReviewResponse {
  const row = objectValue(value);
  const page = objectValue(row.page);
  return {
    schema_version: stringValue(row.schema_version),
    organization_id: stringValue(row.organization_id),
    items: Array.isArray(row.items) ? row.items.map(mapItem) : [],
    page: {
      limit: numberValue(page.limit),
      cursor: nullableString(page.cursor),
      next_cursor: nullableString(page.next_cursor),
      has_more: Boolean(page.has_more),
      returned_count: numberValue(page.returned_count),
    },
  };
}

export async function fetchCatalogZfStagingReview(
  input: CatalogZfStagingReviewFilters = {},
): Promise<CatalogZfStagingReviewResponse> {
  const accessToken = await getAccessToken();
  const url = new URL("/api/catalog/zf-group/staging-review", window.location.origin);
  if (input.candidateId) url.searchParams.set("candidate_id", input.candidateId);
  if (input.runId) url.searchParams.set("run_id", input.runId);
  if (input.brand) url.searchParams.set("brand", input.brand);
  if (input.latestEventType) url.searchParams.set("latest_event_type", input.latestEventType);
  if (input.quarantine && input.quarantine !== "all") url.searchParams.set("quarantine", input.quarantine);
  if (input.cursor) url.searchParams.set("cursor", input.cursor);
  const limit = input.limit || CATALOG_ZF_STAGING_REVIEW_DEFAULT_LIMIT;
  if (limit !== CATALOG_ZF_STAGING_REVIEW_DEFAULT_LIMIT) url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: input.signal,
  });
  const data = (await response.json().catch(() => ({}))) as ErrorResponse;
  if (!response.ok) {
    throw new CatalogZfStagingReviewReadError(
      sanitizeUserFacingMessage(data.error || `Staging review request failed: ${response.status}`, "ZF staging review could not be loaded right now."),
      response.status,
      data.code || "CATALOG_ZF_STAGING_REVIEW_READ_FAILED",
    );
  }
  const mapped = mapResponse(data);
  if (mapped.schema_version !== CATALOG_ZF_STAGING_REVIEW_SCHEMA_VERSION || !mapped.organization_id) {
    throw new CatalogZfStagingReviewReadError("The staging review response is not compatible with this UI version.", 500, "CATALOG_ZF_STAGING_REVIEW_VERSION_MISMATCH");
  }
  return mapped;
}
