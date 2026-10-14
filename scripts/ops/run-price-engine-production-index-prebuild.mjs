#!/usr/bin/env node
// Dedicated PostgreSQL session runner. Importing this module never connects.
// Credentials are read only by the explicit CLI path; there is no env fallback.
import { createHash, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertConnectionTarget, buildPlan, inspectIndexSnapshot, PRODUCTION_PROJECT } from './price-engine-production-index-prebuild.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultPlan = resolve(root, 'scripts/ops/price-engine-production-index-prebuild-plan.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const SESSION_IDENTITY_SQL = "SELECT current_database()='postgres' AS database_ok, session_user='postgres' AS role_ok, pg_backend_pid() AS backend_pid";
const publicErrorCodes = new Set([
  '23505','25001','40P01','42501','42P01','42703','42710','55P03','57014','08001','08003','08004','08006',
  '28P01','28000','53300','53400','57P01','57P02','57P03','53200','53100','XX000',
  'ENOTFOUND','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOENT','EACCES','EPERM','ELOOP','EEXIST',
  'CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
class GuardError extends Error {
  constructor(code, checks = []) { super(code); this.safeCode = code; this.checks = checks; }
}
export function safeFailure(error) {
  // Never serialize message, stack, detail, hint, query, config, parameters or cause.
  return error instanceof GuardError
    ? { code: error.safeCode, checks: error.checks }
    : { code: publicErrorCodes.has(error?.code) ? error.code : 'UNCLASSIFIED_FAILURE', checks: [] };
}
const defaultClient = async (config) => new (await import('pg')).default.Client(config);

export async function runIndexPrebuild({ plan, connection, apply = false, record },
  { regeneratePlan = buildPlan, createClient = defaultClient } = {}) {
  const evidence = { schema_version: 1, project_ref: PRODUCTION_PROJECT, mode: apply === true ? 'apply' : 'inspect',
    status: 'failed', schema_ddl_attempted: 0, completed: [], started_at: new Date().toISOString() };
  let client, asyncError, backendPid, stage = 'plan-validation', currentIndex = null;
  const emit = async (event) => record({ at: new Date().toISOString(), ...event });
  const query = async (sql) => {
    if (asyncError) throw asyncError;
    const result = await client.query(sql);
    if (asyncError) throw asyncError;
    return result;
  };
  try {
    if (typeof record !== 'function' || typeof apply !== 'boolean') throw new GuardError('RUNNER_ARGUMENT_INVALID');
    const expected = await regeneratePlan();
    if (!isDeepStrictEqual(plan, expected)) throw new GuardError('REVIEWED_PLAN_DRIFT');
    evidence.manifest_sha256 = expected.manifest_sha256;
    stage = 'connection-validation';
    let target;
    try { target = assertConnectionTarget(connection); }
    catch { throw new GuardError('CONNECTION_TARGET_UNCONFIRMED'); }
    if (typeof connection.password !== 'string' || !connection.password || /[\r\n\0]/.test(connection.password))
      throw new GuardError('PASSWORD_FILE_INVALID');
    await emit({ event: 'started', mode: evidence.mode, target, manifest_sha256: evidence.manifest_sha256 });
    // Explicit properties prevent connection-string TLS overrides and PGOPTIONS
    // or other ambient settings from choosing a different target/session mode.
    client = await createClient({ host: target.host, user: target.user, database: 'postgres', port: 5432,
      password: connection.password, ssl: { ca: connection.ssl.ca, rejectUnauthorized: true },
      options: '', application_name: 'nm-price-index-prebuild-20261014',
      connectionTimeoutMillis: 10000, query_timeout: 1805000, keepAlive: true });
    client.on('error', (error) => { asyncError = error; });
    stage = 'connect';
    await client.connect();
    if (asyncError) throw asyncError;
    if (client.connection?.stream?.encrypted !== true || client.connection.stream.authorized !== true)
      throw new GuardError('TLS_SESSION_UNVERIFIED');
    stage = 'session-setup';
    for (const sql of expected.session_setup_sql) await query(sql);
    const verify = async (phase, indexName) => {
      const identity = (await query(SESSION_IDENTITY_SQL)).rows?.[0];
      if (identity?.database_ok !== true || identity?.role_ok !== true || !Number.isSafeInteger(identity.backend_pid) || identity.backend_pid < 1 ||
          (backendPid && identity.backend_pid !== backendPid)) throw new GuardError('DEDICATED_SESSION_UNCONFIRMED');
      backendPid = identity.backend_pid;
      const data = (await query(expected.verification_sql)).rows?.[0]?.index_prebuild_snapshot;
      const check = inspectIndexSnapshot(expected, { project_ref: target.project_ref, data }, { phase, indexName });
      // Store known identities, booleans and definition fingerprints only. Raw
      // remote definitions/error text might contain arbitrary sensitive values.
      await emit({ event: 'verification', phase, index: indexName || null, ready: check.ready, checks: check.errors,
        backend_pid: backendPid, indexes: expected.operations.map((item) => {
          const row = data?.indexes?.find((entry) => entry.name === item.name);
          return { name: item.name, present: row?.present === true, valid: row?.valid === true, ready: row?.ready === true,
            live: row?.live === true, definition_sha256: typeof row?.definition === 'string' ? hash(row.definition) : null };
        }) });
      if (!check.ready) throw new GuardError('INDEX_METADATA_GATE_FAILED', check.errors);
      return check;
    };
    stage = 'initial-verification';
    const initial = await verify('before');
    if (!apply) {
      evidence.status = 'inspected';
      evidence.ready_to_apply = true;
      evidence.actions = initial.actions;
    } else {
      for (const item of expected.operations) {
        currentIndex = item.name;
        stage = 'before-index';
        const before = await verify('before', item.name);
        const action = before.actions[0]?.action;
        if (!['create-concurrently','skip-verified-existing'].includes(action)) throw new GuardError('INDEX_ACTION_UNCONFIRMED');
        await emit({ event: 'index-start', name: item.name, action, sql_sha256: item.sql_sha256 });
        if (action === 'create-concurrently') {
          stage = 'create-index';
          evidence.schema_ddl_attempted++;
          await query(item.sql); // Exactly one statement, never BEGIN or a pipeline.
        }
        stage = 'after-index';
        await verify('after', item.name);
        evidence.completed.push({ name: item.name, action });
        await emit({ event: 'index-completed', name: item.name, action });
      }
      currentIndex = null;
      stage = 'final-verification';
      await verify('after');
      evidence.status = 'completed';
    }
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = { stage, index: currentIndex, ...safeFailure(error) };
    evidence.operator_action = 'Stop and inspect fresh metadata; do not retry, drop or reindex automatically.';
  } finally {
    if (client) {
      try { await client.end(); }
      catch (error) {
        evidence.status = 'failed';
        evidence.cleanup_failure = safeFailure(error);
      }
    }
    if (asyncError && evidence.status !== 'failed') {
      evidence.status = 'failed';
      evidence.failure = { stage: 'connection-event', index: currentIndex, ...safeFailure(asyncError) };
    }
    evidence.finished_at = new Date().toISOString();
    try { await emit({ event: 'finished', ...evidence }); }
    catch { evidence.status = 'failed'; evidence.audit_write_failed = true; }
  }
  return evidence;
}

export function parseRunnerArgs(args) {
  const options = { apply: false, plan: defaultPlan };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new GuardError('RUNNER_ARGUMENT_INVALID');
    seen.add(option);
    if (option === '--apply') { options.apply = true; continue; }
    if (option === '--inspect') continue;
    if (!['--host','--password-file','--ca-file','--evidence','--plan'].includes(option) || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new GuardError('RUNNER_ARGUMENT_INVALID');
    options[option.slice(2)] = args[++index];
  }
  if (seen.has('--apply') && seen.has('--inspect')) throw new GuardError('RUNNER_ARGUMENT_INVALID');
  if (!options.host || !options['password-file'] || !options['ca-file'] || !options.evidence) throw new GuardError('RUNNER_ARGUMENT_INVALID');
  return options;
}

async function readPrivatePassword(path) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size < 1 || stat.size > 4096)
      throw new GuardError('PASSWORD_FILE_PERMISSIONS_OR_SIZE_INVALID');
    const password = (await file.readFile('utf8')).replace(/\r?\n$/, '');
    if (!password || /[\r\n\0]/.test(password)) throw new GuardError('PASSWORD_FILE_INVALID');
    return password;
  } finally { await file.close(); }
}

async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log('Dedicated production index prebuild; defaults to inspect (no CREATE INDEX).\n' +
      'node scripts/ops/run-price-engine-production-index-prebuild.mjs\n' +
      '  --host <exact production direct/session host> --password-file <private file>\n' +
      '  --ca-file <verified PEM CA bundle> --evidence <new JSONL file> [--apply]\n' +
      'Password file must be owned by this user with mode 0600. No credentials belong in command arguments.\n' +
      'Apply performs the 12 reviewed operations sequentially. Existing invalid indexes stop the run.');
    return;
  }
  const options = parseRunnerArgs(args);
  const plan = JSON.parse(await readFile(resolve(options.plan), 'utf8'));
  const ca = await readFile(resolve(options['ca-file']), 'utf8');
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!certificates.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) throw new GuardError('CA_BUNDLE_INVALID');
  try { certificates.forEach((certificate) => new X509Certificate(certificate)); }
  catch { throw new GuardError('CA_BUNDLE_INVALID'); }
  const connection = { host: options.host, user: options.host === `db.${PRODUCTION_PROJECT}.supabase.co` ? 'postgres' : `postgres.${PRODUCTION_PROJECT}`,
    database: 'postgres', port: 5432, ssl: { ca, rejectUnauthorized: true }, transaction: false };
  try { assertConnectionTarget(connection); }
  catch { throw new GuardError('CONNECTION_TARGET_UNCONFIRMED'); }
  // Fail if the evidence path already exists; never overwrite credentials,
  // certificates, previous evidence or source files.
  const journal = await open(resolve(options.evidence), 'wx', 0o600);
  try {
    connection.password = await readPrivatePassword(options['password-file']);
    const result = await runIndexPrebuild({ plan, connection, apply: options.apply, record: async (event) => {
      await journal.appendFile(`${JSON.stringify(event)}\n`);
      await journal.sync();
      if (['started','index-start','index-completed'].includes(event.event)) console.log(JSON.stringify(event));
    } });
    console.log(JSON.stringify(result));
    if (result.status === 'failed') process.exitCode = 1;
  } finally { connection.password = undefined; await journal.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(JSON.stringify({ status: 'failed', ...safeFailure(error) })); process.exitCode = 1; });
}
