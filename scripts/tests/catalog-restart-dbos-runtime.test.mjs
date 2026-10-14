import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
const exec = promisify(execFile);
const childPath = fileURLToPath(new URL('../../apps/engine/catalog-import/scripts/catalog-restart-runtime-child.mjs', import.meta.url));

function launch(url, pause, scenario) {
  const child = fork(childPath, [], { silent: true, env: { ...process.env,
    NM_CATALOG_TEST_DATABASE_URL: url, NM_CATALOG_TEST_KILL_WINDOW: pause ? '1' : '0', NM_CATALOG_TEST_SCENARIO: scenario } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const completion = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const messages = new Map();
  child.on('message', message => messages.set(message.event, message));
  const waitFor = name => messages.has(name) ? Promise.resolve(messages.get(name)) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('LOCAL_EVENT_TIMEOUT')); }, 90_000);
    const onMessage = message => {
      if (message.event === 'failed' || message.event === name) {
        clearTimeout(timer); child.off('message', onMessage);
        if (message.event === 'failed') reject(Error(message.code)); else resolve(message);
      }
    };
    child.on('message', onMessage);
    child.once('exit', code => { clearTimeout(timer); child.off('message', onMessage); if (code !== 0) reject(Error('LOCAL_CHILD_EXIT')); });
  });
  return { child, completion, waitFor, event: waitFor(pause ? 'stage-committed-before-checkpoint' : scenario === 'partial' ? 'recovery-scheduling-checked' : 'completed') };
}

for (const scenario of ['partial', 'completed']) {
test(`actual catalog restart at ${scenario === 'partial' ? 'first nonfinal batch defers queued finalization' : 'finalized EOF before checkpoint reuses immutable completion'}`,
  { skip: process.env.RUN_CATALOG_RESTART_DBOS_RUNTIME !== '1', timeout: 180_000 }, async t => {
  const container = `nm-catalog-restart-${process.pid}-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const children = [];
  let client;
  try {
    await exec('docker', ['run', '--detach', '--rm', '--name', container, '--cpus', '0.5', '--memory', '1g',
      '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=catalog_restart_test', 'postgres:17'],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 30_000 });
    const port = (await exec('docker', ['port', container, '5432/tcp'])).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);
    assert.ok(port);
    const url = `postgresql://postgres:${password}@127.0.0.1:${port[1]}/catalog_restart_test`;
    for (let i = 0; i < 120; i++) {
      const candidate = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
      try { await candidate.connect(); client = candidate; break; } catch { await candidate.end().catch(() => {}); await delay(250); }
    }
    assert.ok(client);
    await client.query(`create schema fixture;
      create table fixture.state(cursor_row int default -1,queued boolean default true,
        source_status text default 'processing',run_status text default 'running',
        read_completed_at timestamptz,read_complete_rows int,
        claim_busy_calls int default 0,validation_calls int default 0,finalization_calls int default 0);
      insert into fixture.state default values;
      create table fixture.rows(row_index int primary key,payload jsonb not null);
      create table fixture.products(row_index int primary key,payload jsonb not null);
      create table fixture.rpc_calls(name text not null);
      create table fixture.receipts(cursor_end int primary key,hash text not null,is_final boolean not null);
      create table fixture.calls(id int generated always as identity,cursor_end int,inserted int);`);
    const first = launch(url, true, scenario); children.push(first.child);
    const killedAfterCursor = (await first.event).cursor;
    assert.equal(killedAfterCursor, scenario === 'partial' ? 86 : 2500);
    assert.equal(Number((await client.query('select count(*) from fixture.rows')).rows[0].count), killedAfterCursor + 1);
    assert.equal(Number((await client.query('select count(*) from dbos.operation_outputs')).rows[0].count), 0);
    assert.equal((await client.query('select queue_name from dbos.workflow_status')).rows[0].queue_name, 'catalog-import-storage');
    const mutationCallsBeforeKill = Number((await client.query('select count(*) from fixture.rpc_calls')).rows[0].count);
    first.child.kill('SIGKILL');
    assert.equal((await first.completion).signal, 'SIGKILL');
    const second = launch(url, false, scenario); children.push(second.child);
    let completed;
    if (scenario === 'partial') {
      const scheduling = await second.event;
      assert.deepEqual(scheduling.ingestion, [{ status: 'busy', sourceId: 'local-source' }]);
      assert.deepEqual(scheduling.finalization, { runId: 'local-restart', status: 'awaiting-source-completion' });
      assert.deepEqual((await client.query('select queued,source_status,run_status,read_completed_at,claim_busy_calls,validation_calls,finalization_calls from fixture.state')).rows,
        [{ queued: true, source_status: 'processing', run_status: 'running', read_completed_at: null,
          claim_busy_calls: 1, validation_calls: 0, finalization_calls: 0 }]);
      assert.equal(Number((await client.query('select count(*) from fixture.products')).rows[0].count), 0);
      assert.equal(Number((await client.query('select count(*) from dbos.operation_outputs')).rows[0].count), 0);
      second.child.send({ event: 'continue-recovery' });
      completed = await second.waitFor('completed');
    } else {
      completed = await second.event;
      assert.equal(completed.result.replayed, true);
      assert.equal(completed.result.batches, 0);
      assert.equal(completed.result.preflight.engine, 'durable-read-receipt');
      assert.equal(completed.storageDownloads, 0, 'sealed replay succeeds after Storage cleanup without downloading');
      assert.equal(Number((await client.query('select count(*) from fixture.rpc_calls')).rows[0].count), mutationCallsBeforeKill,
        'completed recovery must perform no heartbeat, stage, verification, EOF or finalization mutation');
    }
    assert.equal(completed.result.processedRows, 2501);
    assert.equal(completed.finalization.status, scenario === 'partial' ? 'finalized' : 'idle');
    assert.equal((await second.completion).code, 0);
    const calls = (await client.query('select cursor_end,inserted from fixture.calls order by id')).rows;
    if (scenario === 'partial') assert.deepEqual(calls.slice(0, 2), [{ cursor_end: killedAfterCursor, inserted: killedAfterCursor + 1 },
      { cursor_end: killedAfterCursor, inserted: 0 }]);
    let cursor = scenario === 'partial' ? killedAfterCursor : -1;
    for (const call of calls.slice(scenario === 'partial' ? 2 : 0)) {
      assert.equal(call.inserted, call.cursor_end - cursor);
      assert.ok(call.inserted > 0 && call.inserted <= 1000);
      cursor = call.cursor_end;
    }
    assert.equal(cursor, 2500);
    assert.deepEqual((await client.query('select cursor_row,queued,source_status,run_status,read_complete_rows,validation_calls,finalization_calls from fixture.state')).rows,
      [{ cursor_row: 2500, queued: false, source_status: 'completed', run_status: 'finalized',
        read_complete_rows: 2501, validation_calls: 1, finalization_calls: 1 }]);
    assert.equal(Number((await client.query('select count(*) from fixture.rows')).rows[0].count), 2501);
    assert.equal(Number((await client.query('select count(*) from fixture.products')).rows[0].count), 2501);
    assert.equal(Number((await client.query('select count(*) from fixture.receipts where is_final')).rows[0].count), 1);
    assert.equal(Number((await client.query('select count(*) from fixture.receipts')).rows[0].count), 29);
    assert.equal(calls.length, scenario === 'partial' ? 30 : 29);
    const history = (await client.query('select output from dbos.operation_outputs')).rows;
    assert.equal(history.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(history)) < 4096);
    assert.equal(JSON.stringify(history).includes('RECOVERY000000002499'), false);
    t.diagnostic(JSON.stringify({ sdk: '5.2.11', postgres: 17, actualWorkflow: true, actualParserAndDuckDb: true, queue: 'catalog-import-storage', registration: 'after-launch',
      scenario, sourceRows: 2501, killedAfterCursor, killedBeforeCheckpoint: true, queuedBeforeFirstStage: true,
      busyRecoveryPollDeferred: scenario === 'partial', completedRecoveryWithoutMutation: scenario === 'completed',
      validationCallsBeforeEof: 0, finalizedRows: 2501, calls, receipts: 29,
      durableOutputBytes: Buffer.byteLength(JSON.stringify(history)), scope: 'local actual DBOS with modeled business RPCs' }));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await client?.end().catch(() => {});
    await exec('docker', ['rm', '--force', container], { timeout: 20_000 }).catch(() => {});
  }
});
}
