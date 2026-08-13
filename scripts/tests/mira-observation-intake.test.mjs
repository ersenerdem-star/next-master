import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  MIRA_OBSERVATION_INTAKE_VERSION,
  buildMiraObservationRpcArgs,
  validateMiraObservationBatch,
} from "../../netlify/functions/_shared/catalog/mira-observation-intake.mjs";

const ids = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  source_id: "22222222-2222-4222-8222-222222222222",
  trust_profile_id: "33333333-3333-4333-8333-333333333333",
  job_id: "44444444-4444-4444-8444-444444444444",
  brand_id: "55555555-5555-4555-8555-555555555555",
  product_id: "66666666-6666-4666-8666-666666666666",
};

function context() {
  return {
    source: {
      id: ids.source_id,
      organization_id: ids.organization_id,
      is_active: true,
      license_posture: "allowed",
      robots_posture: "allowed",
      rate_limit_posture: "bounded",
      credential_boundary: "none",
      metadata: { automated_read_only_approved: true, internal_observation_allowed: true },
    },
    trustProfile: {
      id: ids.trust_profile_id,
      organization_id: ids.organization_id,
      source_id: ids.source_id,
      is_active: true,
      allowed_field_families: ["ean_reference", "oem_reference"],
    },
    job: {
      id: ids.job_id,
      organization_id: ids.organization_id,
      source_id: ids.source_id,
      trust_profile_id: ids.trust_profile_id,
      brand_id: ids.brand_id,
      status: "active",
      allowed_field_families: ["ean_reference", "oem_reference"],
    },
    brand: { id: ids.brand_id, organization_id: ids.organization_id, is_active: true },
    products: [{ id: ids.product_id, brand_id: ids.brand_id, normalized_code: "BF100" }],
  };
}

function input(overrides = {}) {
  return {
    ...ids,
    idempotency_key: "mission-001",
    request_fingerprint: "fingerprint-001",
    observations: [
      {
        product_code: "BF100",
        normalized_code: "BF100",
        field_family: "ean_reference",
        field_name: "ean",
        raw_value: "4000000000001",
        normalized_value: "4000000000001",
        evidence_reference: "MIRA mission mission-001 candidate 1",
        evidence_url: "https://www.bosch-aftermarket.com/catalog/BF100",
        evidence_payload: { source_type: "official_public_page" },
        confidence: 0.92,
        observed_at: "2026-08-13T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

test("validates a bounded EAN candidate and builds observation-only RPC args", () => {
  const request = validateMiraObservationBatch(input(), context());
  assert.equal(request.metadata.mira_intake_protocol, MIRA_OBSERVATION_INTAKE_VERSION);
  assert.equal(request.observations.length, 1);
  assert.equal(request.observations[0].field_family, "ean_reference");
  assert.equal(request.metadata.catalog_products_written, 0);
  assert.equal(buildMiraObservationRpcArgs(request).input_observations.length, 1);
});

test("rejects an unapproved source before any RPC is built", () => {
  const blocked = context();
  blocked.source.license_posture = "internal_review_required";
  assert.throws(() => validateMiraObservationBatch(input(), blocked), {
    code: "SOURCE_POLICY_BLOCKED",
  });
});

test("rejects a candidate for a product outside the tenant catalog", () => {
  assert.throws(
    () => validateMiraObservationBatch(input({ observations: [{ ...input().observations[0], normalized_code: "NOT-IN-CATALOG" }] }), context()),
    { code: "PRODUCT_IDENTITY_MISSING" },
  );
});

test("rejects credential-shaped evidence and oversized batches", () => {
  const unsafe = input({ observations: [{ ...input().observations[0], evidence_payload: { password: "secret" } }] });
  assert.throws(() => validateMiraObservationBatch(unsafe, context()), { code: "UNSAFE_EVIDENCE" });
  assert.throws(() => validateMiraObservationBatch(input({ observations: Array.from({ length: 101 }, () => input().observations[0]) }), context()), { code: "BOUND_EXCEEDED" });
});

test("migration is service-role-only, pinned, and cannot write catalog_products", async () => {
  const migration = await readFile(new URL("../../supabase/migrations/20260812225153_mira_ean_observation_field_family.sql", import.meta.url), "utf8");
  assert.match(migration, /ean_reference/);
  assert.match(migration, /set search_path = public/gi);
  assert.match(migration, /grant execute on function public\.ingest_mira_catalog_observation_batch[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.catalog_products/i);
  assert.doesNotMatch(migration, /update\s+public\.catalog_products/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.catalog_products/i);
});
