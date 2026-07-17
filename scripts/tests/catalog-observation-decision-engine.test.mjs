import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DECISION_THRESHOLDS,
  RECOMMENDATIONS,
  RULES,
  buildDecisionRecommendations,
  fingerprintRecommendation,
  recommendReviewItem,
} from "../catalog/lib/catalog-observation-decision-core.mjs";
import { runDecisionEngine } from "../catalog/run-catalog-observation-decision-engine.mjs";

const generatedAt = "2026-07-18T00:00:00.000Z";
const now = generatedAt;

const baseReviewItem = {
  organization: "org-1",
  product: "product-1",
  observation: "observation-1",
  field: "image_reference",
  comparison_result: "ENRICHMENT_CANDIDATE",
  confidence: 0.8,
  source: "source-1",
  run: "run-1",
  reviewer: null,
  decision: null,
};

const baseObservation = {
  id: "observation-1",
  organization_id: "org-1",
  source_id: "source-1",
  trust_profile_id: "trust-1",
  run_id: "run-1",
  catalog_product_id: "product-1",
  field_family: "image_reference",
  raw_value: "https://example.com/image.webp",
  normalized_value: "https://example.com/image.webp",
  evidence_reference: "official-detail:1",
  evidence_hash: "hash-1",
  external_product_ref: "source-article-1",
  confidence: 0.8,
  observed_at: "2026-07-17T00:00:00.000Z",
  ingested_at: "2026-07-17T00:00:00.000Z",
  deduplication_key: "dedupe-1",
};

const baseProduct = {
  id: "product-1",
  organization_id: "org-1",
  image_url: "",
  description: "Shock Absorber",
};

const baseSource = {
  id: "source-1",
  source_key: "zf-aftermarket",
  display_name: "ZF Aftermarket",
};

const baseTrustProfile = {
  id: "trust-1",
  source_id: "source-1",
  trust_level: "T1",
  trust_score: 0.8,
};

const baseRun = {
  id: "run-1",
  status: "succeeded",
};

function recommend(overrides = {}) {
  return recommendReviewItem({
    reviewItem: { ...baseReviewItem, ...overrides.reviewItem },
    observation: { ...baseObservation, ...overrides.observation },
    product: { ...baseProduct, ...overrides.product },
    source: { ...baseSource, ...overrides.source },
    trustProfile: { ...baseTrustProfile, ...overrides.trustProfile },
    run: { ...baseRun, ...overrides.run },
    allObservations: overrides.allObservations || [{ ...baseObservation, ...overrides.observation }],
    generatedAt,
    now: overrides.now || now,
  });
}

test("high-confidence enrichment becomes LIKELY_ACCEPT", () => {
  const result = recommend({
    trustProfile: { trust_score: 0.85 },
    observation: { confidence: 0.86 },
  });
  assert.equal(result.recommendation, RECOMMENDATIONS.LIKELY_ACCEPT);
  assert.equal(result.winning_rule, RULES.LIKELY_ACCEPT);
});

test("single-source enrichment does not become AUTO_SAFE", () => {
  const result = recommend({
    trustProfile: { trust_level: "T1", trust_score: 0.95 },
    observation: { confidence: 0.95 },
  });
  assert.notEqual(result.recommendation, RECOMMENDATIONS.AUTO_SAFE);
  assert(result.negative_factors.includes("independent corroboration is not proven"));
});

test("independently corroborated enrichment can become AUTO_SAFE", () => {
  const corroborating = {
    ...baseObservation,
    id: "observation-2",
    source_id: "source-2",
    evidence_reference: "official-detail:2",
    evidence_hash: "hash-2",
    deduplication_key: "dedupe-2",
    confidence: 0.95,
  };
  const result = recommend({
    trustProfile: { trust_level: "T1", trust_score: 0.95 },
    observation: { confidence: 0.95 },
    allObservations: [{ ...baseObservation, confidence: 0.95 }, corroborating],
  });
  assert.equal(result.recommendation, RECOMMENDATIONS.AUTO_SAFE);
  assert.equal(result.winning_rule, RULES.AUTO_SAFE);
});

test("conflict becomes MANUAL_REQUIRED", () => {
  const result = recommend({ reviewItem: { comparison_result: "CONFLICT", field: "supplemental_description" }, observation: { field_family: "supplemental_description" } });
  assert.equal(result.recommendation, RECOMMENDATIONS.MANUAL_REQUIRED);
  assert.equal(result.winning_rule, RULES.MANUAL_REQUIRED);
});

test("unsupported field becomes INSUFFICIENT_EVIDENCE", () => {
  const result = recommend({ reviewItem: { field: "fitment" }, observation: { field_family: "fitment" } });
  assert.equal(result.recommendation, RECOMMENDATIONS.INSUFFICIENT_EVIDENCE);
});

test("missing evidence hash becomes INSUFFICIENT_EVIDENCE", () => {
  const result = recommend({ observation: { evidence_hash: "" } });
  assert.equal(result.recommendation, RECOMMENDATIONS.INSUFFICIENT_EVIDENCE);
});

test("missing evidence reference becomes INSUFFICIENT_EVIDENCE", () => {
  const result = recommend({ observation: { evidence_reference: "" } });
  assert.equal(result.recommendation, RECOMMENDATIONS.INSUFFICIENT_EVIDENCE);
});

test("failed acquisition run becomes INSUFFICIENT_EVIDENCE", () => {
  const result = recommend({ run: { status: "failed" } });
  assert.equal(result.recommendation, RECOMMENDATIONS.INSUFFICIENT_EVIDENCE);
});

test("low trust becomes LIKELY_REJECT", () => {
  const result = recommend({ trustProfile: { trust_score: 0.49 } });
  assert.equal(result.recommendation, RECOMMENDATIONS.LIKELY_REJECT);
});

test("low confidence becomes LIKELY_REJECT", () => {
  const result = recommend({ observation: { confidence: 0.49 } });
  assert.equal(result.recommendation, RECOMMENDATIONS.LIKELY_REJECT);
});

test("middle trust band becomes MANUAL_REQUIRED", () => {
  const result = recommend({ trustProfile: { trust_score: 0.6 } });
  assert.equal(result.recommendation, RECOMMENDATIONS.MANUAL_REQUIRED);
});

test("stale evidence becomes LIKELY_REJECT", () => {
  const result = recommend({ observation: { observed_at: "2025-01-01T00:00:00.000Z" } });
  assert.equal(result.recommendation, RECOMMENDATIONS.LIKELY_REJECT);
});

test("contradictory observations become LIKELY_REJECT by precedence", () => {
  const contradiction = {
    ...baseObservation,
    id: "observation-2",
    normalized_value: "https://example.com/other.webp",
    raw_value: "https://example.com/other.webp",
    evidence_reference: "official-detail:2",
    evidence_hash: "hash-2",
  };
  const result = recommend({ allObservations: [baseObservation, contradiction] });
  assert.equal(result.recommendation, RECOMMENDATIONS.LIKELY_REJECT);
});

test("duplicate identical evidence does not count as independent corroboration", () => {
  const duplicate = { ...baseObservation, id: "observation-2" };
  const result = recommend({
    trustProfile: { trust_level: "T1", trust_score: 0.95 },
    observation: { confidence: 0.95 },
    allObservations: [{ ...baseObservation, confidence: 0.95 }, { ...duplicate, confidence: 0.95 }],
  });
  assert.notEqual(result.recommendation, RECOMMENDATIONS.AUTO_SAFE);
});

test("recommendation, score, rule ordering, and fingerprint are deterministic", () => {
  const first = recommend({ trustProfile: { trust_score: 0.85 }, observation: { confidence: 0.86 } });
  const second = recommend({ trustProfile: { trust_score: 0.85 }, observation: { confidence: 0.86 } });
  assert.equal(first.recommendation, second.recommendation);
  assert.equal(first.score, second.score);
  assert.deepEqual(first.rules_evaluated.map((rule) => rule.rule), [
    RULES.INSUFFICIENT_EVIDENCE,
    RULES.LIKELY_REJECT,
    RULES.MANUAL_REQUIRED,
    RULES.LIKELY_ACCEPT,
    RULES.AUTO_SAFE,
  ]);
  assert.equal(first.recommendation_fingerprint, second.recommendation_fingerprint);
});

test("generated_at is excluded from fingerprint", () => {
  const first = recommend({ trustProfile: { trust_score: 0.85 }, observation: { confidence: 0.86 } });
  const { generated_at: _ignored, recommendation_fingerprint: _fingerprint, ...body } = first;
  assert.equal(first.recommendation_fingerprint, fingerprintRecommendation(body));
});

test("maximum 25-item boundary is enforced", () => {
  const reviewQueue = Array.from({ length: DECISION_THRESHOLDS.maximumReviewItems + 1 }, (_, index) => ({
    ...baseReviewItem,
    observation: `observation-${index}`,
  }));
  assert.throws(() => buildDecisionRecommendations({
    reviewQueue,
    observationsById: new Map(),
  }), /refuses unbounded review input/);
});

test("read-only runner performs no DB mutations", async () => {
  const calls = [];
  const db = {
    async get(table, params) {
      calls.push({ method: "get", table, params });
      if (table === "catalog_external_observations") return [{ ...baseObservation }];
      if (table === "catalog_products") return [{ ...baseProduct }];
      if (table === "catalog_external_sources") return [{ ...baseSource }];
      if (table === "catalog_external_source_trust_profiles") return [{ ...baseTrustProfile }];
      if (table === "catalog_observation_runs") return [{ ...baseRun }];
      return [];
    },
    async count(table, params) {
      calls.push({ method: "count", table, params });
      return 0;
    },
  };
  const artifactDir = mkdtempSync(path.join(tmpdir(), "wp2d-decision-test-"));
  const result = await runDecisionEngine({
    db,
    artifactDir,
    runId: "run-1",
    organizationId: "org-1",
    generatedAt,
    now,
  });
  assert.equal(result.recommendations.length, 1);
  assert(calls.every((call) => call.method === "get" || call.method === "count"));
  assert.equal(calls.some((call) => ["insert", "update", "delete", "rpc"].includes(call.method)), false);
  assert.equal(result.safety.product_snapshots_unchanged, true);
  assert.equal(result.safety.observation_snapshots_unchanged, true);
  assert.equal(result.safety.review_decision_count_unchanged, true);
});
