import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../../supabase/migrations/20260726213449_catalog_zf_group_staging_review_projection_compatibility.sql",
  import.meta.url,
);
const validatorPath = new URL(
  "../../supabase/validation/NM-CATALOG-ZF-GROUP-STAGING-REVIEW-PROJECTION-COMPATIBILITY-VALIDATE.sql",
  import.meta.url,
);

const [migration, validator] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(validatorPath, "utf8"),
]);

const normalizeSql = (value) =>
  value.replaceAll(/\s+/g, " ").trim().toLowerCase();

const uncommentedMigration = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const statements = uncommentedMigration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const projection =
  migration.match(
    /create or replace view public\.catalog_zf_new_product_staging_review_v[\s\S]*?\nas\nselect\n([\s\S]*?)\nfrom public\.catalog_new_product_staging_candidates candidate/i,
  )?.[1] ?? "";

const projectionExpressions = projection
  .split(",")
  .map(normalizeSql)
  .filter(Boolean);

const expectedProjectionExpressions = [
  "candidate.id",
  "candidate.organization_id",
  "candidate.brand_id",
  "brand.name as brand",
  "candidate.proposed_display_code",
  "candidate.normalized_code",
  "candidate.official_source_display_code",
  "candidate.official_comparison_key",
  "candidate.description",
  "candidate.ean",
  "candidate.hs_code",
  "candidate.origin",
  "candidate.weight_kg",
  "candidate.oem_references",
  "candidate.vehicle_applications",
  "candidate.fitment_facts",
  "candidate.engine_facts",
  "candidate.lifecycle_status",
  "candidate.lifecycle_note",
  "candidate.replacement_candidates",
  "candidate.supersession_candidates",
  "candidate.official_image_candidate_url",
  "candidate.official_image_evidence_reference",
  "candidate.official_source_url",
  "candidate.observed_at",
  "candidate.evidence_hash",
  "candidate.payload_fingerprint",
  "candidate.observation_fingerprint",
  "candidate.candidate_version",
  "candidate.supersedes_candidate_id",
  "candidate.quarantine_class",
  "candidate.limitation_flags",
  "candidate.source_schema_version",
  "candidate.runtime_commit",
  "candidate.deploy_id",
  "candidate.created_at",
  "latest_event.event_type as latest_event_type",
  "latest_event.event_version as latest_event_version",
  "latest_event.reason_code as latest_event_reason_code",
  "latest_event.created_at as latest_event_at",
  "candidate.run_id",
  "candidate.job_id",
  "candidate.source_id",
  "candidate.contract_version",
].map(normalizeSql);

test("migration is one exact security-invoker view replacement plus grant hardening", () => {
  assert.equal(statements.length, 4);
  assert.match(
    statements[0],
    /^create or replace view public\.catalog_zf_new_product_staging_review_v\s+with \(security_invoker = true\)\s+as\s+select/i,
  );
  assert.match(
    statements[1],
    /^revoke all on table public\.catalog_zf_new_product_staging_review_v\s+from public, anon, authenticated, service_role$/i,
  );
  assert.match(
    statements[2],
    /^grant select on table public\.catalog_zf_new_product_staging_review_v\s+to authenticated$/i,
  );
  assert.match(
    statements[3],
    /^comment on view public\.catalog_zf_new_product_staging_review_v is\s+'/i,
  );
});

test("the existing allowlist is preserved and only four identities are appended", () => {
  assert.deepEqual(projectionExpressions, expectedProjectionExpressions);
  assert.deepEqual(projectionExpressions.slice(-4), [
    "candidate.run_id",
    "candidate.job_id",
    "candidate.source_id",
    "candidate.contract_version",
  ]);
});

test("migration contains no object, policy, function, data, or write expansion", () => {
  for (const forbidden of [
    /\bcreate\s+(table|function|index|trigger|policy|type|extension|schema)\b/i,
    /\balter\s+(table|policy|function|role|schema)\b/i,
    /\bdrop\s+(table|view|function|index|trigger|policy|type|extension|schema)\b/i,
    /\b(insert\s+into|update|delete\s+from|truncate|merge\s+into|copy)\b/i,
    /\bgrant\s+(all|insert|update|delete|truncate|references|trigger|execute)\b/i,
    /\bgrant\s+select[\s\S]*\bto\s+(anon|service_role|public)\b/i,
    /\bsecurity\s+definer\b/i,
    /\b(create|replace)\s+(route|rpc)\b/i,
  ]) {
    assert.doesNotMatch(uncommentedMigration, forbidden);
  }
});

test("validator is rollback-safe and covers the accepted security matrix", () => {
  for (const expected of [
    "security_invoker=true",
    "has_table_privilege",
    "04_admin_same_tenant",
    "03_superadmin_same_tenant_and_cross_tenant_isolation",
    "05_non_admin_zero_rows",
    "06_other_tenant_isolation",
    "07_anon_view_denied",
    "08_service_role_view_denied",
    "09_bounded_projection_query_plans",
    "10_no_product_review_guardian_or_apply_mutation",
    "run_id",
    "job_id",
    "source_id",
    "contract_version",
  ]) {
    assert.match(
      validator,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  assert.match(validator, /^begin;$/m);
  assert.match(validator, /^rollback;$/m);
  assert.match(validator, /select 1 \/ 0 as validator_rejected;/);
  assert.doesNotMatch(validator, /^commit;$/mi);
});

test("package contains no route, provider, Product write, review, Guardian, or Apply authority", () => {
  assert.doesNotMatch(
    uncommentedMigration,
    /\b(api\/catalog|netlify|provider|credential|authorization header|bearer token)\b/i,
  );
  assert.doesNotMatch(
    uncommentedMigration,
    /\b(insert\s+into|update|delete\s+from)\s+public\.(catalog_products|catalog_observation_review_decisions|catalog_apply_events)\b/i,
  );
  assert.doesNotMatch(uncommentedMigration, /\bguardian\b/i);
});
