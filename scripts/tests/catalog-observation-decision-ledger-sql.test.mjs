import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationPath = new URL("../../supabase/migrations/20260719_001_catalog_review_decision_ledger.sql", import.meta.url);
const sql = readFileSync(migrationPath, "utf8");
const fingerprintProjectionPath = new URL("../../supabase/migrations/20260722_001_catalog_review_fingerprint_projection.sql", import.meta.url);
const fingerprintSql = readFileSync(fingerprintProjectionPath, "utf8");
const reversalFixPath = new URL("../../supabase/migrations/20260722_002_catalog_review_reversal_idempotency_order_fix.sql", import.meta.url);
const reversalFixSql = readFileSync(reversalFixPath, "utf8");
const reversalBehaviorValidationPath = new URL("../../supabase/validation/NM-CATALOG-WP2-F1_REVERSAL_IDEMPOTENCY_BEHAVIOR_VALIDATE.sql", import.meta.url);
const reversalBehaviorValidationSql = readFileSync(reversalBehaviorValidationPath, "utf8");

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

test("fingerprint projection exposes DB-canonical read contract only", () => {
  assert.match(fingerprintSql, /create or replace function public\.get_catalog_observation_review_fingerprints\(input_review_item_id text\)/);
  assert.match(fingerprintSql, /auth\.uid\(\)/);
  assert.match(fingerprintSql, /public\.current_profile_org_id\(\)/);
  assert.match(fingerprintSql, /lower\(coalesce\(p\.role, ''\)\) in \('admin', 'superadmin'\)/);
  assert.match(fingerprintSql, /public\.catalog_review_observation_fingerprint\(v_observation\)/);
  assert.match(fingerprintSql, /public\.catalog_review_product_target_fingerprint\(v_parsed\.field_family, v_product\)/);
  assert.match(fingerprintSql, /public\.catalog_review_item_fingerprint\(input_review_item_id, v_observation, v_product\)/);
  assert.match(fingerprintSql, /CATALOG_REVIEW_DECISION_ORGANIZATION_MISMATCH/);
  assert.match(fingerprintSql, /grant execute on function public\.get_catalog_observation_review_fingerprints\(text\) to authenticated;/);
  assert.doesNotMatch(fingerprintSql, /grant execute on function public\.get_catalog_observation_review_fingerprints\(text\) to authenticated, service_role/);
  assert.doesNotMatch(fingerprintSql, /update\s+public\.catalog_products/i);
  assert.doesNotMatch(fingerprintSql, /insert\s+into\s+public\.catalog_products/i);
  assert.doesNotMatch(fingerprintSql, /update\s+public\.catalog_external_observations/i);
  assert.doesNotMatch(fingerprintSql, /insert\s+into\s+public\.catalog_observation_review_decision_events/i);
});

test("reversal idempotency replay is resolved before stale-version rejection", () => {
  assert.match(reversalFixSql, /create or replace function public\.reverse_catalog_observation_review_decision\(/);
  assert.match(reversalFixSql, /select \* into v_existing\s+from public\.catalog_observation_review_decision_events e\s+where e\.organization_id = v_org_id\s+and e\.review_item_id = input_review_item_id\s+and e\.idempotency_key = input_idempotency_key\s+limit 1;/s);
  assert.match(reversalFixSql, /if found then\s+if v_existing\.idempotency_payload_hash <> v_payload_hash then\s+raise exception 'CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH: idempotency key payload changed'/s);
  assert.match(reversalFixSql, /return jsonb_build_object\(\s*'event', to_jsonb\(v_existing\),\s*'current_state', public\.get_catalog_observation_review_decision_state\(input_review_item_id\),\s*'idempotency_replay', true\s*\);/s);
  assert.match(reversalFixSql, /v_current_version := public\.catalog_review_current_version\(v_org_id, input_review_item_id\);/);
  const existingLookupIndex = reversalFixSql.indexOf("select * into v_existing");
  const versionCheckIndex = reversalFixSql.indexOf("v_current_version := public.catalog_review_current_version");
  assert(existingLookupIndex >= 0 && versionCheckIndex >= 0 && existingLookupIndex < versionCheckIndex);
  assert.doesNotMatch(reversalFixSql, /v_current_version := public\.catalog_review_current_version\(v_org_id, input_review_item_id\);\s*if v_current_version <> input_expected_decision_version then\s*raise exception 'CATALOG_REVIEW_DECISION_CONFLICT: expected version does not match current version'\s*using errcode = 'P0001';\s*end if;\s*if found then/s);
  assert.match(reversalFixSql, /revoke all on function public\.reverse_catalog_observation_review_decision\(text, uuid, text, text, integer, text\) from public, anon, authenticated, service_role/);
  assert.match(reversalFixSql, /grant execute on function public\.reverse_catalog_observation_review_decision\(text, uuid, text, text, integer, text\) to authenticated, service_role/);
});

test("reversal behavior validation derives fixture versions from current review item state", () => {
  assert.match(reversalBehaviorValidationSql, /select coalesce\(max\(e\.resulting_decision_version\), 0\)::integer\s+into v_target_prior_version/s);
  assert.match(reversalBehaviorValidationSql, /v_target_decision_version := v_target_prior_version \+ 1/);
  assert.match(reversalBehaviorValidationSql, /v_target_reversal_version := v_target_decision_version \+ 1/);
  assert.match(reversalBehaviorValidationSql, /select coalesce\(max\(e\.resulting_decision_version\), 0\)::integer\s+into v_second_prior_version/s);
  assert.match(reversalBehaviorValidationSql, /v_second_decision_version := v_second_prior_version \+ 1/);
  assert.doesNotMatch(reversalBehaviorValidationSql, /public\.catalog_review_product_target_fingerprint\(v_observation\.field_family, v_product\),\s*0,\s*1,\s*'wp2f1-validation-target-/s);
  assert.doesNotMatch(reversalBehaviorValidationSql, /public\.catalog_review_product_target_fingerprint\(v_second_observation\.field_family, v_second_product\),\s*0,\s*1,\s*'wp2f1-validation-second-target-/s);
});

test("reversal behavior validation isolates cross-organization boundary from transition state", () => {
  assert.match(reversalBehaviorValidationSql, /v_second_target_event_id uuid := gen_random_uuid\(\)/);
  assert.match(reversalBehaviorValidationSql, /v_cross_org_review_item_id := concat_ws\(':', gen_random_uuid\(\)::text, v_second_observation\.catalog_product_id::text, v_second_observation\.id::text, v_second_observation\.field_family\)/);
  assert.match(reversalBehaviorValidationSql, /event_id,\s+organization_id,\s+review_item_id,\s+observation_id/s);
  assert.match(reversalBehaviorValidationSql, /v_second_target_event_id,\s+v_actor\.organization_id,\s+v_second_review_item_id/s);
  assert.match(reversalBehaviorValidationSql, /if v_second_target_event_id = v_target_event_id\s+or v_cross_current_event_id <> v_second_target_event_id\s+or v_cross_version_before <> v_second_decision_version then\s+raise exception 'BLOCKED: cross-organization fixture is not an independent reversible target'/s);
  assert.match(reversalBehaviorValidationSql, /where p\.organization_id <> v_actor\.organization_id\s+and coalesce\(p\.is_active, true\)\s+and lower\(coalesce\(p\.role, ''\)\) in \('admin', 'superadmin'\)/s);
  assert.match(reversalBehaviorValidationSql, /if v_other_actor\.id is not null then\s+perform set_config\('request\.jwt\.claim\.sub', v_other_actor\.id::text, true\);\s+v_cross_org_review_item_id := v_second_review_item_id;\s+end if;/s);
  assert.match(reversalBehaviorValidationSql, /perform set_config\('request\.jwt\.claim\.sub', v_actor\.id::text, true\);/);
  assert.match(reversalBehaviorValidationSql, /expected tenant-safe INVALID_TRANSITION for cross-organization boundary/);
  assert.match(reversalBehaviorValidationSql, /if v_cross_version_after <> v_cross_version_before\s+or v_cross_reversal_count_after <> v_cross_reversal_count_before then\s+raise exception 'BLOCKED: cross-organization rejection changed event state'/s);
  assert.doesNotMatch(reversalBehaviorValidationSql, /expected ORGANIZATION_MISMATCH/);
});
