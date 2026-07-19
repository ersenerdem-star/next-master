export type CatalogObservationReviewComparisonResult =
  | "NO_CHANGE"
  | "ENRICHMENT_CANDIDATE"
  | "CONFLICT"
  | "INSUFFICIENT_EVIDENCE"
  | "UNSUPPORTED_FIELD"
  | string;

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
