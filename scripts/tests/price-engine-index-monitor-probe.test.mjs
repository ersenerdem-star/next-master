import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { runMonitorProbe, parseProbeArgs } from '../ops/probe-price-engine-index-monitor.mjs';
import { PRODUCTION_PROJECT } from '../ops/price-engine-production-index-prebuild.mjs';
import { SESSION_IDENTITY_SQL } from '../ops/run-price-engine-production-index-prebuild.mjs';
import { WATCHDOG_OBSERVATION_SQL } from '../ops/price-engine-index-watchdog.mjs';

const connection = { host: `db.${PRODUCTION_PROJECT}.supabase.co`, user: 'postgres', database: 'postgres', port: 5432,
  password: 'synthetic-secret', ssl: { ca: 'synthetic-ca', rejectUnauthorized: true }, transaction: false };
function harness({ failure, tls = true } = {}) {
  const client = new EventEmitter(), events = [], queries = [], counters = { constructors: 0, observed: 0, active: 0, maxActive: 0, closed: 0 };
  let clock = 0;
  client.connection = { stream: { encrypted: true, authorized: tls } };
  client.connect = async () => {};
  client.end = async () => { counters.closed++; client.emit('end'); };
  client.query = async (sql, values) => {
    queries.push(sql); counters.active++; counters.maxActive = Math.max(counters.maxActive, counters.active);
    try {
      await setImmediate(); clock += 7;
      if (sql.startsWith('SET ')) return { rows: [] };
      if (sql === SESSION_IDENTITY_SQL) return { rows: [{ database_ok: true, role_ok: true, backend_pid: 2468 }] };
      assert.equal(sql, WATCHDOG_OBSERVATION_SQL);
      assert.deepEqual(values, [2468]); counters.observed++;
      if (failure) throw failure;
      return { rows: [{ pid: 2468, waits: [], query: 'synthetic-private-query' }] };
    } finally { counters.active--; }
  };
  const dependencies = { createClient: async config => {
    counters.constructors++;
    assert.equal(config.query_timeout, 3000); assert.equal(config.connectionTimeoutMillis, 10000);
    assert.equal(config.ssl.rejectUnauthorized, true); assert.equal(config.options, '');
    assert.equal(config.port, 5432); assert.equal(config.host, connection.host); assert.equal(config.password, connection.password);
    assert.equal(Object.hasOwn(config, 'connectionString'), false);
    return client;
  }, now: () => clock, wait: async ms => { assert.equal(ms, 500); clock += ms; } };
  return { queries, events, counters, run: overrides => runMonitorProbe({ connection, record: async event => events.push(event), ...overrides }, dependencies) };
}

test('probe performs exactly10 sequential own-session observations with original monitor timeouts and no mutations', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.status, 'completed'); assert.equal(result.completed, 10);
  assert.equal(h.counters.observed, 10); assert.equal(h.counters.maxActive, 1); assert.equal(h.counters.closed, 1);
  assert.deepEqual(h.queries.slice(0, 4), ["SET default_transaction_read_only = on", "SET search_path = pg_catalog",
    "SET statement_timeout = '2s'", "SET lock_timeout = '1s'"]);
  assert.doesNotMatch(h.queries.join('\n'), /\b(?:CREATE|DROP|pg_cancel_backend|pg_terminate_backend)\b/i);
  assert.deepEqual(h.events[0], { event: 'probe', attempt: 1, elapsed_ms: 7, code: 'OK' });
  assert.doesNotMatch(JSON.stringify([result, h.events]), /synthetic-secret|synthetic-ca|synthetic-private-query/);
});

test('probe stops on first query failure and emits only safe classification', async () => {
  const h = harness({ failure: Object.assign(Error('secret provider response'), { code: '57014', detail: 'secret provider response' }) });
  const result = await h.run();
  assert.equal(result.status, 'failed'); assert.equal(h.counters.observed, 1); assert.equal(h.counters.closed, 1);
  assert.equal(h.events[0].sqlstate, '57014'); assert.equal(h.events[0].elapsed_ms, 7);
  assert.doesNotMatch(JSON.stringify([result, h.events]), /secret provider response/);
});

test('probe rejects other targets/unverified TLS before observations and does not accept mutation flags', async () => {
  const wrongTarget = harness();
  assert.equal((await wrongTarget.run({ connection: { ...connection, port: 6543 } })).failure.code, 'CONNECTION_TARGET_UNCONFIRMED');
  assert.equal(wrongTarget.counters.constructors, 0);
  const insecure = harness({ tls: false });
  assert.equal((await insecure.run()).failure.code, 'TLS_SESSION_UNVERIFIED'); assert.equal(insecure.queries.length, 0);
  const args = ['--host', connection.host, '--password-file', '/synthetic/password', '--ca-file', '/synthetic/ca', '--evidence', '/synthetic/new-evidence'];
  assert.equal(parseProbeArgs(args).host, connection.host);
  for (const bad of [['--apply'], [...args, '--apply'], [...args, '--host', connection.host], args.slice(0, -2)])
    assert.throws(() => parseProbeArgs(bad), /PROBE_ARGUMENT_INVALID/);
});
