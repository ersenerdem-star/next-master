import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const exec = promisify(execFile);

async function eventually(read, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw Error(`LOCAL_WATCHDOG_OBSERVATION_TIMEOUT:${label}`);
}

const identitySql = "SELECT pid,extract(epoch from backend_start)::text AS backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()";
async function configureRunner(client) {
  await client.query('SET search_path = pg_catalog');
  await client.query("SET statement_timeout = '30min'");
  await client.query("SET lock_timeout = '5s'");
  const row = (await client.query(identitySql)).rows[0];
  return { pid: row.pid, backendStart: row.backend_start };
}

function observe(promise) {
  const state = { settled: false };
  state.completion = promise.then(
    value => { state.settled = true; return { ok: true, value }; },
    error => { state.settled = true; return { ok: false, error }; },
  );
  return state;
}

test('real PG17 concurrent index watchdog permits old snapshots and cancels only its own initial lock wait', {
  skip: process.env.RUN_PRICE_ENGINE_INDEX_WATCHDOG_RUNTIME !== '1', timeout: 90_000,
}, async t => {
  const { runPhaseAwareIndexQuery, RELATION_WAIT_LIMIT_MS, SNAPSHOT_WAIT_LIMIT_MS, WATCHDOG_POLL_MS } = await import('../ops/price-engine-index-watchdog.mjs');
  assert.equal(RELATION_WAIT_LIMIT_MS, 5000);
  assert.equal(SNAPSHOT_WAIT_LIMIT_MS, 120000);
  assert.equal(WATCHDOG_POLL_MS, 500);
  const container = `nm-index-watchdog-${process.pid}-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const clients = [];
  let config, admin;
  async function connect() {
    const client = new pg.Client(config);
    // Forced container cleanup can disconnect idle clients. Keep that expected
    // teardown signal out of unhandled EventEmitter errors and diagnostic logs.
    client.on('error', () => {});
    clients.push(client);
    await client.connect();
    return client;
  }
  try {
    // Use the already-local official image; never pull or contact a remote DB.
    await exec('docker', ['image', 'inspect', 'postgres:17'], { timeout: 10_000 });
    await exec('docker', ['run', '--pull=never', '--detach', '--rm', '--name', container,
      '--cpus', '0.5', '--memory', '1g', '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=index_watchdog_test', 'postgres:17'], {
      env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 30_000,
    });
    const { stdout } = await exec('docker', ['port', container, '5432/tcp']);
    const match = stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);
    assert.ok(match, 'isolated test database must bind only loopback');
    config = { host: '127.0.0.1', port: Number(match[1]), database: 'index_watchdog_test',
      user: 'postgres', password, connectionTimeoutMillis: 1000, options: '' };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { admin = await connect(); break; }
      catch { await clients.at(-1)?.end().catch(() => {}); await delay(250); }
    }
    assert.ok(admin, 'isolated PostgreSQL did not become ready');
    assert.equal(Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 17);
    await admin.query('CREATE TABLE public.watchdog_runtime_rows(id integer PRIMARY KEY,code text NOT NULL)');
    await admin.query("INSERT INTO public.watchdog_runtime_rows SELECT n,'Code-'||n FROM generate_series(1,1000) n");
    const tableOid = (await admin.query("SELECT 'public.watchdog_runtime_rows'::regclass::oid AS oid")).rows[0].oid;

    await t.test('an expression index remains active after more than five seconds waiting for an old reader', async () => {
      const client = await connect(), monitor = await connect(), reader = await connect();
      const identity = await configureRunner(client);
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await reader.query('SELECT count(*) FROM public.watchdog_runtime_rows');
      const events = [];
      const sql = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS watchdog_old_snapshot_idx ON public.watchdog_runtime_rows(lower(code))';
      const started = Date.now();
      const operation = observe(runPhaseAwareIndexQuery({ client, monitor, sql, tableOid,
        indexName: 'watchdog_old_snapshot_idx', indexOid: 0, identity,
        record: async event => events.push(event), signal: t.signal }));
      try {
        const waiting = await eventually(async () => (await admin.query(`SELECT p.phase,a.wait_event_type,a.wait_event
          FROM pg_stat_progress_create_index p JOIN pg_stat_activity a USING(pid) WHERE p.pid=$1`, [identity.pid])).rows[0],
        row => row?.phase === 'waiting for old snapshots' && row.wait_event_type === 'Lock' && row.wait_event === 'virtualxid', 'old-snapshot-phase');
        const waitStarted = Date.now();
        await delay(6500);
        assert.equal(operation.settled, false, 'old-snapshot wait must survive the former five-second lock timeout');
        assert.equal((await admin.query('SELECT phase FROM pg_stat_progress_create_index WHERE pid=$1', [identity.pid])).rows[0]?.phase, waiting.phase);
        await reader.query('COMMIT');
        const result = await operation.completion;
        assert.equal(result.ok, true, result.error?.code ?? 'concurrent index did not complete');
        assert.deepEqual((await admin.query(`SELECT indisvalid,indisready FROM pg_index
          WHERE indexrelid='public.watchdog_old_snapshot_idx'::regclass`)).rows[0], { indisvalid: true, indisready: true });
        assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, '5s');
        assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '30min');
        assert.equal(Number((await client.query('SELECT count(*) FROM public.watchdog_runtime_rows')).rows[0].count), 1000);
        t.diagnostic(JSON.stringify({ case: 'old-snapshot', phase: waiting.phase, waitEvent: waiting.wait_event,
          heldAfterObservedMs: Date.now() - waitStarted, elapsedMs: Date.now() - started,
          valid: true, ready: true, restoredLockTimeout: '5s', watchdogEvents: events.length }));
      } finally {
        await reader.query('ROLLBACK').catch(() => {});
      }
    });

    await t.test('an initial relation lock lasting five seconds cancels only the matching index query', async () => {
      const client = await connect(), monitor = await connect(), blocker = await connect();
      const identity = await configureRunner(client);
      const blockerIdentity = (await blocker.query(identitySql)).rows[0];
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE public.watchdog_runtime_rows IN ACCESS EXCLUSIVE MODE');
      const blockerStarted = Date.now();
      const blockerSleep = observe(blocker.query('SELECT pg_sleep(9)'));
      const events = [];
      const sql = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS watchdog_relation_lock_idx ON public.watchdog_runtime_rows((code || id::text))';
      const started = Date.now();
      const operation = observe(runPhaseAwareIndexQuery({ client, monitor, sql, tableOid,
        indexName: 'watchdog_relation_lock_idx', indexOid: 0, identity,
        record: async event => events.push(event), signal: t.signal }));
      try {
        await eventually(async () => (await admin.query(`SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1`, [identity.pid])).rows[0],
          row => row?.wait_event_type === 'Lock' && row.wait_event === 'relation', 'initial-relation-lock');
        const result = await operation.completion;
        const elapsedMs = Date.now() - started;
        assert.equal(result.ok, false, 'watchdog must cancel an unsafe initial relation lock wait');
        assert.equal(result.error.safeCode ?? result.error.message, 'INDEX_RELATION_LOCK_WAIT_EXCEEDED');
        assert.ok(elapsedMs >= 5000 && elapsedMs < 8500, `initial lock cancel must occur near the five-second bound, observed ${elapsedMs}ms`);
        assert.equal(blockerSleep.settled, false, 'blocking session must not be cancelled by our watchdog');
        assert.equal((await admin.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [identity.pid])).rows[0].state, 'idle');
        assert.equal((await admin.query(`SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND relation=$2
          AND mode='AccessExclusiveLock' AND granted`, [blockerIdentity.pid, tableOid])).rows[0].n, 1);
        assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, '5s');
        assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '30min');
        assert.equal((await blockerSleep.completion).ok, true, 'unrelated active blocker must finish normally');
        assert.ok(Date.now() - blockerStarted >= 8900, 'blocker sleep must not have been interrupted');
        assert.equal((await blocker.query('SELECT 1 AS still_in_transaction')).rows[0].still_in_transaction, 1);
        await blocker.query('COMMIT');
        assert.equal((await admin.query("SELECT to_regclass('public.watchdog_relation_lock_idx') AS index")).rows[0].index, null,
          'cancel during initial table-lock acquisition must leave no index');
        t.diagnostic(JSON.stringify({ case: 'initial-relation-lock', cancelledAfterMs: elapsedMs,
          blockerSurvived: true, indexCreated: false, restoredLockTimeout: '5s', watchdogEvents: events.length }));
      } finally {
        await blockerSleep.completion;
        await blocker.query('ROLLBACK').catch(() => {});
      }
    });
  } finally {
    // Remove only our randomly named disposable container. Forced removal also
    // releases any test connection still waiting if an assertion failed.
    await exec('docker', ['rm', '--force', container], { timeout: 20_000 }).catch(() => {});
    await Promise.allSettled(clients.map(client => client.end()));
  }
});
