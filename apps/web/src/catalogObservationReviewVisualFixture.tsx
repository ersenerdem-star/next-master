import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "./i18n/I18nProvider";
import { ActionFeedbackProvider } from "./presentation/components/common/ActionFeedback";
import { CatalogObservationReviewPage } from "./presentation/pages/CatalogObservationReviewPage";
import type { CatalogObservationReviewItem, CatalogObservationReviewResponse } from "./types/catalogObservationReview";
import "./styles.css";

const organizationId = "00000000-0000-0000-0000-000000000101";
const runId = "00000000-0000-0000-0000-000000000102";

const eligibleDecisionState: CatalogObservationReviewItem["decision_state"] = {
  organization_id: organizationId,
  review_item_id: "fixture-item-image",
  current_decision: "ACCEPT_RECOMMENDATION",
  current_event_id: "00000000-0000-0000-0000-000000000103",
  reviewer_user_id: "00000000-0000-0000-0000-000000000104",
  reviewer_role: "catalog_reviewer",
  decided_at: "2026-07-25T09:00:00.000Z",
  decision_version: 2,
  is_reversed: false,
  is_superseded: false,
  is_invalidated: false,
  is_stale: false,
  requires_re_review: false,
  recommendation_fingerprint_at_decision: "fixture-recommendation-image",
  current_recommendation_fingerprint: "fixture-recommendation-image",
  review_item_fingerprint_at_decision: "fixture-review-image",
  current_review_item_fingerprint: "fixture-review-image",
  product_target_fingerprint_at_decision: "fixture-target-image",
  current_product_target_fingerprint: "fixture-target-image",
  apply_eligible: true,
  apply_block_reasons: [],
};

const blockedDecisionState: CatalogObservationReviewItem["decision_state"] = {
  ...eligibleDecisionState,
  review_item_id: "fixture-item-conflict",
  current_decision: "REVERSED",
  current_event_id: "00000000-0000-0000-0000-000000000105",
  decision_version: 4,
  is_reversed: true,
  requires_re_review: true,
  apply_eligible: false,
  apply_block_reasons: ["NO_ACCEPT_DECISION", "DECISION_REVERSED"],
};

const fixtureItems: CatalogObservationReviewItem[] = [
  {
    organization_id: organizationId,
    run_id: runId,
    review_queue_id: "fixture-item-image",
    product_id: "00000000-0000-0000-0000-000000000106",
    brand_id: "00000000-0000-0000-0000-000000000107",
    brand_name: "Sachs",
    product_code: "000366",
    normalized_product_code: "000366",
    observation_id: "00000000-0000-0000-0000-000000000108",
    field_family: "image_reference",
    comparison_result: "ENRICHMENT_CANDIDATE",
    comparison_reason: "Product image is empty and the trusted observation is current.",
    product_value: "",
    observation_value: "https://example.invalid/catalog/000366.webp",
    normalized_product_value: "",
    normalized_observation_value: "https://example.invalid/catalog/000366.webp",
    recommendation: "LIKELY_ACCEPT",
    score: 76,
    explanation: "Fixture evidence is complete and current; this remains a review-only surface.",
    rules: [{ rule: "likely_accept", matched: true, reasons: ["Trusted source", "Product target empty"] }],
    winning_rule: "likely_accept",
    recommendation_fingerprint: "fixture-recommendation-image",
    observation_fingerprint: "fixture-observation-image",
    review_item_fingerprint: "fixture-review-image",
    product_target_fingerprint: "fixture-target-image",
    source_key: "fixture_official_source",
    source_display_name: "Official brand observation",
    source_trust_level: "T3",
    source_trust_score: 0.8,
    observation_confidence: 0.8,
    evidence_complete: true,
    evidence_reference: "fixture:000366:image_reference",
    evidence_url: "https://example.invalid/catalog/000366",
    observed_at: "2026-07-25T08:00:00.000Z",
    run_status: "succeeded",
    positive_factors: ["Supported field", "Evidence reference present", "Fresh observation"],
    negative_factors: ["Human decision remains required"],
    reviewer: "Catalog reviewer",
    decision: "ACCEPT_RECOMMENDATION",
    decision_state: eligibleDecisionState,
    created_at: "2026-07-25T08:00:00.000Z",
  },
  {
    organization_id: organizationId,
    run_id: runId,
    review_queue_id: "fixture-item-conflict",
    product_id: "00000000-0000-0000-0000-000000000109",
    brand_id: "00000000-0000-0000-0000-000000000107",
    brand_name: "Sachs",
    product_code: "000006",
    normalized_product_code: "000006",
    observation_id: "00000000-0000-0000-0000-000000000110",
    field_family: "supplemental_description",
    comparison_result: "CONFLICT",
    comparison_reason: "Observed wording differs from the current Product description.",
    product_value: "Shock absorber, cab suspension",
    observation_value: "Shock absorber, driver cab suspension",
    normalized_product_value: "SHOCK ABSORBER CAB SUSPENSION",
    normalized_observation_value: "SHOCK ABSORBER DRIVER CAB SUSPENSION",
    recommendation: "MANUAL_REQUIRED",
    score: 58,
    explanation: "A valid conflict needs human review and does not authorize any Product change.",
    rules: [{ rule: "manual_required", matched: true, reasons: ["Valid conflict"] }],
    winning_rule: "manual_required",
    recommendation_fingerprint: "fixture-recommendation-conflict",
    observation_fingerprint: "fixture-observation-conflict",
    review_item_fingerprint: "fixture-review-conflict",
    product_target_fingerprint: "fixture-target-conflict",
    source_key: "fixture_official_source",
    source_display_name: "Official brand observation",
    source_trust_level: "T3",
    source_trust_score: 0.8,
    observation_confidence: 0.8,
    evidence_complete: true,
    evidence_reference: "fixture:000006:supplemental_description",
    evidence_url: "https://example.invalid/catalog/000006",
    observed_at: "2026-07-25T08:00:00.000Z",
    run_status: "succeeded",
    positive_factors: ["Evidence reference present", "Strong source trust"],
    negative_factors: ["Valid conflict", "Re-review required"],
    reviewer: "Catalog reviewer",
    decision: "REVERSED",
    decision_state: blockedDecisionState,
    created_at: "2026-07-25T08:01:00.000Z",
  },
];

const fixtureResponse: CatalogObservationReviewResponse = {
  schema_version: "catalog-observation-review.v1",
  organization_id: organizationId,
  run_id: runId,
  items: fixtureItems,
  page: { limit: 25, cursor: null, next_cursor: null, has_more: false, returned_count: 2, total_count: 2 },
  summary: {
    total_observations: 2,
    review_queue_count: 2,
    matching_item_count: 2,
    comparison_totals: { ENRICHMENT_CANDIDATE: 1, CONFLICT: 1 },
    recommendation_totals: { LIKELY_ACCEPT: 1, MANUAL_REQUIRED: 1 },
  },
};

async function loadFixtureReview() {
  return fixtureResponse;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider preferredLocale="en">
      <ActionFeedbackProvider>
        <CatalogObservationReviewPage loadReview={loadFixtureReview} />
      </ActionFeedbackProvider>
    </I18nProvider>
  </React.StrictMode>,
);
