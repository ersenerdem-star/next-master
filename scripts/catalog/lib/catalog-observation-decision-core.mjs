import { createHash } from "node:crypto";
import { COMPARISON_RESULTS, SUPPORTED_FIELD_FAMILIES } from "./catalog-observation-review-core.mjs";

export const RECOMMENDATIONS = Object.freeze({
  AUTO_SAFE: "AUTO_SAFE",
  LIKELY_ACCEPT: "LIKELY_ACCEPT",
  MANUAL_REQUIRED: "MANUAL_REQUIRED",
  LIKELY_REJECT: "LIKELY_REJECT",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
});

export const RULES = Object.freeze({
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  LIKELY_REJECT: "likely_reject",
  MANUAL_REQUIRED: "manual_required",
  LIKELY_ACCEPT: "likely_accept",
  AUTO_SAFE: "auto_safe",
});

export const RULE_PRECEDENCE = Object.freeze([
  RULES.INSUFFICIENT_EVIDENCE,
  RULES.LIKELY_REJECT,
  RULES.MANUAL_REQUIRED,
  RULES.LIKELY_ACCEPT,
  RULES.AUTO_SAFE,
]);

export const DECISION_THRESHOLDS = Object.freeze({
  lowTrustScore: 0.5,
  likelyAcceptTrustScore: 0.75,
  autoSafeTrustScore: 0.9,
  lowConfidence: 0.5,
  likelyAcceptConfidence: 0.75,
  autoSafeConfidence: 0.9,
  staleAgeDays: 180,
  maximumReviewItems: 25,
  minimumAcceptedTrustLevel: "T5",
  autoSafeMinimumTrustLevel: "T3",
});

export const SCORE_WEIGHTS = Object.freeze({
  sourceTrust: 24,
  observationConfidence: 24,
  evidenceCompleteness: 16,
  successfulRun: 10,
  sourceConsistency: 8,
  independentCorroboration: 10,
  freshness: 8,
  conflictPenalty: -18,
  ambiguityPenalty: -12,
  missingOptionalEvidencePenalty: -4,
});

const SUCCESSFUL_RUN_STATUSES = new Set(["succeeded"]);

export function buildDecisionRecommendations({
  reviewQueue,
  observationsById,
  productsById = new Map(),
  sourcesById = new Map(),
  trustProfilesById = new Map(),
  runsById = new Map(),
  allObservations = [],
  generatedAt = new Date().toISOString(),
  now = generatedAt,
}) {
  if (!Array.isArray(reviewQueue)) throw new Error("reviewQueue must be an array.");
  if (reviewQueue.length > DECISION_THRESHOLDS.maximumReviewItems) {
    throw new Error(`Decision engine refuses unbounded review input above ${DECISION_THRESHOLDS.maximumReviewItems} items.`);
  }

  return reviewQueue.map((item) => {
    const observationId = item.observation || item.observation_id;
    const productId = item.product || item.product_id;
    const sourceId = item.source || item.source_id;
    const runId = item.run || item.run_id;
    return recommendReviewItem({
      reviewItem: item,
      observation: observationsById.get(observationId) || null,
      product: productsById.get(productId) || null,
      source: sourcesById.get(sourceId) || null,
      trustProfile: trustProfilesById.get(sourceId) || null,
      run: runsById.get(runId) || null,
      allObservations,
      generatedAt,
      now,
    });
  });
}

export function recommendReviewItem({
  reviewItem,
  observation,
  product = null,
  source = null,
  trustProfile = null,
  run = null,
  allObservations = [],
  generatedAt = new Date().toISOString(),
  now = generatedAt,
}) {
  const normalizedInput = normalizeDecisionInput({ reviewItem, observation, product, source, trustProfile, run, allObservations, now });
  const rulesEvaluated = evaluateRules(normalizedInput);
  const winning = rulesEvaluated.find((rule) => rule.matched) || rulesEvaluated[rulesEvaluated.length - 1];
  const score = scoreDecision(normalizedInput);
  const body = buildRecommendationBody({ normalizedInput, rulesEvaluated, winning, score });
  return {
    ...body,
    generated_at: generatedAt,
    recommendation_fingerprint: fingerprintRecommendation(body),
  };
}

export function fingerprintRecommendation(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function normalizeDecisionInput({ reviewItem, observation, product, source, trustProfile, run, allObservations, now }) {
  const fieldFamily = String(reviewItem?.field || reviewItem?.field_family || observation?.field_family || "").trim();
  const comparisonResult = String(reviewItem?.comparison_result || "").trim();
  const confidence = normalizeUnitNumber(observation?.confidence ?? reviewItem?.confidence);
  const trustLevel = String(trustProfile?.trust_level || "").trim();
  const trustScore = normalizeUnitNumber(trustProfile?.trust_score);
  const evidenceReference = String(observation?.evidence_reference || "").trim();
  const evidenceHash = String(observation?.evidence_hash || "").trim();
  const evidenceUrl = String(observation?.evidence_url || "").trim();
  const observationValue = String(observation?.raw_value || observation?.normalized_value || "").trim();
  const runStatus = String(run?.status || "").trim();
  const observationAgeDays = ageInDays(observation?.observed_at || observation?.ingested_at, now);
  const evidenceComplete = Boolean(evidenceReference && evidenceHash);
  const externalProductReferencePresent = Boolean(String(observation?.external_product_ref || "").trim());
  const independence = analyzeEvidenceIndependence({ observation, allObservations });
  const contradiction = analyzeContradiction({ observation, allObservations });

  return {
    organization_id: reviewItem?.organization || reviewItem?.organization_id || observation?.organization_id || product?.organization_id || null,
    product_id: reviewItem?.product || reviewItem?.product_id || observation?.catalog_product_id || product?.id || null,
    observation_id: reviewItem?.observation || reviewItem?.observation_id || observation?.id || null,
    review_queue_key: buildReviewQueueKey(reviewItem, observation),
    field_family: fieldFamily,
    comparison_result: comparisonResult,
    source_key: source?.source_key || source?.display_name || observation?.source_id || reviewItem?.source || null,
    source_trust_level: trustLevel || null,
    source_trust_score: trustScore,
    observation_confidence: confidence,
    evidence_reference: evidenceReference,
    evidence_hash: evidenceHash,
    evidence_url: evidenceUrl,
    evidence_complete: evidenceComplete,
    external_product_reference_present: externalProductReferencePresent,
    run_status: runStatus || null,
    observation_value_present: Boolean(observationValue),
    product_linked: Boolean((reviewItem?.product || reviewItem?.product_id || observation?.catalog_product_id) && product?.id),
    observation_linked: Boolean(observation?.id),
    observation_age_days: observationAgeDays,
    independent_agreeing_evidence_count: independence.independentAgreeingEvidenceCount,
    duplicate_identical_evidence_count: independence.duplicateIdenticalEvidenceCount,
    contradiction_count: contradiction.contradictionCount,
    has_contradiction: contradiction.contradictionCount > 0,
    has_ambiguous_evidence: contradiction.contradictionCount > 0 || independence.duplicateIdenticalEvidenceCount > 0,
    product_target_empty: String(reviewItem?.reason || "").includes("Product value is empty")
      || (comparisonResult === COMPARISON_RESULTS.ENRICHMENT_CANDIDATE && String(reviewItem?.product_value || "").trim() === ""),
  };
}

function evaluateRules(input) {
  return [
    evaluateInsufficientEvidence(input),
    evaluateLikelyReject(input),
    evaluateManualRequired(input),
    evaluateLikelyAccept(input),
    evaluateAutoSafe(input),
  ];
}

function evaluateInsufficientEvidence(input) {
  const reasons = [];
  if (!SUPPORTED_FIELD_FAMILIES.has(input.field_family)) reasons.push("unsupported field family");
  if (!input.observation_value_present) reasons.push("missing observation value");
  if (!input.evidence_hash) reasons.push("missing evidence hash");
  if (!input.evidence_reference) reasons.push("missing evidence reference");
  if (!input.source_trust_level || input.source_trust_score === null) reasons.push("missing source trust profile");
  if (!SUCCESSFUL_RUN_STATUSES.has(input.run_status || "")) reasons.push("acquisition run did not succeed");
  if (input.observation_confidence === null) reasons.push("missing or invalid confidence");
  if (!input.product_linked || !input.observation_linked) reasons.push("missing Product or observation linkage");
  return ruleResult(RULES.INSUFFICIENT_EVIDENCE, reasons.length > 0, reasons);
}

function evaluateLikelyReject(input) {
  const reasons = [];
  if (input.source_trust_score !== null && input.source_trust_score < DECISION_THRESHOLDS.lowTrustScore) reasons.push("trust score below 0.50");
  if (input.observation_confidence !== null && input.observation_confidence < DECISION_THRESHOLDS.lowConfidence) reasons.push("observation confidence below 0.50");
  if (isTrustLevelWorseThan(input.source_trust_level, DECISION_THRESHOLDS.minimumAcceptedTrustLevel)) {
    reasons.push("source trust level below accepted observation tier");
  }
  if (input.observation_age_days !== null && input.observation_age_days > DECISION_THRESHOLDS.staleAgeDays) {
    reasons.push("evidence is stale");
  }
  if (input.has_contradiction && input.comparison_result !== COMPARISON_RESULTS.CONFLICT) {
    reasons.push("deterministic source/evidence contradiction");
  }
  return ruleResult(RULES.LIKELY_REJECT, reasons.length > 0, reasons);
}

function evaluateManualRequired(input) {
  const reasons = [];
  if (input.comparison_result === COMPARISON_RESULTS.CONFLICT) reasons.push("valid conflict requires human review");
  if (input.has_ambiguous_evidence) reasons.push("ambiguous or duplicated evidence requires human review");
  if (input.source_trust_score !== null
    && input.source_trust_score >= DECISION_THRESHOLDS.lowTrustScore
    && input.source_trust_score < DECISION_THRESHOLDS.likelyAcceptTrustScore) {
    reasons.push("source trust is in the middle band");
  }
  if (input.observation_confidence !== null
    && input.observation_confidence >= DECISION_THRESHOLDS.lowConfidence
    && input.observation_confidence < DECISION_THRESHOLDS.likelyAcceptConfidence) {
    reasons.push("observation confidence is in the middle band");
  }
  return ruleResult(RULES.MANUAL_REQUIRED, reasons.length > 0, reasons);
}

function evaluateLikelyAccept(input) {
  const reasons = [];
  if (input.comparison_result === COMPARISON_RESULTS.ENRICHMENT_CANDIDATE) reasons.push("review item is an enrichment candidate");
  if (input.evidence_complete) reasons.push("evidence hash and reference are present");
  if (SUCCESSFUL_RUN_STATUSES.has(input.run_status || "")) reasons.push("acquisition run succeeded");
  if ((input.source_trust_score ?? -1) >= DECISION_THRESHOLDS.likelyAcceptTrustScore) reasons.push("trust score meets likely accept threshold");
  if ((input.observation_confidence ?? -1) >= DECISION_THRESHOLDS.likelyAcceptConfidence) reasons.push("confidence meets likely accept threshold");
  if (SUPPORTED_FIELD_FAMILIES.has(input.field_family)) reasons.push("field family is supported");
  if (!input.has_contradiction) reasons.push("no deterministic contradiction is present");

  const autoSafeRequirementsMet = autoSafeConditionsMet(input);
  const matched = (
    input.comparison_result === COMPARISON_RESULTS.ENRICHMENT_CANDIDATE
    && input.evidence_complete
    && SUCCESSFUL_RUN_STATUSES.has(input.run_status || "")
    && (input.source_trust_score ?? -1) >= DECISION_THRESHOLDS.likelyAcceptTrustScore
    && (input.observation_confidence ?? -1) >= DECISION_THRESHOLDS.likelyAcceptConfidence
    && SUPPORTED_FIELD_FAMILIES.has(input.field_family)
    && !input.has_contradiction
    && !autoSafeRequirementsMet
  );
  return ruleResult(RULES.LIKELY_ACCEPT, matched, reasons);
}

function evaluateAutoSafe(input) {
  const reasons = [];
  if (input.comparison_result === COMPARISON_RESULTS.ENRICHMENT_CANDIDATE) reasons.push("review item is an enrichment candidate");
  if (input.product_target_empty) reasons.push("Product target field is empty");
  if (input.evidence_complete) reasons.push("evidence hash and reference are present");
  if (SUCCESSFUL_RUN_STATUSES.has(input.run_status || "")) reasons.push("acquisition run succeeded");
  if (!isTrustLevelWorseThan(input.source_trust_level, DECISION_THRESHOLDS.autoSafeMinimumTrustLevel)) reasons.push("source trust level meets AUTO_SAFE threshold");
  if ((input.source_trust_score ?? -1) >= DECISION_THRESHOLDS.autoSafeTrustScore) reasons.push("trust score meets AUTO_SAFE threshold");
  if ((input.observation_confidence ?? -1) >= DECISION_THRESHOLDS.autoSafeConfidence) reasons.push("confidence meets AUTO_SAFE threshold");
  if (input.independent_agreeing_evidence_count >= 2) reasons.push("at least two independent approved evidence records agree");
  if (!input.has_contradiction) reasons.push("no contradictory approved observation exists");
  if (input.observation_age_days !== null && input.observation_age_days <= DECISION_THRESHOLDS.staleAgeDays) reasons.push("observation is within freshness threshold");

  const matched = autoSafeConditionsMet(input);
  return ruleResult(RULES.AUTO_SAFE, matched, reasons);
}

function autoSafeConditionsMet(input) {
  return (
    input.comparison_result === COMPARISON_RESULTS.ENRICHMENT_CANDIDATE
    && input.product_target_empty
    && input.evidence_complete
    && SUCCESSFUL_RUN_STATUSES.has(input.run_status || "")
    && !isTrustLevelWorseThan(input.source_trust_level, DECISION_THRESHOLDS.autoSafeMinimumTrustLevel)
    && (input.source_trust_score ?? -1) >= DECISION_THRESHOLDS.autoSafeTrustScore
    && (input.observation_confidence ?? -1) >= DECISION_THRESHOLDS.autoSafeConfidence
    && input.independent_agreeing_evidence_count >= 2
    && !input.has_contradiction
    && input.observation_age_days !== null
    && input.observation_age_days <= DECISION_THRESHOLDS.staleAgeDays
  );
}

function buildRecommendationBody({ normalizedInput, rulesEvaluated, winning, score }) {
  const positiveFactors = buildPositiveFactors(normalizedInput);
  const negativeFactors = buildNegativeFactors(normalizedInput, winning);
  return {
    organization_id: normalizedInput.organization_id,
    product_id: normalizedInput.product_id,
    observation_id: normalizedInput.observation_id,
    review_queue_key: normalizedInput.review_queue_key,
    field_family: normalizedInput.field_family,
    comparison_result: normalizedInput.comparison_result,
    recommendation: recommendationForRule(winning.rule),
    score,
    positive_factors: positiveFactors,
    negative_factors: negativeFactors,
    rules_evaluated: rulesEvaluated,
    winning_rule: winning.rule,
    human_explanation: buildHumanExplanation({ normalizedInput, winning, positiveFactors, negativeFactors }),
    source_key: normalizedInput.source_key,
    source_trust_level: normalizedInput.source_trust_level,
    source_trust_score: normalizedInput.source_trust_score,
    observation_confidence: normalizedInput.observation_confidence,
    evidence_complete: normalizedInput.evidence_complete,
    run_status: normalizedInput.run_status,
  };
}

function scoreDecision(input) {
  let score = 0;
  score += Math.round(SCORE_WEIGHTS.sourceTrust * (input.source_trust_score ?? 0));
  score += Math.round(SCORE_WEIGHTS.observationConfidence * (input.observation_confidence ?? 0));
  if (input.evidence_complete) score += SCORE_WEIGHTS.evidenceCompleteness;
  if (SUCCESSFUL_RUN_STATUSES.has(input.run_status || "")) score += SCORE_WEIGHTS.successfulRun;
  if (!input.has_contradiction) score += SCORE_WEIGHTS.sourceConsistency;
  if (input.independent_agreeing_evidence_count >= 2) score += SCORE_WEIGHTS.independentCorroboration;
  if (input.observation_age_days !== null && input.observation_age_days <= DECISION_THRESHOLDS.staleAgeDays) score += SCORE_WEIGHTS.freshness;
  if (input.comparison_result === COMPARISON_RESULTS.CONFLICT) score += SCORE_WEIGHTS.conflictPenalty;
  if (input.has_ambiguous_evidence) score += SCORE_WEIGHTS.ambiguityPenalty;
  if (!input.external_product_reference_present) score += SCORE_WEIGHTS.missingOptionalEvidencePenalty;
  return Math.max(0, Math.min(100, score));
}

function buildPositiveFactors(input) {
  const factors = [];
  if (SUPPORTED_FIELD_FAMILIES.has(input.field_family)) factors.push("supported field family");
  if (input.evidence_complete) factors.push("evidence hash and reference present");
  if (SUCCESSFUL_RUN_STATUSES.has(input.run_status || "")) factors.push("acquisition run succeeded");
  if ((input.source_trust_score ?? 0) >= DECISION_THRESHOLDS.likelyAcceptTrustScore) factors.push("source trust score is strong");
  if ((input.observation_confidence ?? 0) >= DECISION_THRESHOLDS.likelyAcceptConfidence) factors.push("observation confidence is strong");
  if (!input.has_contradiction) factors.push("no deterministic contradiction");
  if (input.independent_agreeing_evidence_count >= 2) factors.push("independent corroboration present");
  if (input.observation_age_days !== null && input.observation_age_days <= DECISION_THRESHOLDS.staleAgeDays) factors.push("evidence is fresh");
  return factors;
}

function buildNegativeFactors(input, winning) {
  const factors = [...winning.reasons];
  if (input.comparison_result === COMPARISON_RESULTS.CONFLICT && !factors.includes("valid conflict requires human review")) {
    factors.push("valid conflict requires human review");
  }
  if (input.independent_agreeing_evidence_count < 2) factors.push("independent corroboration is not proven");
  if (!input.external_product_reference_present) factors.push("external product reference is absent");
  return dedupe(factors);
}

function buildHumanExplanation({ normalizedInput, winning, positiveFactors, negativeFactors }) {
  const recommendation = recommendationForRule(winning.rule);
  return [
    `${recommendation} was selected by ${winning.rule}.`,
    `Comparison result is ${normalizedInput.comparison_result} for ${normalizedInput.field_family}.`,
    positiveFactors.length ? `Positive factors: ${positiveFactors.join("; ")}.` : "Positive factors: none.",
    negativeFactors.length ? `Negative factors: ${negativeFactors.join("; ")}.` : "Negative factors: none.",
    "This is advisory only and does not approve, review, publish, apply, or mutate Catalog truth.",
  ].join(" ");
}

function recommendationForRule(rule) {
  if (rule === RULES.AUTO_SAFE) return RECOMMENDATIONS.AUTO_SAFE;
  if (rule === RULES.LIKELY_ACCEPT) return RECOMMENDATIONS.LIKELY_ACCEPT;
  if (rule === RULES.MANUAL_REQUIRED) return RECOMMENDATIONS.MANUAL_REQUIRED;
  if (rule === RULES.LIKELY_REJECT) return RECOMMENDATIONS.LIKELY_REJECT;
  return RECOMMENDATIONS.INSUFFICIENT_EVIDENCE;
}

function ruleResult(rule, matched, reasons) {
  return { rule, matched, reasons: dedupe(reasons).sort() };
}

function buildReviewQueueKey(reviewItem, observation) {
  return [
    reviewItem?.organization || reviewItem?.organization_id || observation?.organization_id || "unknown-org",
    reviewItem?.product || reviewItem?.product_id || observation?.catalog_product_id || "unknown-product",
    reviewItem?.observation || reviewItem?.observation_id || observation?.id || "unknown-observation",
    reviewItem?.field || reviewItem?.field_family || observation?.field_family || "unknown-field",
  ].join(":");
}

function analyzeEvidenceIndependence({ observation, allObservations }) {
  if (!observation?.id) return { independentAgreeingEvidenceCount: 0, duplicateIdenticalEvidenceCount: 0 };
  const sameValue = allObservations.filter((candidate) => (
    candidate.catalog_product_id === observation.catalog_product_id
    && candidate.field_family === observation.field_family
    && String(candidate.normalized_value || candidate.raw_value || "").trim() === String(observation.normalized_value || observation.raw_value || "").trim()
    && candidate.evidence_hash
    && candidate.evidence_reference
  ));
  const independentKeys = new Set(sameValue.map((candidate) => [
    candidate.source_id || "unknown-source",
    candidate.evidence_reference || "unknown-evidence",
  ].join(":")));
  const duplicateKeys = new Set(sameValue.map((candidate) => String(candidate.deduplication_key || candidate.evidence_hash || candidate.id || "")));
  return {
    independentAgreeingEvidenceCount: independentKeys.size,
    duplicateIdenticalEvidenceCount: Math.max(0, sameValue.length - duplicateKeys.size),
  };
}

function analyzeContradiction({ observation, allObservations }) {
  if (!observation?.id) return { contradictionCount: 0 };
  const currentValue = String(observation.normalized_value || observation.raw_value || "").trim();
  const contradictions = allObservations.filter((candidate) => (
    candidate.id !== observation.id
    && candidate.catalog_product_id === observation.catalog_product_id
    && candidate.field_family === observation.field_family
    && candidate.evidence_hash
    && candidate.evidence_reference
    && String(candidate.normalized_value || candidate.raw_value || "").trim()
    && String(candidate.normalized_value || candidate.raw_value || "").trim() !== currentValue
  ));
  return { contradictionCount: contradictions.length };
}

function normalizeUnitNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(1, numeric));
}

function trustLevelRank(level) {
  const match = String(level || "").trim().match(/^T([1-6])$/);
  return match ? Number(match[1]) : null;
}

function isTrustLevelWorseThan(level, threshold) {
  const rank = trustLevelRank(level);
  const thresholdRank = trustLevelRank(threshold);
  if (rank === null || thresholdRank === null) return true;
  return rank > thresholdRank;
}

function ageInDays(value, now) {
  const observed = Date.parse(value || "");
  const reference = Date.parse(now || "");
  if (!Number.isFinite(observed) || !Number.isFinite(reference)) return null;
  return Math.max(0, Math.floor((reference - observed) / 86_400_000));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
