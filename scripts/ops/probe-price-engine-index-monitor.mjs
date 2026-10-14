#!/usr/bin/env node
// Explicit, read-only production monitor diagnosis. Importing never connects.
import { X509Certificate } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertConnectionTarget, PRODUCTION_PROJECT } from './price-engine-production-index-prebuild.mjs';
import { readPrivatePassword, safeFailure, SESSION_IDENTITY_SQL } from './run-price-engine-production-index-prebuild.mjs';
import { safeMonitorCause, WATCHDOG_OBSERVATION_SQL, WATCHDOG_POLL_MS } from './price-engine-index-watchdog.mjs';

const PROBE_COUNT = 10;
const SETUP = ["SET default_transaction_read_only = on", "SET search_path = pg_catalog",
  "SET statement_timeout = '2s'", "SET lock_timeout = '1s'"];
class ProbeError extends Error {
  constructor(code) { super(code); this.safeCode = code; }
}
const fail = code => { throw new ProbeError(code); };
const defaultClient = async config => new (await import('pg')).default.Client(config);
const diagnostic = error => {
  const cause = safeMonitorCause(error);
  return { ...cause, code: error instanceof ProbeError ? error.safeCode : cause.sqlstate || cause.network_code || safeFailure(error).code };
};

export function parseProbeArgs(args) {
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--host', '--password-file', '--ca-file', '--evidence'].includes(option) || seen.has(option)
      || !args[i + 1] || args[i + 1].startsWith('--')) fail('PROBE_ARGUMENT_INVALID');
    seen.add(option); options[option.slice(2)] = args[++i];
  }
  if (seen.size !== 4) fail('PROBE_ARGUMENT_INVALID');
  return options;
}

export async function runMonitorProbe({ connection, record },
  { createClient = defaultClient, now = Date.now, wait = delay } = {}) {
  let client, connectionFailure, closing = false, stage = 'connection-validation', completed = 0;
  const started = now();
  const result = { status: 'failed', completed: 0 };
  try {
    if (typeof record !== 'function') fail('PROBE_ARGUMENT_INVALID');
    let target;
    try { target = assertConnectionTarget(connection); } catch { fail('CONNECTION_TARGET_UNCONFIRMED'); }
    if (typeof connection.password !== 'string' || !connection.password || /[\r\n\0]/.test(connection.password)) fail('PASSWORD_FILE_INVALID');
    client = await createClient({ host: target.host, user: target.user, database: 'postgres', port: 5432,
      password: connection.password, ssl: { ca: connection.ssl.ca, rejectUnauthorized: true }, options: '',
      application_name: 'nm-price-index-monitor-probe-20261014',
      connectionTimeoutMillis: 10000, query_timeout: 3000, keepAlive: true });
    client.on('error', error => { connectionFailure ??= { stage: 'monitor_error_event', ...diagnostic(error) }; });
    client.on('end', () => { if (!closing) connectionFailure ??= {
      stage: 'monitor_end_event', kind: 'connection_ended', sqlstate: null, network_code: null, code: 'MONITOR_CONNECTION_ENDED' }; });
    const query = async (sql, parameters) => {
      if (connectionFailure) fail('MONITOR_CONNECTION_FAILED');
      const data = await client.query(sql, parameters);
      if (connectionFailure) fail('MONITOR_CONNECTION_FAILED');
      return data;
    };
    stage = 'connect'; await client.connect();
    if (client.connection?.stream?.encrypted !== true || client.connection.stream.authorized !== true) fail('TLS_SESSION_UNVERIFIED');
    stage = 'session-setup';
    for (const sql of SETUP) await query(sql);
    const identity = (await query(SESSION_IDENTITY_SQL)).rows?.[0];
    if (identity?.database_ok !== true || identity?.role_ok !== true || !Number.isSafeInteger(identity.backend_pid)
      || identity.backend_pid < 1) fail('DEDICATED_SESSION_UNCONFIRMED');
    // Observe our own live session. An absent old CIC PID can skip pg_locks
    // evaluation and falsely imply the monitor query has been exercised.
    stage = 'observation-query';
    for (let attempt = 1; attempt <= PROBE_COUNT; attempt++) {
      const queryStarted = now();
      try {
        const rows = (await query(WATCHDOG_OBSERVATION_SQL, [identity.backend_pid])).rows;
        if (rows?.length !== 1 || rows[0].pid !== identity.backend_pid || !Array.isArray(rows[0].waits)) fail('PROBE_OBSERVATION_UNCONFIRMED');
        await record({ event: 'probe', attempt, elapsed_ms: Math.max(0, now() - queryStarted), code: 'OK' });
        completed++;
      } catch (error) {
        await record({ event: 'probe', attempt, elapsed_ms: Math.max(0, now() - queryStarted),
          ...(connectionFailure || { stage, ...diagnostic(error) }) });
        throw error; // A failed connection/query ends the probe; no retries.
      }
      if (attempt < PROBE_COUNT) await wait(WATCHDOG_POLL_MS);
    }
    result.status = 'completed';
  } catch (error) {
    result.failure = connectionFailure || { stage, ...diagnostic(error) };
  } finally {
    closing = true;
    try { await client?.end(); }
    catch (error) { result.status = 'failed'; result.cleanup_failure = diagnostic(error); }
    result.completed = completed; result.elapsed_ms = Math.max(0, now() - started);
    await record({ event: 'finished', ...result });
  }
  return result;
}

async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log('Read-only monitor probe: 10 serial queries of this dedicated session; stops on first failure.\n' +
      'node scripts/ops/probe-price-engine-index-monitor.mjs --host <exact production direct/session host>\n' +
      '  --password-file <private file> --ca-file <verified PEM bundle> --evidence <new JSONL file>\n' +
      'No DDL, cancellation, retries or target-session query text is emitted. This does not reproduce a running CIC.');
    return;
  }
  const options = parseProbeArgs(args);
  const ca = await readFile(resolve(options['ca-file']), 'utf8');
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!certificates.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) fail('CA_BUNDLE_INVALID');
  try { certificates.forEach(certificate => new X509Certificate(certificate)); } catch { fail('CA_BUNDLE_INVALID'); }
  const connection = { host: options.host, user: options.host === `db.${PRODUCTION_PROJECT}.supabase.co`
    ? 'postgres' : `postgres.${PRODUCTION_PROJECT}`, database: 'postgres', port: 5432,
    ssl: { ca, rejectUnauthorized: true }, transaction: false };
  try { assertConnectionTarget(connection); } catch { fail('CONNECTION_TARGET_UNCONFIRMED'); }
  const journal = await open(resolve(options.evidence), 'wx', 0o600);
  try {
    connection.password = await readPrivatePassword(options['password-file']);
    const result = await runMonitorProbe({ connection, record: async event => {
      const safeEvent = { at: new Date().toISOString(), ...event };
      await journal.appendFile(`${JSON.stringify(safeEvent)}\n`); await journal.sync();
      console.log(JSON.stringify(safeEvent));
    } });
    if (result.status !== 'completed') process.exitCode = 1;
  } finally { connection.password = undefined; await journal.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ status: 'failed', ...diagnostic(error) })); process.exitCode = 1;
  });
}
