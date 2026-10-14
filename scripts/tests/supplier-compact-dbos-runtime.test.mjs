import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { requireCompactHistoryDrained } from '../../apps/engine/supplier-price-shadow/src/verified-workflow-version.mjs';

const exec = promisify(execFile);
const childPath = fileURLToPath(new URL('../../apps/engine/supplier-price-shadow/scripts/compact-dbos-runtime-child.mjs', import.meta.url));

async function checkHistoryDrain(connectionString) {
  // Resolve the same pinned SDK as the worker, without launching DBOS.
  const { DBOSClient } = createRequire(childPath)('@dbos-inc/dbos-sdk');
  const history = await DBOSClient.create({ systemDatabaseUrl: connectionString,
    systemDatabasePoolSize: 1, systemDatabasePollingConcurrency: 1, observabilityQueryTimeoutMs: 15000,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try { await requireCompactHistoryDrained(history); }
  finally { await history.destroy(); }
}

async function historySnapshot(client) {
  const tables = (await client.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='dbos' and c.relkind in ('r','p') order by c.relname`)).rows;
  const result = [];
  for (const { relname } of tables) {
    const quotedName = '"' + relname.replaceAll('"', '""') + '"';
    const { rows } = await client.query(`select count(*)::int as count,
      md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest
      from dbos.${quotedName} t`);
    result.push({ table: relname, ...rows[0] });
  }
  return result;
}

function launch(connectionString, pause) {
  const child = fork(childPath, [], { silent: true, env: { ...process.env,
    NM_COMPACT_TEST_DATABASE_URL: connectionString,
    NM_COMPACT_TEST_PAUSE_AFTER_STAGE: pause ? '1' : '0', NM_COMPACT_TEST_RESUME: pause ? '0' : '1' } });
  // Consume output privately; credentials/provider messages never enter reports.
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const completion = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const event = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('LOCAL_WORKFLOW_EVENT_TIMEOUT')); }, 90_000);
    child.on('message', (message) => {
      if (message.event === 'failed') { clearTimeout(timer); reject(Error(message.code)); }
      if (message.event === (pause ? 'stage-committed-before-checkpoint' : 'completed')) { clearTimeout(timer); resolve(message); }
    });
    child.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(Error('LOCAL_CHILD_EXITED_BEFORE_EVENT')); });
  });
  return { child, completion, event };
}

test('real DBOS5.2.11 restarts after stage commit with compact history and one idempotent business effect',
  { skip: process.env.RUN_SUPPLIER_COMPACT_DBOS_RUNTIME !== '1', timeout: 180_000 }, async (t) => {
  const sdkPackage = JSON.parse(await readFile(new URL('../../apps/engine/supplier-price-shadow/node_modules/@dbos-inc/dbos-sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(sdkPackage.version, '5.2.11');
  const container = `nm-compact-dbos-${process.pid}-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const children = [];
  let client;
  try {
    await exec('docker', ['run', '--detach', '--rm', '--name', container, '--cpus', '0.5', '--memory', '1g',
      '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=compact_runtime_test', 'postgres:17'],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 30_000 });
    const { stdout } = await exec('docker', ['port', container, '5432/tcp']);
    const match = stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);
    assert.ok(match, 'test database must only bind loopback');
    const connectionString = `postgresql://postgres:${password}@127.0.0.1:${match[1]}/compact_runtime_test`;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const candidate = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
      try { await candidate.connect(); client = candidate; break; }
      catch { await candidate.end().catch(() => {}); await delay(250); }
    }
    assert.ok(client, 'local PostgreSQL did not become ready');
    assert.equal((await client.query("select to_regnamespace('dbos') as schema")).rows[0].schema, null);
    await checkHistoryDrain(connectionString);
    assert.equal((await client.query("select to_regnamespace('dbos') as schema")).rows[0].schema, null,
      'public DBOSClient create/list/destroy must not initialize a fresh history database');
    assert.deepEqual(await historySnapshot(client), []);
    await client.query(`create schema runtime_fixture;
      create table runtime_fixture.state(finalized boolean not null default false,validated boolean not null default false);
      insert into runtime_fixture.state default values;
      create table runtime_fixture.rows(row_number int primary key,payload jsonb not null);
      create table runtime_fixture.receipts(batch_id uuid primary key,owner text not null,payload_hash text not null);
      create table runtime_fixture.stage_calls(id bigint generated always as identity,owner text not null,payload_hash text not null,inserted_rows int not null);`);
    const first = launch(connectionString, true); children.push(first.child);
    await first.event;
    const before = await client.query(`select function_name,output from dbos.operation_outputs where workflow_uuid=$1`, ['supplier-compact-runtime-proof-v5']);
    assert.equal(before.rows.some((row) => row.function_name === 'compact-scan-stage-v5'), false, 'kill window must precede the compact durable checkpoint');
    assert.equal(Number((await client.query('select count(*) from runtime_fixture.rows')).rows[0].count), 1000);
    first.child.kill('SIGKILL');
    assert.equal((await first.completion).signal, 'SIGKILL');

    const second = launch(connectionString, false); children.push(second.child);
    const completed = await second.event;
    assert.equal(completed.result.status, 'validated');
    assert.equal(completed.result.published, false);
    assert.equal((await second.completion).code, 0);
    const calls = (await client.query('select owner,payload_hash,inserted_rows from runtime_fixture.stage_calls order by id')).rows;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((row) => row.inserted_rows), [1000, 0]);
    assert.equal(calls[0].owner, calls[1].owner);
    assert.equal(calls[0].payload_hash, calls[1].payload_hash);
    assert.equal(Number((await client.query('select count(*) from runtime_fixture.receipts')).rows[0].count), 1);
    assert.deepEqual((await client.query('select finalized,validated from runtime_fixture.state')).rows, [{ finalized: true, validated: true }]);
    const checkpoints = (await client.query('select function_name,output from dbos.operation_outputs where workflow_uuid=$1 order by function_id', ['supplier-compact-runtime-proof-v5'])).rows;
    const outputs = JSON.stringify(checkpoints);
    assert.equal(outputs.includes('COMPACT_ROW_SENTINEL_'), false);
    assert.equal(outputs.includes('PRIVATE_ROW_PAYLOAD_SENTINEL_'), false);
    const compact = checkpoints.filter((row) => row.function_name === 'compact-scan-stage-v5');
    assert.equal(compact.length, 1);
    assert.ok(Buffer.byteLength(String(compact[0].output)) < 4096, 'stage checkpoint must remain bounded without row payloads');
    assert.ok(Buffer.byteLength(outputs) < 32768, 'all durable step outputs must remain compact');

    // All worker processes have exited. Fixture setup is the only history mutation;
    // each actual pre-launch gate call must leave every DBOS table unchanged.
    const legacyId = 'supplier-legacy-v4-drain-fixture';
    await client.query(`insert into dbos.workflow_status
      select (jsonb_populate_record(null::dbos.workflow_status,to_jsonb(s)||$1::jsonb)).*
      from dbos.workflow_status s where workflow_uuid=$2`, [JSON.stringify({ workflow_uuid: legacyId,
      name: 'supplier-price-verified-release-v4', application_version: '0.8.0-verified-integrity', status: 'PENDING' }),
      'supplier-compact-runtime-proof-v5']);
    const legacyStatuses = ['PENDING', 'ENQUEUED', 'DELAYED'];
    for (const status of legacyStatuses) {
      await client.query('update dbos.workflow_status set status=$1 where workflow_uuid=$2', [status, legacyId]);
      const snapshot = await historySnapshot(client);
      await assert.rejects(checkHistoryDrain(connectionString), /VERIFIED_VERSION_DRAIN_REQUIRED/);
      assert.deepEqual(await historySnapshot(client), snapshot, `history gate must not alter ${status} history`);
    }
    await client.query('update dbos.workflow_status set status=$1 where workflow_uuid=$2', ['SUCCESS', legacyId]);
    const drainedSnapshot = await historySnapshot(client);
    await checkHistoryDrain(connectionString);
    assert.deepEqual(await historySnapshot(client), drainedSnapshot, 'successful drain gate must preserve all history');
    t.diagnostic(JSON.stringify({ sdk: sdkPackage.version, postgres: 17, cpu: 0.5, memoryMiB: 1024,
      sourceRows: 1000, stageInvocations: 2, rowInsertions: 1000, stageReceipts: 1,
      durableStepCount: checkpoints.length, durableOutputBytes: Buffer.byteLength(outputs),
      compactStageOutputBytes: Buffer.byteLength(String(compact[0].output)), rowPayloadPersistedInDbos: false,
      killedBeforeCheckpoint: true, recoveredWithSameLeaseIdentity: true,
      freshHistoryGateCreatesTables: false, legacyStatusesBlocked: legacyStatuses,
      drainedHistoryGatePasses: true, historyGatePreservesAllTables: true }));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await client?.end().catch(() => {});
    await exec('docker', ['rm', '--force', container], { timeout: 20_000 }).catch(() => {});
  }
});
