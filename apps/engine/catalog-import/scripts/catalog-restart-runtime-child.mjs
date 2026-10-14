// Local-only process-kill fixture. The deployed entrypoint never imports this.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';

const connection = new URL(process.env.NM_CATALOG_TEST_DATABASE_URL || 'https://invalid.invalid');
if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/catalog_restart_test'
  || !['postgres:', 'postgresql:'].includes(connection.protocol)) throw Error('LOCAL_DATABASE_REQUIRED');
const client = new pg.Client({ connectionString: connection.href });
const scenario = process.env.NM_CATALOG_TEST_SCENARIO || 'partial';
let pollFinalization;
let storageDownloads = 0;
const description = ('Temporary catalog restart acceptance. ' + 'Synthetic catalog test text; isolated discontinued item. '.repeat(50)).slice(0, 2559).trimEnd() + '.';
const csv = 'Brand,Product_Code,Description,Market_Segment,Lifecycle_Status\n' + Array.from({ length: 2501 }, (_, i) =>
  `Corteco,RECOVERY${String(i).padStart(12, '0')},${description},pc,discontinued\n`).join('');
const sha = createHash('sha256').update(csv).digest('hex');
const id = 'catalog-storage:local-restart:lease-1';
const queueName = 'catalog-import-storage';
const input = { runId: 'local-restart', organizationId: 'local-org', actorId: 'local-actor', resumeAfter: -1,
  source: { sourcePath: 'local-org/local-restart/catalog.csv', sourceBytes: Buffer.byteLength(csv), sourceSha256: sha },
  lease: { sourceId: 'local-source', workerId: 'catalog-local-01', leaseToken: 'local-token', leaseGeneration: 1, leaseSeconds: 3600 } };
let recoveredStageObserved;
const recoveryReached = new Promise(resolve => { recoveredStageObserved = resolve; });
let continueRecovery;
const recoveryReleased = new Promise(resolve => { continueRecovery = resolve; });
const onParentMessage = message => { if (message?.event === 'continue-recovery') continueRecovery(); };
process.on('message', onParentMessage);
let firstRecoveredStage = true;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.includes('/storage/v1/object/')) {
    storageDownloads += 1;
    // Actual cleanup may already have removed the private Storage object once
    // finalized. A sealed-proof replay must never depend on downloading it.
    if (scenario === 'completed' && process.env.NM_CATALOG_TEST_KILL_WINDOW !== '1') return new Response(null, { status: 404 });
    return new Response(csv);
  }
  if (path === '/rest/v1/catalog_import_runs') {
    if (init.method === 'PATCH') { await client.query('update fixture.state set queued=false'); return new Response(null, { status: 204 }); }
    const state = (await client.query('select * from fixture.state')).rows[0];
    if (!parsed.searchParams.has('id') && (!state.queued || state.run_status === 'finalized')) return Response.json([]);
    return Response.json([{ id: input.runId, organization_id: input.organizationId, created_by: input.actorId,
      status: state.run_status, processing_queued_at: state.queued ? '2026-10-14T00:00:00Z' : null,
      input_scope: { source_kind: 'storage', source_id: input.lease.sourceId } }]);
  }
  if (path === '/rest/v1/catalog_import_sources') {
    const state = (await client.query('select * from fixture.state')).rows[0];
    return Response.json([{ id: input.lease.sourceId, run_id: input.runId, organization_id: input.organizationId,
      created_by: input.actorId, status: state.source_status, cursor_row: state.cursor_row,
      rows_parsed: state.cursor_row + 1, rows_staged: state.cursor_row + 1,
      read_completed_at: state.read_completed_at?.toISOString() ?? null, read_complete_rows: state.read_complete_rows }]);
  }
  const name = path.split('/').at(-1);
  const args = JSON.parse(init.body);
  if (name === 'get_catalog_import_storage_read_completion_system') {
    const state = (await client.query('select * from fixture.state')).rows[0];
    if (!state.read_completed_at) return Response.json({ read_complete: false });
    if (args.input_source_id !== input.lease.sourceId || args.input_source_sha256 !== sha
      || args.input_source_bytes !== Buffer.byteLength(csv)) throw Error('LOCAL_PROOF_SCOPE_CHANGED');
    return Response.json({ read_complete: true, run_id: input.runId, source_id: input.lease.sourceId,
      source_sha256: sha, source_bytes: Buffer.byteLength(csv), source_path: input.source.sourcePath, total_rows: state.read_complete_rows,
      cursor_row: state.cursor_row, read_completed_at: state.read_completed_at.toISOString(),
      source_status: state.source_status, run_status: state.run_status });
  }
  await client.query('insert into fixture.rpc_calls(name) values($1)', [name]);
  if (name === 'claim_catalog_import_storage_source_system') {
    await client.query('update fixture.state set claim_busy_calls=claim_busy_calls+1');
    return Response.json({ claimed: false, status: 'busy' });
  }
  if (name === 'heartbeat_catalog_import_storage_source_system') return Response.json({ status: 'processing' });
  if (name === 'complete_catalog_import_storage_upload_system') {
    if (args.input_checksum_sha256 !== sha || args.input_uploaded_bytes !== Buffer.byteLength(csv)) throw Error('SOURCE_CHANGED');
    return Response.json({ status: 'processing' });
  }
  if (name === 'stage_catalog_import_storage_batch_system') {
    // DBOS recovery runs concurrently with the ordinary worker poll after
    // launch. Pause before replay so the parent can prove the queued, busy,
    // partially staged source never reaches validation/finalization.
    if (scenario === 'partial' && process.env.NM_CATALOG_TEST_KILL_WINDOW !== '1' && firstRecoveredStage) {
      firstRecoveredStage = false;
      recoveredStageObserved();
      await recoveryReleased;
    }
    const payload = JSON.stringify(args.input_payload);
    const hash = createHash('sha256').update(JSON.stringify({ payload: args.input_payload, final: args.input_is_final })).digest('hex');
    await client.query('begin');
    let inserted;
    try {
      const previous = (await client.query('select hash from fixture.receipts where cursor_end=$1', [args.input_cursor_row])).rows[0];
      if (previous && previous.hash !== hash) throw Error('PAYLOAD_CHANGED');
      inserted = await client.query(`insert into fixture.rows(row_index,payload)
        select (value->>'row_index')::int,value from jsonb_array_elements($1::jsonb) on conflict do nothing`, [payload]);
      await client.query('insert into fixture.receipts(cursor_end,hash,is_final) values($1,$2,$3) on conflict do nothing', [args.input_cursor_row, hash, args.input_is_final]);
      await client.query('insert into fixture.calls(cursor_end,inserted) values($1,$2)', [args.input_cursor_row, inserted.rowCount]);
      await client.query("update fixture.state set cursor_row=greatest(cursor_row,$1),source_status=case when $2 then 'staged' else 'processing' end", [args.input_cursor_row, args.input_is_final]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    if (scenario === 'partial' && process.env.NM_CATALOG_TEST_KILL_WINDOW === '1') {
      process.send?.({ event: 'stage-committed-before-checkpoint', cursor: args.input_cursor_row });
      await new Promise(() => {});
    }
    return Response.json({ staged_count: args.input_payload.length, cursor_row: args.input_cursor_row, replayed: inserted.rowCount === 0 });
  }
  if (name === 'complete_catalog_import_storage_read_system') {
    const state = (await client.query('select *, (select count(*)::int from fixture.rows) rows from fixture.state')).rows[0];
    if (args.input_total_rows !== 2501 || state.cursor_row !== 2500 || state.rows !== 2501 || state.source_status !== 'staged') throw Error('LOCAL_INCOMPLETE_EOF');
    const updated = (await client.query('update fixture.state set queued=true,read_completed_at=now(),read_complete_rows=$1 returning read_completed_at', [args.input_total_rows])).rows[0];
    if (scenario === 'completed' && process.env.NM_CATALOG_TEST_KILL_WINDOW === '1') {
      const finalized = await pollFinalization();
      if (finalized.status !== 'finalized') throw Error('LOCAL_EOF_FINALIZATION_REQUIRED');
      process.send?.({ event: 'stage-committed-before-checkpoint', cursor: state.cursor_row, finalized: true });
      await new Promise(() => {});
    }
    return Response.json({ queued: true, status: 'queued', run_id: input.runId, source_id: input.lease.sourceId,
      read_complete_rows: args.input_total_rows, read_completed_at: updated.read_completed_at.toISOString() });
  }
  // Deliberately model the old unguarded business endpoints. This test must
  // catch an early worker call even before the separate real-SQL fence tests.
  if (name === 'validate_catalog_import_storage_batch_system') {
    await client.query("update fixture.state set validation_calls=validation_calls+1,run_status='validated'");
    return Response.json({ status: 'validated', has_more: false });
  }
  if (name === 'finalize_catalog_import_batch_system') {
    await client.query('insert into fixture.products select * from fixture.rows on conflict do nothing');
    await client.query("update fixture.state set finalization_calls=finalization_calls+1,run_status='finalized',source_status='completed'");
    return Response.json({ status: 'finalized', has_more: false });
  }
  throw Error('UNEXPECTED_LOCAL_RPC');
};

async function main() {
  await client.connect();
  process.env.SUPABASE_URL = 'https://catalog-local.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-placeholder';
  process.env.CATALOG_IMPORT_WORKER_ID = input.lease.workerId;
  const { catalogWorkflow, configureCatalogRecoveryQueue, pollCatalogImportSources, pollCatalogFinalization } = await import('../src/worker.mjs');
  pollFinalization = pollCatalogFinalization;
  DBOS.setConfig({ name: 'catalog-restart-local', applicationVersion: '0.1.0-catalog-storage',
    executorID: 'catalog-local-01', systemDatabaseUrl: connection.href, logLevel: 'error', listenQueues: [queueName] });
  configureCatalogRecoveryQueue();
  await DBOS.launch();
  await DBOS.registerQueue(queueName, { globalConcurrency: 1, workerConcurrency: 1 });
  try {
    const handle = process.env.NM_CATALOG_TEST_KILL_WINDOW === '1'
      ? await DBOS.startWorkflow(catalogWorkflow, { workflowID: id, queueName })(input) : DBOS.retrieveWorkflow(id);
    if (scenario === 'partial' && process.env.NM_CATALOG_TEST_KILL_WINDOW !== '1') {
      await recoveryReached;
      const ingestion = await pollCatalogImportSources();
      const finalization = await pollCatalogFinalization();
      process.send?.({ event: 'recovery-scheduling-checked', ingestion, finalization });
      await recoveryReleased;
    }
    const result = await handle.getResult();
    const finalization = await pollCatalogFinalization();
    process.send?.({ event: 'completed', result, finalization, storageDownloads });
  } finally {
    await DBOS.shutdown({ deregister: false, workflowCompletionTimeoutMS: 1000 });
    await client.end();
    process.off('message', onParentMessage);
  }
}
main().catch(() => { process.send?.({ event: 'failed', code: 'LOCAL_CATALOG_RUNTIME_FAILED' }); process.exitCode = 1; });
