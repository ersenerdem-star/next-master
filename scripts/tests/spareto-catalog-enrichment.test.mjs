import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUsableCatalogImage,
  mergeMotorserviceSparetoCandidate,
  normalizeCatalogBrand,
  normalizeCatalogPartNumber,
  validateSparetoEnrichment,
} from "../_shared/spareto-catalog-enrichment.mjs";

const primary = {
  brand: "Pierburg",
  product_code: "7.12477.00.0",
  normalized_code: "7.12477.00.0",
  weight_kg: null,
  hs_code: "",
  origin: "",
  origin_source_value: "",
  image_url: "",
  ean: "4028977975967",
  description: "exhaust gas pressure sensor",
  oem_no: "",
  vehicle_model: "Mercedes-Benz Actros",
  fitment_review_status: "accepted",
  fitment_outcomes: [],
};

const secondary = {
  status: "accepted",
  reason: "",
  brand: "Pierburg",
  product_code: "7.12477.00.0",
  exact_brand_match: true,
  exact_code_match: true,
  weight_kg: 0.047,
  weight_raw: "0.047 kg",
  hs_code_candidate: "902620",
  customs_code_raw: "902620",
  origin_short_code_candidate: "DE",
  origin_raw: "Germany",
  image_url_candidate: "https://img.spareto.com/products/712477000.jpg",
  source_url: "https://spareto.com/products/712477000",
};

test("part numbers remove whitespace only and preserve punctuation", () => {
  assert.equal(normalizeCatalogPartNumber(" 7. 12477.00-0 "), "7.12477.00-0");
});

test("known brand variants use one strict comparison key", () => {
  assert.equal(normalizeCatalogBrand("TRW Engine Component"), "trw engine components");
  assert.equal(normalizeCatalogBrand("TRW Engine Components"), "trw engine components");
  assert.notEqual(normalizeCatalogBrand("TRW Engine Components"), normalizeCatalogBrand("TRW"));
  assert.equal(normalizeCatalogBrand("BF"), "bf");
});

test("exact brand and code evidence is mandatory", () => {
  assert.equal(validateSparetoEnrichment(primary, secondary).accepted, true);
  assert.equal(
    validateSparetoEnrichment(primary, {
      ...secondary,
      product_code: "7.12477.00-0",
    }).reason,
    "PRIMARY_SECONDARY_IDENTITY_MISMATCH",
  );
});

test("secondary fills only missing fields and retains field provenance", () => {
  const candidate = mergeMotorserviceSparetoCandidate(primary, secondary);
  assert.equal(candidate.weight_kg, 0.047);
  assert.equal(candidate.hs_code, "902620");
  assert.equal(candidate.origin, "DE");
  assert.equal(candidate.image_policy, "EXACT_SPARETO_SECONDARY");
  assert.equal(candidate.readiness, "READY_STAGED_CANDIDATE");
  assert.deepEqual(candidate.enrichment.applied_fields, [
    "weight_kg",
    "hs_code",
    "origin",
    "image_url",
  ]);
  assert.equal(candidate.production_import_authorized, false);
});

test("primary values are never overwritten", () => {
  const candidate = mergeMotorserviceSparetoCandidate(
    {
      ...primary,
      weight_kg: 1.5,
      hs_code: "840999",
      origin: "TR",
      image_url: "https://official.example/product.jpg",
    },
    secondary,
  );
  assert.equal(candidate.weight_kg, 1.5);
  assert.equal(candidate.hs_code, "840999");
  assert.equal(candidate.origin, "TR");
  assert.equal(candidate.image_url, "https://official.example/product.jpg");
  assert.deepEqual(candidate.enrichment.applied_fields, []);
  assert.equal(candidate.image_policy, "OFFICIAL_MOTORSERVICE");
});

test("placeholder images are rejected and absent images require brand fallback", () => {
  assert.equal(isUsableCatalogImage("https://cdn.example/noimage/product.png"), false);
  const candidate = mergeMotorserviceSparetoCandidate(primary, {
    ...secondary,
    image_url_candidate: "https://cdn.example/noimage/product.png",
  });
  assert.equal(candidate.image_url, "");
  assert.equal(candidate.image_policy, "BRAND_LOGO_FALLBACK");
  assert.equal(candidate.brand_logo_fallback_required, true);
});

test("truncated and no-fitment rows remain review-required", () => {
  const truncated = mergeMotorserviceSparetoCandidate(
    {
      ...primary,
      fitment_outcomes: [{ kind: "vehicles", truncated: true }],
    },
    secondary,
  );
  const noFitment = mergeMotorserviceSparetoCandidate(
    { ...primary, fitment_review_status: "no_fitment_data" },
    secondary,
  );
  assert.equal(truncated.readiness, "REVIEW_REQUIRED_TRUNCATED_FITMENT");
  assert.equal(noFitment.readiness, "REVIEW_REQUIRED_NO_FITMENT");
});
