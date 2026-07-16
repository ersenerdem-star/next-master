import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_FIELD_FAMILIES,
  MAX_OBSERVATIONS,
  MAX_SOURCE_CONCURRENCY,
  buildCheckpointCursor,
  buildObservationInputs,
  deriveFinalStatus,
  normalizeCode,
  parseCodeList,
  runPool,
  validateCliOptions,
} from "../catalog/lib/catalog-observation-pilot-core.mjs";

const baseOptions = {
  dryRun: true,
  confirmProduction: false,
  organizationId: "11111111-1111-4111-8111-111111111111",
  actorId: "22222222-2222-4222-8222-222222222222",
  brand: "SACHS",
  codes: parseCodeList("3000951051"),
};

const product = {
  id: "33333333-3333-4333-8333-333333333333",
  product_code: "3000 951 051",
  normalized_code: "3000951051",
};

const source = {
  product_code: "3000951051",
  external_product_ref: "3000951051",
  source_url: "https://aftermarket.zf.com/tr/catalog/products/3000951051",
  image_url: "https://aftermarket.zf.com/image.jpg",
  description: "Clutch kit",
  observed_at: "2026-07-17T00:00:00.000Z",
};

test("missing confirm production blocks real execution", () => {
  assert.deepEqual(validateCliOptions({ ...baseOptions, dryRun: false, confirmProduction: false }), [
    "real production execution requires --confirm-production",
  ]);
});

test("missing organization is rejected", () => {
  assert(validateCliOptions({ ...baseOptions, organizationId: "" }).includes("organization ID is required"));
});

test("missing actor is rejected", () => {
  assert(validateCliOptions({ ...baseOptions, actorId: "" }).includes("actor ID is required"));
});

test("non-SACHS brand is rejected", () => {
  assert(validateCliOptions({ ...baseOptions, brand: "TRW" }).includes("brand must equal SACHS"));
});

test("empty code list is rejected", () => {
  assert(validateCliOptions({ ...baseOptions, codes: [] }).includes("explicit product-code list is required"));
});

test("more than five unique codes are rejected", () => {
  assert(validateCliOptions({ ...baseOptions, codes: parseCodeList("1,2,3,4,5,6") }).includes("at most 5 unique product codes are allowed"));
});

test("duplicate input codes normalize and dedupe", () => {
  assert.deepEqual(parseCodeList(" 3000 951 051,3000951051, 3000-951-051 "), [
    { input: "3000 951 051", normalized: "3000951051" },
  ]);
});

test("normalization strips punctuation and spaces", () => {
  assert.equal(normalizeCode(" 3 000-951/051 "), "3000951051");
});

test("observation mapping emits only permitted field families", () => {
  const observations = buildObservationInputs({ product, source });
  assert.equal(observations.length, 2);
  assert(observations.every((item) => ALLOWED_FIELD_FAMILIES.has(item.input_field_family)));
  assert.deepEqual(observations.map((item) => item.input_field_family).sort(), ["image_reference", "supplemental_description"]);
});

test("empty source values create no observations", () => {
  assert.deepEqual(buildObservationInputs({ product, source: { ...source, image_url: "", description: "" } }), []);
});

test("evidence hash and reference are stable", () => {
  const first = buildObservationInputs({ product, source });
  const second = buildObservationInputs({ product, source });
  assert.equal(first[0].input_evidence_hash, second[0].input_evidence_hash);
  assert.equal(first[0].input_evidence_reference, second[0].input_evidence_reference);
});

test("maximum source concurrency stays at two", async () => {
  const result = await runPool([1, 2, 3, 4, 5], MAX_SOURCE_CONCURRENCY, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(result.maxActive, 2);
});

test("maximum ten observations is the configured cap", () => {
  assert.equal(MAX_OBSERVATIONS, 10);
});

test("truthful run status", () => {
  assert.equal(deriveFinalStatus({ appendedCount: 0, failureCount: 0 }), "failed");
  assert.equal(deriveFinalStatus({ appendedCount: 1, failureCount: 1 }), "completed_with_warnings");
  assert.equal(deriveFinalStatus({ appendedCount: 1, failureCount: 0 }), "succeeded");
});

test("checkpoint cursor is deterministic and success-only caller controlled", () => {
  const observations = buildObservationInputs({ product, source });
  const first = buildCheckpointCursor({ codes: parseCodeList("3000951051"), observations });
  const second = buildCheckpointCursor({ codes: parseCodeList("3000 951 051"), observations });
  assert.equal(first, second);
  assert(first.startsWith("manual:"));
});
