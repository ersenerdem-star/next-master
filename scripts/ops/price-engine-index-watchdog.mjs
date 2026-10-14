// Optional operator policy. No connection or SQL executes on module import.
import { setTimeout as delay } from 'node:timers/promises';

export const RELATION_WAIT_LIMIT_MS = 5000;
export const SNAPSHOT_WAIT_LIMIT_MS = 120000;
export const WATCHDOG_POLL_MS = 500;
export class IndexWatchdogError extends Error {
  constructor(code, diagnostic) { super(code); this.safeCode = code; this.diagnostic = diagnostic; }
}
// Return fixed classifications/codes only; provider messages, SQL and connection
// data must never become evidence. Keep timeout classification separate from a
// network failure: their recovery decisions differ.
export function safeMonitorCause(error) {
  const networkCode = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(error?.code) ? error.code : null;
  const sqlstate = !networkCode && typeof error?.code === 'string' && error.code.length === 5 && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  const kind = error?.message === 'Query read timeout' ? 'client_read_timeout'
    : sqlstate === '57014' && error?.message === 'canceling statement due to statement timeout' ? 'server_statement_timeout'
    : sqlstate === '55P03' ? 'server_lock_timeout'
    : networkCode ? 'network_error' : sqlstate ? 'database_error' : 'unknown_error';
  return { kind, sqlstate, network_code: networkCode };
}
export const WATCHDOG_IDENTITY_SQL = `SELECT pg_backend_pid() AS pid,
  (SELECT extract(epoch FROM backend_start)::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start`;
export const WATCHDOG_OBSERVATION_SQL = `SELECT a.pid,extract(epoch FROM a.backend_start)::text AS backend_start,
  a.state,a.query,a.wait_event_type,a.wait_event,p.command,p.phase,p.relid::bigint AS table_oid,
  p.index_relid::bigint AS index_oid,ic.relname AS index_name,ns.nspname AS index_schema,
  coalesce((SELECT jsonb_agg(jsonb_build_object('type',l.locktype,'mode',l.mode,
    'wait_ms',greatest(0,extract(epoch FROM (clock_timestamp()-l.waitstart))*1000)))
    FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted),'[]'::jsonb) AS waits
  FROM pg_stat_activity a LEFT JOIN pg_stat_progress_create_index p ON p.pid=a.pid
  LEFT JOIN pg_class ic ON ic.oid=p.index_relid LEFT JOIN pg_namespace ns ON ns.oid=ic.relnamespace
  WHERE a.pid=$1`;
export const WATCHDOG_CANCEL_SQL = `SELECT pg_cancel_backend(a.pid) AS cancelled FROM pg_stat_activity a
  WHERE a.pid=$1 AND extract(epoch FROM a.backend_start)::text=$2 AND a.state='active'
  AND btrim(regexp_replace(a.query,'[[:space:]]+',' ','g'))=$3`;
export const normalizeIndexStatement = sql => sql.replace(/\s+/g, ' ').trim();
const extendedPhases = new Set(['waiting for old snapshots', 'waiting for writers before build', 'waiting for writers before validation']);
const fail = (code, diagnostic) => { throw new IndexWatchdogError(code, diagnostic); };

// The SQL cancellation guard binds PID + backend birth + exact statement. It
// never uses current_locker_pid, pg_terminate_backend or a user-session PID.
async function cancelOwnQuery({ monitor, openMonitor, identity, statement }) {
  const cancel = async connection => {
    const result = await connection.query(WATCHDOG_CANCEL_SQL, [identity.pid, identity.backendStart, statement]);
    return result.rows?.length === 1 && result.rows[0].cancelled === true;
  };
  try { return await cancel(monitor); }
  catch {
    if (!openMonitor) return false;
    let replacement;
    try { replacement = await openMonitor(); return await cancel(replacement); }
    catch { return false; }
    finally { await replacement?.end().catch(() => {}); }
  }
}

export async function runPhaseAwareIndexQuery({ client, monitor, openMonitor, sql, tableOid, indexName,
  indexOid = 0, identity, record = async () => {}, signal },
  { now = Date.now, wait = delay } = {}) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid < 1 || !/^\d+(?:\.\d+)?$/.test(identity.backendStart || '')
    || !Number.isSafeInteger(tableOid) || tableOid < 1 || !Number.isSafeInteger(indexOid) || indexOid < 0
    || !/^[a-z][a-z0-9_]+$/.test(indexName || '') || typeof sql !== 'string'
    || !/^\s*create index concurrently\b/i.test(sql) || normalizeIndexStatement(sql).length > 1000)
    fail('INDEX_WATCHDOG_ARGUMENT_INVALID');
  const statement = normalizeIndexStatement(sql);
  const own = (await client.query(WATCHDOG_IDENTITY_SQL)).rows?.[0];
  if (own?.pid !== identity.pid || own.backend_start !== identity.backendStart) fail('INDEX_WATCHDOG_IDENTITY_CHANGED');
  // Record both budgets before removing the server's undifferentiated lock
  // timeout. Metadata checks always run after it has been restored to 5s.
  await record({ event: 'index-watchdog-start', index: indexName, backend_pid: identity.pid,
    relation_wait_limit_ms: RELATION_WAIT_LIMIT_MS, snapshot_wait_limit_ms: SNAPSHOT_WAIT_LIMIT_MS,
    poll_ms: WATCHDOG_POLL_MS, statement_timeout: '30min' });
  let settled = false, outcome, stopped = false, monitorError = null;
  const onMonitorError = error => { monitorError ??= { stage: 'monitor_error_event', ...safeMonitorCause(error) }; };
  const onMonitorEnd = () => { monitorError ??= { stage: 'monitor_end_event', kind: 'connection_ended', sqlstate: null, network_code: null }; };
  monitor.on?.('error', onMonitorError);
  monitor.on?.('end', onMonitorEnd);
  let operation;
  try {
    await client.query("SET lock_timeout = '0'");
    operation = client.query(sql).then(value => { settled = true; outcome = { value }; },
      error => { settled = true; outcome = { error }; });
    let extendedWaitMs = 0, previousExtended = false, previousAt = now(), unknownWaitSince = null, lastObservation;
    try {
      while (!settled) {
        if (signal?.aborted) fail('INDEX_WATCHDOG_ABORTED');
        if (monitorError) fail('INDEX_WATCHDOG_MONITOR_FAILED', monitorError);
        let row;
        const observationStarted = now();
        try { row = (await monitor.query(WATCHDOG_OBSERVATION_SQL, [identity.pid])).rows?.[0]; }
        catch (error) { fail('INDEX_WATCHDOG_MONITOR_FAILED', { stage: 'observation_query',
          elapsed_ms: Math.max(0, now() - observationStarted), ...safeMonitorCause(error) }); }
        if (settled) break;
        if (!row || row.pid !== identity.pid || row.backend_start !== identity.backendStart)
          fail('INDEX_WATCHDOG_IDENTITY_CHANGED');
        if (row.state !== 'active' || normalizeIndexStatement(row.query || '') !== statement)
          fail('INDEX_WATCHDOG_STATEMENT_CHANGED');
        if (!Array.isArray(row.waits)) fail('INDEX_WATCHDOG_MONITOR_FAILED', {
          stage: 'observation_result', kind: 'invalid_waits_shape', sqlstate: null, network_code: null });
        const currentAt = now();
        const lockWait = row.wait_event_type === 'Lock' || row.waits.length > 0;
        const waitMs = Math.max(0, ...row.waits.map(lock => Number(lock.wait_ms) || 0));
        const extended = lockWait && row.waits.length > 0 && row.waits.every(lock => lock.type === 'virtualxid')
          && row.command === 'CREATE INDEX CONCURRENTLY' && extendedPhases.has(row.phase)
          && Number(row.table_oid) === tableOid && Number(row.index_oid) > 0
          && (!indexOid || Number(row.index_oid) === indexOid)
          && row.index_name === indexName && row.index_schema === 'public';
        if (extended && previousExtended) extendedWaitMs += Math.max(0, currentAt - previousAt);
        if (extended && Math.max(extendedWaitMs, waitMs) > SNAPSHOT_WAIT_LIMIT_MS) fail('INDEX_SNAPSHOT_WAIT_EXCEEDED');
        if (lockWait && !extended) {
          unknownWaitSince ??= currentAt;
          if (Math.max(waitMs, currentAt - unknownWaitSince) > RELATION_WAIT_LIMIT_MS) fail('INDEX_RELATION_LOCK_WAIT_EXCEEDED');
        } else unknownWaitSince = null;
        const observation = { phase: row.phase || null, wait_type: row.wait_event_type || null,
          wait_event: row.wait_event || null, lock_types: row.waits.map(lock => lock.type), extended_wait_allowed: extended };
        if (JSON.stringify(observation) !== lastObservation) {
          try { await record({ event: 'index-watchdog-observation', index: indexName, backend_pid: identity.pid,
            ...observation, wait_ms: Math.round(waitMs) }); }
          catch (error) { fail('INDEX_WATCHDOG_MONITOR_FAILED', { stage: 'observation_record', ...safeMonitorCause(error) }); }
          lastObservation = JSON.stringify(observation);
        }
        previousExtended = extended; previousAt = currentAt;
        await wait(WATCHDOG_POLL_MS);
      }
    } catch (error) {
      const failure = error instanceof IndexWatchdogError ? error : new IndexWatchdogError('INDEX_WATCHDOG_MONITOR_FAILED', {
        stage: 'monitor_loop', ...safeMonitorCause(error) });
      if (!settled) {
        const cancelled = await cancelOwnQuery({ monitor, openMonitor, identity, statement });
        await record({ event: 'index-watchdog-cancel', index: indexName, backend_pid: identity.pid,
          reason: failure.safeCode, ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
          own_query_cancel_confirmed: cancelled }).catch(() => {});
        if (!cancelled) {
          stopped = true;
          // A broken network can prevent server-side cancellation confirmation.
          // Close only our dedicated session and refuse further work; the
          // unchanged 30min server statement timeout remains the final bound.
          await client.end().catch(() => {});
          fail('INDEX_WATCHDOG_CANCELLATION_UNCONFIRMED');
        }
      }
      await operation;
      throw failure;
    }
    await operation;
    if (outcome?.error) throw outcome.error;
    return outcome?.value;
  } finally {
    monitor.off?.('error', onMonitorError); monitor.off?.('end', onMonitorEnd);
    if (!stopped) await client.query("SET lock_timeout = '5s'");
  }
}
