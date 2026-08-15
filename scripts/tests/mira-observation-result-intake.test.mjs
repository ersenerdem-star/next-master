import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeMiraObservationResultIntake,
  resolveMiraObservationScope,
  stageMiraObservationResult,
} from "../../netlify/functions/_shared/catalog/mira-observation-result-intake.mjs";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  source: "22222222-2222-4222-8222-222222222222",
  trust: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
  brand: "55555555-5555-4555-8555-555555555555",
  mission: "66666666-6666-4666-8666-666666666666",
};

function intake(overrides = {}) {
  return {
    protocolVersion: "mira-observation-intake.v1",
    sourceKey: "bosch_official_observation",
    brand: "BF",
    observations: [{
      product_code: "BF100",
      normalized_code: "BF100",
      field_family: "ean_reference",
      field_name: "ean",
      raw_value: "4000000000001",
      normalized_value: "4000000000001",
      evidence_reference: "MIRA mission candidate 1",
      evidence_url: "https://www.bosch-aftermarket.com/catalog/BF100",
      evidence_payload: { source_type: "official_public_page" },
      confidence: 0.9,
      writeDisposition: "observation-staging-only",
    }],
    ...overrides,
  };
}

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function fakeFetch(url, init = {}) {
  const path = new URL(url).pathname;
  if (path.endsWith("/catalog_external_sources")) {
    return Promise.resolve(response([{
      id: ids.source,
      organization_id: ids.organization,
      source_key: "bosch_official_observation",
      license_posture: "allowed",
      robots_posture: "allowed",
      rate_limit_posture: "bounded",
      credential_boundary: "none",
      is_active: true,
      metadata: { automated_read_only_approved: true, internal_observation_allowed: true },
    }]));
  }
  if (path.endsWith("/catalog_external_source_trust_profiles")) {
    return Promise.resolve(response([{
      id: ids.trust,
      organization_id: ids.organization,
      source_id: ids.source,
      allowed_field_families: ["ean_reference"],
      is_active: true,
    }]));
  }
  if (path.endsWith("/brands")) {
    const query = new URL(url).searchParams;
    assert.equal(query.get("is_active"), null);
    assert.doesNotMatch(query.get("select") ?? "", /is_active/);
    return Promise.resolve(response([{ id: ids.brand, organization_id: ids.organization, name: "BF" }]));
  }
  if (path.endsWith("/catalog_observation_jobs")) {
    return Promise.resolve(response([{
      id: ids.job,
      organization_id: ids.organization,
      source_id: ids.source,
      trust_profile_id: ids.trust,
      brand_id: ids.brand,
      status: "active",
      allowed_field_families: ["ean_reference"],
      sync_mode: "observation_only",
      metadata: { mira_intake_protocol: "v1" },
    }]));
  }
  if (path.endsWith("/rpc/ingest_mira_catalog_observation_batch")) {
    const body = JSON.parse(init.body);
    assert.equal(body.input_source_id, ids.source);
    assert.equal(body.input_trust_profile_id, ids.trust);
    assert.equal(body.input_job_id, ids.job);
    assert.equal(body.input_brand_id, ids.brand);
    return Promise.resolve(response({ status: "succeeded", run_id: ids.mission, observed_count: 1, deduped_count: 0 }));
  }
  throw new Error(`unexpected URL ${url}`);
}

test("rejects client-supplied scope identifiers", () => {
  assert.throws(() => normalizeMiraObservationResultIntake({ ...intake(), source_id: ids.source }), { code: "CLIENT_SCOPE_FORBIDDEN" });
  assert.throws(() => normalizeMiraObservationResultIntake({ ...intake(), observations: [{ ...intake().observations[0], evidence_payload: { job_id: ids.job } }] }), { code: "CLIENT_SCOPE_FORBIDDEN" });
  assert.throws(() => normalizeMiraObservationResultIntake({ ...intake(), observations: [{ ...intake().observations[0], catalog_product_id: ids.mission }] }), { code: "CLIENT_SCOPE_FORBIDDEN" });
  assert.throws(() => normalizeMiraObservationResultIntake({ ...intake(), observations: [{ ...intake().observations[0], evidence_payload: { actorId: ids.mission } }] }), { code: "CLIENT_SCOPE_FORBIDDEN" });
});

test("accepts a partially typed batch when skipped candidates reconcile", () => {
  const value = intake({
    candidateCount: 2,
    skippedCount: 1,
    skipReasons: [{ candidateId: "candidate-2", code: "PRODUCT_IDENTITY_MISSING", reason: "No product identity." }],
  });
  const normalized = normalizeMiraObservationResultIntake(value);
  assert.equal(normalized.observations.length, 1);
  assert.equal(normalized.candidateCount, 2);
  assert.equal(normalized.skippedCount, 1);
  assert.equal(normalized.skipReasons[0].code, "PRODUCT_IDENTITY_MISSING");
});

test("accepts an all-skipped batch but rejects unreconciled counts", () => {
  const normalized = normalizeMiraObservationResultIntake(intake({
    candidateCount: 2,
    skippedCount: 2,
    observations: [],
    skipReasons: [
      { candidateId: "candidate-1", code: "PRODUCT_IDENTITY_MISSING", reason: "No product identity." },
      { candidateId: "candidate-2", code: "HTTPS_EVIDENCE_MISSING", reason: "No HTTPS evidence." },
    ],
  }));
  assert.equal(normalized.observations.length, 0);
  assert.equal(normalized.skippedCount, 2);
  assert.throws(() => normalizeMiraObservationResultIntake(intake({
    candidateCount: 2,
    skippedCount: 0,
  })), { code: "CANDIDATE_COUNT_MISMATCH" });
});

test("resolves source, trust, job, and brand only from the tenant server registry", async () => {
  const scope = await resolveMiraObservationScope({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    organizationId: ids.organization,
    sourceKey: "bosch_official_observation",
    brand: "bf",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual({ source: scope.source.id, trust: scope.trustProfile.id, job: scope.job.id, brand: scope.brand.id }, {
    source: ids.source, trust: ids.trust, job: ids.job, brand: ids.brand,
  });
});

test("stages through the observation RPC and reports no Product mutation", async () => {
  const result = await stageMiraObservationResult({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    organizationId: ids.organization,
    missionId: ids.mission,
    resultIntake: intake(),
    fetchImpl: fakeFetch,
  });
  assert.equal(result.status, "staged");
  assert.equal(result.observedCount, 1);
  assert.equal(result.catalogProductsWritten, 0);
  assert.equal(result.applyPerformed, false);
});
