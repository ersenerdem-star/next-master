import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = (name) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');

test('long catalog conflicts deduplicate without losing evidence or changing short keys', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create table product_attribute_conflicts (
        organization_id uuid not null default '00000000-0000-0000-0000-000000000001',
        product_id uuid not null default '00000000-0000-0000-0000-000000000002',
        field_name text not null,
        normalized_incoming_value text not null,
        incoming_value text not null,
        status text not null default 'pending_review',
        detection_count int not null default 1
      );
      create unique index uq_product_attribute_conflicts_pending_attempt
        on product_attribute_conflicts(organization_id, product_id, field_name, normalized_incoming_value)
        where status = 'pending_review';
    `);
    await db.exec(migration('20260713_002_product_conflict_weight_normalization_fix'));
    const insert = (value) => db.query(`
      insert into product_attribute_conflicts(field_name, normalized_incoming_value, incoming_value)
      values ('vehicle_model', normalize_product_conflict_value('vehicle_model', $1), $1)
      on conflict (organization_id, product_id, field_name, normalized_incoming_value)
      where status = 'pending_review' do update
      set detection_count = product_attribute_conflicts.detection_count + 1
      returning normalized_incoming_value as key, incoming_value as evidence, detection_count as count
    `, [value]);
    const { rows: [{ value: longValue }] } = await db.query(`
      select string_agg(md5(i::text), '' order by i) as value from generate_series(1, 130) i
    `);
    const legacyValue = longValue.slice(0, 2112);
    await assert.rejects(insert(longValue), { code: '54000' });
    const { rows: [legacy] } = await insert(legacyValue);
    assert.equal(legacy.key, legacyValue);

    await db.exec(`begin; ${migration('20261123095354_bound_catalog_conflict_index_keys')} commit;`);

    const { rows: [legacyRetry] } = await insert(legacyValue);
    assert.equal(legacyRetry.count, 2);
    assert.equal(legacyRetry.evidence, legacyValue);

    const { rows: [first] } = await insert(longValue);
    const { rows: [retry] } = await insert(`  ${longValue.toUpperCase()}  `);
    const { rows: [different] } = await insert(`${longValue}a`);
    const { rows: [reserved] } = await insert(first.key);

    assert.match(first.key, /^@nm-sha256@[a-f0-9]{64}$/);
    assert.deepEqual(retry, { ...first, evidence: longValue, count: 2 });
    assert.notEqual(different.key, first.key);
    assert.notEqual(reserved.key, first.key);
    const { rows: [short] } = await db.query(`
      select normalize_product_conflict_value('weight_kg', '1.2300') as weight,
             normalize_product_conflict_value('hs_code', '8484.90') as hs,
             normalize_product_conflict_value('vehicle_model', '  VW   Golf ') as model,
             length(product_conflict_index_key(repeat('ü', 1001))) as multibyte_key_length
    `);
    assert.deepEqual(short, { weight: '1.23', hs: '848490', model: 'vw golf', multibyte_key_length: 75 });
  } finally {
    await db.close();
  }
});
