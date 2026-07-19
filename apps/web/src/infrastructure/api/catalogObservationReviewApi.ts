import type {
  CatalogObservationReviewItem,
  CatalogObservationReviewPage,
  CatalogObservationReviewResponse,
  CatalogObservationReviewRuleEvaluation,
  CatalogObservationReviewSummary,
} from "../../types/catalogObservationReview";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";

const CATALOG_OBSERVATION_REVIEW_SCHEMA_VERSION = "catalog-observation-review.v1";

type FetchCatalogObservationReviewInput = {
  runId: string;
  productId?: string;
  fieldFamily?: string;
  comparisonResult?: string;
  recommendation?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};

type ErrorResponse = {
  error?: string;
};

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Your session has expired. Sign in again."));
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("Your session has expired. Sign in again.");
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
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nullableNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item).trim()).filter(Boolean) : [];
}

function ruleArray(value: unknown): CatalogObservationReviewRuleEvaluation[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = objectValue(item);
    return {
      rule: stringValue(row.rule),
      matched: Boolean(row.matched),
      reasons: stringArray(row.reasons),
    };
  });
}

function mapReviewItem(value: unknown): CatalogObservationReviewItem {
  const row = objectValue(value);
  return {
    organization_id: stringValue(row.organization_id),
    run_id: stringValue(row.run_id),
    review_queue_id: stringValue(row.review_queue_id),
    product_id: nullableString(row.product_id),
    brand_id: stringValue(row.brand_id),
    brand_name: stringValue(row.brand_name),
    product_code: stringValue(row.product_code),
    normalized_product_code: stringValue(row.normalized_product_code),
    observation_id: nullableString(row.observation_id),
    field_family: stringValue(row.field_family),
    comparison_result: stringValue(row.comparison_result),
    comparison_reason: stringValue(row.comparison_reason),
    product_value: stringValue(row.product_value),
    observation_value: stringValue(row.observation_value),
    normalized_product_value: stringValue(row.normalized_product_value),
    normalized_observation_value: stringValue(row.normalized_observation_value),
    recommendation: stringValue(row.recommendation),
    score: numberValue(row.score),
    explanation: stringValue(row.explanation),
    rules: ruleArray(row.rules),
    winning_rule: stringValue(row.winning_rule),
    recommendation_fingerprint: stringValue(row.recommendation_fingerprint),
    source_key: nullableString(row.source_key),
    source_display_name: nullableString(row.source_display_name),
    source_trust_level: nullableString(row.source_trust_level),
    source_trust_score: nullableNumber(row.source_trust_score),
    observation_confidence: nullableNumber(row.observation_confidence),
    evidence_complete: Boolean(row.evidence_complete),
    evidence_reference: nullableString(row.evidence_reference),
    evidence_url: nullableString(row.evidence_url),
    observed_at: nullableString(row.observed_at),
    run_status: nullableString(row.run_status),
    positive_factors: stringArray(row.positive_factors),
    negative_factors: stringArray(row.negative_factors),
    reviewer: nullableString(row.reviewer),
    decision: nullableString(row.decision),
    created_at: stringValue(row.created_at),
  };
}

function mapPage(value: unknown): CatalogObservationReviewPage {
  const row = objectValue(value);
  return {
    limit: numberValue(row.limit),
    cursor: nullableString(row.cursor),
    next_cursor: nullableString(row.next_cursor),
    has_more: Boolean(row.has_more),
    returned_count: numberValue(row.returned_count),
    total_count: numberValue(row.total_count),
  };
}

function numberRecord(value: unknown) {
  return Object.fromEntries(
    Object.entries(objectValue(value)).map(([key, entry]) => [key, numberValue(entry)]),
  );
}

function mapSummary(value: unknown): CatalogObservationReviewSummary {
  const row = objectValue(value);
  return {
    total_observations: numberValue(row.total_observations),
    review_queue_count: numberValue(row.review_queue_count),
    matching_item_count: numberValue(row.matching_item_count),
    comparison_totals: numberRecord(row.comparison_totals),
    recommendation_totals: numberRecord(row.recommendation_totals),
  };
}

function mapResponse(value: unknown): CatalogObservationReviewResponse {
  const row = objectValue(value);
  return {
    schema_version: stringValue(row.schema_version),
    organization_id: stringValue(row.organization_id),
    run_id: stringValue(row.run_id),
    items: Array.isArray(row.items) ? row.items.map(mapReviewItem) : [],
    page: mapPage(row.page),
    summary: mapSummary(row.summary),
  };
}

export async function fetchCatalogObservationReview(input: FetchCatalogObservationReviewInput): Promise<CatalogObservationReviewResponse> {
  const organizationId = await getCurrentOrgId();
  const accessToken = await getAccessToken();
  const url = new URL("/api/catalog/observation-review", window.location.origin);
  url.searchParams.set("organization_id", organizationId);
  url.searchParams.set("run_id", input.runId);
  if (input.productId) url.searchParams.set("product_id", input.productId);
  if (input.fieldFamily) url.searchParams.set("field_family", input.fieldFamily);
  if (input.comparisonResult) url.searchParams.set("comparison_result", input.comparisonResult);
  if (input.recommendation) url.searchParams.set("recommendation", input.recommendation);
  if (input.cursor) url.searchParams.set("cursor", input.cursor);
  if (input.limit) url.searchParams.set("limit", String(input.limit));

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: input.signal,
  });
  const data = (await response.json().catch(() => ({}))) as ErrorResponse;
  if (!response.ok) {
    throw new Error(sanitizeUserFacingMessage(data.error || `Catalog observation review request failed: ${response.status}`, "The review workspace could not be loaded right now."));
  }
  const mapped = mapResponse(data);
  if (mapped.schema_version !== CATALOG_OBSERVATION_REVIEW_SCHEMA_VERSION) {
    throw new Error("The review workspace response is not compatible with this UI version.");
  }
  return mapped;
}
