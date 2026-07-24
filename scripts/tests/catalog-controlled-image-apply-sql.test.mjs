import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migrationPath = new URL("../../supabase/migrations/20260724_001_catalog_controlled_image_apply.sql", import.meta.url);
const sql = readFileSync(migrationPath, "utf8");
const validationPath = new URL("../../supabase/validation/NM-CATALOG-WP2-F2_CONTROLLED_IMAGE_APPLY_BEHAVIOR_VALIDATE.sql", import.meta.url);
const validationSql = readFileSync(validationPath, "utf8");
const concurrencySetupPath = new URL("../../supabase/validation/NM-CATALOG-WP2-F2_CONTROLLED_IMAGE_APPLY_CONCURRENCY_SETUP.sql", import.meta.url);
const concurrencySetupSql = readFileSync(concurrencySetupPath, "utf8");
const concurrencyCleanupPath = new URL("../../supabase/validation/NM-CATALOG-WP2-F2_CONTROLLED_IMAGE_APPLY_CONCURRENCY_CLEANUP.sql", import.meta.url);
const concurrencyCleanupSql = readFileSync(concurrencyCleanupPath, "utf8");
const concurrencyProcedurePath = new URL("../../supabase/validation/NM-CATALOG-WP2-F2_CONTROLLED_IMAGE_APPLY_CONCURRENCY_PROCEDURE.md", import.meta.url);
const concurrencyProcedure = readFileSync(concurrencyProcedurePath, "utf8");

test("F2 DB defines an append-only image Apply audit ledger", () => {
  assert.match(sql, /create table if not exists public\.catalog_observation_review_apply_events/);
  assert.match(sql, /field_family text not null check \(field_family = 'image_reference'\)/);
  assert.match(sql, /target_field text not null check \(target_field = 'image_url'\)/);
  assert.match(sql, /uq_catalog_review_apply_idempotency/);
  assert.match(sql, /uq_catalog_review_apply_decision/);
  assert.match(sql, /prevent_catalog_review_apply_event_mutation/);
  assert.match(sql, /before update or delete\s+on public\.catalog_observation_review_apply_events/i);
});

test("F2 DB Apply is tenant-bound, separately authorized, and does not self-approve", () => {
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /public\.current_profile_org_id\(\)/);
  assert.match(sql, /CATALOG_REVIEW_APPLY_ORGANIZATION_MISMATCH/);
  assert.match(sql, /v_decision\.reviewer_user_id = v_actor_id/);
  assert.match(sql, /decision reviewer cannot self-authorize apply/);
});

test("F2 DB Apply revalidates the current accepted decision and current Product target", () => {
  assert.match(sql, /v_decision\.event_id <> input_decision_event_id/);
  assert.match(sql, /v_decision\.event_type <> 'DECISION_RECORDED'/);
  assert.match(sql, /v_decision\.decision_type <> 'ACCEPT_RECOMMENDATION'/);
  assert.match(sql, /not v_decision\.apply_eligible/);
  assert.match(sql, /v_current_version <> input_expected_decision_version/);
  assert.match(sql, /v_product_target_fingerprint_before <> input_expected_product_target_fingerprint/);
  assert.match(sql, /for update/);
  assert.match(sql, /CATALOG_REVIEW_APPLY_STALE/);
  assert.match(sql, /perform public\.enqueue_catalog_integrity_product\(/);
  assert.match(sql, /'controlled_image_apply'/);
  assert.match(sql, /downstream_revalidation_requested_at timestamptz not null default now\(\)/);
});

test("F2 DB Apply is fill-only and derives the candidate from reviewed observation evidence", () => {
  assert.match(sql, /v_candidate := btrim\(coalesce\(v_observation\.normalized_value, ''\)\)/);
  assert.doesNotMatch(sql, /input_candidate_image_url/);
  assert.match(sql, /CATALOG_REVIEW_APPLY_TARGET_NOT_EMPTY/);
  assert.match(sql, /nullif\(btrim\(coalesce\(v_product\.image_url, ''\)\), ''\) is not null/);
  assert.match(sql, /CATALOG_REVIEW_APPLY_EVIDENCE_BLOCKED/);
  assert.match(sql, /v_observation\.freshness_status <> 'fresh'/);
  assert.match(sql, /v_observation\.license_posture <> 'allowed'/);
  assert.match(sql, /v_source\.source_type not in \('manufacturer', 'authorized_distributor', 'licensed_catalog'\)/);
  assert.match(sql, /Mira\/Dimbax material remains a governed future intake/);
  assert.match(sql, /CATALOG_REVIEW_APPLY_URL_BLOCKED/);
});

test("F2 DB Apply is idempotent and leaves no browser/API execution grant", () => {
  assert.match(sql, /CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH/);
  assert.match(sql, /'idempotency_replay', true/);
  assert.match(sql, /perform pg_advisory_xact_lock/);
  assert.match(sql, /revoke all on function public\.apply_catalog_observation_review_image\(text, uuid, integer, text, text, text\) from public, anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /grant execute on function public\.apply_catalog_observation_review_image/i);
  assert.doesNotMatch(sql, /update\s+public\.catalog_external_observations/i);
});

test("F2 DB ships an unrun rollback-safe behavior validation pack", () => {
  assert.match(validationSql, /^begin;/m);
  assert.match(validationSql, /rollback;\s*$/m);
  assert.match(validationSql, /wp2f2_local_fixture/);
  assert.match(validationSql, /must not require production or copied customer data/);
  assert.match(validationSql, /01_first_apply_atomic/);
  assert.match(validationSql, /02_exact_replay_stable/);
  assert.match(validationSql, /03_payload_change_conflict/);
  assert.match(validationSql, /04_stale_target_rejected/);
  assert.match(validationSql, /05_separation_of_duties/);
  assert.match(validationSql, /CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH/);
  assert.match(validationSql, /CATALOG_REVIEW_APPLY_AUTHORIZATION_BLOCKED/);
  assert.match(validationSql, /event'->>'apply_event_id/);
  assert.match(validationSql, /CONTROLLED_IMAGE_APPLY_BEHAVIOR_VERIFIED/);
});

test("F2 DB supplies a local-only two-session concurrency fixture", () => {
  assert.match(concurrencySetupSql, /Local-only setup for the two-session F2 Apply concurrency proof/);
  assert.match(concurrencySetupSql, /'f2-concurrency-authorizer@local\.invalid'/);
  assert.match(concurrencySetupSql, /'10000000-0000-0000-0000-00000000000b'/);
  assert.match(concurrencySetupSql, /'f2-concurrency-decision'/);
  assert.match(concurrencyCleanupSql, /LOCAL-ONLY disposable fixture cleanup/);
  assert.match(concurrencyCleanupSql, /set local session_replication_role = replica/);
  assert.match(concurrencyCleanupSql, /catalog_integrity_summary/);
  assert.match(concurrencyProcedure, /first response has `idempotency_replay=false`/);
  assert.match(concurrencyProcedure, /same `apply_event_id`/);
  assert.match(concurrencyProcedure, /exactly one row/);
});
