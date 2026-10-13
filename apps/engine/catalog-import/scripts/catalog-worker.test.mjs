import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runCatalogStorageImport } from "../src/catalog-worker.mjs";

const csv = "Brand,Product_Code,Description\nClevite,A-1,One\nClevite,A-2,Two\nClevite,A-3,Three\n";
const sha256 = createHash("sha256").update(csv).digest("hex");

function fakeFetch(url, init) {
  assert.match(url, /\/storage\/v1\/object\/catalog-imports\/org\/run\/catalog\.csv$/);
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.Authorization, "Bearer test-key");
  return Promise.resolve(new Response(Buffer.from(csv), { status: 200, headers: { "content-type": "text/csv" } }));
}

function fakeRpc(calls) {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "stage_catalog_import_storage_batch_system") return { staged_count: args.input_payload.length, cursor_row: args.input_cursor_row };
    if (name === "heartbeat_catalog_import_storage_source_system") return { status: "processing" };
    if (name === "complete_catalog_import_storage_upload_system") return { status: "uploaded" };
    if (name === "mark_catalog_import_storage_processing_queued_system") return { status: "queued" };
    throw new Error(`unexpected rpc ${name}`);
  };
}

test("catalog worker verifies, stages, checkpoints the durable cursor, and queues the source", async () => {
  const calls = [];
  const result = await runCatalogStorageImport({
    supabaseUrl: "https://staging.supabase.co/",
    serviceRoleKey: "test-key",
    runId: "run-1",
    organizationId: "org-1",
    actorId: "actor-1",
    source: { sourcePath: "org/run/catalog.csv", sourceBytes: Buffer.byteLength(csv), sourceSha256: sha256 },
    lease: { sourceId: "source-1", workerId: "worker-1", leaseToken: "token-1", leaseGeneration: 1 },
    fetchImpl: fakeFetch,
    batchOptions: { maxRows: 2, maxBytes: 10_000 },
    rpc: fakeRpc(calls),
  });
  assert.equal(result.runId, "run-1");
  assert.equal(result.processedRows, 3);
  assert.equal(result.cursorEnd, 2); // zero-based source cursor
  assert.equal(result.batches, 2);
  assert.equal(calls.filter((call) => call.name === "complete_catalog_import_storage_upload_system").length, 1);
  assert.equal(calls.filter((call) => call.name === "stage_catalog_import_storage_batch_system").length, 2);
  assert.equal(calls.filter((call) => call.name === "heartbeat_catalog_import_storage_source_system").length, 3);
  assert.equal(calls.at(-1).name, "mark_catalog_import_storage_processing_queued_system");
  assert.deepEqual(calls.filter((call) => call.name === "stage_catalog_import_storage_batch_system").map((call) => [
    call.args.input_payload.map((row) => row.row_index), call.args.input_cursor_row, call.args.input_is_final,
  ]), [[[0, 1], 1, false], [[2], 2, true]]);

  const resumedCalls = [];
  const resumed = await runCatalogStorageImport({
    supabaseUrl: "https://staging.supabase.co/",
    serviceRoleKey: "test-key",
    runId: "run-1",
    organizationId: "org-1",
    actorId: "actor-1",
    resumeAfter: 1,
    source: { sourcePath: "org/run/catalog.csv", sourceBytes: Buffer.byteLength(csv), sourceSha256: sha256 },
    lease: { sourceId: "source-1", workerId: "worker-1", leaseToken: "token-1", leaseGeneration: 1 },
    fetchImpl: fakeFetch,
    batchOptions: { maxRows: 2, maxBytes: 10_000 },
    rpc: fakeRpc(resumedCalls),
  });
  assert.equal(resumed.processedRows, 1);
  assert.equal(resumed.cursorEnd, 2);
  const resumedStage = resumedCalls.find((call) => call.name === "stage_catalog_import_storage_batch_system");
  assert.deepEqual(resumedStage.args.input_payload.map((row) => row.product_code), ["A-3"]);
  assert.equal(resumedStage.args.input_is_final, true);
});

test("catalog worker verifies source checksum before calling any RPC", async () => {
  let rpcCalls = 0;
  await assert.rejects(runCatalogStorageImport({
    supabaseUrl: "https://staging.supabase.co/",
    serviceRoleKey: "test-key",
    runId: "run-1",
    organizationId: "org-1",
    actorId: "actor-1",
    source: { sourcePath: "org/run/catalog.csv", sourceBytes: Buffer.byteLength(csv), sourceSha256: "f".repeat(64) },
    lease: { sourceId: "source-1", workerId: "worker-1", leaseToken: "token-1", leaseGeneration: 1 },
    fetchImpl: fakeFetch,
    rpc: async () => { rpcCalls += 1; },
  }), /CATALOG_SOURCE_CHECKSUM_MISMATCH/);
  assert.equal(rpcCalls, 0);
});
