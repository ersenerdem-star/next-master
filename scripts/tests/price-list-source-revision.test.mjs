import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile('supabase/migrations/20261015000000_supplier_price_source_revision.sql', 'utf8');
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('legacy source revision fingerprint is bounded and invalidates every mutation form', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile('scripts/tests/export-quote-eligibility-pg.setup.sql', 'utf8'));
    await db.exec(`
      alter table public.brands add column organization_id uuid;
      create table public.suppliers(id uuid primary key, organization_id uuid, name text);
      create table public.supplier_prices(
        id uuid primary key, organization_id uuid, supplier_id uuid, brand_id uuid,
        product_code text, normalized_code text, description text, buy_price numeric,
        currency text, valid_from date, valid_to date, is_active boolean,
        updated_at timestamptz default now()
      );
    `);
    await db.exec(migration);
    const org = id(1), brand = id(2), supplier = id(3), otherBrand = id(4);
    await db.query('insert into brands(id,name,organization_id) values($1,$2,$3)', [brand, 'Large legacy', org]);
    const version = async () => (await db.query(
      'select public.get_admin_price_list_export_version($1,$2) version', [org, brand],
    )).rows[0].version;
    const masterVersion = async () => (await db.query(
      "select public.get_catalog_master_export_version($1,$2,'priced') version", [org, brand],
    )).rows[0].version;

    const initial = await version();
    assert.equal(await version(), initial, 'read-only version calls are stable');
    await db.query(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,buy_price,currency,is_active)
      values($1,$2,$3,$4,'A',10,'EUR',true)`, [id(10), org, supplier, brand]);
    const inserted = await version();
    assert.notEqual(inserted, initial, 'insert increments source revision');
    const masterInserted = await masterVersion();
    await db.query('update supplier_prices set buy_price=11 where id=$1', [id(10)]);
    const updated = await version();
    assert.notEqual(updated, inserted, 'update increments source revision');
    assert.notEqual(await masterVersion(), masterInserted, 'master version follows the bounded source revision');
    await db.query('delete from supplier_prices where id=$1', [id(10)]);
    const deleted = await version();
    assert.notEqual(deleted, updated, 'delete increments source revision');
    await db.query(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,buy_price,currency,is_active)
      values($1,$2,$3,$4,'B',20,'EUR',true)`, [id(11), org, supplier, brand]);
    const beforeMove = await version();
    await db.query('update supplier_prices set brand_id=$1 where id=$2', [otherBrand, id(11)]);
    const afterMove = await version();
    assert.notEqual(afterMove, beforeMove, 'moving a row out of scope invalidates the old scope');
    await db.query('truncate supplier_prices');
    const afterTruncate = await version();
    assert.notEqual(afterTruncate, afterMove, 'truncate increments global source revision');

    const explain = await db.query(
      'explain (format json) select public.get_admin_price_list_export_version($1,$2)', [org, brand],
    );
    const planText = JSON.stringify(explain.rows);
    assert.doesNotMatch(planText, /supplier_prices/, 'version read does not scan the legacy source table');
  } finally {
    await db.close();
  }
});
