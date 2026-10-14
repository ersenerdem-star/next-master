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
    if (name === "get_catalog_import_storage_read_completion_system") return { read_complete: false };
    if (name === "stage_catalog_import_storage_batch_system") return { staged_count: args.input_payload.length, cursor_row: args.input_cursor_row };
    if (name === "heartbeat_catalog_import_storage_source_system") return { status: "processing" };
    if (name === "complete_catalog_import_storage_upload_system") return { status: "uploaded" };
    if (name === "complete_catalog_import_storage_read_system") return { queued: true, status: "queued", run_id: args.input_run_id,
      source_id: "source-1", read_complete_rows: args.input_total_rows, read_completed_at: "2026-10-14T20:00:00Z" };
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
  assert.equal(calls.at(-1).name, "complete_catalog_import_storage_read_system");
  assert.equal(calls.at(-1).args.input_total_rows, 3);
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
  assert.equal(resumedCalls.at(-1).args.input_total_rows, 3, "EOF proof attests the entire source, not just this attempt's remaining row");
});

test("catalog worker verifies source checksum before any mutation RPC", async () => {
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
    rpc: async (name) => { assert.equal(name, 'get_catalog_import_storage_read_completion_system'); rpcCalls += 1; return { read_complete: false }; },
  }), /CATALOG_SOURCE_CHECKSUM_MISMATCH/);
  assert.equal(rpcCalls, 1, 'only the read-only immutable receipt lookup precedes source verification');
});

test('a durable cursor beyond the source cannot mint a full-file read receipt', async () => {
  const calls = [];
  await assert.rejects(runCatalogStorageImport({
    supabaseUrl: 'https://staging.supabase.co/', serviceRoleKey: 'test-key', runId: 'run-1', organizationId: 'org-1', actorId: 'actor-1',
    resumeAfter: 4, source: { sourcePath: 'org/run/catalog.csv', sourceBytes: Buffer.byteLength(csv), sourceSha256: sha256 },
    lease: { sourceId: 'source-1', workerId: 'worker-1', leaseToken: 'token-1', leaseGeneration: 1 },
    fetchImpl: fakeFetch, rpc: fakeRpc(calls),
  }), /CATALOG_CURSOR_BEYOND_SOURCE/);
  assert.equal(calls.some(x => x.name === 'complete_catalog_import_storage_read_system'), false);
});

test('EOF acknowledgement is exact to the source/run/count and can replay after the last staged batch', async () => {
  const input = { supabaseUrl: 'https://staging.supabase.co/', serviceRoleKey: 'test-key', runId: 'run-1', organizationId: 'org-1', actorId: 'actor-1',
    resumeAfter: 2, source: { sourcePath: 'org/run/catalog.csv', sourceBytes: Buffer.byteLength(csv), sourceSha256: sha256 },
    lease: { sourceId: 'source-1', workerId: 'worker-1', leaseToken: 'token-1', leaseGeneration: 1 }, fetchImpl: fakeFetch };
  const calls = [];
  const result = await runCatalogStorageImport({ ...input, rpc: fakeRpc(calls) });
  assert.equal(result.processedRows, 0);
  assert.equal(calls.some(x => x.name === 'stage_catalog_import_storage_batch_system'), false);
  assert.equal(calls.at(-1).args.input_total_rows, 3);
  for (const changed of [{ source_id: 'other-source' }, { run_id: 'other-run' }, { read_complete_rows: 2 }, { queued: false }]) {
    const rpc = fakeRpc([]);
    await assert.rejects(runCatalogStorageImport({ ...input, rpc: async (name, args) => {
      const value = await rpc(name, args);
      return name === 'complete_catalog_import_storage_read_system' ? { ...value, ...changed } : value;
    } }), /CATALOG_SOURCE_READ_RECEIPT_INVALID/);
  }
});

test('finalized EOF proof recovers without downloading cleaned source or mutating business rows', async () => {
  const proof = { read_complete: true, run_id: 'run-1', source_id: 'source-1', source_path: 'org/run/catalog.csv',
    source_sha256: sha256, source_bytes: Buffer.byteLength(csv), total_rows: 3, cursor_row: 2,
    source_status: 'completed', run_status: 'finalized', read_completed_at: '2026-10-14T20:00:00Z' };
  const input = { supabaseUrl: 'https://staging.supabase.co/', serviceRoleKey: 'test-key', runId: 'run-1', organizationId: 'org-1', actorId: 'actor-1',
    source: { sourcePath: 'org/run/catalog.csv', sourceBytes: Buffer.byteLength(csv) },
    lease: { sourceId: 'source-1', workerId: 'worker-1', leaseToken: 'old-token', leaseGeneration: 1 },
    fetchImpl: () => { throw Error('MUST_NOT_DOWNLOAD_CLEANED_OBJECT'); } };
  let reads = 0;
  const result = await runCatalogStorageImport({ ...input, rpc: async (name, args) => {
    reads++;
    assert.equal(name, 'get_catalog_import_storage_read_completion_system');
    assert.equal(args.input_source_sha256, null, 'initial claim may not yet have a verified hash; immutable proof binds its source identity');
    return proof;
  } });
  assert.equal(reads, 1);
  assert.equal(result.processedRows, 3);
  assert.equal(result.replayed, true);
  assert.equal(result.sourceSha256, sha256);
  assert.equal(result.queued.replayed, true);
  for (const changed of [{ source_id: 'other' }, { source_path: 'org/other/catalog.csv' }, { source_bytes: 1 }, { total_rows: 87 }, { source_sha256: 'bad' }]) {
    await assert.rejects(runCatalogStorageImport({ ...input, rpc: async () => ({ ...proof, ...changed }) }), /CATALOG_SOURCE_READ_RECEIPT_INVALID/);
  }
  await assert.rejects(runCatalogStorageImport({ ...input, source: { ...input.source, sourceSha256: 'f'.repeat(64) }, rpc: async () => proof }), /CATALOG_SOURCE_READ_RECEIPT_INVALID/);
});

test('historical terminal partial source without EOF proof cannot become successful replay', async () => {
  const calls = [];
  await assert.rejects(runCatalogStorageImport({
    supabaseUrl: 'https://staging.supabase.co/', serviceRoleKey: 'test-key', runId: 'run-1', organizationId: 'org-1', actorId: 'actor-1',
    source: { sourcePath: 'org/run/catalog.csv', sourceBytes: Buffer.byteLength(csv), sourceSha256: sha256 },
    lease: { sourceId: 'source-1', workerId: 'worker-1', leaseToken: 'token-1', leaseGeneration: 1 }, fetchImpl: fakeFetch,
    rpc: async name => { calls.push(name); if (name === 'get_catalog_import_storage_read_completion_system') return { read_complete: false };
      throw Error('CATALOG_STORAGE_RUN_TERMINAL:finalized'); },
  }), /CATALOG_STORAGE_RUN_TERMINAL/);
  assert.deepEqual(calls, ['get_catalog_import_storage_read_completion_system', 'complete_catalog_import_storage_upload_system']);
});
