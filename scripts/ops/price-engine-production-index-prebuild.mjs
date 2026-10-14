#!/usr/bin/env node
// Offline only: extracts reviewed statements and verifies supplied metadata.
// This module has no network, PostgreSQL client, deployment or execution path.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(repoRoot, 'scripts/ops/price-engine-production-manifest.json');
export const PRODUCTION_PROJECT = 'zjgueqijumzlfioihnkt';
export const SESSION_SETUP_SQL = [
  'SET search_path = pg_catalog', "SET lock_timeout = '5s'", "SET statement_timeout = '30min'",
  "SET idle_in_transaction_session_timeout = '30s'", "SET application_name = 'nm-price-index-prebuild-20261014'",
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Only existing large-table indexes identified by the production baseline audit.
// New-table and new-column indexes remain in the ordinary reviewed migrations.
export const REVIEWED_INDEXES = [
  ['idx_catalog_products_export_exact_code', 'catalog_products', '20261013140012_supplier_price_export_exact_catalog_identity'],
  ['idx_supplier_prices_export_keyset', 'supplier_prices', '20261014072055_supplier_price_export_keyset_page'],
  ['idx_supplier_prices_export_search', 'supplier_prices', '20261014072055_supplier_price_export_keyset_page'],
  ['idx_catalog_products_export_id', 'catalog_products', '20261014085226_catalog_export_source_contracts'],
  ['idx_catalog_products_export_code_id', 'catalog_products', '20261014085226_catalog_export_source_contracts'],
  ['idx_supplier_prices_export_keyset_coalesced', 'supplier_prices', '20261014085547_supplier_price_export_published_source'],
  ['idx_catalog_products_export_exact_identity', 'catalog_products', '20261014090241_export_source_keyset_collation'],
  ['idx_catalog_products_export_code_c_id', 'catalog_products', '20261014090241_export_source_keyset_collation'],
  ['idx_supplier_price_rollups_export_code_c', 'supplier_price_rollups', '20261014090241_export_source_keyset_collation'],
  ['idx_supplier_prices_export_code_c', 'supplier_prices', '20261014090241_export_source_keyset_collation'],
  ['idx_catalog_import_stage_run_validation', 'catalog_import_stage', '20261014132000_catalog_import_storage_validation_batches'],
  ['idx_catalog_import_stage_run_code_brand', 'catalog_import_stage', '20261014132000_catalog_import_storage_validation_batches'],
].map(([name, table, source]) => ({ name, schema: 'public', table, source: `supabase/migrations/${source}.sql` }));

// A single reviewed supersession, enabled only by the new forward migration
// in the supplied manifest. Older 60-entry plans remain exactly reproducible.
export const COMPACT_SEARCH_OVERRIDE = Object.freeze({
  name: 'idx_supplier_prices_export_search',
  source: 'supabase/migrations/20261014145352_supplier_price_export_compact_search_index.sql',
  source_sha256: '0bf89e6b27238cec08cddfcadb918fdeacfc9c5f1d600aff6d143490d488a488',
  source_sql_sha256: '9b44a174ddd584f237d5a5a8f437db8eab6ad4cf4e4f55b4beb77414ecb3626f',
  superseded_source: 'supabase/migrations/20261014072055_supplier_price_export_keyset_page.sql',
  superseded_source_sha256: '61601e15328df84ed97b0c7d94312ee3537b20355139fe9d117433da90d4a726',
  superseded_sql_sha256: '1bee78a279b7d809b35aa2f162eac2f39b3f731e3666a800013ef8e6cce45fcc',
});

// A small SQL lexer, not a regexp across function bodies. Dollar bodies, quoted
// strings/identifiers and nested comments cannot introduce top-level statements.
function statements(sql) {
  const result = [];
  let tokens = [], offset = 0;
  while (offset < sql.length) {
    const start = offset;
    if (/\s/.test(sql[offset])) { offset++; continue; }
    if (sql.startsWith('--', offset)) {
      const end = sql.indexOf('\n', offset + 2);
      offset = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith('/*', offset)) {
      offset += 2; let depth = 1;
      while (offset < sql.length && depth) {
        if (sql.startsWith('/*', offset)) { depth++; offset += 2; }
        else if (sql.startsWith('*/', offset)) { depth--; offset += 2; }
        else offset++;
      }
      if (depth) throw Error('SQL_COMMENT_UNTERMINATED');
      continue;
    }
    const dollar = sql.slice(offset).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, offset + dollar.length);
      if (end < 0) throw Error('SQL_DOLLAR_BODY_UNTERMINATED');
      offset = end + dollar.length;
    } else if (sql[offset] === "'" || sql[offset] === '"') {
      const quote = sql[offset++]; let closed = false;
      while (offset < sql.length) {
        if (sql[offset++] === quote) {
          if (sql[offset] === quote) offset++;
          else { closed = true; break; }
        }
      }
      if (!closed) throw Error('SQL_QUOTE_UNTERMINATED');
    } else if (/[a-z_0-9]/i.test(sql[offset])) {
      while (offset < sql.length && /[a-z_0-9$]/i.test(sql[offset])) offset++;
    } else offset++;
    const raw = sql.slice(start, offset);
    tokens.push({ raw, value: /^[a-z_]/i.test(raw) ? raw.toLowerCase() : raw, start, end: offset });
    if (raw === ';') { result.push(tokens); tokens = []; }
  }
  if (tokens.length) result.push(tokens);
  return result;
}

export async function extractReviewedIndexes(manifestBytes, { loadFile = (file) => readFile(resolve(repoRoot, file)) } = {}) {
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.schema_version !== 1 || manifest.environment !== 'production-preparation' ||
      manifest.targets?.production_project_ref !== PRODUCTION_PROJECT || !Array.isArray(manifest.migration_order) || !manifest.migration_order.length)
    throw Error('INDEX_MANIFEST_TARGET_OR_SHAPE_INVALID');
  const override = manifest.migration_order.find((entry) => entry.file === COMPACT_SEARCH_OVERRIDE.source);
  if (override && (override.sha256 !== COMPACT_SEARCH_OVERRIDE.source_sha256 ||
      manifest.migration_order.findIndex(entry => entry.file === COMPACT_SEARCH_OVERRIDE.source) >=
      manifest.migration_order.findIndex(entry => entry.file === COMPACT_SEARCH_OVERRIDE.superseded_source)))
    throw Error('INDEX_SUPERSESSION_SOURCE_OR_ORDER_INVALID');
  const wanted = new Map(REVIEWED_INDEXES.map((item) => [item.name,
    override && item.name === COMPACT_SEARCH_OVERRIDE.name ? {...item, source: COMPACT_SEARCH_OVERRIDE.source} : item]));
  const found = new Map(), seen = new Set();
  for (const [migrationIndex, entry] of manifest.migration_order.entries()) {
    if (!/^supabase\/migrations\/[a-z0-9_]+\.sql$/.test(entry.file || '') || seen.has(entry.file))
      throw Error('INDEX_MANIFEST_PATH_INVALID');
    seen.add(entry.file);
    const bytes = await loadFile(entry.file);
    if (digest(bytes) !== entry.sha256) throw Error(`INDEX_MIGRATION_HASH_CHANGED:${entry.file}`);
    const sql = bytes.toString();
    for (const tokens of statements(sql)) {
      const words = tokens.map((token) => token.value);
      if (words.slice(0, 5).join(' ') !== 'create index if not exists') continue;
      const candidate = wanted.get(words[5]);
      if (!candidate) continue;
      if (words[6] !== 'on' || words[7] !== 'public' || words[8] !== '.' || words[9] !== candidate.table || words.at(-1) !== ';')
        throw Error(`INDEX_STATEMENT_SHAPE_CHANGED:${candidate.name}`);
      const originalSql = sql.slice(tokens[0].start, tokens.at(-1).end);
      const previous = found.get(candidate.name);
      if (override && candidate.name === COMPACT_SEARCH_OVERRIDE.name && entry.file === COMPACT_SEARCH_OVERRIDE.superseded_source) {
        if (!previous || entry.sha256 !== COMPACT_SEARCH_OVERRIDE.superseded_source_sha256 ||
            digest(originalSql) !== COMPACT_SEARCH_OVERRIDE.superseded_sql_sha256)
          throw Error('INDEX_SUPERSEDED_DEFINITION_CHANGED');
        previous.superseded_in.push({file: entry.file, sha256: entry.sha256, migration_position: migrationIndex + 1,
          source_sql_sha256: digest(originalSql), action: 'skip-only-after-compact-index-verification'});
        continue;
      }
      if (previous) {
        if (previous.tokens !== JSON.stringify(words)) throw Error(`INDEX_REPEATED_DEFINITION_CHANGED:${candidate.name}`);
        previous.repeated_in.push({ file: entry.file, sha256: entry.sha256, migration_position: migrationIndex + 1 });
        continue;
      }
      if (entry.file !== candidate.source) throw Error(`INDEX_SOURCE_ORDER_CHANGED:${candidate.name}`);
      if (override && candidate.name === COMPACT_SEARCH_OVERRIDE.name && digest(originalSql) !== COMPACT_SEARCH_OVERRIDE.source_sql_sha256)
        throw Error('INDEX_COMPACT_DEFINITION_CHANGED');
      const concurrentSql = originalSql.slice(0, tokens[1].end - tokens[0].start) + ' concurrently' + originalSql.slice(tokens[1].end - tokens[0].start);
      found.set(candidate.name, {
        name: candidate.name, schema: candidate.schema, table: candidate.table,
        source: { file: entry.file, sha256: entry.sha256, migration_position: migrationIndex + 1 },
        source_sql: originalSql, source_sql_sha256: digest(originalSql),
        sql: concurrentSql, sql_sha256: digest(concurrentSql), repeated_in: [], tokens: JSON.stringify(words),
        ...(override && candidate.name === COMPACT_SEARCH_OVERRIDE.name ? {superseded_in: []} : {}),
      });
    }
  }
  if (found.size !== REVIEWED_INDEXES.length) throw Error(`INDEX_REVIEWED_DEFINITIONS_MISSING:${REVIEWED_INDEXES.filter((item) => !found.has(item.name)).map((item) => item.name).join(',')}`);
  const actualOrder = [...found.keys()];
  const expectedDiscovery = REVIEWED_INDEXES.map((item) => item.name);
  if (override) {
    // The forward source must precede the legacy migration. Keep the reviewed
    // prebuild operation order stable, while explicitly pinning this one move.
    [expectedDiscovery[1], expectedDiscovery[2]] = [expectedDiscovery[2], expectedDiscovery[1]];
    if (found.get(COMPACT_SEARCH_OVERRIDE.name).superseded_in.length !== 1)
      throw Error('INDEX_SUPERSEDED_DEFINITION_MISSING');
  }
  if (actualOrder.join(',') !== expectedDiscovery.join(',')) throw Error('INDEX_EXECUTION_ORDER_CHANGED');
  return REVIEWED_INDEXES.map(({name}) => found.get(name)).map(({ tokens: _tokens, ...item }, index) => ({ sequence: index + 1, ...item }));
}

// Run with search_path=pg_catalog on the same dedicated session. This stabilizes
// pg_get_indexdef qualification; comparing names alone is insufficient.
export function metadataSql() {
  const values = REVIEWED_INDEXES.map((item) => `(${literal(item.name)},${literal(item.table)})`).join(',\n    ');
  return `WITH wanted(name,table_name) AS (VALUES ${values})
SELECT jsonb_build_object(
  'snapshot_version',1,'collected_at',clock_timestamp(),
  'server_version_num',current_setting('server_version_num'),
  'search_path',current_setting('search_path'),
  'lock_timeout',current_setting('lock_timeout'),'statement_timeout',current_setting('statement_timeout'),
  'idle_in_transaction_session_timeout',current_setting('idle_in_transaction_session_timeout'),
  'normalizer',jsonb_build_object('present',p.oid IS NOT NULL,'volatility',p.provolatile,
    'definition_md5',CASE WHEN p.oid IS NOT NULL THEN md5(pg_get_functiondef(p.oid)) END),
  'indexes',(SELECT jsonb_agg(jsonb_build_object(
    'name',w.name,'schema','public','table',w.table_name,
    'table_present',tc.oid IS NOT NULL,'table_kind',tc.relkind,
    'present',ic.oid IS NOT NULL,'kind',ic.relkind,
    'actual_table_schema',tn.nspname,'actual_table',it.relname,
    'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'unique',i.indisunique,
    'definition',CASE WHEN i.indexrelid IS NOT NULL THEN pg_get_indexdef(i.indexrelid) END
  ) ORDER BY w.name)
  FROM wanted w
  LEFT JOIN pg_namespace ns ON ns.nspname='public'
  LEFT JOIN pg_class tc ON tc.relnamespace=ns.oid AND tc.relname=w.table_name
  LEFT JOIN pg_class ic ON ic.relnamespace=ns.oid AND ic.relname=w.name
  LEFT JOIN pg_index i ON i.indexrelid=ic.oid
  LEFT JOIN pg_class it ON it.oid=i.indrelid
  LEFT JOIN pg_namespace tn ON tn.oid=it.relnamespace)
) AS index_prebuild_snapshot
FROM (SELECT 1) seed LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.normalize_catalog_product_code(text)');`;
}

// An operator using a PostgreSQL client must bind the envelope to the actual
// configured endpoint, never just type a desired project_ref into the evidence.
// Transaction pooling cannot preserve SET/session locks between statements.
export function assertConnectionTarget(connection) {
  const direct = connection?.host === `db.${PRODUCTION_PROJECT}.supabase.co` && connection?.user === 'postgres';
  const sessionPool = /^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(connection?.host || '') && connection?.user === `postgres.${PRODUCTION_PROJECT}`;
  if ((!direct && !sessionPool) || String(connection?.port || 5432) !== '5432' || connection?.database !== 'postgres' ||
      connection?.ssl?.rejectUnauthorized !== true || !connection?.ssl?.ca || connection?.transaction !== false)
    throw Error('INDEX_CONNECTION_TARGET_UNCONFIRMED');
  return { project_ref: PRODUCTION_PROJECT, host: connection.host, user: connection.user, database: connection.database, port: 5432,
    tls_certificate_verification: true, transaction: false, pooling: direct ? 'direct' : 'session' };
}

export function inspectIndexSnapshot(plan, envelope, { phase = 'before', indexName } = {}) {
  const errors = [], data = envelope?.data;
  if (plan?.schema_version !== 1 || plan?.project_ref !== PRODUCTION_PROJECT || envelope?.project_ref !== PRODUCTION_PROJECT)
    errors.push('INDEX_PROJECT_TARGET_UNCONFIRMED');
  if (!Array.isArray(plan?.operations) || plan.operations.length !== REVIEWED_INDEXES.length ||
      plan.operations.some((item, index) => item.name !== REVIEWED_INDEXES[index].name || item.table !== REVIEWED_INDEXES[index].table || typeof item.expected_definition !== 'string') ||
      !/^[a-f0-9]{32}$/.test(plan?.normalizer?.definition_md5 || '')) errors.push('INDEX_PLAN_INCOMPLETE');
  if (!['before', 'after'].includes(phase) || (indexName && !plan?.operations?.some((item) => item.name === indexName)))
    errors.push('INDEX_CHECK_SCOPE_INVALID');
  if (data?.snapshot_version !== 1 || Math.floor(Number(data?.server_version_num) / 10000) !== 17 || data?.search_path !== 'pg_catalog')
    errors.push('INDEX_METADATA_CONTEXT_UNCONFIRMED');
  if (data?.lock_timeout !== '5s' || data?.statement_timeout !== '30min' || data?.idle_in_transaction_session_timeout !== '30s')
    errors.push('INDEX_SESSION_TIMEOUTS_UNCONFIRMED');
  if (data?.normalizer?.present !== true || data?.normalizer?.volatility !== 'i' || data?.normalizer?.definition_md5 !== plan?.normalizer?.definition_md5)
    errors.push('INDEX_NORMALIZER_CHANGED');
  const rows = data?.indexes || [];
  if (rows.length !== REVIEWED_INDEXES.length || new Set(rows.map((row) => row.name)).size !== REVIEWED_INDEXES.length ||
      REVIEWED_INDEXES.some((item) => !rows.some((row) => row.name === item.name))) errors.push('INDEX_METADATA_INCOMPLETE');
  const actions = [];
  if (!errors.length) for (const item of plan.operations) {
    const row = rows.find((candidate) => candidate.name === item.name);
    if (row.schema !== 'public' || row.table !== item.table || row.table_present !== true || row.table_kind !== 'r') {
      errors.push(`INDEX_TABLE_UNCONFIRMED:${item.name}`); continue;
    }
    if (row.present === false) {
      if (phase === 'after' && (!indexName || item.name === indexName)) errors.push(`INDEX_MISSING_AFTER_BUILD:${item.name}`);
      actions.push({ name: item.name, action: 'create-concurrently' }); continue;
    }
    if (row.present !== true || row.kind !== 'i' || row.actual_table_schema !== 'public' || row.actual_table !== item.table ||
        row.unique !== false || row.definition !== item.expected_definition) {
      errors.push(`INDEX_NAME_COLLISION_OR_DEFINITION_DRIFT:${item.name}`); continue;
    }
    if (row.valid !== true || row.ready !== true || row.live !== true) errors.push(`INDEX_INVALID_REQUIRES_OPERATOR_REVIEW:${item.name}`);
    else actions.push({ name: item.name, action: 'skip-verified-existing' });
  }
  return { ready: errors.length === 0, project_ref: envelope?.project_ref, phase, index_name: indexName || null, errors,
    actions: errors.length ? [] : actions.filter((item) => !indexName || item.name === indexName),
    evidence_scope: 'Supplied read-only PostgreSQL metadata. This helper performed no remote connection or schema mutation.' };
}

export async function buildPlan({ bytes = readFile(manifestPath), loadFile } = {}) {
  const manifestBytes = await bytes;
  const operations = await extractReviewedIndexes(manifestBytes, { loadFile });
  // Real local PG17 parsing/deparsing against the captured production schema.
  // Only ordinary local CREATE INDEX is used here; this is not a remote timing,
  // physical concurrency, lock-contention or capacity test.
  const { createFullReplayDb, fullReplaySource } = await import('../tests/fixtures/price-engine-full-replay-db.mjs');
  if (fullReplaySource.source.projectRef !== PRODUCTION_PROJECT) throw Error('INDEX_BASELINE_TARGET_CHANGED');
  const db = await createFullReplayDb();
  let metadata;
  try {
    for (const sql of SESSION_SETUP_SQL) await db.query(sql);
    for (const item of operations) await db.query(item.source_sql);
    metadata = (await db.query(metadataSql())).rows[0].index_prebuild_snapshot;
    for (const item of operations) item.expected_definition = metadata.indexes.find((row) => row.name === item.name).definition;
  } finally { await db.close(); }
  const plan = {
    schema_version: 1, project_ref: PRODUCTION_PROJECT, action: 'offline-concurrent-index-prebuild-plan',
    manifest_file: 'scripts/ops/price-engine-production-manifest.json', manifest_sha256: digest(manifestBytes),
    captured_schema_file: 'scripts/tests/fixtures/price-engine-full-replay-production-source.json',
    captured_schema_sha256: digest(await readFile(resolve(repoRoot, 'scripts/tests/fixtures/price-engine-full-replay-production-source.json'))),
    normalizer: metadata.normalizer,
    execution_policy: {
      remote_mutation_performed: false, parallelism: 1, outer_transaction: false, automatic_drop_or_reindex: false,
      use_dedicated_direct_or_session_pooled_connection: true, verify_tls_certificate: true,
      each_sql_is_a_separate_client_query: true, verify_all_before_start: true, verify_before_and_after_each_index: true,
      stop_on_any_error_or_definition_drift: true, migration_files_modified: false,
    },
    session_setup_sql: SESSION_SETUP_SQL,
    verification_sql: metadataSql(), operations,
    operator_notes: [
      'Validate the actual client configuration with assertConnectionTarget, retain its sanitized result, and use that same dedicated session for every query.',
      'Run each setup statement separately; do not concatenate SET and CREATE INDEX into one query, BEGIN block, migration wrapper or transaction pool.',
      'Bind the snapshot envelope project_ref to the verified connection. Query metadata and inspect all 12 indexes before starting, then before and after each individual operation.',
      'Execute an operation only when its before check returns create-concurrently; skip only a valid, ready, live exact-definition match.',
      'Run one CREATE INDEX CONCURRENTLY at a time. The only change from each original source statement is insertion of the CONCURRENTLY keyword.',
      'A timeout or disconnect may leave an invalid index. Stop, capture fresh metadata and review it; never retry blindly or automatically DROP/REINDEX.',
      'Concurrent creation reduces write blocking but still uses I/O, disk, CPU and short locks; verify provider capacity and long transactions immediately before execution.',
      'A concurrent DDL name race cannot be made atomic with this precheck; postcheck must pass even when IF NOT EXISTS reports a skip.',
      'Keep all reviewed migration bytes unchanged. After all 12 exact indexes verify, their later CREATE INDEX IF NOT EXISTS statements will skip them.',
      ...(operations.some(item => item.superseded_in?.length) ? [
        'The compact supplier search definition explicitly supersedes the exact recorded historical wide statement. Prebuild the compact definition first; verify it again before both forward and superseded migrations. Never build the wide statement or accept it as equivalent.',
      ] : []),
      'This plan does not execute SQL, authorize a production change, prove production readiness or activate any import/export/catalog workflow.',
    ],
  };
  const verification = inspectIndexSnapshot(plan, { project_ref: PRODUCTION_PROJECT, data: metadata }, { phase: 'after' });
  if (!verification.ready) throw Error(`INDEX_LOCAL_DEFINITION_VERIFICATION_FAILED:${verification.errors.join(',')}`);
  return plan;
}

async function main(args) {
  if (args[0] === '--help' || !args.length) {
    console.log('Offline only; no connections or remote execution.\n' +
      '  node scripts/ops/price-engine-production-index-prebuild.mjs --write-plan <path>\n' +
      '  node scripts/ops/price-engine-production-index-prebuild.mjs --check <snapshot.json> [--after] [--index <name>]\n' +
      'Snapshots: {project_ref: <verified connection target>, data: <verification_sql result>}.'); return;
  }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--after') { options.after = true; continue; }
    if (!['--write-plan', '--check', '--index'].includes(key) || !args[index + 1]) throw Error(`Unknown or incomplete option: ${key}`);
    options[key.slice(2)] = args[++index];
  }
  if (!!options['write-plan'] === !!options.check || (options['write-plan'] && (options.after || options.index))) throw Error('Choose exactly one offline operation');
  const plan = await buildPlan();
  if (options['write-plan']) {
    await writeFile(resolve(options['write-plan']), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ action: 'local-plan-written', operations: plan.operations.length, manifest_sha256: plan.manifest_sha256, remote_mutation_performed: false }));
  } else {
    const envelope = JSON.parse(await readFile(resolve(options.check), 'utf8'));
    const check = inspectIndexSnapshot(plan, envelope, { phase: options.after ? 'after' : 'before', indexName: options.index });
    console.log(JSON.stringify(check, null, 2));
    if (!check.ready) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
