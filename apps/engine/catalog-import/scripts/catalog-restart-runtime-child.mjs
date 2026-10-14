// Local-only process-kill fixture. The deployed entrypoint never imports this.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';

const connection = new URL(process.env.NM_CATALOG_TEST_DATABASE_URL || 'https://invalid.invalid');
if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/catalog_restart_test'
  || !['postgres:', 'postgresql:'].includes(connection.protocol)) throw Error('LOCAL_DATABASE_REQUIRED');
const client = new pg.Client({ connectionString: connection.href });
const csv = 'Brand,Product_Code,Description\n' + Array.from({ length: 2501 }, (_, i) => `Clevite,RECOVERY${i},Recovery row ${i}\n`).join('');
const sha = createHash('sha256').update(csv).digest('hex');
const id = 'catalog-storage:local-restart:lease-1';
const input = { runId: 'local-restart', organizationId: 'local-org', actorId: 'local-actor', resumeAfter: -1,
  source: { sourcePath: 'local-org/local-restart/catalog.csv', sourceBytes: Buffer.byteLength(csv), sourceSha256: sha },
  lease: { sourceId: 'local-source', workerId: 'catalog-local-01', leaseToken: 'local-token', leaseGeneration: 1, leaseSeconds: 3600 } };

globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  if (path.includes('/storage/v1/object/')) return new Response(csv);
  const name = path.split('/').at(-1);
  const args = JSON.parse(init.body);
  if (name === 'heartbeat_catalog_import_storage_source_system') return Response.json({ status: 'processing' });
  if (name === 'complete_catalog_import_storage_upload_system') {
    if (args.input_checksum_sha256 !== sha || args.input_uploaded_bytes !== Buffer.byteLength(csv)) throw Error('SOURCE_CHANGED');
    return Response.json({ status: 'processing' });
  }
  if (name === 'stage_catalog_import_storage_batch_system') {
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
      await client.query('update fixture.state set cursor_row=greatest(cursor_row,$1)', [args.input_cursor_row]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    if (process.env.NM_CATALOG_TEST_KILL_WINDOW === '1') {
      process.send?.({ event: 'stage-committed-before-checkpoint', cursor: args.input_cursor_row });
      await new Promise(() => {});
    }
    return Response.json({ staged_count: args.input_payload.length, cursor_row: args.input_cursor_row, replayed: inserted.rowCount === 0 });
  }
  if (name === 'mark_catalog_import_storage_processing_queued_system') {
    await client.query('update fixture.state set queued=true');
    return Response.json({ queued: true });
  }
  throw Error('UNEXPECTED_LOCAL_RPC');
};

async function main() {
  await client.connect();
  process.env.SUPABASE_URL = 'https://catalog-local.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-placeholder';
  const { catalogWorkflow } = await import('../src/worker.mjs');
  DBOS.setConfig({ name: 'catalog-restart-local', applicationVersion: '0.1.0-catalog-storage',
    executorID: 'catalog-local-01', systemDatabaseUrl: connection.href, logLevel: 'error' });
  await DBOS.launch();
  try {
    const handle = process.env.NM_CATALOG_TEST_KILL_WINDOW === '1'
      ? await DBOS.startWorkflow(catalogWorkflow, { workflowID: id })(input) : DBOS.retrieveWorkflow(id);
    const result = await handle.getResult();
    process.send?.({ event: 'completed', result });
  } finally {
    await DBOS.shutdown({ deregister: false, workflowCompletionTimeoutMS: 1000 });
    await client.end();
  }
}
main().catch(() => { process.send?.({ event: 'failed', code: 'LOCAL_CATALOG_RUNTIME_FAILED' }); process.exitCode = 1; });
