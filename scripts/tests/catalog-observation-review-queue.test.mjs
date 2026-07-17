import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPARISON_RESULTS,
  buildReviewQueue,
  compareObservationToProduct,
  normalizeDescriptionValue,
  normalizeImageValue,
  summarizeComparisons,
} from "../catalog/lib/catalog-observation-review-core.mjs";

const createdAt = "2026-07-17T00:00:00.000Z";

const baseProduct = {
  id: "product-1",
  organization_id: "org-1",
  image_url: "https://example.com/a/b",
  description: "Shock Absorber",
};

const baseObservation = {
  id: "observation-1",
  organization_id: "org-1",
  source_id: "source-1",
  run_id: "run-1",
  catalog_product_id: "product-1",
  field_family: "image_reference",
  raw_value: "https://example.com//a/b/",
  normalized_value: "https://example.com/a/b",
  evidence_reference: "evidence-1",
  confidence: 0.8,
};

test("same image resolves to NO_CHANGE", () => {
  const comparison = compareObservationToProduct({ product: baseProduct, observation: baseObservation, createdAt });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.NO_CHANGE);
  assert.equal(comparison.normalized_product_value, "https://example.com/a/b");
  assert.equal(comparison.normalized_observation_value, "https://example.com/a/b");
});

test("same description resolves to NO_CHANGE with case-insensitive comparison", () => {
  const comparison = compareObservationToProduct({
    product: { ...baseProduct, description: "Shock Absorber" },
    observation: {
      ...baseObservation,
      field_family: "supplemental_description",
      raw_value: " shock\r\nabsorber ",
      normalized_value: "shock absorber",
    },
    createdAt,
  });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.NO_CHANGE);
});

test("empty product value resolves to ENRICHMENT_CANDIDATE", () => {
  const comparison = compareObservationToProduct({
    product: { ...baseProduct, image_url: "" },
    observation: baseObservation,
    createdAt,
  });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.ENRICHMENT_CANDIDATE);
});

test("different description resolves to CONFLICT", () => {
  const comparison = compareObservationToProduct({
    product: { ...baseProduct, description: "Old description" },
    observation: {
      ...baseObservation,
      field_family: "supplemental_description",
      raw_value: "New description",
      normalized_value: "new description",
    },
    createdAt,
  });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.CONFLICT);
});

test("different image resolves to CONFLICT", () => {
  const comparison = compareObservationToProduct({
    product: baseProduct,
    observation: { ...baseObservation, raw_value: "https://example.com/c/d" },
    createdAt,
  });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.CONFLICT);
});

test("unsupported field resolves to UNSUPPORTED_FIELD", () => {
  const comparison = compareObservationToProduct({
    product: baseProduct,
    observation: { ...baseObservation, field_family: "fitment" },
    createdAt,
  });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.UNSUPPORTED_FIELD);
});

test("missing evidence resolves to INSUFFICIENT_EVIDENCE", () => {
  const comparison = compareObservationToProduct({
    product: baseProduct,
    observation: { ...baseObservation, evidence_reference: "", evidence_hash: "", evidence_url: "" },
    createdAt,
  });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.INSUFFICIENT_EVIDENCE);
});

test("missing Product resolves to INSUFFICIENT_EVIDENCE", () => {
  const comparison = compareObservationToProduct({
    product: null,
    observation: baseObservation,
    createdAt,
  });
  assert.equal(comparison.comparison_result, COMPARISON_RESULTS.INSUFFICIENT_EVIDENCE);
});

test("confidence is preserved and clamped", () => {
  const comparison = compareObservationToProduct({
    product: { ...baseProduct, image_url: "" },
    observation: { ...baseObservation, confidence: 0.91 },
    createdAt,
  });
  assert.equal(comparison.confidence, 0.91);

  const clamped = compareObservationToProduct({
    product: { ...baseProduct, image_url: "" },
    observation: { ...baseObservation, confidence: 2 },
    createdAt,
  });
  assert.equal(clamped.confidence, 1);
});

test("queue includes enrichment and conflict only", () => {
  const enrichment = compareObservationToProduct({
    product: { ...baseProduct, image_url: "" },
    observation: baseObservation,
    createdAt,
  });
  const conflict = compareObservationToProduct({
    product: baseProduct,
    observation: { ...baseObservation, id: "observation-2", raw_value: "https://example.com/c/d" },
    createdAt,
  });
  const noChange = compareObservationToProduct({ product: baseProduct, observation: baseObservation, createdAt });
  const unsupported = compareObservationToProduct({
    product: baseProduct,
    observation: { ...baseObservation, id: "observation-3", field_family: "fitment" },
    createdAt,
  });

  const queue = buildReviewQueue([enrichment, conflict, noChange, unsupported]);
  assert.deepEqual(queue.map((item) => item.observation), ["observation-1", "observation-2"]);
  assert(queue.every((item) => item.reviewer === null && item.decision === null));
});

test("queue excludes insufficient evidence", () => {
  const insufficient = compareObservationToProduct({
    product: null,
    observation: baseObservation,
    createdAt,
  });
  assert.deepEqual(buildReviewQueue([insufficient]), []);
});

test("normalization is deterministic", () => {
  assert.equal(normalizeImageValue(" https://example.com//a///b/ "), "https://example.com/a/b");
  assert.equal(normalizeImageValue("https://example.com/a/b"), normalizeImageValue("https://example.com//a/b/"));
  assert.equal(normalizeDescriptionValue("Line\r\n Break\tValue"), "line break value");
  assert.equal(normalizeDescriptionValue("LINE BREAK VALUE"), normalizeDescriptionValue("line break value"));
});

test("summary counts comparison states", () => {
  const comparisons = [
    compareObservationToProduct({ product: baseProduct, observation: baseObservation, createdAt }),
    compareObservationToProduct({ product: { ...baseProduct, image_url: "" }, observation: baseObservation, createdAt }),
    compareObservationToProduct({ product: baseProduct, observation: { ...baseObservation, raw_value: "x" }, createdAt }),
  ];
  const queue = buildReviewQueue(comparisons);
  assert.deepEqual(summarizeComparisons(comparisons, queue), {
    total: 3,
    NO_CHANGE: 1,
    ENRICHMENT_CANDIDATE: 1,
    CONFLICT: 1,
    INSUFFICIENT_EVIDENCE: 0,
    UNSUPPORTED_FIELD: 0,
    review_queue_count: 2,
  });
});

test("output shape contains required comparison fields", () => {
  const comparison = compareObservationToProduct({ product: baseProduct, observation: baseObservation, createdAt });
  assert.deepEqual(Object.keys(comparison), [
    "organization_id",
    "product_id",
    "observation_id",
    "field_family",
    "product_value",
    "observation_value",
    "normalized_product_value",
    "normalized_observation_value",
    "comparison_result",
    "confidence",
    "reason",
    "created_at",
    "source_id",
    "run_id",
  ]);
});
