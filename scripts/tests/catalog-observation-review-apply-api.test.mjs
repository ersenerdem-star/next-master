import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  APPLY_COMMAND_SCHEMA_VERSION,
  serializeApplyResult,
  validateApplyCommand,
} from "../../netlify/functions/_shared/catalog/catalog-observation-review-apply-api.mjs";
import { handleCatalogObservationReviewApplyRequest } from "../../netlify/functions/catalog-observation-review-apply.mts";

const ORG_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000101";
const OBSERVATION_ID = "00000000-0000-4000-8000-000000000201";
const DECISION_EVENT_ID = "00000000-0000-4000-8000-000000000301";
const APPLY_EVENT_ID = "00000000-0000-4000-8000-000000000401";
const REVIEW_ITEM_ID = `${ORG_ID}:${PRODUCT_ID}:${OBSERVATION_ID}:image_reference`;
const grantSql = readFileSync(new URL("../../supabase/migrations/20260724_002_catalog_controlled_image_apply_api_grant.sql", import.meta.url), "utf8");
const netlifyToml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8");
const functionEntrypoint = readFileSync(new URL("../../netlify/functions/catalog-observation-review-apply.mts", import.meta.url), "utf8");

test("Apply endpoint has an explicit Netlify route before the generic API redirect", () => {
  const explicitRoute = netlifyToml.indexOf('from = "/api/catalog/observation-review/apply"');
  const genericRoute = netlifyToml.indexOf('from = "/api/*"');
  assert.ok(explicitRoute >= 0);
  assert.ok(genericRoute >= 0);
  assert.ok(explicitRoute < genericRoute);
  assert.match(netlifyToml, /to = "\/.netlify\/functions\/catalog-observation-review-apply"/);
});

test("Netlify dispatches all methods so the handler can return the bounded 405 response", () => {
  assert.doesNotMatch(functionEntrypoint, /\bmethod\s*:\s*["']POST["']/);
});

test("Apply command accepts only the bounded F2 contract", () => {
  const command = validateApplyCommand(validBody());
  assert.equal(command.reviewItemId, REVIEW_ITEM_ID);
  assert.equal(command.expectedDecisionVersion, 1);
  assert.throws(() => validateApplyCommand({ ...validBody(), organizationId: ORG_ID }), /Unsupported field: organizationId/);
  assert.throws(() => validateApplyCommand({ ...validBody(), candidateImageUrl: "https:\/\/example.test\/x.jpg" }), /Unsupported field: candidateImageUrl/);
  assert.throws(() => validateApplyCommand({ ...validBody(), reviewItemId: `${ORG_ID}:${PRODUCT_ID}:${OBSERVATION_ID}:fitment` }), /reviewItemId is invalid/);
  assert.throws(() => validateApplyCommand({ ...validBody(), expectedDecisionVersion: 0 }), /positive integer/);
  assert.throws(() => validateApplyCommand({ ...validBody(), idempotencyKey: "bad key" }), /idempotencyKey is invalid/);
});

test("Apply endpoint rejects unsupported methods and missing auth", async () => {
  const method = await handleCatalogObservationReviewApplyRequest(new Request("https://example.test/api/catalog/observation-review/apply", { method: "GET" }), {}, deps());
  assert.equal(method.status, 405);

  const auth = await handleCatalogObservationReviewApplyRequest(request(validBody()), {}, deps({
    requireCallerProfile: async () => ({ error: "Missing caller token", status: 401 }),
  }));
  assert.equal(auth.status, 401);
});

test("Apply endpoint invokes only the bounded image Apply RPC", async () => {
  const calls = [];
  const response = await handleCatalogObservationReviewApplyRequest(request(validBody()), {}, deps({
    createCatalogObservationApplyCommandDb: () => ({
      async applyImage(input) {
        calls.push(input);
        return rpcResult(false);
      },
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.schema_version, APPLY_COMMAND_SCHEMA_VERSION);
  assert.equal(body.success, true);
  assert.equal(body.action, "apply_canonical_image");
  assert.equal(body.replayed, false);
  assert.equal(body.event.apply_event_id, APPLY_EVENT_ID);
  assert.deepEqual(calls, [validBody()]);
});

test("Apply replay and conflict responses are stable", async () => {
  assert.equal(serializeApplyResult(rpcResult(true)).replayed, true);

  const mismatch = await handleCatalogObservationReviewApplyRequest(request(validBody()), {}, deps({
    createCatalogObservationApplyCommandDb: () => ({ async applyImage() { throw new Error("CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH: payload changed"); } }),
  }));
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH");

  const selfAuthorize = await handleCatalogObservationReviewApplyRequest(request(validBody()), {}, deps({
    createCatalogObservationApplyCommandDb: () => ({ async applyImage() { throw new Error("CATALOG_REVIEW_APPLY_AUTHORIZATION_BLOCKED: reviewer cannot self-authorize"); } }),
  }));
  assert.equal(selfAuthorize.status, 403);
  assert.deepEqual(await selfAuthorize.json(), {
    error: "Forbidden",
    code: "CATALOG_REVIEW_APPLY_AUTHORIZATION_BLOCKED",
  });
});

test("Apply endpoint sanitizes unexpected failures and the migration adds no table-write grant", async () => {
  const response = await handleCatalogObservationReviewApplyRequest(request(validBody()), {}, deps({
    createCatalogObservationApplyCommandDb: () => ({ async applyImage() { throw new Error("database stack private evidence URL"); } }),
  }));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(body).includes("private evidence URL"), false);
  assert.match(grantSql, /grant execute on function public\.apply_catalog_observation_review_image\(text, uuid, integer, text, text, text\)\s+to authenticated/i);
  assert.doesNotMatch(grantSql, /grant\s+(insert|update|delete|all)\s+on\s+table/i);
});

function deps(overrides = {}) {
  return {
    requireCallerProfile: async () => ({ profile: { id: "user-2", role: "admin", is_active: true, organization_id: ORG_ID } }),
    createCatalogObservationApplyCommandDb: () => ({ async applyImage() { return rpcResult(false); } }),
    env: {
      get(name) {
        if (name === "SUPABASE_URL") return "https://example.supabase.co";
        if (name === "SUPABASE_ANON_KEY") return "anon-key";
        if (name === "SUPABASE_SERVICE_ROLE_KEY") return "service-key";
        return "";
      },
    },
    ...overrides,
  };
}

function request(body) {
  return new Request("https://example.test/api/catalog/observation-review/apply", {
    method: "POST",
    headers: { authorization: "Bearer caller-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    reviewItemId: REVIEW_ITEM_ID,
    decisionEventId: DECISION_EVENT_ID,
    expectedDecisionVersion: 1,
    expectedReviewItemFingerprint: "canonical-review-item-fingerprint",
    expectedProductTargetFingerprint: "canonical-product-target-fingerprint",
    idempotencyKey: "apply-1",
  };
}

function rpcResult(replayed) {
  return {
    idempotency_replay: replayed,
    event: {
      apply_event_id: APPLY_EVENT_ID,
      review_item_id: REVIEW_ITEM_ID,
      decision_event_id: DECISION_EVENT_ID,
      observation_id: OBSERVATION_ID,
      catalog_product_id: PRODUCT_ID,
      field_family: "image_reference",
      target_field: "image_url",
      decision_version: 1,
      apply_authorizer_user_id: "user-2",
      outcome: "APPLIED",
      created_at: "2026-07-24T12:00:00.000Z",
      downstream_revalidation_requested_at: "2026-07-24T12:00:00.000Z",
    },
  };
}
