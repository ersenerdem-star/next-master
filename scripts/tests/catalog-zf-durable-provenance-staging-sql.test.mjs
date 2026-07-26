import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../../supabase/migrations/20260726203831_catalog_zf_group_durable_provenance_staging.sql",
  import.meta.url,
);
const validatorPath = new URL(
  "../../supabase/validation/NM-CATALOG-ZF-GROUP-DURABLE-PROVENANCE-AND-STAGING-DB-VALIDATE.sql",
  import.meta.url,
);

const [migration, validator] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(validatorPath, "utf8"),
]);

test("migration extends the observation foundation with the accepted durable objects", () => {
  assert.match(migration, /alter table public\.catalog_observation_runs[\s\S]*?contract_version text/);
  assert.match(migration, /create table if not exists public\.catalog_observation_item_outcomes/);
  assert.match(migration, /create table if not exists public\.catalog_new_product_staging_candidates/);
  assert.match(migration, /create table if not exists public\.catalog_new_product_staging_events/);
  assert.match(migration, /create table if not exists public\.catalog_product_source_aliases/);
  assert.match(migration, /uq_catalog_observation_runs_durable_identity/);
});

test("run identity is tenant derived, fingerprinted, replayable, and conflict safe", () => {
  const beginFunction =
    migration.match(
      /create or replace function public\.begin_catalog_zf_durable_run[\s\S]*?\n\$\$;/i,
    )?.[0] || "";

  assert.match(beginFunction, /source\.source_key = 'zf_aftermarket'/);
  assert.match(beginFunction, /v_job\.organization_id/);
  assert.match(beginFunction, /pg_advisory_xact_lock/);
  assert.match(beginFunction, /'replayed', true/);
  assert.match(beginFunction, /'RUN_IDEMPOTENCY_CONFLICT'/);
  assert.match(beginFunction, /input_candidate_limit <> 1/);
  assert.doesNotMatch(
    beginFunction.match(/begin_catalog_zf_durable_run\(([\s\S]*?)\)\nreturns/)?.[1] || "",
    /input_organization_id/i,
  );
});

test("staging preserves whitespace-only identity and immutable official aliases", () => {
  assert.match(migration, /public\.normalize_catalog_product_code\(\s*v_candidate ->> 'proposedDisplayCode'/);
  assert.match(migration, /official_source_display_code text not null/);
  assert.match(migration, /official_comparison_key text not null/);
  assert.match(
    migration,
    /unique \(\s*organization_id,\s*source_id,\s*brand_id,\s*official_source_display_code\s*\)/,
  );
  assert.match(migration, /'SOURCE_ALIAS_CONFLICT'/);
  assert.match(migration, /v_product\.product_code/);
});

test("new durable tables are RLS protected and service role is execute-only", () => {
  for (const table of [
    "catalog_new_product_staging_candidates",
    "catalog_product_source_aliases",
    "catalog_observation_item_outcomes",
    "catalog_new_product_staging_events",
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(
      migration,
      new RegExp(
        `revoke all on table public\\.${table}[\\s\\S]*?from public, anon, authenticated, service_role`,
      ),
    );
    assert.match(
      migration,
      new RegExp(`grant select on table public\\.${table}[\\s\\S]*?to authenticated, service_role`),
    );
  }

  assert.doesNotMatch(
    migration,
    /grant\s+(insert|update|delete|all)[\s\S]{0,180}to\s+service_role/i,
  );
  assert.match(migration, /to authenticated[\s\S]*?organization_id = public\.current_profile_org_id\(\)/);
  assert.match(migration, /with \(security_invoker = true\)/);
});

test("evidence, aliases, outcomes, and staging events are append-only", () => {
  assert.match(migration, /create or replace function public\.prevent_catalog_zf_append_only_mutation/);
  assert.match(migration, /trg_catalog_new_product_staging_candidates_append_only/);
  assert.match(migration, /trg_catalog_product_source_aliases_append_only/);
  assert.match(migration, /trg_catalog_observation_item_outcomes_append_only/);
  assert.match(migration, /trg_catalog_new_product_staging_events_append_only/);
  assert.match(migration, /trg_catalog_observation_runs_zf_provenance_immutable/);
});

test("item payload validation is exhaustive, redacted, atomic, and checkpoint bounded", () => {
  const itemFunction =
    migration.match(
      /create or replace function public\.record_catalog_zf_durable_item[\s\S]*?\n\$\$;/i,
    )?.[0] || "";

  assert.match(itemFunction, /jsonb_object_keys\(input_item\)/);
  assert.match(itemFunction, /UNKNOWN_ITEM_FIELD/);
  assert.match(itemFunction, /UNKNOWN_CANDIDATE_FIELD/);
  assert.match(itemFunction, /REDACTION_UNSAFE_ITEM_PAYLOAD/);
  assert.match(itemFunction, /SOURCE_PAYLOAD_CONFLICT/);
  assert.match(itemFunction, /TIMEOUT_CANNOT_ADVANCE_CHECKPOINT/);
  assert.match(itemFunction, /generate_series\(1, max_sequence\.max_sequence\)/);
  assert.match(itemFunction, /insert into public\.catalog_new_product_staging_candidates/);
  assert.match(itemFunction, /insert into public\.catalog_observation_item_outcomes/);
  assert.match(itemFunction, /insert into public\.catalog_observation_audit_ledger/);
});

test("reserved Product-creation and Apply events are absent from the staging event contract", () => {
  const eventTable =
    migration.match(
      /create table if not exists public\.catalog_new_product_staging_events[\s\S]*?\n\);/i,
    )?.[0] || "";
  const eventFunction =
    migration.match(
      /create or replace function public\.append_catalog_zf_staging_event[\s\S]*?\n\$\$;/i,
    )?.[0] || "";

  for (const reserved of [
    "ACCEPTED_FOR_PRODUCT_CREATION",
    "APPLY_REQUESTED",
    "APPLIED",
    "APPLY_FAILED",
  ]) {
    assert.doesNotMatch(eventTable, new RegExp(`'${reserved}'`));
    assert.doesNotMatch(eventFunction, new RegExp(`'${reserved}'`));
  }
});

test("migration has no canonical Product, relation, review, Guardian, image, or Apply mutation", () => {
  assert.doesNotMatch(migration, /insert\s+into\s+public\.catalog_products/i);
  assert.doesNotMatch(migration, /update\s+public\.catalog_products/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.catalog_products/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.item_code_references/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.catalog_product_relations/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.catalog_apply_events/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.catalog_observation_review_decisions/i);
});

test("behavior validator covers the accepted local evidence matrix and always rolls back", () => {
  for (const expected of [
    "RUN_IDEMPOTENCY_CONFLICT",
    "SOURCE_PAYLOAD_CONFLICT",
    "UNKNOWN_ITEM_FIELD",
    "REDACTION_UNSAFE_ITEM_PAYLOAD",
    "STAGING_REPLAYED",
    "SOURCE_ALIAS_CONFLICT",
    "SUSPECT_PROVIDER_BOUNDARY",
    "OFFICIAL_BRAND_MISMATCH",
    "ATOMIC_FAILURE_PROBE",
    "service_role has exact function execute but no direct staging/evidence table write",
    "no Product, review, Guardian, relation, image authority, or Apply event is created",
    "non-production run replay, item page, and tenant/brand staging plans avoid sequential scans",
  ]) {
    assert.match(validator, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(validator, /^begin;/m);
  assert.match(validator, /^rollback;$/m);
});
