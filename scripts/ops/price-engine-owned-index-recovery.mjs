// Two finite, explicitly reviewed failed attempts. Never a general invalid-index cleaner.
import { createHash } from 'node:crypto';
export const OWNED_INDEX_NAME = 'idx_catalog_products_export_exact_code';
export const OWNED_INDEX_OID = 264797;
export const OWNED_ATTEMPT_SHA256 = '2738ccefb55df42955be767c22a55c41d0ec844beea2e8b9d816e6174c350ecb';
export const SECOND_OWNED_INDEX_OID = 264840;
export const SECOND_OWNED_ATTEMPT_SHA256 = '271f7c5eb5d44e16e72cab4f9639d4b1088903b13708eea08cd9684bbb15b215';
const reviewedAttempts = Object.freeze([
  Object.freeze({ oid: OWNED_INDEX_OID, sha256: OWNED_ATTEMPT_SHA256, ready: true, eventCount: 5, failure: '55P03' }),
  Object.freeze({ oid: SECOND_OWNED_INDEX_OID, sha256: SECOND_OWNED_ATTEMPT_SHA256, ready: false, eventCount: 9, failure: 'INDEX_WATCHDOG_MONITOR_FAILED' }),
]);
export const DROP_OWNED_INDEX_SQL = 'DROP INDEX CONCURRENTLY public.idx_catalog_products_export_exact_code';
export class OwnedIndexRecoveryError extends Error {
  constructor(code) { super(code); this.safeCode = code; }
}
const fail = code => { throw new OwnedIndexRecoveryError(code); };
export function validateOwnedIndexAttempt({ plan, journalBytes, journalSha256, indexOid }) {
  const reviewed = reviewedAttempts.find(attempt => attempt.oid === indexOid && attempt.sha256 === journalSha256);
  if (!reviewed
    || !Buffer.isBuffer(journalBytes) || createHash('sha256').update(journalBytes).digest('hex') !== journalSha256)
    fail('OWNED_INDEX_ATTEMPT_UNCONFIRMED');
  let events;
  try { events = journalBytes.toString().trim().split('\n').map(JSON.parse); }
  catch { fail('OWNED_INDEX_ATTEMPT_UNCONFIRMED'); }
  const item = plan.operations.find(operation => operation.name === OWNED_INDEX_NAME);
  const [start, initial, before, attempt] = events, finish = events.at(-1);
  if (!item || events.length !== reviewed.eventCount || start.event !== 'started' || start.mode !== 'apply'
    || start.manifest_sha256 !== plan.manifest_sha256 || start.target?.project_ref !== plan.project_ref
    || start.target?.database !== 'postgres' || start.target?.port !== 5432
    || start.target?.tls_certificate_verification !== true || start.target?.transaction !== false
    || [initial, before].some(event => event.event !== 'verification' || event.phase !== 'before'
      || event.ready !== true || event.indexes?.find(row => row.name === OWNED_INDEX_NAME)?.present !== false)
    || before.index !== OWNED_INDEX_NAME || attempt.event !== 'index-start' || attempt.name !== OWNED_INDEX_NAME
    || attempt.action !== 'create-concurrently' || attempt.sql_sha256 !== item.sql_sha256
    || finish.event !== 'finished' || finish.status !== 'failed' || finish.mode !== 'apply'
    || finish.manifest_sha256 !== plan.manifest_sha256 || finish.schema_ddl_attempted !== 1
    || !Array.isArray(finish.completed) || finish.completed.length !== 0
    || finish.failure?.stage !== 'create-index' || finish.failure.index !== OWNED_INDEX_NAME || finish.failure.code !== reviewed.failure)
    fail('OWNED_INDEX_ATTEMPT_UNCONFIRMED');
  if (indexOid === SECOND_OWNED_INDEX_OID) {
    const [watchStart, firstObservation, secondObservation, cancellation] = events.slice(4, 8);
    if (finish.allow_snapshot_wait !== true || !Number.isSafeInteger(before.backend_pid) || before.backend_pid < 1
      || initial.backend_pid !== before.backend_pid
      || [watchStart, firstObservation, secondObservation, cancellation].some(event =>
        event.index !== OWNED_INDEX_NAME || event.backend_pid !== before.backend_pid)
      || watchStart.event !== 'index-watchdog-start' || watchStart.relation_wait_limit_ms !== 5000
      || watchStart.snapshot_wait_limit_ms !== 120000 || watchStart.poll_ms !== 500 || watchStart.statement_timeout !== '30min'
      || firstObservation.event !== 'index-watchdog-observation' || firstObservation.phase !== 'initializing'
      || secondObservation.event !== 'index-watchdog-observation' || secondObservation.phase !== 'building index: scanning table'
      || cancellation.event !== 'index-watchdog-cancel' || cancellation.reason !== reviewed.failure
      || cancellation.own_query_cancel_confirmed !== true) fail('OWNED_INDEX_ATTEMPT_UNCONFIRMED');
  }
  return { item, indexOid, journalSha256 };
}
export const OWNED_INDEX_METADATA_SQL = `SELECT ic.oid::bigint AS index_oid,ic.relkind AS index_kind,
  ns.nspname AS index_schema,ic.relname AS index_name,tc.oid::bigint AS table_oid,
  tn.nspname AS table_schema,tc.relname AS table_name,i.indisvalid AS valid,i.indisready AS ready,
  i.indislive AS live,i.indisunique AS unique,
  CASE WHEN ic.relkind='i' THEN pg_get_indexdef(ic.oid) END AS definition,
  (SELECT count(*)::int FROM pg_constraint c WHERE c.conindid=ic.oid) AS constraint_count,
  (SELECT count(*)::int FROM pg_stat_progress_create_index p WHERE p.index_relid=ic.oid OR p.relid=tc.oid) AS active_build_count
  FROM pg_class ic JOIN pg_namespace ns ON ns.oid=ic.relnamespace
  LEFT JOIN pg_index i ON i.indexrelid=ic.oid LEFT JOIN pg_class tc ON tc.oid=i.indrelid
  LEFT JOIN pg_namespace tn ON tn.oid=tc.relnamespace WHERE ic.oid=to_regclass($1)`;
export function validateOwnedIndexMetadata({ item, indexOid, metadata }) {
  const row = metadata;
  const reviewed = reviewedAttempts.find(attempt => attempt.oid === indexOid);
  if (!reviewed || Number(row?.index_oid) !== indexOid || row?.index_kind !== 'i'
    || row.index_schema !== 'public' || row.index_name !== OWNED_INDEX_NAME || item?.name !== OWNED_INDEX_NAME
    || row.table_schema !== 'public' || row.table_name !== 'catalog_products'
    || !Number.isSafeInteger(Number(row.table_oid)) || Number(row.table_oid) < 1
    || row.valid !== false || row.ready !== reviewed.ready || row.live !== true || row.unique !== false
    || row.definition !== item.expected_definition || row.constraint_count !== 0 || row.active_build_count !== 0)
    fail('OWNED_INDEX_METADATA_UNCONFIRMED');
  return { index_oid: indexOid, table_oid: Number(row.table_oid) };
}
