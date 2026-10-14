import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const baseSql = fs.readFileSync(
  new URL("../../supabase/migrations/20261014090000_catalog_import_storage_pipeline.sql", import.meta.url),
  "utf8",
);
const hardeningSql = fs.readFileSync(
  new URL("../../supabase/migrations/20261014100000_catalog_import_storage_hardening.sql", import.meta.url),
  "utf8",
);
const runtimeFenceSql = fs.readFileSync(
  new URL("../../supabase/migrations/20261014110000_catalog_import_storage_runtime_fence.sql", import.meta.url),
  "utf8",
);
const apiCleanupSql = fs.readFileSync(
  new URL("../../supabase/migrations/20261014120000_catalog_import_storage_api_cleanup.sql", import.meta.url),
  "utf8",
);
const validationSql = fs.readFileSync(
  new URL("../../supabase/migrations/20261014132000_catalog_import_storage_validation_batches.sql", import.meta.url),
  "utf8",
);
const sql = `${baseSql}\n${hardeningSql}\n${runtimeFenceSql}\n${apiCleanupSql}\n${validationSql}`;

const functionBlock = (name) => {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `${name} function must exist`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `${name} function body must be closed`);
  return sql.slice(start, end);
};

const latestFunctionBlock = (name) => {
  const start = sql.lastIndexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `${name} function must exist`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `${name} function body must be closed`);
  return sql.slice(start, end);
};

test("catalog storage is private, bounded, and sealed by restrictive policies", () => {
  assert.match(sql, /insert into storage\.buckets[\s\S]*'catalog-imports'[\s\S]*false/i);
  assert.match(sql, /file_size_limit[\s\S]*1073741824/i);
  assert.doesNotMatch(sql, /catalog-imports[\s\S]{0,200}public\s*=\s*true/i);
  for (const policy of ["select", "insert", "update", "delete"]) {
    assert.match(sql, new RegExp(`catalog_import_objects_${policy}_fence[\\s\\S]*as restrictive`, "i"));
  }
  assert.match(sql, /catalog_storage_object_allowed\(name,true\)/i);
  assert.match(sql, /status in \('created','uploading'\)/i);
  assert.match(sql, /bucket_id <> 'catalog-imports'/i);
});

test("source metadata and batch receipts are durable, tenant-scoped, and RLS protected", () => {
  assert.match(sql, /create table if not exists public\.catalog_import_sources/i);
  assert.match(sql, /run_id uuid not null unique references public\.catalog_import_runs/i);
  assert.match(sql, /organization_id uuid not null references public\.organizations/i);
  assert.match(sql, /storage_object_path text not null/i);
  assert.match(sql, /admitted_checksum_sha256 text/i);
  assert.match(sql, /parser_version text not null default 'catalog-csv-v1'/i);
  assert.match(sql, /lease_token uuid/i);
  assert.match(sql, /lease_generation bigint not null default 0/i);
  assert.match(sql, /create table if not exists public\.catalog_import_source_batches/i);
  assert.match(sql, /foreign key \(source_id, run_id, organization_id\)/i);
  assert.match(sql, /create unique index if not exists idx_catalog_import_source_batches_cursor_unique[\s\S]*\(source_id, cursor_end\)/i);
  assert.match(sql, /alter table public\.catalog_import_sources enable row level security/i);
  assert.match(sql, /alter table public\.catalog_import_source_batches enable row level security/i);
  assert.match(sql, /revoke all on table public\.catalog_import_sources from public, anon, authenticated, service_role/i);
  assert.match(sql, /catalog_import_sources_select_ops[\s\S]*current_profile_org_id\(\)[\s\S]*admin','superadmin/i);
  assert.match(sql, /catalog_storage_source_identity_guard/i);
  assert.match(sql, /CATALOG_STORAGE_SOURCE_IDENTITY_IMMUTABLE/i);
});

test("authenticated begin and browser seal bind org/actor and verify object metadata", () => {
  const begin = functionBlock("begin_catalog_import_storage");
  assert.match(begin, /v_actor uuid := auth\.uid\(\)/i);
  assert.match(begin, /v_org uuid := public\.current_profile_org_id\(\)/i);
  assert.match(begin, /profile_has_permission\('catalog\.manage'\)/i);
  assert.match(begin, /pg_advisory_xact_lock/i);
  assert.match(begin, /idempotency_key = v_key/i);
  assert.match(begin, /public\.begin_catalog_import\(v_scope,v_mode\)/i);
  assert.match(begin, /storage_object_path.*v_path/i);
  assert.match(sql, /grant execute on function public\.begin_catalog_import_storage\([^)]*\) to authenticated/i);

  const seal = functionBlock("complete_catalog_import_storage_upload");
  assert.match(seal, /catalog_storage_lock_run/i);
  assert.match(seal, /owner_id::text is distinct from v_actor::text/i);
  assert.match(seal, /metadata->>'size'/i);
  assert.match(seal, /sealed_object_version=v_object\.version/i);
  assert.match(seal, /status='uploaded'/i);
});

test("system bridges are service-only and use explicit lease fencing", () => {
  const names = [
    "begin_catalog_import_storage_system",
    "complete_catalog_import_storage_upload_system",
    "claim_catalog_import_storage_source_system",
    "heartbeat_catalog_import_storage_source_system",
    "stage_catalog_import_storage_batch_system",
    "mark_catalog_import_storage_processing_queued_system",
    "fail_catalog_import_storage_source_system",
    "release_catalog_import_storage_source_system",
  ];
  for (const name of names) {
    const body = functionBlock(name);
    if (name !== "begin_catalog_import_storage_system") {
      assert.match(body, /auth\.role\(\).*service_role/i, `${name} must reject non-service callers`);
    }
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role`, "i"));
  }
  assert.match(sql, /input_uploaded_bytes/i);
  assert.match(sql, /input_checksum_sha256/i);
  assert.match(sql, /CATALOG_STORAGE_LEASE_FENCE/i);
});

test("claim cannot take an unsealed or unqueued source", () => {
  const body = functionBlock("claim_catalog_import_storage_source_system");
  assert.match(body, /processing_queued_at is null/i);
  assert.match(body, /status not in \('uploaded','processing','staged'\)/i);
  assert.match(body, /sealed_object_version is null/i);
  assert.match(body, /lease_expires_at is not null and v_source\.lease_expires_at > now\(\)/i);
  assert.match(body, /v_generation := v_source\.lease_generation \+ 1/i);
});

test("stage receipts enforce bounded contiguous cursors and idempotent replay", () => {
  const body = functionBlock("stage_catalog_import_storage_batch_system");
  assert.match(body, /jsonb_array_length\(input_payload\)>10000/i);
  assert.match(body, /pg_column_size\(input_payload\)>8388608/i);
  assert.match(body, /catalog_provider_jsonb_sha256/i);
  assert.match(body, /v_existing\.payload_sha256<>v_hash/i);
  assert.match(body, /v_source\.cursor_row\+1/i);
  assert.match(body, /v_rows<>v_max-v_min\+1/i);
  assert.match(sql, /create unique index if not exists idx_catalog_import_source_batches_cursor_unique/i);
  assert.match(body, /stage_catalog_import_chunk\(input_run_id,input_payload\)/i);
  assert.match(body, /case when input_is_final then 'staged' else 'processing' end/i);
  assert.match(body, /CATALOG_STORAGE_FINAL_CURSOR_MISMATCH/i);
});

test("failure handoff is fenced, terminal, and clears the queue marker", () => {
  const body = functionBlock("fail_catalog_import_storage_source_system");
  assert.match(body, /status='failed'/i);
  assert.match(body, /processing_queued_at=null/i);
  assert.match(body, /public\.fail_catalog_import\(v_run\.id/i);
  assert.match(body, /lease_owner=null/i);
  assert.match(body, /error_code/i);
});

test("browser upload failure is authenticated and hands private object cleanup to Storage API", () => {
  const body = latestFunctionBlock("fail_catalog_import_storage_upload");
  assert.match(sql, /status in \('created','uploading','uploaded','processing','staged','completed','failed','expired','cancelled'\)/i);
  assert.match(body, /auth\.uid\(\)/i);
  assert.doesNotMatch(body, /delete from storage\.objects/i);
  assert.match(body, /storage_object_id is not null/i);
  assert.match(body, /cleanup_required/i);
  assert.match(body, /CATALOG_STORAGE_UPLOAD_FAILED/i);
  assert.match(body, /public\.fail_catalog_import\(/i);
  assert.match(sql, /grant execute on function public\.fail_catalog_import_storage_upload\(uuid,text\)\s+to authenticated/i);
});

test("transient release clears only the matching lease and preserves queue retry", () => {
  const body = functionBlock("release_catalog_import_storage_source_system");
  assert.match(body, /lease_owner=null/i);
  assert.match(body, /lease_token=null/i);
  assert.match(body, /CATALOG_STORAGE_LEASE_FENCE/i);
  assert.match(body, /processing_queued_at',v_run\.processing_queued_at/i);
  assert.doesNotMatch(body, /public\.fail_catalog_import\(/i);
});

test("queued catalog runs retain the system finalization bridge", () => {
  const body = latestFunctionBlock("finalize_catalog_import_batch_system");
  assert.match(body, /input_organization_id/i);
  assert.match(body, /input_actor_id/i);
  assert.match(body, /public\.finalize_catalog_import_batch\(/i);
  assert.match(body, /to_regprocedure\('public\.finalize_catalog_import_batch\(uuid,integer\)'\)/i);
  assert.match(body, /public\.finalize_catalog_import\(\$1\)/i);
  assert.match(body, /least\(coalesce\(input_batch_size, 500\), 1000\)/i);
  assert.doesNotMatch(body, /delete from storage\.objects/i);
  assert.match(body, /storage_cleanup_required/i);
  assert.match(sql, /grant execute on function public\.finalize_catalog_import_batch_system\([^)]*\) to service_role/i);
  assert.match(body, /status = 'completed'/i);
});

test("large storage runs validate in durable bounded batches", () => {
  assert.match(validationSql, /add column if not exists validation_cursor/i);
  assert.match(validationSql, /idx_catalog_import_stage_run_validation/i);
  assert.match(validationSql, /idx_catalog_import_stage_run_code_brand/i);
  const body = latestFunctionBlock("validate_catalog_import_storage_batch_system");
  assert.match(body, /auth\.role\(\).*service_role/i);
  assert.match(body, /validation_cursor/i);
  assert.match(body, /limit v_batch_size/i);
  assert.match(body, /status = 'validating'/i);
  assert.match(body, /has_more/i);
  assert.match(validationSql, /grant execute on function public\.validate_catalog_import_storage_batch_system\([^)]*\)\s+to service_role/i);
});
