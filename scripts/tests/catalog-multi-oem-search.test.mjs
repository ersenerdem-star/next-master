import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('catalog search returns all tenant-scoped OE matches without changing exact SKU precedence', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role authenticated;
    create role service_role;
    create function public.current_profile_org_id() returns uuid language sql stable as $$
      select nullif(current_setting('test.org', true), '')::uuid
    $$;
    create function public.is_superadmin() returns boolean language sql stable as $$
      select coalesce(current_setting('test.superadmin', true), 'false') = 'true'
    $$;
    create function public.normalize_part_code(value text) returns text language sql immutable as $$
      select regexp_replace(upper(coalesce(value, '')), '[^A-Z0-9]', '', 'g')
    $$;
    create function public.normalize_catalog_market_segment(value text) returns text language sql immutable as $$
      select nullif(upper(trim(coalesce(value, ''))), '')
    $$;
    create table public.brands(id uuid primary key, organization_id uuid, name text, normalized_name text);
    create table public.catalog_products(
      id uuid primary key, organization_id uuid, brand_id uuid, product_code text, normalized_code text,
      normalized_oem text, search_text text, image_url text, market_segment text, description text, oem_no text,
      vehicle text, hs_code text, origin text, weight_kg numeric, ean text, lifecycle_status text, lifecycle_note text
    );
    create table public.catalog_product_identifiers(organization_id uuid, catalog_product_id uuid,
      identifier_type text, normalized_value text);
    create table public.catalog_product_integrity(organization_id uuid, product_id uuid, status text,
      critical_missing_fields text[], optional_missing_fields text[], conflict_fields text[],
      pending_conflict_count integer, last_evaluated_at timestamptz, last_error text);
    insert into public.brands values
      ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','TITANX','TITANX'),
      ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000001','OTHER','OTHER'),
      ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000002','TITANX','TITANX');
    insert into public.catalog_products(id, organization_id, brand_id, product_code, normalized_code, search_text, market_segment) values
      ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','CD119002','CD119002','cd119002','LKW'),
      ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','CX119002','CX119002','cx119002','LKW'),
      ('00000000-0000-0000-0000-000000000203','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','9405000454','9405000454','9405000454','LKW'),
      ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','OTHER-1','OTHER1','other-1','LKW'),
      ('00000000-0000-0000-0000-000000000205','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000103','FOREIGN','FOREIGN','foreign','LKW');
    insert into public.catalog_product_identifiers values
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000201','oem','9405000454'),
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000201','oem','9405000454'),
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000202','oem','9405000454'),
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000204','oem','9405000454'),
      ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000205','oem','9405000454'),
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000201','oem','000123');
    insert into public.catalog_product_integrity(organization_id,product_id,status) values
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000201','conflict'),
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000202','conflict');
    select set_config('test.org','00000000-0000-0000-0000-000000000001',false);
    select set_config('test.superadmin','true',false);
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261120144107_catalog_multi_oem_search.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261120144429_catalog_oe_search_plan_hotfix.sql', import.meta.url), 'utf8'));
  const query = (sql) => db.query(sql).then((result) => result.rows);
  const list = await query("select product_code, total_count from public.search_catalog_products('940 500 0454', 'TITANX', '', 1, 10)");
  assert.deepEqual(list.map((row) => row.product_code), ['9405000454', 'CD119002', 'CX119002']);
  assert.ok(list.every((row) => Number(row.total_count) === 3));
  const allBrands = await query("select product_code from public.search_catalog_products('940 500 0454', '', '', 1, 10)");
  assert.deepEqual(allBrands.map((row) => row.product_code), ['9405000454', 'CD119002', 'CX119002', 'OTHER-1']);
  const prefix = await query("select product_code from public.search_catalog_products('CD119', 'TITANX', '', 1, 10)");
  assert.deepEqual(prefix.map((row) => row.product_code), ['CD119002']);
  const browse = await query("select product_code from public.search_catalog_products('', 'TITANX', '', 1, 10)");
  assert.deepEqual(browse.map((row) => row.product_code), ['9405000454', 'CD119002', 'CX119002']);
  const page1 = await query("select product_code, has_more from public.cloud_catalog_integrity_page('9405000454', 'TITANX', '', '', 1, 2)");
  const page2 = await query("select product_code, has_more from public.cloud_catalog_integrity_page('9405000454', 'TITANX', '', '', 2, 2)");
  assert.deepEqual(page1.map((row) => row.product_code), ['9405000454', 'CD119002']);
  assert.ok(page1.every((row) => row.has_more));
  assert.deepEqual(page2.map((row) => row.product_code), ['CX119002']);
  assert.equal(page2[0].has_more, false);
  const conflicts = await query("select product_code from public.cloud_catalog_integrity_page('9405000454', 'TITANX', '', 'conflict', 1, 10)");
  assert.deepEqual(conflicts.map((row) => row.product_code), ['CD119002', 'CX119002']);
  const leadingZeros = await query("select product_code from public.search_catalog_products('000-123', 'TITANX', '', 1, 10)");
  assert.deepEqual(leadingZeros.map((row) => row.product_code), ['CD119002']);
  const noZeros = await query("select product_code from public.search_catalog_products('123', 'TITANX', '', 1, 10)");
  assert.deepEqual(noZeros, []);
  await db.exec("select set_config('test.superadmin','false',false)");
  await assert.rejects(() => query("select * from public.search_catalog_products('9405000454', 'TITANX', '', 1, 10)"), /Only active superadmin/);
});
