export type CatalogObservationReviewComparisonResult =
  | "NO_CHANGE"
  | "ENRICHMENT_CANDIDATE"
  | "CONFLICT"
  | "INSUFFICIENT_EVIDENCE"
  | "UNSUPPORTED_FIELD"
  | string;

export const CATALOG_OBSERVATION_REVIEW_DECISION_TYPES = [
  "ACCEPT_RECOMMENDATION",
  "REJECT_RECOMMENDATION",
  "DEFER",
  "REQUEST_MORE_EVIDENCE",
] as const;

export type CatalogObservationReviewDecisionType = (typeof CATALOG_OBSERVATION_REVIEW_DECISION_TYPES)[number];

export const CATALOG_OBSERVATION_REVIEW_DECISION_REASON_CODES = {
  ACCEPT_RECOMMENDATION: ["EVIDENCE_SUFFICIENT", "VERIFIED_AGAINST_CURRENT_PRODUCT", "TRUSTED_OFFICIAL_SOURCE"],
  REJECT_RECOMMENDATION: ["INCORRECT_OBSERVATION", "INSUFFICIENT_EVIDENCE", "CONFLICTS_WITH_CANONICAL_DATA", "WRONG_PRODUCT_MATCH", "FIELD_NOT_APPLICABLE"],
  DEFER: ["NEEDS_SECOND_REVIEW", "WAITING_FOR_SOURCE_CONFIRMATION", "TEMPORARY_REVIEW_HOLD"],
  REQUEST_MORE_EVIDENCE: ["MISSING_PRIMARY_SOURCE", "CONFLICTING_SOURCES", "LOW_CONFIDENCE", "INCOMPLETE_PRODUCT_MATCH"],
} as const;

export type CatalogObservationReviewDecisionReasonCode =
  | (typeof CATALOG_OBSERVATION_REVIEW_DECISION_REASON_CODES.ACCEPT_RECOMMENDATION)[number]
  | (typeof CATALOG_OBSERVATION_REVIEW_DECISION_REASON_CODES.REJECT_RECOMMENDATION)[number]
  | (typeof CATALOG_OBSERVATION_REVIEW_DECISION_REASON_CODES.DEFER)[number]
  | (typeof CATALOG_OBSERVATION_REVIEW_DECISION_REASON_CODES.REQUEST_MORE_EVIDENCE)[number];

export const CATALOG_OBSERVATION_REVIEW_REVERSAL_REASON_CODES = [
  "DECISION_ENTERED_IN_ERROR",
  "NEW_EVIDENCE_RECEIVED",
  "RECOMMENDATION_CHANGED",
  "PRODUCT_STATE_CHANGED",
] as const;

export type CatalogObservationReviewReversalReasonCode = (typeof CATALOG_OBSERVATION_REVIEW_REVERSAL_REASON_CODES)[number];

export type CatalogObservationReviewRecommendation =
  | "AUTO_SAFE"
  | "LIKELY_ACCEPT"
  | "MANUAL_REQUIRED"
  | "LIKELY_REJECT"
  | "INSUFFICIENT_EVIDENCE"
  | string;

export type CatalogObservationReviewRuleEvaluation = {
  rule: string;
  matched: boolean;
  reasons: string[];
};

export type CatalogObservationReviewItem = {
  organization_id: string;
  run_id: string;
  review_queue_id: string;
  product_id: string | null;
  brand_id: string;
  brand_name: string;
  product_code: string;
  normalized_product_code: string;
  observation_id: string | null;
  field_family: string;
  comparison_result: CatalogObservationReviewComparisonResult;
  comparison_reason: string;
  product_value: string;
  observation_value: string;
  normalized_product_value: string;
  normalized_observation_value: string;
  recommendation: CatalogObservationReviewRecommendation;
  score: number;
  explanation: string;
  rules: CatalogObservationReviewRuleEvaluation[];
  winning_rule: string;
  recommendation_fingerprint: string;
  observation_fingerprint: string;
  review_item_fingerprint: string;
  product_target_fingerprint: string;
  source_key: string | null;
  source_display_name: string | null;
  source_trust_level: string | null;
  source_trust_score: number | null;
  observation_confidence: number | null;
  evidence_complete: boolean;
  evidence_reference: string | null;
  evidence_url: string | null;
  observed_at: string | null;
  run_status: string | null;
  positive_factors: string[];
  negative_factors: string[];
  reviewer: string | null;
  decision: string | null;
  decision_state: CatalogObservationReviewDecisionState;
  created_at: string;
};

export type CatalogObservationReviewDecisionState = {
  organization_id: string | null;
  review_item_id: string | null;
  current_decision: string | null;
  current_event_id: string | null;
  reviewer_user_id: string | null;
  reviewer_role: string | null;
  decided_at: string | null;
  decision_version: number;
  is_reversed: boolean;
  is_superseded: boolean;
  is_invalidated: boolean;
  is_stale: boolean;
  requires_re_review: boolean;
  recommendation_fingerprint_at_decision: string | null;
  current_recommendation_fingerprint: string | null;
  review_item_fingerprint_at_decision: string | null;
  current_review_item_fingerprint: string | null;
  product_target_fingerprint_at_decision: string | null;
  current_product_target_fingerprint: string | null;
  apply_eligible: boolean;
  apply_block_reasons: string[];
};

export type CatalogObservationReviewDecisionEvent = {
  event_id: string | null;
  review_item_id: string | null;
  event_type: string | null;
  decision_type: string | null;
  reason_code: string | null;
  decision_version: number;
  reviewer_user_id: string | null;
  reviewer_role: string | null;
  decided_at: string | null;
  reversal_target_event_id: string | null;
};

export type CatalogObservationReviewDecisionCommandInput = {
  reviewItemId: string;
  decisionType: CatalogObservationReviewDecisionType;
  reasonCode: CatalogObservationReviewDecisionReasonCode;
  reviewerNote: string;
  expectedDecisionVersion: number;
  expectedRecommendationFingerprint: string;
  expectedReviewItemFingerprint: string;
  expectedProductTargetFingerprint: string;
  idempotencyKey: string;
};

export type CatalogObservationReviewDecisionReversalInput = {
  reviewItemId: string;
  targetDecisionEventId: string;
  reasonCode: CatalogObservationReviewReversalReasonCode;
  reviewerNote: string;
  expectedDecisionVersion: number;
  idempotencyKey: string;
};

export type CatalogObservationReviewDecisionCommandResult = {
  schema_version: string;
  success: boolean;
  action: "record_decision" | "reverse_decision" | string;
  replayed: boolean;
  event: CatalogObservationReviewDecisionEvent;
  current_state: CatalogObservationReviewDecisionState;
};

export type CatalogObservationReviewSummary = {
  total_observations: number;
  review_queue_count: number;
  matching_item_count: number;
  comparison_totals: Record<string, number>;
  recommendation_totals: Record<string, number>;
};

export type CatalogObservationReviewPage = {
  limit: number;
  cursor: string | null;
  next_cursor: string | null;
  has_more: boolean;
  returned_count: number;
  total_count: number;
};

export type CatalogObservationReviewResponse = {
  schema_version: string;
  organization_id: string;
  run_id: string;
  items: CatalogObservationReviewItem[];
  page: CatalogObservationReviewPage;
  summary: CatalogObservationReviewSummary;
};
