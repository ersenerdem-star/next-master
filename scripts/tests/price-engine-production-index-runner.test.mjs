import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { buildPlan, PRODUCTION_PROJECT } from '../ops/price-engine-production-index-prebuild.mjs';
import { runIndexPrebuild, parseRunnerArgs, SESSION_IDENTITY_SQL, safeFailure } from '../ops/run-price-engine-production-index-prebuild.mjs';

const plan = JSON.parse(await readFile(new URL('../ops/price-engine-production-index-prebuild-plan.json', import.meta.url), 'utf8'));
const actualRegeneratedPlan = await buildPlan();
// Synthetic test placeholders only; tests never read any credential file.
const secret = 'synthetic-password-never-log-this';
const ca = 'synthetic-certificate-never-log-this';
const connection = { host: `db.${PRODUCTION_PROJECT}.supabase.co`, user: 'postgres', database: 'postgres', port: 5432,
  password: secret, ssl: { ca, rejectUnauthorized: true }, transaction: false };

function harness({ present = 0, onQuery, onRecord, connectError, endError, tlsAuthorized = true } = {}) {
  const events = [], queries = [], rows = plan.operations.map((item, index) => ({ name: item.name, schema: 'public', table: item.table,
    table_present: true, table_kind: 'r', present: index < present, kind: 'i', actual_table_schema: 'public', actual_table: item.table,
    valid: true, ready: true, live: true, unique: false, definition: item.expected_definition }));
  const counters = { constructors: 0, connects: 0, ends: 0, metadata: 0, ddl: 0, active: 0, maxActive: 0 };
  const client = new EventEmitter();
  client.connection = { stream: { encrypted: true, authorized: tlsAuthorized } };
  client.connect = async () => { counters.connects++; if (connectError) throw connectError; };
  client.end = async () => { counters.ends++; if (endError) throw endError; };
  client.query = async (sql) => {
    queries.push(sql); counters.active++; counters.maxActive = Math.max(counters.maxActive, counters.active);
    try {
      await setImmediate();
      const isMetadata = sql === plan.verification_sql;
      const operation = plan.operations.find((item) => item.sql === sql);
      if (isMetadata) counters.metadata++;
      if (operation) counters.ddl++;
      const override = await onQuery?.({ sql, operation, counters, rows, client });
      if (override) return override;
      if (plan.session_setup_sql.includes(sql)) return { rows: [] };
      if (sql === SESSION_IDENTITY_SQL) return { rows: [{ database_ok: true, role_ok: true, backend_pid: 1234 }] };
      if (isMetadata) return { rows: [{ index_prebuild_snapshot: { snapshot_version: 1, server_version_num: '170006',
        search_path: 'pg_catalog', lock_timeout: '5s', statement_timeout: '30min', idle_in_transaction_session_timeout: '30s',
        normalizer: structuredClone(plan.normalizer), indexes: structuredClone(rows) } }] };
      assert.ok(operation, 'Only a reviewed standalone query may reach the client');
      rows.find((row) => row.name === operation.name).present = true;
      return { rows: [] };
    } finally { counters.active--; }
  };
  const dependencies = { regeneratePlan: async () => actualRegeneratedPlan,
    createClient: async (config) => {
      counters.constructors++;
      assert.equal(config.password, secret);
      assert.equal(config.host, connection.host);
      assert.equal(config.ssl.rejectUnauthorized, true);
      assert.equal(config.ssl.ca, ca);
      assert.equal(config.options, '');
      assert.equal(config.port, 5432);
      assert.equal(Object.hasOwn(config, 'connectionString'), false);
      return client;
    } };
  const record = async (event) => { await onRecord?.(event); events.push(structuredClone(event)); };
  const run = (overrides = {}) => runIndexPrebuild({ plan, connection, record, ...overrides }, dependencies);
  return { run, rows, queries, events, counters };
}

test('default inspect regenerates the actual plan and performs only session setup plus fresh metadata', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.status, 'inspected');
  assert.equal(result.schema_ddl_attempted, 0);
  assert.equal(result.actions.length, 12);
  assert.deepEqual(h.queries.slice(0, 5), plan.session_setup_sql);
  assert.equal(h.counters.metadata, 1);
  assert.equal(h.counters.ddl, 0);
  assert.equal(h.counters.ends, 1);
  assert.equal(h.counters.maxActive, 1);
  const serialized = JSON.stringify([h.events, result]);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(ca), false);
});

test('explicit apply performs one sequential CREATE with fresh before/after checks and skips verified existing indexes', async () => {
  const h = harness({ present: 2 }), result = await h.run({ apply: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.schema_ddl_attempted, 10);
  assert.equal(result.completed.filter((item) => item.action === 'skip-verified-existing').length, 2);
  assert.equal(h.counters.metadata, 26);
  assert.equal(h.counters.maxActive, 1);
  assert.equal(h.counters.connects, 1);
  assert.equal(h.counters.ends, 1);
  for (const sql of h.queries.filter((sql) => /^create /i.test(sql))) {
    const position = h.queries.indexOf(sql);
    assert.match(sql, /^create index concurrently if not exists /i);
    assert.equal(h.queries[position - 1], plan.verification_sql);
    assert.equal(h.queries[position + 1], SESSION_IDENTITY_SQL);
    assert.equal(h.queries[position + 2], plan.verification_sql);
  }
  assert.equal(h.queries.some((sql) => /^(?:begin|commit|rollback|drop|reindex)\b/i.test(sql)), false);
});

test('plan tampering, unconfirmed TLS and wrong production target stop before any DDL', async () => {
  const changed = structuredClone(plan); changed.operations[0].sql += '\nDROP TABLE public.catalog_products;';
  const stale = harness(), staleResult = await stale.run({ plan: changed, apply: true });
  assert.equal(staleResult.failure.code, 'REVIEWED_PLAN_DRIFT');
  assert.equal(stale.counters.constructors, 0);
  const wrongTarget = harness(), targetResult = await wrongTarget.run({ connection: { ...connection, port: 6543 }, apply: true });
  assert.equal(targetResult.failure.code, 'CONNECTION_TARGET_UNCONFIRMED');
  assert.equal(wrongTarget.counters.constructors, 0);
  const tls = harness({ tlsAuthorized: false }), tlsResult = await tls.run({ apply: true });
  assert.equal(tlsResult.failure.code, 'TLS_SESSION_UNVERIFIED');
  assert.equal(tls.queries.length, 0);
  assert.equal(tls.counters.ends, 1);
});

test('new collision between initial and per-index precheck stops before CREATE', async () => {
  const h = harness({ onQuery({ counters, rows }) {
    if (counters.metadata === 2) Object.assign(rows[0], { present: true, definition: `sensitive ${secret}` });
  } });
  const result = await h.run({ apply: true });
  assert.equal(result.failure.stage, 'before-index');
  assert.equal(result.failure.code, 'INDEX_METADATA_GATE_FAILED');
  assert.equal(h.counters.ddl, 0);
  assert.equal(JSON.stringify([h.events, result]).includes(secret), false);
});

test('successful SQL response with an invalid resulting index stops before the next operation', async () => {
  const h = harness({ onQuery({ operation, rows }) {
    if (operation) Object.assign(rows.find((row) => row.name === operation.name), { valid: false });
  } });
  const result = await h.run({ apply: true });
  assert.equal(result.failure.stage, 'after-index');
  assert.equal(h.counters.ddl, 1);
  assert.equal(result.completed.length, 0);
  assert.match(result.failure.checks[0], /^INDEX_INVALID_REQUIRES_OPERATOR_REVIEW:/);
});

test('statement failure preserves prior completions, closes the session and never retries or exposes raw errors', async () => {
  const rawError = Object.assign(new Error(`password=${secret}; certificate=${ca}`), { code: '57014', detail: secret, hint: ca, query: secret, stack: secret });
  const h = harness({ onQuery({ operation, counters }) { if (operation && counters.ddl === 2) throw rawError; } });
  const result = await h.run({ apply: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, '57014');
  assert.equal(result.completed.length, 1);
  assert.equal(h.counters.ddl, 2);
  assert.equal(h.queries.at(-1), plan.operations[1].sql);
  assert.equal(h.counters.ends, 1);
  assert.equal(JSON.stringify([result, h.events]).includes(secret), false);
  assert.equal(JSON.stringify([result, h.events]).includes(ca), false);
  assert.deepEqual(safeFailure({ message: secret, code: secret, detail: secret }), { code: 'UNCLASSIFIED_FAILURE', checks: [] });
});

test('session switching and audit-write failure stop the next statement', async () => {
  let identities = 0;
  const changed = harness({ onQuery({ sql }) {
    if (sql === SESSION_IDENTITY_SQL && ++identities === 2) return { rows: [{ database_ok: true, role_ok: true, backend_pid: 9999 }] };
  } });
  assert.equal((await changed.run({ apply: true })).failure.code, 'DEDICATED_SESSION_UNCONFIRMED');
  assert.equal(changed.counters.ddl, 0);
  const asyncFailure = harness({ onQuery({ sql, client }) {
    if (sql === SESSION_IDENTITY_SQL) client.emit('error', Object.assign(new Error(secret), { code: 'ECONNRESET' }));
  } });
  assert.equal((await asyncFailure.run({ apply: true })).failure.code, 'ECONNRESET');
  assert.equal(asyncFailure.counters.ddl, 0);
  assert.equal(asyncFailure.counters.ends, 1);
  const failedAudit = harness({ onRecord(event) { if (event.event === 'index-start') throw new Error(secret); } });
  const result = await failedAudit.run({ apply: true });
  assert.equal(result.status, 'failed');
  assert.equal(failedAudit.counters.ddl, 0);
  assert.equal(failedAudit.counters.ends, 1);
  assert.equal(JSON.stringify([result, failedAudit.events]).includes(secret), false);
});

test('connection and cleanup errors are sanitized; apply requires an explicit unambiguous flag', async () => {
  const failure = Object.assign(new Error(secret), { code: '28P01', detail: ca });
  const h = harness({ connectError: failure }), result = await h.run({ apply: true });
  assert.equal(result.failure.code, '28P01');
  assert.equal(h.queries.length, 0);
  assert.equal(h.counters.ends, 1);
  const cleanup = harness({ endError: Object.assign(new Error(secret), { code: 'ECONNRESET' }) });
  assert.equal((await cleanup.run()).cleanup_failure.code, 'ECONNRESET');
  const args = ['--host', connection.host, '--password-file', '/synthetic/password', '--ca-file', '/synthetic/ca', '--evidence', '/synthetic/evidence'];
  assert.equal(parseRunnerArgs(args).apply, false);
  assert.equal(parseRunnerArgs([...args, '--apply']).apply, true);
  assert.throws(() => parseRunnerArgs([...args, '--apply', '--inspect']), /RUNNER_ARGUMENT_INVALID/);
  assert.throws(() => parseRunnerArgs([...args, '--password', secret]), /RUNNER_ARGUMENT_INVALID/);
});
