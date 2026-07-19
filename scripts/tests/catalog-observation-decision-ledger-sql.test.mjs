import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationPath = new URL("../../supabase/migrations/20260719_001_catalog_review_decision_ledger.sql", import.meta.url);
const sql = readFileSync(migrationPath, "utf8");

function has(pattern) {
  assert.match(sql, pattern);
}

function notHas(pattern) {
  assert.doesNotMatch(sql, pattern);
}

test("migration defines append-only decision ledger and canonical review item identity", () => {
  has(/create table if not exists public\.catalog_observation_review_decision_events/);
  has(/review_item_id text not null/);
  has(/observation_id uuid not null references public\.catalog_external_observations/);
  has(/catalog_product_id uuid not null references public\.catalog_products/);
  has(/prevent_catalog_review_decision_event_mutation/);
  has(/before update or delete\s+on public\.catalog_observation_review_decision_events/i);
  has(/string_to_array\(coalesce\(input_review_item_id, ''\), ':'\)/);
});

test("decision and event policy is constrained", () => {
  for (const eventType of ["DECISION_RECORDED", "DECISION_REVERSED", "DECISION_SUPERSEDED", "DECISION_INVALIDATED"]) {
    assert(sql.includes(eventType));
  }
  for (const decisionType of ["ACCEPT_RECOMMENDATION", "REJECT_RECOMMENDATION", "DEFER", "REQUEST_MORE_EVIDENCE"]) {
    assert(sql.includes(decisionType));
  }
  for (const reasonCode of ["EVIDENCE_SUFFICIENT", "INCORRECT_OBSERVATION", "NEEDS_SECOND_REVIEW", "MISSING_PRIMARY_SOURCE", "DECISION_ENTERED_IN_ERROR"]) {
    assert(sql.includes(reasonCode));
  }
});

test("command RPCs implement optimistic concurrency and idempotency", () => {
  has(/create or replace function public\.record_catalog_observation_review_decision\(\s*input_review_item_id text/);
  has(/create or replace function public\.reverse_catalog_observation_review_decision\(\s*input_review_item_id text/);
  has(/input_expected_decision_version integer/);
  has(/input_idempotency_key text/);
  has(/uq_catalog_review_decision_idempotency/);
  has(/uq_catalog_review_decision_version/);
  has(/pg_advisory_xact_lock/);
  has(/CATALOG_REVIEW_DECISION_CONFLICT/);
  has(/CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH/);
});

test("authorization and tenant isolation are enforced inside DB boundary", () => {
  has(/auth\.uid\(\)/);
  has(/public\.current_profile_org_id\(\)/);
  has(/lower\(coalesce\(p\.role, ''\)\) in \('admin', 'superadmin'\)/);
  has(/CATALOG_REVIEW_DECISION_ORGANIZATION_MISMATCH/);
  has(/v_parsed\.organization_id <> v_org_id/);
});

test("current-state projection exposes staleness and apply eligibility only", () => {
  has(/create or replace function public\.get_catalog_observation_review_decision_state/);
  has(/RECOMMENDATION_CHANGED/);
  has(/REVIEW_ITEM_CHANGED/);
  has(/PRODUCT_TARGET_CHANGED/);
  has(/FIELD_POLICY_PROHIBITS_APPLY/);
  has(/'apply_eligible'/);
  has(/field_risk in \('LOW_RISK', 'GUARDED', 'HIGH_RISK_OR_PROHIBITED_FOR_APPLY'\)/);
});

test("migration does not mutate Product, observations, or recommendation outputs", () => {
  notHas(/update\s+public\.catalog_products/i);
  notHas(/insert\s+into\s+public\.catalog_products/i);
  notHas(/delete\s+from\s+public\.catalog_products/i);
  notHas(/update\s+public\.catalog_external_observations/i);
  notHas(/delete\s+from\s+public\.catalog_external_observations/i);
  notHas(/insert\s+into\s+public\.catalog_external_observations/i);
  notHas(/update\s+public\.catalog_observation_candidates/i);
  notHas(/record_catalog_observation_apply_event/);
});

test("direct mutation grants are not exposed to browser roles", () => {
  has(/revoke all privileges on table public\.catalog_observation_review_decision_events from public, anon, authenticated, service_role/);
  has(/grant select on public\.catalog_observation_review_decision_events to authenticated, service_role/);
  notHas(/grant\s+(insert|update|delete).*catalog_observation_review_decision_events.*authenticated/i);
  has(/revoke all on function public\.record_catalog_observation_review_decision\(text, text, text, text, integer, text, text, text, text\) from public, anon, authenticated, service_role/);
  has(/grant execute on function public\.record_catalog_observation_review_decision\(text, text, text, text, integer, text, text, text, text\) to authenticated, service_role/);
});
