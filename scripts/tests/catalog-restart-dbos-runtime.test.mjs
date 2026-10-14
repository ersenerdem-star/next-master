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

function launch(url, pause) {
  const child = fork(childPath, [], { silent: true, env: { ...process.env,
    NM_CATALOG_TEST_DATABASE_URL: url, NM_CATALOG_TEST_KILL_WINDOW: pause ? '1' : '0' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const completion = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const event = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('LOCAL_EVENT_TIMEOUT')); }, 90_000);
    child.on('message', message => {
      if (message.event === 'failed') { clearTimeout(timer); reject(Error(message.code)); }
      if (message.event === (pause ? 'stage-committed-before-checkpoint' : 'completed')) { clearTimeout(timer); resolve(message); }
    });
    child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(Error('LOCAL_CHILD_EXIT')); });
  });
  return { child, completion, event };
}

test('actual catalog workflow resumes after SIGKILL with one receipt per batch and no duplicate rows',
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
    for (let i = 0; i < 60; i++) {
      const candidate = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
      try { await candidate.connect(); client = candidate; break; } catch { await candidate.end().catch(() => {}); await delay(250); }
    }
    assert.ok(client);
    await client.query(`create schema fixture;
      create table fixture.state(cursor_row int default -1,queued boolean default false); insert into fixture.state default values;
      create table fixture.rows(row_index int primary key,payload jsonb not null);
      create table fixture.receipts(cursor_end int primary key,hash text not null,is_final boolean not null);
      create table fixture.calls(id int generated always as identity,cursor_end int,inserted int);`);
    const first = launch(url, true); children.push(first.child);
    const killedAfterCursor = (await first.event).cursor;
    assert.ok(killedAfterCursor >= 0 && killedAfterCursor < 1000, 'actual byte-bounded first batch');
    assert.equal(Number((await client.query('select count(*) from fixture.rows')).rows[0].count), killedAfterCursor + 1);
    assert.equal(Number((await client.query('select count(*) from dbos.operation_outputs')).rows[0].count), 0);
    first.child.kill('SIGKILL');
    assert.equal((await first.completion).signal, 'SIGKILL');
    const second = launch(url, false); children.push(second.child);
    const completed = await second.event;
    assert.equal(completed.result.processedRows, 2501);
    assert.equal((await second.completion).code, 0);
    const calls = (await client.query('select cursor_end,inserted from fixture.calls order by id')).rows;
    assert.deepEqual(calls.slice(0, 2), [{ cursor_end: killedAfterCursor, inserted: killedAfterCursor + 1 },
      { cursor_end: killedAfterCursor, inserted: 0 }]);
    let cursor = killedAfterCursor;
    for (const call of calls.slice(2)) {
      assert.equal(call.inserted, call.cursor_end - cursor);
      assert.ok(call.inserted > 0 && call.inserted <= 1000);
      cursor = call.cursor_end;
    }
    assert.equal(cursor, 2500);
    assert.deepEqual((await client.query('select cursor_row,queued from fixture.state')).rows, [{ cursor_row: 2500, queued: true }]);
    assert.equal(Number((await client.query('select count(*) from fixture.rows')).rows[0].count), 2501);
    assert.equal(Number((await client.query('select count(*) from fixture.receipts')).rows[0].count), calls.length - 1);
    const history = (await client.query('select output from dbos.operation_outputs')).rows;
    assert.equal(history.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(history)) < 4096);
    assert.equal(JSON.stringify(history).includes('RECOVERY2499'), false);
    t.diagnostic(JSON.stringify({ sdk: '5.2.11', postgres: 17, actualWorkflow: true, actualParserAndDuckDb: true,
      sourceRows: 2501, killedAfterCursor, killedBeforeCheckpoint: true, calls, receipts: calls.length - 1,
      durableOutputBytes: Buffer.byteLength(JSON.stringify(history)), scope: 'local actual DBOS with modeled business RPCs' }));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await client?.end().catch(() => {});
    await exec('docker', ['rm', '--force', container], { timeout: 20_000 }).catch(() => {});
  }
});
