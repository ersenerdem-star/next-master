import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECISION_COMMAND_SCHEMA_VERSION,
  serializeDecisionResult,
  validateDecisionCommand,
  validateReversalCommand,
} from "../../netlify/functions/_shared/catalog/catalog-observation-review-decision-api.mjs";
import { handleCatalogObservationReviewDecisionRequest } from "../../netlify/functions/catalog-observation-review-decision.mts";
import { handleCatalogObservationReviewDecisionReverseRequest } from "../../netlify/functions/catalog-observation-review-decision-reverse.mts";

const ORG_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000101";
const OBSERVATION_ID = "00000000-0000-4000-8000-000000000201";
const EVENT_ID = "00000000-0000-4000-8000-000000000301";
const REVIEW_ITEM_ID = `${ORG_ID}:${PRODUCT_ID}:${OBSERVATION_ID}:image_reference`;
const NOW = "2026-07-19T12:00:00.000Z";

test("decision command validation is strict and requires optimistic metadata", () => {
  const command = validateDecisionCommand(validDecisionBody());
  assert.equal(command.reviewItemId, REVIEW_ITEM_ID);
  assert.equal(command.decisionType, "ACCEPT_RECOMMENDATION");
  assert.equal(command.expectedDecisionVersion, 0);

  assert.throws(() => validateDecisionCommand({ ...validDecisionBody(), decisionType: "AUTO_SAFE" }), /decisionType is not supported/);
  assert.throws(() => validateDecisionCommand({ ...validDecisionBody(), reasonCode: "INCORRECT_OBSERVATION" }), /reasonCode is not supported/);
  assert.throws(() => validateDecisionCommand({ ...validDecisionBody(), expectedDecisionVersion: "0" }), /expectedDecisionVersion/);
  assert.throws(() => validateDecisionCommand({ ...validDecisionBody(), expectedRecommendationFingerprint: "" }), /expectedRecommendationFingerprint/);
  assert.throws(() => validateDecisionCommand({ ...validDecisionBody(), idempotencyKey: "bad key" }), /idempotencyKey/);
  assert.throws(() => validateDecisionCommand({ ...validDecisionBody(), organizationId: ORG_ID }), /Unsupported field: organizationId/);
});

test("reversal validation allows only reversal contract fields", () => {
  const command = validateReversalCommand(validReversalBody());
  assert.equal(command.targetDecisionEventId, EVENT_ID);
  assert.equal(command.reasonCode, "DECISION_ENTERED_IN_ERROR");

  assert.throws(() => validateReversalCommand({ ...validReversalBody(), reasonCode: "EVIDENCE_SUFFICIENT" }), /reasonCode is not supported/);
  assert.throws(() => validateReversalCommand({ ...validReversalBody(), targetDecisionEventId: "bad" }), /targetDecisionEventId must be a UUID/);
  assert.throws(() => validateReversalCommand({ ...validReversalBody(), reviewerUserId: EVENT_ID }), /Unsupported field: reviewerUserId/);
});

test("decision endpoint rejects unsupported methods and missing auth", async () => {
  const method = await handleCatalogObservationReviewDecisionRequest(new Request("https://example.test/api/catalog/observation-review/decision", { method: "GET" }), {}, deps());
  assert.equal(method.status, 405);

  const auth = await handleCatalogObservationReviewDecisionRequest(request(validDecisionBody()), {}, deps({
    requireCallerProfile: async () => ({ error: "Missing caller token", status: 401 }),
  }));
  assert.equal(auth.status, 401);
});

test("decision endpoint invokes only record RPC and serializes success", async () => {
  const calls = [];
  const response = await handleCatalogObservationReviewDecisionRequest(request(validDecisionBody()), {}, deps({
    createCatalogObservationDecisionCommandDb: () => ({
      async recordDecision(input) {
        calls.push({ method: "rpc", name: "record_catalog_observation_review_decision", input });
        return rpcResult({ eventType: "DECISION_RECORDED", decisionType: "ACCEPT_RECOMMENDATION", replayed: false, version: 1 });
      },
      async reverseDecision() {
        throw new Error("reverse should not be called");
      },
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.schema_version, DECISION_COMMAND_SCHEMA_VERSION);
  assert.equal(body.success, true);
  assert.equal(body.replayed, false);
  assert.equal(body.event.event_type, "DECISION_RECORDED");
  assert.equal(body.current_state.apply_eligible, true);
  assert.deepEqual(calls.map((call) => call.name), ["record_catalog_observation_review_decision"]);
  assert.equal(calls[0].input.expectedRecommendationFingerprint, "canonical-recommendation-fingerprint");
  assert.equal(calls[0].input.expectedReviewItemFingerprint, "canonical-review-item-fingerprint");
  assert.equal(calls[0].input.expectedProductTargetFingerprint, "canonical-product-target-fingerprint");
});

test("idempotent replay and DB conflicts are stable HTTP responses", async () => {
  const replay = serializeDecisionResult(rpcResult({ replayed: true, version: 1 }), { action: "record_decision" });
  assert.equal(replay.replayed, true);

  const mismatch = await handleCatalogObservationReviewDecisionRequest(request(validDecisionBody()), {}, deps({
    createCatalogObservationDecisionCommandDb: () => ({
      async recordDecision() {
        throw new Error("CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH: idempotency key payload changed");
      },
    }),
  }));
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH");

  const stale = await handleCatalogObservationReviewDecisionRequest(request(validDecisionBody()), {}, deps({
    createCatalogObservationDecisionCommandDb: () => ({
      async recordDecision() {
        throw new Error("CATALOG_REVIEW_DECISION_CONFLICT: expected version does not match current version");
      },
    }),
  }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "CATALOG_REVIEW_DECISION_CONFLICT");

  const mutatedFingerprint = await handleCatalogObservationReviewDecisionRequest(request({ ...validDecisionBody(), expectedReviewItemFingerprint: "mutated-review-fingerprint" }), {}, deps({
    createCatalogObservationDecisionCommandDb: () => ({
      async recordDecision() {
        throw new Error("CATALOG_REVIEW_DECISION_REVIEW_FINGERPRINT_MISMATCH: review item changed");
      },
    }),
  }));
  assert.equal(mutatedFingerprint.status, 409);
  assert.deepEqual(await mutatedFingerprint.json(), {
    error: "This review item changed while you were reviewing it. Reload the latest state before deciding.",
    code: "CATALOG_REVIEW_DECISION_REVIEW_FINGERPRINT_MISMATCH",
  });
});

test("reverse endpoint invokes only reversal RPC and serializes reversal", async () => {
  const calls = [];
  const response = await handleCatalogObservationReviewDecisionReverseRequest(request(validReversalBody(), "/api/catalog/observation-review/decision/reverse"), {}, deps({
    createCatalogObservationDecisionCommandDb: () => ({
      async recordDecision() {
        throw new Error("record should not be called");
      },
      async reverseDecision(input) {
        calls.push({ method: "rpc", name: "reverse_catalog_observation_review_decision", input });
        return rpcResult({ eventType: "DECISION_REVERSED", decisionType: null, replayed: false, version: 2 });
      },
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.action, "reverse_decision");
  assert.equal(body.event.event_type, "DECISION_REVERSED");
  assert.deepEqual(calls.map((call) => call.name), ["reverse_catalog_observation_review_decision"]);
});

test("unexpected failures are sanitized and reviewer notes are not reflected in error body", async () => {
  const response = await handleCatalogObservationReviewDecisionRequest(request({ ...validDecisionBody(), reviewerNote: "sensitive reviewer note" }), {}, deps({
    createCatalogObservationDecisionCommandDb: () => ({
      async recordDecision() {
        throw new Error("database stack sensitive reviewer note");
      },
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(body).includes("sensitive reviewer note"), false);
});

function deps(overrides = {}) {
  return {
    requireCallerProfile: async () => ({ profile: { id: "user-1", role: "admin", is_active: true, organization_id: ORG_ID } }),
    createCatalogObservationDecisionCommandDb: () => ({
      async recordDecision() {
        return rpcResult({ eventType: "DECISION_RECORDED", decisionType: "ACCEPT_RECOMMENDATION", replayed: false, version: 1 });
      },
      async reverseDecision() {
        return rpcResult({ eventType: "DECISION_REVERSED", decisionType: null, replayed: false, version: 2 });
      },
    }),
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

function request(body, path = "/api/catalog/observation-review/decision") {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer caller-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function validDecisionBody() {
  return {
    reviewItemId: REVIEW_ITEM_ID,
    decisionType: "ACCEPT_RECOMMENDATION",
    reasonCode: "EVIDENCE_SUFFICIENT",
    reviewerNote: "checked",
    expectedDecisionVersion: 0,
    expectedRecommendationFingerprint: "canonical-recommendation-fingerprint",
    expectedReviewItemFingerprint: "canonical-review-item-fingerprint",
    expectedProductTargetFingerprint: "canonical-product-target-fingerprint",
    idempotencyKey: "decision-1",
  };
}

function validReversalBody() {
  return {
    reviewItemId: REVIEW_ITEM_ID,
    targetDecisionEventId: EVENT_ID,
    reasonCode: "DECISION_ENTERED_IN_ERROR",
    reviewerNote: "wrong item",
    expectedDecisionVersion: 1,
    idempotencyKey: "reverse-1",
  };
}

function rpcResult({ eventType, decisionType = "ACCEPT_RECOMMENDATION", replayed, version }) {
  return {
    idempotency_replay: replayed,
    event: {
      event_id: EVENT_ID,
      review_item_id: REVIEW_ITEM_ID,
      event_type: eventType,
      decision_type: decisionType,
      reason_code: decisionType ? "EVIDENCE_SUFFICIENT" : "DECISION_ENTERED_IN_ERROR",
      resulting_decision_version: version,
      reviewer_user_id: "user-1",
      reviewer_role: "admin",
      created_at: NOW,
      reversal_target_event_id: eventType === "DECISION_REVERSED" ? EVENT_ID : null,
    },
    current_state: {
      organization_id: ORG_ID,
      review_item_id: REVIEW_ITEM_ID,
      current_decision: eventType === "DECISION_REVERSED" ? "REVERSED" : decisionType,
      current_event_id: EVENT_ID,
      reviewer_user_id: "user-1",
      reviewer_role: "admin",
      decided_at: NOW,
      decision_version: version,
      is_reversed: eventType === "DECISION_REVERSED",
      is_superseded: false,
      is_invalidated: false,
      is_stale: false,
      requires_re_review: eventType === "DECISION_REVERSED",
      apply_eligible: decisionType === "ACCEPT_RECOMMENDATION",
      apply_block_reasons: decisionType === "ACCEPT_RECOMMENDATION" ? [] : ["DECISION_REVERSED"],
    },
  };
}
