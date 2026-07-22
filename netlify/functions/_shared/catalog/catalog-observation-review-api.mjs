import { buildRestUrl, getJson, sendJson, serviceRoleHeaders } from "../http.mts";
import { isAdminLikeRole } from "../roles.mts";
import {
  COMPARISON_RESULTS,
  compareObservationToProduct,
  summarizeComparisons,
} from "../../../../scripts/catalog/lib/catalog-observation-review-core.mjs";
import {
  RECOMMENDATIONS,
  recommendReviewItem,
} from "../../../../scripts/catalog/lib/catalog-observation-decision-core.mjs";

export const REVIEW_SCHEMA_VERSION = "catalog-observation-review.v1";
export const REVIEW_DEFAULT_LIMIT = 25;
export const REVIEW_MAX_LIMIT = 50;
export const REVIEW_RECOMMENDATION_ORDER = [
  RECOMMENDATIONS.MANUAL_REQUIRED,
  RECOMMENDATIONS.LIKELY_REJECT,
  RECOMMENDATIONS.INSUFFICIENT_EVIDENCE,
  RECOMMENDATIONS.LIKELY_ACCEPT,
  RECOMMENDATIONS.AUTO_SAFE,
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOMMENDATION_RANK = new Map(REVIEW_RECOMMENDATION_ORDER.map((value, index) => [value, index]));

export class CatalogObservationReviewError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CatalogObservationReviewError";
    this.status = status;
  }
}

export function parseCatalogObservationReviewQuery(requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl || ""));
  const organizationId = String(url.searchParams.get("organization_id") || "").trim();
  const runId = String(url.searchParams.get("run_id") || "").trim();
  const productId = String(url.searchParams.get("product_id") || "").trim();
  const fieldFamily = String(url.searchParams.get("field_family") || "").trim();
  const comparisonResult = String(url.searchParams.get("comparison_result") || "").trim();
  const recommendation = String(url.searchParams.get("recommendation") || "").trim();
  const cursor = String(url.searchParams.get("cursor") || "").trim();
  const rawLimit = String(url.searchParams.get("limit") || "").trim();
  const limit = rawLimit ? Number(rawLimit) : REVIEW_DEFAULT_LIMIT;

  if (!organizationId) throw new Error("organization_id is required");
  if (!isUuid(organizationId)) throw new Error("organization_id must be a UUID");
  if (!runId) throw new Error("run_id is required");
  if (!isUuid(runId)) throw new Error("run_id must be a UUID");
  if (productId && !isUuid(productId)) throw new Error("product_id must be a UUID");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (limit > REVIEW_MAX_LIMIT) throw new Error(`limit must be at most ${REVIEW_MAX_LIMIT}`);

  return {
    organization_id: organizationId,
    run_id: runId,
    product_id: productId || "",
    field_family: fieldFamily,
    comparison_result: comparisonResult,
    recommendation: recommendation,
    cursor: cursor || "",
    limit,
  };
}

export function authorizeCatalogObservationReviewAccess(caller, organizationId) {
  const callerOrganizationId = String(caller?.organization_id || caller?.organizationId || "").trim();
  if (!caller || !isAdminLikeRole(caller.role)) {
    return { error: "Forbidden", status: 403 };
  }
  if (!callerOrganizationId || callerOrganizationId !== String(organizationId || "").trim()) {
    return { error: "Forbidden", status: 403 };
  }
  return { ok: true };
}

export function createCatalogObservationReviewDb({ supabaseUrl, serviceRoleKey }) {
  return {
    async get(table, params) {
      return getJson(buildRestUrl(supabaseUrl, table, params), {
        headers: serviceRoleHeaders(serviceRoleKey),
      });
    },
  };
}

export function createCatalogObservationReviewDecisionStateDb({ supabaseUrl, supabaseAnonKey, accessToken }) {
  return {
    async getFingerprints(input) {
      return sendJson(`${supabaseUrl}/rest/v1/rpc/get_catalog_observation_review_fingerprints`, {
        method: "POST",
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_review_item_id: input.reviewItemId,
        }),
      });
    },
    async getDecisionState(input) {
      return sendJson(`${supabaseUrl}/rest/v1/rpc/get_catalog_observation_review_decision_state`, {
        method: "POST",
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_review_item_id: input.reviewItemId,
          input_current_recommendation_fingerprint: input.recommendationFingerprint,
          input_current_review_item_fingerprint: input.reviewItemFingerprint,
          input_current_product_target_fingerprint: input.productTargetFingerprint,
        }),
      });
    },
  };
}

export async function loadCatalogObservationReviewWorkspace(db, { organizationId, runId }) {
  const runs = await db.get("catalog_observation_runs", {
    select: "id,organization_id,job_id,source_id,brand_id,status,started_at,finished_at,observed_count,deduped_count,candidate_count,review_routed_count,apply_event_count,error_message",
    organization_id: `eq.${organizationId}`,
    id: `eq.${runId}`,
    limit: "1",
  });

  if (!runs.length) {
    return {
      runs: [],
      observations: [],
      products: [],
      brands: [],
      sources: [],
      trustProfiles: [],
    };
  }

  const observations = await db.get("catalog_external_observations", {
    select: [
      "id",
      "organization_id",
      "source_id",
      "trust_profile_id",
      "run_id",
      "catalog_product_id",
      "product_code",
      "normalized_code",
      "field_family",
      "raw_value",
      "normalized_value",
      "evidence_url",
      "evidence_reference",
      "evidence_hash",
      "confidence",
      "observed_at",
      "ingested_at",
      "deduplication_key",
    ].join(","),
    organization_id: `eq.${organizationId}`,
    run_id: `eq.${runId}`,
    order: "ingested_at.asc,id.asc",
  });

  const productIds = uniqueStrings(observations.map((observation) => observation.catalog_product_id));
  const sourceIds = uniqueStrings(observations.map((observation) => observation.source_id));
  const trustProfileIds = uniqueStrings(observations.map((observation) => observation.trust_profile_id));

  const products = productIds.length
    ? await db.get("catalog_products", {
      select: "id,organization_id,brand_id,product_code,normalized_code,description,image_url,updated_at",
      id: `in.(${productIds.join(",")})`,
      order: "product_code.asc",
    })
    : [];
  const brandIds = uniqueStrings([
    ...products.map((product) => product.brand_id),
    ...runs.map((run) => run.brand_id),
  ]);
  const brands = brandIds.length
    ? await db.get("brands", {
      select: "id,organization_id,name",
      id: `in.(${brandIds.join(",")})`,
      order: "name.asc",
    })
    : [];
  const sources = sourceIds.length
    ? await db.get("catalog_external_sources", {
      select: "id,organization_id,source_key,display_name,source_type,license_posture,is_active",
      id: `in.(${sourceIds.join(",")})`,
      order: "source_key.asc",
    })
    : [];
  const trustProfiles = trustProfileIds.length
    ? await db.get("catalog_external_source_trust_profiles", {
      select: "id,organization_id,source_id,trust_level,trust_score,allowed_field_families,human_review_required,evidence_required,is_active",
      id: `in.(${trustProfileIds.join(",")})`,
      order: "source_id.asc",
    })
    : [];

  return {
    runs,
    observations,
    products,
    brands,
    sources,
    trustProfiles,
  };
}

export async function buildCatalogObservationReviewResponse({
  db,
  decisionStateDb = null,
  organizationId,
  runId,
  productId = "",
  fieldFamily = "",
  comparisonResult = "",
  recommendation = "",
  cursor = "",
  limit = REVIEW_DEFAULT_LIMIT,
  generatedAt = new Date().toISOString(),
  now = generatedAt,
}) {
  const workspace = await loadCatalogObservationReviewWorkspace(db, { organizationId, runId });
  if (!workspace.runs.length) {
    throw new CatalogObservationReviewError(404, "Review run not found in the authorized organization.");
  }
  if (!workspace.observations.length) {
    throw new CatalogObservationReviewError(409, "Review run linkage is inconsistent.");
  }

  const { observations, products, brands, sources, trustProfiles, runs } = workspace;
  const productById = new Map(products.map((product) => [product.id, product]));
  const brandById = new Map(brands.map((brand) => [brand.id, brand]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const trustProfileById = new Map(trustProfiles.map((profile) => [profile.id, profile]));
  const runById = new Map(runs.map((run) => [run.id, run]));
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));

  for (const observation of observations) {
    if (!productById.has(observation.catalog_product_id)) {
      throw new CatalogObservationReviewError(409, "Review run linkage is inconsistent.");
    }
  }

  const comparisons = observations.map((observation) => compareObservationToProduct({
    observation,
    product: productById.get(observation.catalog_product_id) || null,
    createdAt: observation.ingested_at || observation.observed_at || generatedAt,
  }));
  const reviewQueue = buildReviewQueueFromComparisons(comparisons);
  const recommendationsByObservationId = new Map();
  for (const queueItem of reviewQueue) {
    const observation = observationById.get(queueItem.observation) || null;
    const product = productById.get(queueItem.product) || null;
    const source = sourceById.get(observation?.source_id || "") || null;
    const trustProfile = trustProfileById.get(observation?.trust_profile_id || "") || null;
    const run = runById.get(observation?.run_id || queueItem.run || "") || null;
    const recommendationBody = recommendReviewItem({
      reviewItem: queueItem,
      observation,
      product,
      source,
      trustProfile,
      run,
      allObservations: observations,
      generatedAt,
      now,
    });
    recommendationsByObservationId.set(String(queueItem.observation || ""), recommendationBody);
  }

  const records = reviewQueue
    .map((queueItem) => {
      const observation = observationById.get(queueItem.observation) || null;
      const product = productById.get(queueItem.product) || null;
      const brand = brandById.get(product?.brand_id || "") || null;
      const source = sourceById.get(observation?.source_id || "") || null;
      const comparison = comparisons.find((candidate) => candidate.observation_id === queueItem.observation) || null;
      const recommendationBody = recommendationsByObservationId.get(String(queueItem.observation || "")) || null;
      if (!comparison || !recommendationBody) return null;
      return {
        organization_id: recommendationBody.organization_id || comparison.organization_id || organizationId,
        run_id: comparison.run_id || runId,
        review_queue_id: recommendationBody.review_queue_key,
        product_id: comparison.product_id || queueItem.product || null,
        brand_id: String(product?.brand_id || ""),
        brand_name: String(brand?.name || ""),
        product_code: String(product?.product_code || ""),
        normalized_product_code: String(product?.normalized_code || product?.product_code || ""),
        observation_id: comparison.observation_id || queueItem.observation || null,
        field_family: comparison.field_family || queueItem.field || "",
        comparison_result: comparison.comparison_result || queueItem.comparison_result || "",
        comparison_reason: comparison.reason || "",
        product_value: comparison.product_value || "",
        observation_value: comparison.observation_value || "",
        normalized_product_value: comparison.normalized_product_value || "",
        normalized_observation_value: comparison.normalized_observation_value || "",
        recommendation: recommendationBody.recommendation,
        score: recommendationBody.score,
        explanation: recommendationBody.human_explanation,
        rules: recommendationBody.rules_evaluated,
        winning_rule: recommendationBody.winning_rule,
        recommendation_fingerprint: recommendationBody.recommendation_fingerprint,
        observation_fingerprint: "",
        review_item_fingerprint: "",
        product_target_fingerprint: "",
        source_key: recommendationBody.source_key || null,
        source_display_name: String(source?.display_name || source?.source_key || recommendationBody.source_key || ""),
        source_trust_level: recommendationBody.source_trust_level || null,
        source_trust_score: recommendationBody.source_trust_score ?? null,
        observation_confidence: recommendationBody.observation_confidence ?? null,
        evidence_complete: Boolean(recommendationBody.evidence_complete),
        evidence_reference: String(observation?.evidence_reference || ""),
        evidence_url: String(observation?.evidence_url || ""),
        observed_at: String(observation?.observed_at || observation?.ingested_at || ""),
        run_status: recommendationBody.run_status || null,
        positive_factors: Array.isArray(recommendationBody.positive_factors) ? recommendationBody.positive_factors : [],
        negative_factors: Array.isArray(recommendationBody.negative_factors) ? recommendationBody.negative_factors : [],
        reviewer: null,
        decision: null,
        decision_state: null,
        created_at: comparison.created_at || observation?.ingested_at || observation?.observed_at || generatedAt,
      };
    })
    .filter(Boolean);

  if (records.length && !decisionStateDb) {
    throw new CatalogObservationReviewError(500, "Review fingerprint projection is not configured.");
  }
  for (const record of records) {
    const fingerprints = await decisionStateDb.getFingerprints({ reviewItemId: record.review_queue_id });
    record.observation_fingerprint = String(fingerprints?.observation_fingerprint || "");
    record.review_item_fingerprint = String(fingerprints?.review_item_fingerprint || "");
    record.product_target_fingerprint = String(fingerprints?.product_target_fingerprint || "");
    if (!record.review_item_fingerprint || !record.product_target_fingerprint) {
      throw new CatalogObservationReviewError(409, "Review run linkage is inconsistent.");
    }
    if (typeof decisionStateDb.getDecisionState === "function") {
      record.decision_state = await decisionStateDb.getDecisionState({
        reviewItemId: record.review_queue_id,
        recommendationFingerprint: record.recommendation_fingerprint,
        reviewItemFingerprint: record.review_item_fingerprint,
        productTargetFingerprint: record.product_target_fingerprint,
      });
      record.decision = record.decision_state?.current_decision === "UNDECIDED" ? null : String(record.decision_state?.current_decision || "");
      record.reviewer = record.decision_state?.reviewer_user_id ? String(record.decision_state.reviewer_user_id) : null;
    } else {
      record.decision_state = buildUndecidedDecisionState({
        organizationId,
        reviewItemId: record.review_queue_id,
        recommendationFingerprint: record.recommendation_fingerprint,
        reviewItemFingerprint: record.review_item_fingerprint,
        productTargetFingerprint: record.product_target_fingerprint,
      });
    }
  }

  const comparisonTotals = summarizeComparisons(comparisons, reviewQueue);
  const recommendedRecords = records.filter((record) => matchesResponseFilters(record, { productId, fieldFamily, comparisonResult, recommendation }));
  const sortedRecords = [...recommendedRecords].sort(compareReviewRecords);
  const cursorPayload = cursor ? decodeCursor(cursor) : null;
  if (cursorPayload) {
    validateCursorPayload(cursorPayload, {
      organizationId,
      runId,
      productId,
      fieldFamily,
      comparisonResult,
      recommendation,
    });
  }
  const startIndex = cursorPayload ? sortedRecords.findIndex((record) => compareCursorRecord(record, cursorPayload) > 0) : 0;
  const safeStartIndex = startIndex >= 0 ? startIndex : sortedRecords.length;
  const pageItems = sortedRecords.slice(safeStartIndex, safeStartIndex + limit);
  const nextCursor = safeStartIndex + limit < sortedRecords.length && pageItems.length
    ? encodeCursor(pageItems[pageItems.length - 1], {
      organizationId,
      runId,
      productId,
      fieldFamily,
      comparisonResult,
      recommendation,
    })
    : null;

  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    organization_id: organizationId,
    run_id: runId,
    items: pageItems,
    page: {
      limit,
      cursor: cursor || null,
      next_cursor: nextCursor,
      has_more: Boolean(nextCursor),
      returned_count: pageItems.length,
      total_count: sortedRecords.length,
    },
    summary: {
      total_observations: observations.length,
      review_queue_count: reviewQueue.length,
      matching_item_count: sortedRecords.length,
      comparison_totals: comparisonTotals,
      recommendation_totals: summarizeRecommendationTotals(sortedRecords),
    },
  };
}

function buildReviewQueueFromComparisons(comparisons) {
  return comparisons
    .filter((comparison) => (
      comparison.comparison_result === COMPARISON_RESULTS.ENRICHMENT_CANDIDATE
      || comparison.comparison_result === COMPARISON_RESULTS.CONFLICT
    ))
    .map((comparison) => ({
      organization: comparison.organization_id,
      product: comparison.product_id,
      observation: comparison.observation_id,
      field: comparison.field_family,
      comparison_result: comparison.comparison_result,
      confidence: comparison.confidence,
      reason: comparison.reason,
      source: comparison.source_id || null,
      run: comparison.run_id || null,
      created_at: comparison.created_at,
      reviewer: null,
      decision: null,
    }));
}

function matchesResponseFilters(record, { productId, fieldFamily, comparisonResult, recommendation }) {
  if (productId && String(record.product_id || "") !== productId) return false;
  if (fieldFamily && String(record.field_family || "") !== fieldFamily) return false;
  if (comparisonResult && String(record.comparison_result || "") !== comparisonResult) return false;
  if (recommendation && String(record.recommendation || "") !== recommendation) return false;
  return true;
}

function compareReviewRecords(left, right) {
  const recommendationDiff = recommendationRank(left.recommendation) - recommendationRank(right.recommendation);
  if (recommendationDiff) return recommendationDiff;
  const productDiff = compareText(left.product_code, right.product_code);
  if (productDiff) return productDiff;
  const fieldDiff = compareText(left.field_family, right.field_family);
  if (fieldDiff) return fieldDiff;
  return compareText(left.observation_id, right.observation_id);
}

function compareCursorRecord(record, cursorPayload) {
  const left = {
    recommendation: String(record.recommendation || ""),
    product_code: String(record.product_code || ""),
    field_family: String(record.field_family || ""),
    observation_id: String(record.observation_id || ""),
  };
  const right = {
    recommendation: String(cursorPayload.sort_recommendation || cursorPayload.recommendation || ""),
    product_code: String(cursorPayload.product_code || ""),
    field_family: String(cursorPayload.sort_field_family || cursorPayload.field_family || ""),
    observation_id: String(cursorPayload.observation_id || ""),
  };
  return compareReviewRecords(left, right);
}

function recommendationRank(value) {
  return RECOMMENDATION_RANK.get(String(value || "")) ?? Number.MAX_SAFE_INTEGER;
}

function summarizeRecommendationTotals(records) {
  const totals = Object.fromEntries(REVIEW_RECOMMENDATION_ORDER.map((value) => [value, 0]));
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(totals, record.recommendation)) {
      totals[record.recommendation] += 1;
    }
  }
  return totals;
}

function validateCursorPayload(payload, expected) {
  if (String(payload.v || "") !== "1") throw new Error("Invalid cursor");
  if (String(payload.organization_id || "") !== expected.organizationId) throw new Error("Cursor does not match the requested organization");
  if (String(payload.run_id || "") !== expected.runId) throw new Error("Cursor does not match the requested run");
  if (String(payload.product_id || "") !== String(expected.productId || "")) throw new Error("Cursor does not match the requested product filter");
  if (String(payload.field_family || "") !== String(expected.fieldFamily || "")) throw new Error("Cursor does not match the requested field filter");
  if (String(payload.comparison_result || "") !== String(expected.comparisonResult || "")) throw new Error("Cursor does not match the requested comparison filter");
  if (String(payload.recommendation || "") !== String(expected.recommendation || "")) throw new Error("Cursor does not match the requested recommendation filter");
}

function encodeCursor(record, filters) {
  const payload = {
    v: 1,
    organization_id: filters.organizationId,
    run_id: filters.runId,
    product_id: filters.productId || "",
    field_family: filters.fieldFamily || "",
    comparison_result: filters.comparisonResult || "",
    recommendation: filters.recommendation || "",
    sort_recommendation: String(record.recommendation || ""),
    product_code: String(record.product_code || ""),
    sort_field_family: String(record.field_family || ""),
    observation_id: String(record.observation_id || ""),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    return JSON.parse(Buffer.from(String(cursor || ""), "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor");
  }
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || "").trim());
}

function buildUndecidedDecisionState({
  organizationId,
  reviewItemId,
  recommendationFingerprint,
  reviewItemFingerprint,
  productTargetFingerprint,
}) {
  return {
    organization_id: organizationId,
    review_item_id: reviewItemId,
    current_decision: "UNDECIDED",
    current_event_id: null,
    reviewer_user_id: null,
    reviewer_role: null,
    decided_at: null,
    decision_version: 0,
    is_reversed: false,
    is_superseded: false,
    is_invalidated: false,
    is_stale: false,
    requires_re_review: false,
    recommendation_fingerprint_at_decision: null,
    current_recommendation_fingerprint: recommendationFingerprint,
    review_item_fingerprint_at_decision: null,
    current_review_item_fingerprint: reviewItemFingerprint,
    product_target_fingerprint_at_decision: null,
    current_product_target_fingerprint: productTargetFingerprint,
    apply_eligible: false,
    apply_block_reasons: ["NO_ACCEPT_DECISION"],
  };
}
