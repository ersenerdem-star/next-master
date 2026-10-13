import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rpcPath = new URL("../../netlify/functions/app-rpc.mts", import.meta.url);
const workerPath = new URL("../../netlify/functions/import-processing-worker.mts", import.meta.url);
const migrationPath = new URL(
  "../../supabase/migrations/20260805223258_import_queue_first_system_bridge.sql",
  import.meta.url,
);
const [rpcGateway, worker, migration] = await Promise.all([
  readFile(rpcPath, "utf8"),
  readFile(workerPath, "utf8"),
  readFile(migrationPath, "utf8"),
]);

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("catalog queue hand-off has one background owner", () => {
  const queueBlock = blockBetween(
    rpcGateway,
    'if (name === "queue_catalog_import_processing")',
    'if (name === "queue_supplier_price_catalog_sync")',
  );

  assert.match(queueBlock, /mark_catalog_import_processing_queued/);
  assert.doesNotMatch(queueBlock, /validate_catalog_import_system/);
  assert.doesNotMatch(queueBlock, /finalize_catalog_import_batch_system/);
  assert.doesNotMatch(queueBlock, /context\.waitUntil/);
});

test("scheduled worker owns catalog validation and finalization", () => {
  assert.match(worker, /validate_catalog_import_system/);
  assert.match(worker, /finalize_catalog_import_batch_system/);
  assert.match(worker, /processing_queued_at/);
});

test("terminal catalog runs clear stale queue markers", () => {
  assert.match(worker, /validation_failed/);
  assert.match(worker, /finalize_failed/);
  assert.match(worker, /clearTerminalCatalogQueueMarkers/);
  assert.match(worker, /processing_queued_at/);
  assert.match(worker, /not\.is\.null/);
  assert.match(worker, /TERMINAL_CATALOG_STATUSES\.has\(status\)/);
  assert.match(worker, /queueMarkerCleared: true/);
  assert.match(worker, /TERMINAL_CATALOG_STATUSES\.has\(latestStatus\)/);
});

test("catalog queue marker is tenant-scoped and idempotent", () => {
  const markerFunction = blockBetween(
    migration,
    "create or replace function public.mark_catalog_import_processing_queued",
    "revoke all on function public.mark_catalog_import_processing_queued",
  );

  assert.match(markerFunction, /current_profile_org_id\(\)/);
  assert.match(markerFunction, /current_profile_role\(\)/);
  assert.match(markerFunction, /organization_id = v_org_id/);
  assert.match(markerFunction, /for update/);
  assert.match(markerFunction, /processing_queued_at = coalesce\(processing_queued_at, now\(\)\)/);
  assert.match(markerFunction, /processing_queued_by = coalesce\(processing_queued_by, auth\.uid\(\)\)/);
  assert.match(migration, /grant execute on function public\.mark_catalog_import_processing_queued\(uuid\) to authenticated/);
});
