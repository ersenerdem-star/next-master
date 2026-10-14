import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runPhaseAwareIndexQuery, WATCHDOG_IDENTITY_SQL, WATCHDOG_OBSERVATION_SQL, WATCHDOG_CANCEL_SQL,
  normalizeIndexStatement, safeMonitorCause } from '../ops/price-engine-index-watchdog.mjs';

const sql = 'CREATE INDEX CONCURRENTLY test_index ON public.test_rows (lower(code))';
const identity = { pid: 111, backendStart: '123456.000001' };
const snapshot = { pid: identity.pid, backend_start: identity.backendStart, state: 'active', query: sql,
  wait_event_type: 'Lock', wait_event: 'virtualxid', command: 'CREATE INDEX CONCURRENTLY',
  phase: 'waiting for old snapshots', table_oid: '222', index_oid: '333', index_name: 'test_index', index_schema: 'public',
  waits: [{ type: 'virtualxid', mode: 'ShareLock', wait_ms: 7000 }] };

function harness({ observation = snapshot, observationError = false, monitorEvent, monitorClosed = false, cancelMatches = true } = {}) {
  const events = [], queries = [], cancels = [], client = new EventEmitter(), monitor = new EventEmitter();
  let clock = 0, resolveOperation, rejectOperation, ended = false;
  client.query = async statement => {
    queries.push(statement);
    if (statement === WATCHDOG_IDENTITY_SQL) return { rows: [{ pid: identity.pid, backend_start: identity.backendStart }] };
    if (statement.startsWith('SET ')) return { rows: [] };
    assert.equal(statement, sql);
    return new Promise((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
  };
  client.end = async () => { ended = true; rejectOperation?.(Error('connection closed')); };
  const cancel = async (statement, parameters) => {
    assert.equal(statement, WATCHDOG_CANCEL_SQL);
    cancels.push(parameters);
    if (!cancelMatches) return { rows: [] };
    rejectOperation(Object.assign(Error('cancelled'), { code: '57014' }));
    return { rows: [{ cancelled: true }] };
  };
  monitor.query = async (statement, parameters) => {
    if (statement === WATCHDOG_CANCEL_SQL) {
      if (monitorClosed) throw Error('closed monitor');
      return cancel(statement, parameters);
    }
    assert.equal(statement, WATCHDOG_OBSERVATION_SQL); assert.deepEqual(parameters, [identity.pid]);
    if (observationError) throw observationError === true ? Error('secret provider text') : observationError;
    return { rows: [observation] };
  };
  const run = overrides => runPhaseAwareIndexQuery({ client, monitor, sql, identity, indexName: 'test_index', tableOid: 222,
    record: async event => events.push(event), ...overrides },
  { now: () => clock, wait: async milliseconds => { clock += milliseconds;
    if (monitorEvent) monitor.emit(monitorEvent.name, monitorEvent.error);
    else resolveOperation?.({ rows: [] }); } });
  return { run, events, queries, cancels, cancel, get ended() { return ended; } };
}

test('only the matching concurrent index virtualxid snapshot/writer phases receive the larger budget', async () => {
  for (const phase of ['waiting for old snapshots', 'waiting for writers before build', 'waiting for writers before validation']) {
    const h = harness({ observation: { ...snapshot, phase } }); await h.run();
    assert.equal(h.cancels.length, 0);
    assert.equal(h.events.find(event => event.event === 'index-watchdog-observation').extended_wait_allowed, true);
    assert.equal(h.queries.at(-1), "SET lock_timeout = '5s'");
  }
  for (const patch of [{ phase: 'initializing' }, { table_oid: '999' }, { index_name: 'other' }, { index_schema: 'other' },
    { command: 'CREATE INDEX' }, { waits: [{ type: 'relation', wait_ms: 7000 }] }]) {
    const h = harness({ observation: { ...snapshot, ...patch } });
    await assert.rejects(h.run(), /INDEX_RELATION_LOCK_WAIT_EXCEEDED/);
    assert.deepEqual(h.cancels, [[identity.pid, identity.backendStart, normalizeIndexStatement(sql)]]);
  }
});

test('snapshot waits also stop at120 seconds and cancellation is never directed at a locker PID', async () => {
  const h = harness({ observation: { ...snapshot, current_locker_pid: 98765, waits: [{ type: 'virtualxid', wait_ms: 120001 }] } });
  await assert.rejects(h.run(), /INDEX_SNAPSHOT_WAIT_EXCEEDED/);
  assert.deepEqual(h.cancels, [[111, identity.backendStart, sql]]);
  assert.doesNotMatch(WATCHDOG_CANCEL_SQL, /terminate|current_locker_pid/i);
  assert.match(WATCHDOG_CANCEL_SQL, /backend_start/); assert.match(WATCHDOG_CANCEL_SQL, /regexp_replace\(a.query/);
});

test('monitor errors fail closed and use only a guarded cancellation of the owned statement', async () => {
  const h = harness({ observationError: true });
  await assert.rejects(h.run(), /INDEX_WATCHDOG_MONITOR_FAILED/);
  assert.deepEqual(h.cancels, [[111, identity.backendStart, sql]]);
  assert.doesNotMatch(JSON.stringify(h.events), /secret provider text/);
  assert.equal(h.queries.at(-1), "SET lock_timeout = '5s'");
});

test('a disconnected monitor uses a replacement guarded connection; unconfirmed cancellation closes only our client', async () => {
  const h = harness({ observationError: true, monitorClosed: true });
  let replacementClosed = false;
  await assert.rejects(h.run({ openMonitor: async () => ({ query: h.cancel, end: async () => { replacementClosed = true; } }) }),
    /INDEX_WATCHDOG_MONITOR_FAILED/);
  assert.equal(replacementClosed, true); assert.deepEqual(h.cancels, [[111, identity.backendStart, sql]]);
  const failed = harness({ observationError: true, monitorClosed: true });
  await assert.rejects(failed.run(), /INDEX_WATCHDOG_CANCELLATION_UNCONFIRMED/);
  assert.equal(failed.ended, true);
  assert.equal(failed.queries.at(-1), sql, 'closed client must never proceed to another statement');
});

test('changed backend birth/statement cannot broaden cancellation to a replacement session', async () => {
  for (const patch of [{ backend_start: '999999.0' }, { pid: 999 }, { query: 'SELECT unrelated_user_query()' }]) {
    const h = harness({ observation: { ...snapshot, ...patch }, cancelMatches: false });
    await assert.rejects(h.run(), /INDEX_WATCHDOG_CANCELLATION_UNCONFIRMED/);
    assert.deepEqual(h.cancels, [[111, identity.backendStart, sql]]);
    assert.equal(h.ended, true);
  }
});

test('monitor diagnostics distinguish server, client and network failures without provider text', async () => {
  const cases = [
    [Object.assign(Error('canceling statement due to statement timeout'), { code: '57014' }), 'server_statement_timeout', '57014', null],
    [Object.assign(Error('secret provider text'), { code: '55P03' }), 'server_lock_timeout', '55P03', null],
    [Object.assign(Error('secret provider text'), { code: '54000' }), 'database_error', '54000', null],
    [Error('Query read timeout'), 'client_read_timeout', null, null],
    [Object.assign(Error('secret provider text'), { code: 'ECONNRESET' }), 'network_error', null, 'ECONNRESET'],
    [Object.assign(Error('secret provider text'), { code: 'secret provider text', detail: 'secret provider text' }), 'unknown_error', null, null],
  ];
  for (const [error, kind, sqlstate, network_code] of cases) {
    const h = harness({ observationError: error });
    await assert.rejects(h.run(), /INDEX_WATCHDOG_MONITOR_FAILED/);
    assert.deepEqual(h.events.find(event => event.event === 'index-watchdog-cancel').diagnostic,
      { stage: 'observation_query', elapsed_ms: 0, kind, sqlstate, network_code });
    assert.deepEqual(h.cancels, [[identity.pid, identity.backendStart, sql]]);
    assert.doesNotMatch(JSON.stringify(h.events), /secret provider text|canceling statement|Query read timeout/);
    assert.equal(h.queries.at(-1), "SET lock_timeout = '5s'");
  }
  assert.equal(safeMonitorCause({ code: '12345\n' }).sqlstate, null);
});

test('monitor event, result shape and journal failures have distinct safe stages', async () => {
  for (const [name, error, expected] of [
    ['error', Object.assign(Error('secret provider text'), { code: 'EPIPE' }), { stage: 'monitor_error_event', kind: 'network_error', sqlstate: null, network_code: 'EPIPE' }],
    ['end', undefined, { stage: 'monitor_end_event', kind: 'connection_ended', sqlstate: null, network_code: null }],
  ]) {
    const h = harness({ monitorEvent: { name, error } });
    await assert.rejects(h.run(), /INDEX_WATCHDOG_MONITOR_FAILED/);
    assert.deepEqual(h.events.find(event => event.event === 'index-watchdog-cancel').diagnostic, expected);
  }
  const malformed = harness({ observation: { ...snapshot, waits: 'secret provider text' } });
  await assert.rejects(malformed.run(), /INDEX_WATCHDOG_MONITOR_FAILED/);
  assert.equal(malformed.events.find(event => event.event === 'index-watchdog-cancel').diagnostic.kind, 'invalid_waits_shape');
  const h = harness(), events = [];
  await assert.rejects(h.run({ record: async event => {
    if (event.event === 'index-watchdog-observation') throw Error('secret provider text');
    events.push(event);
  } }), /INDEX_WATCHDOG_MONITOR_FAILED/);
  assert.equal(events.find(event => event.event === 'index-watchdog-cancel').diagnostic.stage, 'observation_record');
  assert.doesNotMatch(JSON.stringify([events, malformed.events]), /secret provider text/);
});
