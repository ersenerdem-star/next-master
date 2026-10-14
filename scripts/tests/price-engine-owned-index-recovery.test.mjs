import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { OWNED_INDEX_NAME, OWNED_INDEX_OID, OWNED_ATTEMPT_SHA256, DROP_OWNED_INDEX_SQL,
  validateOwnedIndexAttempt, validateOwnedIndexMetadata } from '../ops/price-engine-owned-index-recovery.mjs';

const plan = JSON.parse(await readFile(new URL('../ops/price-engine-production-index-prebuild-plan.json', import.meta.url)));
// Exact original sanitized runner journal; contains fingerprints and public
// object identities, never credentials, raw provider errors or business data.
const journalBytes = await readFile(new URL('./fixtures/price-engine-owned-index-attempt-20261014.jsonl', import.meta.url));
const proof = { plan, journalBytes, journalSha256: OWNED_ATTEMPT_SHA256, indexOid: OWNED_INDEX_OID };
const item = plan.operations[0];
const metadata = { index_oid: String(OWNED_INDEX_OID), index_kind: 'i', index_schema: 'public', index_name: OWNED_INDEX_NAME,
  table_oid: '20000', table_schema: 'public', table_name: 'catalog_products', valid: false, ready: true, live: true,
  unique: false, definition: item.expected_definition, constraint_count: 0, active_build_count: 0 };

test('cleanup authorization binds exact prior absent-index failure journal, definition and owned OID', () => {
  assert.equal(createHash('sha256').update(journalBytes).digest('hex'), OWNED_ATTEMPT_SHA256);
  assert.equal(validateOwnedIndexAttempt(proof).item.name, OWNED_INDEX_NAME);
  assert.deepEqual(validateOwnedIndexMetadata({ item, indexOid: OWNED_INDEX_OID, metadata }),
    { index_oid: OWNED_INDEX_OID, table_oid: 20000 });
  assert.equal(DROP_OWNED_INDEX_SQL, 'DROP INDEX CONCURRENTLY public.idx_catalog_products_export_exact_code');
  assert.doesNotMatch(DROP_OWNED_INDEX_SQL, /CASCADE|IF EXISTS|;/);
});

test('changed/missing journal, wrong hash/OID/plan, or extra attempts cannot authorize cleanup', () => {
  for (const change of [
    { journalBytes: undefined }, { journalBytes: Buffer.from('not-json') },
    { journalBytes: Buffer.concat([journalBytes, Buffer.from('\n')]) },
    { journalSha256: 'a'.repeat(64) }, { indexOid: OWNED_INDEX_OID + 1 },
    { plan: { ...plan, manifest_sha256: 'a'.repeat(64) } },
    { plan: { ...plan, operations: [{ ...item, sql_sha256: 'a'.repeat(64) }] } },
  ]) assert.throws(() => validateOwnedIndexAttempt({ ...proof, ...change }), /OWNED_INDEX_ATTEMPT_UNCONFIRMED/);
  const events = journalBytes.toString().trim().split('\n').map(JSON.parse);
  for (const change of [e => e.push(e[3]), e => { e[2].indexes[0].present = true; },
    e => { e[4].failure.code = '57014'; }, e => { e[4].schema_ddl_attempted = 2; }]) {
    const altered = structuredClone(events); change(altered);
    assert.throws(() => validateOwnedIndexAttempt({ ...proof, journalBytes: Buffer.from(altered.map(JSON.stringify).join('\n') + '\n') }),
      /OWNED_INDEX_ATTEMPT_UNCONFIRMED/);
  }
});

test('valid, replaced, constrained, rebuilding, dead, malformed or unrelated indexes are never cleanup targets', () => {
  for (const change of [
    { valid: true }, { ready: false }, { live: false }, { unique: true }, { index_oid: OWNED_INDEX_OID + 1 },
    { index_kind: 'r' }, { index_schema: 'other' }, { index_name: 'legacy_index' }, { table_schema: 'other' },
    { table_name: 'supplier_prices' }, { table_oid: null }, { table_oid: 'NaN' }, { definition: 'different' },
    { constraint_count: 1 }, { active_build_count: 1 },
  ]) assert.throws(() => validateOwnedIndexMetadata({ item, indexOid: OWNED_INDEX_OID, metadata: { ...metadata, ...change } }),
    /OWNED_INDEX_METADATA_UNCONFIRMED/);
  assert.throws(() => validateOwnedIndexMetadata({ item, indexOid: OWNED_INDEX_OID, metadata: undefined }), /OWNED_INDEX_METADATA_UNCONFIRMED/);
});
