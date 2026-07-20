import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REVIEW_DEFAULT_LIMIT,
  REVIEW_MAX_LIMIT,
  REVIEW_SCHEMA_VERSION,
  CatalogObservationReviewError,
  authorizeCatalogObservationReviewAccess,
  buildCatalogObservationReviewResponse,
  loadCatalogObservationReviewWorkspace,
  parseCatalogObservationReviewQuery,
} from "../../netlify/functions/_shared/catalog/catalog-observation-review-api.mjs";
import { handleCatalogObservationReviewRequest } from "../../netlify/functions/catalog-observation-review.mts";

const ORG_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const RUN_ID = "11581bfd-3a12-43d5-bb39-d6aa09e3bd96";
const NOW = "2026-07-18T00:00:00.000Z";

const observations = [
  makeObservation("00000000-0000-4000-8000-000000000001", "product-accept-1", "source-1", "trust-1", "image_reference", "https://example.com/a-001.jpg", "https://example.com/a-001.jpg"),
  makeObservation("00000000-0000-4000-8000-000000000002", "product-accept-2", "source-1", "trust-1", "image_reference", "https://example.com/a-002.jpg", "https://example.com/a-002.jpg"),
  makeObservation("00000000-0000-4000-8000-000000000003", "product-accept-3", "source-1", "trust-1", "image_reference", "https://example.com/a-003.jpg", "https://example.com/a-003.jpg"),
  makeObservation("00000000-0000-4000-8000-000000000004", "product-accept-4", "source-1", "trust-1", "image_reference", "https://example.com/a-004.jpg", "https://example.com/a-004.jpg"),
  makeObservation("00000000-0000-4000-8000-000000000005", "product-accept-5", "source-1", "trust-1", "image_reference", "https://example.com/a-005.jpg", "https://example.com/a-005.jpg"),
  makeObservation("00000000-0000-4000-8000-000000000006", "product-conflict", "source-2", "trust-2", "supplemental_description", "New description", "New description"),
];

const products = [
  {
    id: "product-accept-1",
    organization_id: ORG_ID,
    brand_id: "brand-1",
    product_code: "A-001",
    normalized_code: "A001",
    description: "",
    image_url: "",
    updated_at: NOW,
  },
  {
    id: "product-accept-2",
    organization_id: ORG_ID,
    brand_id: "brand-1",
    product_code: "A-002",
    normalized_code: "A002",
    description: "",
    image_url: "",
    updated_at: NOW,
  },
  {
    id: "product-accept-3",
    organization_id: ORG_ID,
    brand_id: "brand-1",
    product_code: "A-003",
    normalized_code: "A003",
    description: "",
    image_url: "",
    updated_at: NOW,
  },
  {
    id: "product-accept-4",
    organization_id: ORG_ID,
    brand_id: "brand-1",
    product_code: "A-004",
    normalized_code: "A004",
    description: "",
    image_url: "",
    updated_at: NOW,
  },
  {
    id: "product-accept-5",
    organization_id: ORG_ID,
    brand_id: "brand-1",
    product_code: "A-005",
    normalized_code: "A005",
    description: "",
    image_url: "",
    updated_at: NOW,
  },
  {
    id: "product-conflict",
    organization_id: ORG_ID,
    brand_id: "brand-1",
    product_code: "Z-999",
    normalized_code: "Z999",
    description: "Legacy description",
    image_url: "",
    updated_at: NOW,
  },
];

const brands = [
  { id: "brand-1", organization_id: ORG_ID, name: "Brand 1" },
];

const sources = [
  { id: "source-1", organization_id: ORG_ID, source_key: "zf-aftermarket", display_name: "ZF Aftermarket", source_type: "official", license_posture: "approved", is_active: true },
  { id: "source-2", organization_id: ORG_ID, source_key: "official-description", display_name: "Official Description", source_type: "official", license_posture: "approved", is_active: true },
];

const trustProfiles = [
  { id: "trust-1", organization_id: ORG_ID, source_id: "source-1", trust_level: "T4", trust_score: 0.82, allowed_field_families: ["image_reference"], human_review_required: false, evidence_required: true, is_active: true },
  { id: "trust-2", organization_id: ORG_ID, source_id: "source-2", trust_level: "T2", trust_score: 0.61, allowed_field_families: ["supplemental_description"], human_review_required: true, evidence_required: true, is_active: true },
];

const runs = [
  { id: RUN_ID, organization_id: ORG_ID, job_id: "job-1", source_id: "source-1", brand_id: "brand-1", status: "succeeded", started_at: NOW, finished_at: NOW, observed_count: 6, deduped_count: 6, candidate_count: 6, review_routed_count: 6, apply_event_count: 0, error_message: null },
];

test("query parsing enforces bounded UUID filters and default limit", () => {
  const parsed = parseCatalogObservationReviewQuery(`https://example.test/api/catalog/observation-review?organization_id=${ORG_ID}&run_id=${RUN_ID}`);
  assert.equal(parsed.limit, REVIEW_DEFAULT_LIMIT);
  assert.equal(parsed.organization_id, ORG_ID);
  assert.equal(parsed.run_id, RUN_ID);

  assert.throws(() => parseCatalogObservationReviewQuery(`https://example.test/api/catalog/observation-review?organization_id=bad&run_id=${RUN_ID}`), /organization_id must be a UUID/);
  assert.throws(() => parseCatalogObservationReviewQuery(`https://example.test/api/catalog/observation-review?organization_id=${ORG_ID}&run_id=${RUN_ID}&limit=${REVIEW_MAX_LIMIT + 1}`), /at most 50/);
});

test("authorization blocks cross-org access and non-admin users", () => {
  assert.deepEqual(authorizeCatalogObservationReviewAccess({ role: "viewer", organization_id: ORG_ID }, ORG_ID), { error: "Forbidden", status: 403 });
  assert.deepEqual(authorizeCatalogObservationReviewAccess({ role: "admin", organization_id: "other-org" }, ORG_ID), { error: "Forbidden", status: 403 });
  assert.deepEqual(authorizeCatalogObservationReviewAccess({ role: "superadmin", organization_id: ORG_ID }, ORG_ID), { ok: true });
});

test("workspace loader returns 404 when the run is missing", async () => {
  const db = {
    async get(table) {
      if (table === "catalog_observation_runs") return [];
      throw new Error(`Unexpected table read: ${table}`);
    },
  };
  const workspace = await loadCatalogObservationReviewWorkspace(db, { organizationId: ORG_ID, runId: RUN_ID });
  assert.deepEqual(workspace, {
    runs: [],
    observations: [],
    products: [],
    brands: [],
    sources: [],
    trustProfiles: [],
  });
  await assert.rejects(() => buildCatalogObservationReviewResponse({
    db,
    organizationId: ORG_ID,
    runId: RUN_ID,
    generatedAt: NOW,
    now: NOW,
  }), (error) => error instanceof CatalogObservationReviewError && error.status === 404);
});

test("workspace loader returns 409 when linkage is inconsistent", async () => {
  const db = {
    async get(table) {
      if (table === "catalog_observation_runs") {
        return [{ id: RUN_ID, organization_id: ORG_ID }];
      }
      if (table === "catalog_external_observations") {
        return [{
          ...observations[0],
          catalog_product_id: "00000000-0000-4000-8000-000000009999",
        }];
      }
      if (table === "catalog_products") return [];
      if (table === "catalog_external_sources") return sources;
      if (table === "catalog_external_source_trust_profiles") return trustProfiles;
      return [];
    },
  };
  await assert.rejects(() => buildCatalogObservationReviewResponse({
    db,
    organizationId: ORG_ID,
    runId: RUN_ID,
    generatedAt: NOW,
    now: NOW,
  }), (error) => error instanceof CatalogObservationReviewError && error.status === 409);
});

test("read helper returns deterministic bounded review candidates with stable ordering", async () => {
  const { result, calls } = await buildWithFakeDb();
  assert.equal(result.schema_version, REVIEW_SCHEMA_VERSION);
  assert.equal(result.organization_id, ORG_ID);
  assert.equal(result.run_id, RUN_ID);
  assert.equal(result.items.length, 6);
  assert.deepEqual(result.items.map((item) => item.recommendation), [
    "MANUAL_REQUIRED",
    "LIKELY_ACCEPT",
    "LIKELY_ACCEPT",
    "LIKELY_ACCEPT",
    "LIKELY_ACCEPT",
    "LIKELY_ACCEPT",
  ]);
  assert.equal(result.summary.review_queue_count, 6);
  assert.equal(result.summary.matching_item_count, 6);
  assert.equal(result.summary.recommendation_totals.LIKELY_ACCEPT, 5);
  assert.equal(result.summary.recommendation_totals.MANUAL_REQUIRED, 1);
  assert.equal(result.summary.recommendation_totals.AUTO_SAFE, 0);
  assert(result.items.every((item) => item.reviewer === null && item.decision === null));
  assert(result.items.every((item) => item.decision_state && typeof item.decision_state.decision_version === "number"));
  assert(result.items.every((item) => typeof item.recommendation_fingerprint === "string" && item.recommendation_fingerprint.length > 0));
  assert(result.items.every((item) => typeof item.comparison_reason === "string" && item.comparison_reason.length > 0));
  assert(result.items.every((item) => item.brand_id === "brand-1"));
  assert(result.items.every((item) => item.brand_name === "Brand 1"));
  assert(result.items.every((item) => typeof item.product_value === "string"));
  assert(result.items.every((item) => typeof item.observation_value === "string"));
  assert(result.items.every((item) => typeof item.source_display_name === "string" && item.source_display_name.length > 0));
  assert(result.items.every((item) => typeof item.evidence_reference === "string" && item.evidence_reference.length > 0));
  assert(result.items.every((item) => typeof item.evidence_url === "string" && item.evidence_url.length > 0));
  assert(result.items.every((item) => typeof item.winning_rule === "string" && item.winning_rule.length > 0));
  assert(result.items.every((item) => Array.isArray(item.positive_factors) && Array.isArray(item.negative_factors)));
  assert(calls.every((call) => call.method === "get"));
});

test("cursor pagination is stable and repeatable", async () => {
  const firstPage = await buildWithFakeDb({ limit: 2 });
  assert.equal(firstPage.result.items.length, 2);
  assert.equal(firstPage.result.page.has_more, true);
  assert(firstPage.result.page.next_cursor);

  const secondPage = await buildWithFakeDb({ limit: 2, cursor: firstPage.result.page.next_cursor });
  assert.equal(secondPage.result.items.length, 2);
  assert.notEqual(secondPage.result.items[0].observation_id, firstPage.result.items[0].observation_id);

  const repeatFirstPage = await buildWithFakeDb({ limit: 2 });
  assert.deepEqual(firstPage.result, repeatFirstPage.result);
});

test("filters keep only matching review records", async () => {
  const manualRequired = await buildWithFakeDb({ recommendation: "MANUAL_REQUIRED" });
  assert.equal(manualRequired.result.items.length, 1);
  assert.equal(manualRequired.result.items[0].recommendation, "MANUAL_REQUIRED");

  const conflict = await buildWithFakeDb({ comparisonResult: "CONFLICT" });
  assert.equal(conflict.result.items.length, 1);
  assert.equal(conflict.result.items[0].comparison_result, "CONFLICT");
});

test("only read operations are used when loading the review workspace", async () => {
  const { calls } = await buildWithFakeDb();
  assert(calls.every((call) => call.method === "get"));
  assert.equal(calls.some((call) => ["insert", "update", "delete", "rpc"].includes(call.method)), false);
});

test("route handler returns documented statuses", async () => {
  const env = {
    get(name) {
      if (name === "SUPABASE_URL") return "https://example.supabase.co";
      if (name === "SUPABASE_ANON_KEY") return "anon-key";
      if (name === "SUPABASE_SERVICE_ROLE_KEY") return "service-key";
      return "";
    },
  };

  const missingAuth = await handleCatalogObservationReviewRequest(
    new Request(`https://example.test/api/catalog/observation-review?organization_id=${ORG_ID}&run_id=${RUN_ID}`, { method: "GET" }),
    {},
    {
      requireCallerProfile: async () => ({ error: "Missing caller token", status: 401 }),
      createCatalogObservationReviewDb: () => { throw new Error("should not be called"); },
      env,
    },
  );
  assert.equal(missingAuth.status, 401);

  const forbidden = await handleCatalogObservationReviewRequest(
    new Request(`https://example.test/api/catalog/observation-review?organization_id=${ORG_ID}&run_id=${RUN_ID}`, { method: "GET", headers: { authorization: "Bearer token" } }),
    {},
    {
      requireCallerProfile: async () => ({ profile: { organization_id: ORG_ID, role: "viewer" } }),
      createCatalogObservationReviewDb: () => { throw new Error("should not be called"); },
      env,
    },
  );
  assert.equal(forbidden.status, 403);

  const invalid = await handleCatalogObservationReviewRequest(
    new Request(`https://example.test/api/catalog/observation-review?organization_id=bad&run_id=${RUN_ID}`, { method: "GET", headers: { authorization: "Bearer token" } }),
    {},
    {
      requireCallerProfile: async () => ({ profile: { organization_id: ORG_ID, role: "admin" } }),
      createCatalogObservationReviewDb: () => { throw new Error("should not be called"); },
      env,
    },
  );
  assert.equal(invalid.status, 400);

  const notFound = await handleCatalogObservationReviewRequest(
    new Request(`https://example.test/api/catalog/observation-review?organization_id=${ORG_ID}&run_id=${RUN_ID}`, { method: "GET", headers: { authorization: "Bearer token" } }),
    {},
    {
      requireCallerProfile: async () => ({ profile: { organization_id: ORG_ID, role: "admin" } }),
      createCatalogObservationReviewDb: () => ({
        async get(table) {
          if (table === "catalog_observation_runs") return [];
          throw new Error(`Unexpected table read: ${table}`);
        },
      }),
      env,
    },
  );
  assert.equal(notFound.status, 404);

  const inconsistent = await handleCatalogObservationReviewRequest(
    new Request(`https://example.test/api/catalog/observation-review?organization_id=${ORG_ID}&run_id=${RUN_ID}`, { method: "GET", headers: { authorization: "Bearer token" } }),
    {},
    {
      requireCallerProfile: async () => ({ profile: { organization_id: ORG_ID, role: "admin" } }),
      createCatalogObservationReviewDb: () => ({
        async get(table) {
          if (table === "catalog_observation_runs") return [{ id: RUN_ID, organization_id: ORG_ID }];
          if (table === "catalog_external_observations") return [{
            ...observations[0],
            catalog_product_id: "00000000-0000-4000-8000-000000009999",
          }];
          if (table === "catalog_products") return [];
          if (table === "catalog_external_sources") return sources;
          if (table === "catalog_external_source_trust_profiles") return trustProfiles;
          return [];
        },
      }),
      env,
    },
  );
  assert.equal(inconsistent.status, 409);

  const internal = await handleCatalogObservationReviewRequest(
    new Request(`https://example.test/api/catalog/observation-review?organization_id=${ORG_ID}&run_id=${RUN_ID}`, { method: "GET", headers: { authorization: "Bearer token" } }),
    {},
    {
      requireCallerProfile: async () => ({ profile: { organization_id: ORG_ID, role: "admin" } }),
      createCatalogObservationReviewDb: () => ({
        async get() {
          throw new Error("boom");
        },
      }),
      env,
    },
  );
  assert.equal(internal.status, 500);
  assert.deepEqual(await internal.json(), { error: "Review queue could not be loaded right now." });
});

async function buildWithFakeDb({ limit, cursor, recommendation, comparisonResult } = {}) {
  const calls = [];
  const db = {
    async get(table, params) {
      calls.push({ method: "get", table, params });
      if (table === "catalog_external_observations") return observations;
      if (table === "catalog_products") return products;
      if (table === "brands") return brands;
      if (table === "catalog_external_sources") return sources;
      if (table === "catalog_external_source_trust_profiles") return trustProfiles;
      if (table === "catalog_observation_runs") return runs;
      return [];
    },
  };

  const result = await buildCatalogObservationReviewResponse({
    db,
    organizationId: ORG_ID,
    runId: RUN_ID,
    limit: limit || REVIEW_DEFAULT_LIMIT,
    cursor: cursor || "",
    recommendation: recommendation || "",
    comparisonResult: comparisonResult || "",
    generatedAt: NOW,
    now: NOW,
  });

  return { result, calls };
}

function makeObservation(id, productId, sourceId, trustProfileId, fieldFamily, rawValue, normalizedValue) {
  return {
    id,
    organization_id: ORG_ID,
    source_id: sourceId,
    trust_profile_id: trustProfileId,
    run_id: RUN_ID,
    catalog_product_id: productId,
    product_code: productId.toUpperCase(),
    normalized_code: productId.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    field_family: fieldFamily,
    raw_value: rawValue,
    normalized_value: normalizedValue,
    evidence_url: "https://example.test/evidence",
    evidence_reference: `evidence:${id}`,
    evidence_hash: `hash:${id}`,
    confidence: 0.82,
    observed_at: NOW,
    ingested_at: NOW,
    deduplication_key: `dedupe:${id}`,
  };
}
