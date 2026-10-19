// Local-only crash/restart fixture. Never invoked by the worker image entrypoint.
import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { createCompactVerifiedWorkflow } from '../src/compact-verified-workflow.mjs';

const connection = new URL(process.env.NM_COMPACT_TEST_DATABASE_URL || 'https://invalid.invalid');
if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/compact_runtime_test'
  || !['postgres:', 'postgresql:'].includes(connection.protocol)) throw Error('LOCAL_RUNTIME_DATABASE_REQUIRED');
const client = new pg.Client({ connectionString: connection.href });
const releaseId = '11111111-1111-4111-8111-111111111111';
const handoffId = '22222222-2222-4222-8222-222222222222';
const batchId = '33333333-3333-4333-8333-333333333333';
const commercialFields = process.env.NM_COMPACT_TEST_COMMERCIAL_FIELDS === '1';
const version = commercialFields ? 7 : 5;
const workflowId = `supplier-compact-runtime-proof-v${version}`;
const rowCount = 1000;
const sourceHash = 'a'.repeat(64);
const release = { id: releaseId, handoff_id: handoffId, total_rows: rowCount, source_file_sha256: sourceHash,
  source_file_bytes: 1_500_000, source_file_path: `44444444-4444-4444-8444-444444444444/${releaseId}/source.csv`, source_date: '2026-10-14' };
const rows = Array.from({ length: rowCount }, (_, index) => ({ source_row_number: index + 1,
  product_code: `COMPACT_ROW_SENTINEL_${index + 1}`, normalized_code: `COMPACTROW${index + 1}`,
  buy_price: '12.34', currency: 'EUR', ...(commercialFields ? {stock_qty:index === 0 ? 0 : null,order_multiple:3,valid_to:'2027-10-14'} : {}), notes: 'PRIVATE_ROW_PAYLOAD_SENTINEL_'.repeat(40) }));

async function rpc(name, args) {
  if (name === 'get_supplier_price_verified_manifest') return release;
  if (name === 'claim_supplier_price_verified_release_batch') {
    const state = (await client.query('select finalized from runtime_fixture.state')).rows[0];
    if (state.finalized) return { status: 'complete', release_id: releaseId };
    return { status: 'claimed', release_id: releaseId, batch_id: batchId, cursor_start: 1, cursor_end: rowCount };
  }
  if (name === (commercialFields ? 'stage_supplier_price_release_batch_v2' : 'stage_supplier_price_release_batch')) {
    const payload = JSON.stringify(args.input_rows);
    const hash = createHash('sha256').update(payload).digest('hex');
    await client.query('begin');
    try {
      const existing = (await client.query('select owner, payload_hash from runtime_fixture.receipts where batch_id=$1 for update', [batchId])).rows[0];
      if (existing && (existing.owner !== args.input_worker_id || existing.payload_hash !== hash)) throw Error('LOCAL_STAGE_REPLAY_IDENTITY_CONFLICT');
      const inserted = await client.query(`insert into runtime_fixture.rows(row_number,payload)
        select (value->>'source_row_number')::int,value from jsonb_array_elements($1::jsonb)
        on conflict(row_number) do nothing`, [payload]);
      await client.query('insert into runtime_fixture.receipts(batch_id,owner,payload_hash) values($1,$2,$3) on conflict do nothing', [batchId, args.input_worker_id, hash]);
      await client.query('insert into runtime_fixture.stage_calls(owner,payload_hash,inserted_rows) values($1,$2,$3)', [args.input_worker_id, hash, inserted.rowCount]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    if (process.env.NM_COMPACT_TEST_PAUSE_AFTER_STAGE === '1') {
      process.send?.({ event: 'stage-committed-before-checkpoint', workflowId });
      await new Promise(() => {});
    }
    return { status: 'staged', release_id_result: releaseId, batch_id: batchId, staged_rows: rowCount };
  }
  if (name === 'heartbeat_supplier_price_release_batch') return { status: 'heartbeat', batch_id: batchId, release_id: releaseId, current_cursor: rowCount, processed_rows: rowCount };
  if (name === 'finalize_supplier_price_release_shadow_batch') {
    await client.query('update runtime_fixture.state set finalized=true');
    return { status: 'finalized', release_id: releaseId, batch_id: batchId, current_cursor: rowCount, processed_rows: rowCount, release_status: 'staged' };
  }
  if (name === 'complete_supplier_price_release_duckdb_validation') {
    const count = Number((await client.query('select count(*) from runtime_fixture.rows')).rows[0].count);
    if (count !== args.input_accepted_rows || count !== rowCount) throw Error('LOCAL_ROW_COUNT_MISMATCH');
    await client.query('update runtime_fixture.state set validated=true');
    return { status: 'validated', release_id: releaseId, publishable: true };
  }
  throw Error('UNEXPECTED_LOCAL_RPC');
}

const source = {
  prepare: async () => ({ bucket: 'supplier-price-prepared', key: `44444444-4444-4444-8444-444444444444/${releaseId}/${sourceHash}/manifest.json`,
    sha256: sourceHash, validation: { engine: 'duckdb', totalRows: rowCount, currencyCount: 1, publishable: true } }),
  scan: async () => ({ rows, batchRows: rowCount, cursorEnd: rowCount, acceptedRows: rowCount,
    warningRows: 0, rejectedRows: 0, checksum: sourceHash, prepared: true, sourceRows: rowCount }),
};
const workflow = DBOS.registerWorkflow(createCompactVerifiedWorkflow({ DBOS, rpc, source, requireMode() {}, batchSize: rowCount, commercialFields }),
  { name: `supplier-price-verified-release-v${version}` });

async function main() {
  await client.connect();
  DBOS.setConfig({ name: 'supplier-compact-local-runtime', applicationVersion: commercialFields ? '0.11.0-measurement-diagnostics' : '0.9.0-compact-history',
    executorID: 'supplier-compact-local-runtime-01', systemDatabaseUrl: connection.href,
    logLevel: 'error', logger: { debug() {}, info() {}, warn() {}, error() {} } });
  await DBOS.launch();
  try {
    const handle = process.env.NM_COMPACT_TEST_RESUME === '1'
      ? DBOS.retrieveWorkflow(workflowId)
      : await DBOS.startWorkflow(workflow, { workflowID: workflowId })({ releaseId, handoffId });
    const result = await handle.getResult();
    process.send?.({ event: 'completed', result });
  } finally {
    await DBOS.shutdown({ deregister: false, workflowCompletionTimeoutMS: 1000 });
    await client.end();
  }
}
main().catch(() => { process.send?.({ event: 'failed', code: 'LOCAL_COMPACT_RUNTIME_FAILED' }); process.exitCode = 1; });
