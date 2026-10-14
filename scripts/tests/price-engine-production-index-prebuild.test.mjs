import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildPlan, extractReviewedIndexes, inspectIndexSnapshot, assertConnectionTarget,
  metadataSql, PRODUCTION_PROJECT, REVIEWED_INDEXES, SESSION_SETUP_SQL } from '../ops/price-engine-production-index-prebuild.mjs';
import { createFullReplayDb } from './fixtures/price-engine-full-replay-db.mjs';

const manifestBytes = await readFile(new URL('../ops/price-engine-production-manifest.json', import.meta.url));
const plan = await buildPlan({ bytes: manifestBytes });
const repoRoot = new URL('../../', import.meta.url);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const wrap = (data) => ({ project_ref: PRODUCTION_PROJECT, data });
async function snapshot(db) { return wrap((await db.query(metadataSql())).rows[0].index_prebuild_snapshot); }

test('plan is exactly 12 reviewed standalone concurrent statements in pinned operation order', async () => {
  assert.equal(plan.operations.length, 12);
  assert.deepEqual(plan.operations.map((item) => item.name), REVIEWED_INDEXES.map((item) => item.name));
  assert.equal(plan.manifest_sha256, hash(manifestBytes));
  for (const item of plan.operations) {
    assert.match(item.sql, /^create index concurrently if not exists /i);
    assert.equal(item.sql.replace(/\bindex concurrently\b/i, 'index'), item.source_sql);
    assert.equal(hash(item.sql), item.sql_sha256);
    assert.equal(hash(item.source_sql), item.source_sql_sha256);
    assert.equal(hash(await readFile(new URL(item.source.file, repoRoot))), item.source.sha256);
    assert.match(item.expected_definition, /^CREATE INDEX .* ON public\./);
    assert.equal(item.sql.split(';').length, 2);
  }
  assert.equal(plan.execution_policy.outer_transaction, false);
  assert.equal(plan.execution_policy.parallelism, 1);
  assert.equal(plan.execution_policy.automatic_drop_or_reindex, false);
  assert.ok(plan.session_setup_sql.includes("SET lock_timeout = '5s'"));
  assert.ok(plan.session_setup_sql.includes("SET statement_timeout = '30min'"));
  assert.ok(plan.operations.at(-1).repeated_in.length > 0);
});

test('real PG17 metadata supports partial completion, exact skips and complete postcheck', async () => {
  const db = await createFullReplayDb();
  try {
    for (const sql of SESSION_SETUP_SQL) await db.query(sql);
    const initial = await snapshot(db);
    const start = inspectIndexSnapshot(plan, initial);
    assert.equal(start.ready, true);
    assert.ok(start.actions.every((item) => item.action === 'create-concurrently'));
    assert.equal(inspectIndexSnapshot(plan, initial, { phase: 'after' }).ready, false);
    // Ordinary local CREATE verifies definitions. It does not simulate remote
    // concurrent build timing, locks, cancellation or disk requirements.
    await db.query(plan.operations[0].source_sql);
    const partial = await snapshot(db);
    const resumable = inspectIndexSnapshot(plan, partial);
    assert.equal(resumable.ready, true);
    assert.equal(resumable.actions.filter((item) => item.action === 'skip-verified-existing').length, 1);
    assert.equal(inspectIndexSnapshot(plan, partial, { phase: 'after', indexName: plan.operations[0].name }).ready, true);
    assert.equal(inspectIndexSnapshot(plan, partial, { phase: 'after', indexName: plan.operations[1].name }).ready, false);
    for (const item of plan.operations.slice(1)) await db.query(item.source_sql);
    const complete = await snapshot(db);
    assert.equal(inspectIndexSnapshot(plan, complete, { phase: 'after' }).ready, true);
    // Same names cannot mask predicate, collation or expression differences.
    const item = plan.operations.find((entry) => entry.name === 'idx_supplier_prices_export_code_c');
    await db.exec(`DROP INDEX public.${item.name}`);
    await db.query(item.source_sql.replace(' collate "C"', ''));
    const wrongDefinition = inspectIndexSnapshot(plan, await snapshot(db));
    assert.equal(wrongDefinition.ready, false);
    assert.ok(wrongDefinition.errors.includes(`INDEX_NAME_COLLISION_OR_DEFINITION_DRIFT:${item.name}`));
    assert.deepEqual(wrongDefinition.actions, []);
    await db.exec(`DROP INDEX public.${item.name}; CREATE TABLE public.${item.name}(id integer)`);
    const tableCollision = inspectIndexSnapshot(plan, await snapshot(db));
    assert.ok(tableCollision.errors.includes(`INDEX_NAME_COLLISION_OR_DEFINITION_DRIFT:${item.name}`));
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.${item.name}`)).rows[0].n, 0);
  } finally { await db.close(); }
});

function completeEnvelope() {
  return wrap({ snapshot_version: 1, server_version_num: '170006', search_path: 'pg_catalog', normalizer: plan.normalizer,
    lock_timeout: '5s', statement_timeout: '30min', idle_in_transaction_session_timeout: '30s',
    indexes: plan.operations.map((item) => ({ name: item.name, schema: 'public', table: item.table,
      table_present: true, table_kind: 'r', present: true, kind: 'i', actual_table_schema: 'public', actual_table: item.table,
      valid: true, ready: true, live: true, unique: false, definition: item.expected_definition })) });
}

test('invalid/not-ready/dead indexes fail closed and never yield a retry or drop action', () => {
  for (const state of ['valid', 'ready', 'live']) {
    const envelope = completeEnvelope();
    envelope.data.indexes[0][state] = false;
    const result = inspectIndexSnapshot(plan, envelope);
    assert.equal(result.ready, false);
    assert.ok(result.errors.includes(`INDEX_INVALID_REQUIRES_OPERATOR_REVIEW:${plan.operations[0].name}`));
    assert.deepEqual(result.actions, []);
  }
});

test('target, PG version, deparse context, normalizer and full metadata coverage are mandatory', () => {
  const changes = [
    (e) => { e.project_ref = 'kaxsqafdevabkxofwdod'; },
    (e) => { e.data.server_version_num = '160006'; },
    (e) => { e.data.search_path = 'public'; },
    (e) => { e.data.lock_timeout = '0'; },
    (e) => { e.data.statement_timeout = '0'; },
    (e) => { e.data.normalizer = { ...e.data.normalizer, volatility: 's' }; },
    (e) => { e.data.normalizer = { ...e.data.normalizer, definition_md5: 'changed' }; },
    (e) => { e.data.indexes.pop(); },
    (e) => { e.data.indexes[1] = e.data.indexes[0]; },
    (e) => { e.data.indexes[0].table_present = false; },
    (e) => { e.data.indexes[0].actual_table = 'another_table'; },
  ];
  for (const change of changes) {
    const envelope = completeEnvelope(); change(envelope);
    const result = inspectIndexSnapshot(plan, envelope);
    assert.equal(result.ready, false);
    assert.deepEqual(result.actions, []);
  }
  assert.equal(inspectIndexSnapshot({ ...plan, operations: [] }, completeEnvelope()).ready, false);
});

test('connection verification accepts only the exact production direct/session endpoint with verified TLS', () => {
  const direct = { host: `db.${PRODUCTION_PROJECT}.supabase.co`, user: 'postgres', database: 'postgres', port: 5432,
    ssl: { rejectUnauthorized: true, ca: 'Synthetic local certificate placeholder; never a real credential' }, transaction: false };
  const accepted = assertConnectionTarget(direct);
  assert.equal(accepted.project_ref, PRODUCTION_PROJECT);
  assert.equal(accepted.pooling, 'direct');
  assert.equal(Object.hasOwn(accepted, 'ssl'), false);
  assert.equal(assertConnectionTarget({ ...direct, host: 'aws-0-eu-west-1.pooler.supabase.com', user: `postgres.${PRODUCTION_PROJECT}` }).pooling, 'session');
  for (const change of [
    { host: 'db.kaxsqafdevabkxofwdod.supabase.co' }, { user: 'another-user' }, { database: 'another-db' },
    { port: 6543 }, { transaction: true }, { ssl: { rejectUnauthorized: false, ca: 'synthetic' } }, { ssl: { rejectUnauthorized: true } },
  ]) assert.throws(() => assertConnectionTarget({ ...direct, ...change }), /INDEX_CONNECTION_TARGET_UNCONFIRMED/);
});

test('any migration byte drift stops extraction, including files outside the 12-index subset', async () => {
  const original = JSON.parse(manifestBytes);
  const changedFile = original.migration_order[0].file;
  await assert.rejects(extractReviewedIndexes(manifestBytes, { loadFile: async (file) => {
    const bytes = await readFile(new URL(file, repoRoot));
    return file === changedFile ? Buffer.concat([bytes, Buffer.from('\n-- drift\n')]) : bytes;
  } }), /INDEX_MIGRATION_HASH_CHANGED/);
});

test('repeated migration definitions must remain identical and dollar/comment decoys cannot replace missing SQL', async () => {
  const manifest = JSON.parse(manifestBytes);
  const repeated = plan.operations.at(-1).repeated_in[0].file;
  const original = await readFile(new URL(repeated, repoRoot), 'utf8');
  const modified = original.replace('on public.catalog_import_stage (run_id, normalized_code, brand)', 'on public.catalog_import_stage (run_id, normalized_code)');
  assert.notEqual(modified, original);
  manifest.migration_order.find((entry) => entry.file === repeated).sha256 = hash(modified);
  await assert.rejects(extractReviewedIndexes(Buffer.from(JSON.stringify(manifest)), { loadFile: (file) =>
    file === repeated ? Buffer.from(modified) : readFile(new URL(file, repoRoot)) }), /INDEX_REPEATED_DEFINITION_CHANGED/);

  const clean = JSON.parse(manifestBytes), first = plan.operations[0];
  const source = await readFile(new URL(first.source.file, repoRoot), 'utf8');
  const decoy = source.replace(first.source_sql, `/* nested /* comment */ ${first.source_sql} */\nDO $decoy$ BEGIN RAISE NOTICE '${first.name}';\n${first.source_sql}\nEND; $decoy$;`);
  clean.migration_order.find((entry) => entry.file === first.source.file).sha256 = hash(decoy);
  await assert.rejects(extractReviewedIndexes(Buffer.from(JSON.stringify(clean)), { loadFile: (file) =>
    file === first.source.file ? Buffer.from(decoy) : readFile(new URL(file, repoRoot)) }), /INDEX_REVIEWED_DEFINITIONS_MISSING/);
});
