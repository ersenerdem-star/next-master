export const COMPARISON_RESULTS = Object.freeze({
  NO_CHANGE: "NO_CHANGE",
  ENRICHMENT_CANDIDATE: "ENRICHMENT_CANDIDATE",
  CONFLICT: "CONFLICT",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  UNSUPPORTED_FIELD: "UNSUPPORTED_FIELD",
});

export const SUPPORTED_FIELD_FAMILIES = new Set(["image_reference", "supplemental_description"]);

export function normalizeImageValue(value) {
  const compact = String(value || "").trim().replace(/\s+/g, " ");
  if (!compact) return "";
  const protocolMatch = compact.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  const normalized = protocolMatch
    ? `${protocolMatch[1]}${protocolMatch[2].replace(/\/{2,}/g, "/")}`
    : compact.replace(/\/{2,}/g, "/");
  return normalized.replace(/\/+$/g, "");
}

export function normalizeDescriptionValue(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function normalizeObservationComparableValue(fieldFamily, value) {
  if (fieldFamily === "image_reference") return normalizeImageValue(value);
  if (fieldFamily === "supplemental_description") return normalizeDescriptionValue(value);
  return String(value || "").trim();
}

export function productValueForObservation(product, observation) {
  if (!product) return "";
  if (observation.field_family === "image_reference") return product.image_url || "";
  if (observation.field_family === "supplemental_description") return product.description || "";
  return "";
}

export function observationDisplayValue(observation) {
  return String(observation?.raw_value || observation?.normalized_value || "").trim();
}

export function hasObservationEvidence(observation) {
  return Boolean(
    String(observation?.evidence_reference || "").trim()
      || String(observation?.evidence_hash || "").trim()
      || String(observation?.evidence_url || "").trim(),
  );
}

export function compareObservationToProduct({ observation, product, createdAt = new Date().toISOString() }) {
  const fieldFamily = String(observation?.field_family || "").trim();
  const confidence = normalizeConfidence(observation?.confidence);

  if (!SUPPORTED_FIELD_FAMILIES.has(fieldFamily)) {
    return buildComparison({
      observation,
      product,
      fieldFamily,
      productValue: productValueForObservation(product, observation || {}),
      observationValue: observationDisplayValue(observation),
      result: COMPARISON_RESULTS.UNSUPPORTED_FIELD,
      confidence,
      reason: `Unsupported observation field family: ${fieldFamily || "unknown"}.`,
      createdAt,
    });
  }

  const productValue = productValueForObservation(product, observation);
  const observationValue = observationDisplayValue(observation);
  const normalizedProductValue = normalizeObservationComparableValue(fieldFamily, productValue);
  const normalizedObservationValue = normalizeObservationComparableValue(fieldFamily, observationValue);

  if (!observation?.id || !product?.id || !hasObservationEvidence(observation) || !normalizedObservationValue) {
    return buildComparison({
      observation,
      product,
      fieldFamily,
      productValue,
      observationValue,
      normalizedProductValue,
      normalizedObservationValue,
      result: COMPARISON_RESULTS.INSUFFICIENT_EVIDENCE,
      confidence,
      reason: buildInsufficientReason({ observation, product, normalizedObservationValue }),
      createdAt,
    });
  }

  if (!normalizedProductValue) {
    return buildComparison({
      observation,
      product,
      fieldFamily,
      productValue,
      observationValue,
      normalizedProductValue,
      normalizedObservationValue,
      result: COMPARISON_RESULTS.ENRICHMENT_CANDIDATE,
      confidence,
      reason: "Catalog Product value is empty and trusted observation value is present.",
      createdAt,
    });
  }

  if (normalizedProductValue === normalizedObservationValue) {
    return buildComparison({
      observation,
      product,
      fieldFamily,
      productValue,
      observationValue,
      normalizedProductValue,
      normalizedObservationValue,
      result: COMPARISON_RESULTS.NO_CHANGE,
      confidence,
      reason: "Current Catalog Product value matches the normalized observation value.",
      createdAt,
    });
  }

  return buildComparison({
    observation,
    product,
    fieldFamily,
    productValue,
    observationValue,
    normalizedProductValue,
    normalizedObservationValue,
    result: COMPARISON_RESULTS.CONFLICT,
    confidence,
    reason: "Current Catalog Product value and normalized observation value differ.",
    createdAt,
  });
}

export function buildReviewQueue(comparisons) {
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

export function summarizeComparisons(comparisons, queue) {
  const counts = {
    total: comparisons.length,
    NO_CHANGE: 0,
    ENRICHMENT_CANDIDATE: 0,
    CONFLICT: 0,
    INSUFFICIENT_EVIDENCE: 0,
    UNSUPPORTED_FIELD: 0,
    review_queue_count: queue.length,
  };
  for (const comparison of comparisons) {
    if (Object.prototype.hasOwnProperty.call(counts, comparison.comparison_result)) {
      counts[comparison.comparison_result] += 1;
    }
  }
  return counts;
}

function buildComparison({
  observation,
  product,
  fieldFamily,
  productValue,
  observationValue,
  normalizedProductValue = normalizeObservationComparableValue(fieldFamily, productValue),
  normalizedObservationValue = normalizeObservationComparableValue(fieldFamily, observationValue),
  result,
  confidence,
  reason,
  createdAt,
}) {
  return {
    organization_id: observation?.organization_id || product?.organization_id || null,
    product_id: product?.id || observation?.catalog_product_id || null,
    observation_id: observation?.id || null,
    field_family: fieldFamily,
    product_value: productValue || "",
    observation_value: observationValue || "",
    normalized_product_value: normalizedProductValue || "",
    normalized_observation_value: normalizedObservationValue || "",
    comparison_result: result,
    confidence,
    reason,
    created_at: createdAt,
    source_id: observation?.source_id || null,
    run_id: observation?.run_id || null,
  };
}

function buildInsufficientReason({ observation, product, normalizedObservationValue }) {
  if (!observation?.id) return "Observation row is missing.";
  if (!product?.id) return "Catalog Product is missing.";
  if (!hasObservationEvidence(observation)) return "Observation evidence reference is missing.";
  if (!normalizedObservationValue) return "Observation value is empty after normalization.";
  return "Observation cannot be compared with the current Product value.";
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(1, numeric));
}
