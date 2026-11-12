import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const source = await readFile(new URL('../../supabase/migrations/20261013140016_supplier_price_exact_sku_lookup.sql', import.meta.url), 'utf8');
const baseline = source.match(/create or replace function public\.cloud_resolve_quote_line_v3\([\s\S]*?\n\$function\$;/i)?.[0];
assert.ok(baseline, 'the deployed resolver baseline must be extracted from its migration');
const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationsDir)).filter(name => name.endsWith('_quote_resolver_live_catalog_metadata.sql'));
assert.equal(migrationFiles.length, 1, 'exactly one live-catalog overlay migration must exist');
const migration = await readFile(new URL(migrationFiles[0], migrationsDir), 'utf8');
const org = '10000000-0000-4000-8000-000000000001';
const otherOrg = '10000000-0000-4000-8000-000000000002';
const user = '20000000-0000-4000-8000-000000000001';
const bosch = '30000000-0000-4000-8000-000000000001';
const sachs = '30000000-0000-4000-8000-000000000002';
const otherBrand = '30000000-0000-4000-8000-000000000003';
const gnk = '40000000-0000-4000-8000-000000000001';
const romany = '40000000-0000-4000-8000-000000000002';
const product = '50000000-0000-4000-8000-000000000001';
const secondProduct = '50000000-0000-4000-8000-000000000002';
const code = '0445120385';
const signature = 'public.cloud_resolve_quote_line_v3(text,text,text,numeric,numeric)';

async function fixture(t, { apply = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('test.uid', true), '')::uuid
    $$;
    create function public.current_profile_org_id() returns uuid language sql as $$
      select nullif(current_setting('test.org', true), '')::uuid
    $$;
    create function public.normalize_part_code(input text) returns text language sql immutable as $$
      select regexp_replace(upper(coalesce(input, '')), '[^A-Z0-9]', '', 'g')
    $$;
    create table public.catalog_products (
      id uuid primary key, organization_id uuid not null, brand_id uuid not null,
      product_code text not null,
      normalized_code text generated always as (public.normalize_part_code(product_code)) stored,
      description text, oem_no text, hs_code text, origin text, weight_kg numeric,
      updated_at timestamptz default '2026-11-09T12:00:00Z',
      unique (organization_id, brand_id, normalized_code)
    );
    create table public.price_fixture (
      id bigint generated always as identity primary key,
      organization_id uuid not null, brand_id uuid not null, brand text not null,
      product_code text not null, description text, supplier_id uuid not null,
      supplier_name text not null, buy_price numeric not null,
      price_date date default '2026-11-01', notes text default 'Saved supplier terms'
    );
    -- Only the existing current-price bridge is substituted. Selection remains
    -- exact and bounded to the caller's organization/brand; the real V3 body,
    -- migration, authorization and financial expressions execute in Postgres.
    create function public.cloud_current_supplier_price_options(input_code text, input_brand text)
    returns table(supplier_id uuid, supplier_name text, brand_id uuid, brand text,
      product_code text, description text, buy_price numeric, price_date date, notes text)
    language sql stable as $$
      select p.supplier_id, p.supplier_name, p.brand_id, p.brand, p.product_code,
        p.description, p.buy_price, p.price_date, p.notes
      from public.price_fixture p
      where p.organization_id = public.current_profile_org_id()
        and public.normalize_part_code(p.brand) = public.normalize_part_code(input_brand)
        and upper(regexp_replace(btrim(p.product_code), '[[:space:]]+', '', 'g')) =
            upper(regexp_replace(btrim(input_code), '[[:space:]]+', '', 'g'))
        and p.buy_price > 0
      order by p.buy_price, p.price_date desc, p.supplier_id limit 25
    $$;
    create table public.sales_orders(id text primary key, organization_id uuid, status text, lines jsonb);
    create table public.purchase_orders(id text primary key, organization_id uuid, status text, lines jsonb);
    select set_config('test.uid', '${user}', false), set_config('test.org', '${org}', false);
  `);
  const catalog = async (changes = {}) => {
    const r = { id: product, organization_id: org, brand_id: bosch, product_code: code,
      description: 'Injector Nozzle', oem_no: 'OEM-EXACT', hs_code: '840999', origin: 'DE', weight_kg: 1.13, ...changes };
    await db.query(`insert into public.catalog_products
      (id,organization_id,brand_id,product_code,description,oem_no,hs_code,origin,weight_kg)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, Object.values(r));
  };
  const price = async (changes = {}) => {
    const r = { organization_id: org, brand_id: bosch, brand: 'Bosch', product_code: code,
      description: null, supplier_id: gnk, supplier_name: 'GNK', buy_price: 308.08, ...changes };
    await db.query(`insert into public.price_fixture
      (organization_id,brand_id,brand,product_code,description,supplier_id,supplier_name,buy_price)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, Object.values(r));
  };
  await price();
  await price({ supplier_id: romany, supplier_name: 'Romany', buy_price: 350, description: 'Old supplier description' });
  await price({ organization_id: otherOrg, buy_price: 1, description: 'Other organization' });
  await price({ brand_id: otherBrand, brand: 'Other', buy_price: 2, description: 'Other brand' });
  await catalog();
  const historicalLine = JSON.stringify([{ product_code: code, description: null, qty: 48, supplier_name: 'GNK', buy_price: 308.08, sell_price: 338.89 }]);
  await db.query("insert into public.sales_orders values('existing-sales',$1,'confirmed',$2::jsonb)", [org, historicalLine]);
  await db.query("insert into public.purchase_orders values('existing-purchase',$1,'open',$2::jsonb)", [org, historicalLine]);
  await db.exec(baseline);
  await db.exec(`revoke all on function ${signature} from public, anon;
    grant execute on function ${signature} to authenticated, service_role;`);
  if (apply) await db.exec(migration);
  const resolve = async (requested = code, brand = 'Bosch', type = 'A', a = 0.10, b = 0.15) =>
    (await db.query('select * from public.cloud_resolve_quote_line_v3($1,$2,$3,$4,$5)', [requested, brand, type, a, b])).rows;
  const snapshot = async () => (await db.query(`select
    (select jsonb_agg(to_jsonb(x) order by id) from public.catalog_products x) catalog,
    (select jsonb_agg(to_jsonb(x) order by id) from public.price_fixture x) prices,
    (select jsonb_agg(to_jsonb(x) order by id) from public.sales_orders x) sales,
    (select jsonb_agg(to_jsonb(x) order by id) from public.purchase_orders x) purchases`)).rows[0];
  return { db, resolve, catalog, price, snapshot };
}

const commercial = row => Object.fromEntries(['found', 'product_code', 'brand', 'supplier_id', 'supplier_name', 'buy_price', 'price_date', 'sell_price', 'notes'].map(key => [key, row[key]]));

test('reported Bosch line gains live catalog details while exact supplier selection, zeros and prices remain unchanged', async t => {
  const { db, resolve } = await fixture(t, { apply: false });
  assert.equal((await db.query(`select md5(pg_get_functiondef('${signature}'::regprocedure)) hash`)).rows[0].hash, 'e13b82634667de5ba04f1f70ba47d787');
  const before = (await resolve())[0];
  assert.equal(before.description, null);
  assert.equal(before.product_id, null);
  assert.equal(Number(before.buy_price), 308.08);
  assert.equal(Number(before.sell_price), 338.89);
  await db.exec(migration);
  const after = (await resolve())[0];
  assert.deepEqual(commercial(after), commercial(before));
  assert.equal(after.product_code, '0445120385');
  assert.equal(after.product_id, product);
  assert.equal(after.description, 'Injector Nozzle');
  assert.equal(after.oem_no, 'OEM-EXACT');
  assert.equal(after.hs_code, '840999');
  assert.equal(after.origin, 'DE');
  assert.equal(Number(after.weight_kg), 1.13);
});

test('stale supplier descriptions are overlaid immediately after each catalog update without refreshing prices', async t => {
  const { db, resolve } = await fixture(t);
  for (const stale of [code, '-', 'Old supplier injector name']) {
    await db.query('update public.price_fixture set description=$1 where organization_id=$2 and supplier_id=$3', [stale, org, gnk]);
    assert.equal((await resolve())[0].description, 'Injector Nozzle');
  }
  const before = commercial((await resolve())[0]);
  await db.query("update public.catalog_products set description=E'  Updated Injector Nozzle\\t', origin='JP', weight_kg=0, hs_code='840991', oem_no='NEW-OEM' where id=$1", [product]);
  const after = (await resolve())[0];
  assert.equal(after.description, 'Updated Injector Nozzle');
  assert.equal(after.origin, 'JP');
  assert.equal(Number(after.weight_kg), 0);
  assert.equal(after.hs_code, '840991');
  assert.equal(after.oem_no, 'NEW-OEM');
  assert.deepEqual(commercial(after), before);
  assert.equal(Number((await resolve(code, 'Bosch', 'B'))[0].sell_price), 354.29);
  assert.equal(Number((await resolve(code, 'Bosch', 'A', null))[0].sell_price), 308.08);
});

test('metadata identity includes organization and exact brand rather than compact code alone', async t => {
  const { db, resolve, catalog } = await fixture(t);
  await db.query('delete from public.catalog_products');
  await catalog({ organization_id: otherOrg, description: 'Secret other organization' });
  await catalog({ id: secondProduct, brand_id: otherBrand, description: 'Wrong brand' });
  const row = (await resolve())[0];
  assert.equal(row.product_id, null);
  assert.equal(row.description, null);
  assert.equal(row.origin, null);
  assert.equal(Number(row.buy_price), 308.08);
  await catalog({ id: '50000000-0000-4000-8000-000000000003' });
  assert.equal((await resolve())[0].description, 'Injector Nozzle');
});

test('slash and other punctuation collisions never borrow catalog metadata, and whitespace does not change identity', async t => {
  const { db, resolve, catalog, price } = await fixture(t);
  await db.query('delete from public.catalog_products');
  await catalog({ product_code: '611', description: 'Compact sibling' });
  for (const requested of ['61/1', '61-1']) {
    await price({ product_code: requested, description: `Supplier ${requested}` });
    const row = (await resolve(requested))[0];
    assert.equal(row.product_id, null);
    assert.equal(row.description, `Supplier ${requested}`);
    assert.equal(row.product_code, requested);
  }
  await price({ product_code: '611' });
  assert.equal((await resolve('611'))[0].description, 'Compact sibling');
  await db.query('delete from public.catalog_products');
  await catalog({ product_code: '0 445 120 385' });
  const spaced = (await resolve(' 0 445 120 385 '))[0];
  assert.equal(spaced.description, 'Injector Nozzle');
  assert.equal(spaced.product_code, code);
  await db.query('delete from public.catalog_products');
  await catalog({ product_code: '445120385', description: 'Missing leading zero' });
  assert.equal((await resolve())[0].product_id, null);
});

test('only the approved SACHS six-digit 3+3 dot separator aliases a compact article', async t => {
  const { db, resolve, catalog, price } = await fixture(t);
  await db.query('delete from public.catalog_products');
  await price({ brand_id: sachs, brand: 'Sachs', product_code: '311409', description: 'Supplier Sachs name' });
  await catalog({ brand_id: sachs, product_code: '311.409', description: 'Shock Absorber' });
  const sachsRow = (await resolve('311409', 'Sachs'))[0];
  assert.equal(sachsRow.description, 'Shock Absorber');
  assert.equal(sachsRow.product_code, '311409');
  await db.query("update public.catalog_products set product_code='311409' where id=$1", [product]);
  await price({ brand_id: sachs, brand: 'Sachs', product_code: '311.409' });
  assert.equal((await resolve('311.409', 'Sachs'))[0].description, 'Shock Absorber');
  for (const [brand, brandId, catalogCode, priceCode] of [
    ['Other', otherBrand, '311.409', '311409'],
    ['Sachs', sachs, '311/409', '311409'],
    ['Sachs', sachs, '2294.001.234', '2294001234'],
    ['Sachs', sachs, '031.409', '31409'],
  ]) {
    await db.query('delete from public.catalog_products');
    await catalog({ brand_id: brandId, product_code: catalogCode, description: 'Must not borrow' });
    await price({ brand_id: brandId, brand, product_code: priceCode });
    assert.equal((await resolve(priceCode, brand))[0].product_id, null, `${brand} ${priceCode} vs ${catalogCode}`);
  }
});

test('blank, dash and code-only catalog descriptions retain the supplier fallback; absent catalog and prices keep baseline behavior', async t => {
  const { db, resolve, catalog } = await fixture(t);
  await db.query("update public.price_fixture set description='Useful supplier description' where organization_id=$1 and supplier_id=$2", [org, gnk]);
  for (const description of [null, '', ' \t\n ', '-', ' - ', code, '0 445 120 385', '0-445-120-385']) {
    await db.query('update public.catalog_products set description=$1 where id=$2', [description, product]);
    assert.equal((await resolve())[0].description, 'Useful supplier description');
  }
  await db.query('delete from public.catalog_products');
  const absentCatalog = (await resolve())[0];
  assert.equal(absentCatalog.product_id, null);
  assert.equal(absentCatalog.description, 'Useful supplier description');
  assert.equal(absentCatalog.weight_kg, null);
  await catalog({ product_code: '0000000999', description: 'Catalog-only product without a current price' });
  const notFound = (await resolve('0000000999'))[0];
  assert.equal(notFound.found, false);
  assert.equal(notFound.product_code, '0000000999');
  for (const key of ['product_id', 'description', 'supplier_id', 'buy_price', 'sell_price']) assert.equal(notFound[key], null);
});

test('migration and reads preserve historical documents, catalog rows, prices, authorization, grants and function security', async t => {
  const { db, resolve, snapshot } = await fixture(t, { apply: false });
  const properties = async () => (await db.query(`select oid, proowner, prosecdef, provolatile, proconfig, proacl::text,
    pg_get_function_identity_arguments(oid) arguments, pg_get_function_result(oid) result,
    pg_get_expr(proargdefaults,0) defaults from pg_proc where oid='${signature}'::regprocedure`)).rows[0];
  const before = await snapshot(), config = await properties();
  await db.exec(migration);
  assert.deepEqual(await properties(), config);
  await resolve(); await resolve(code, 'Bosch', 'B');
  assert.deepEqual(await snapshot(), before);
  for (const role of ['authenticated', 'service_role']) assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') allowed', [role, signature])).rows[0].allowed, true);
  assert.equal((await db.query('select has_function_privilege(\'anon\',$1,\'execute\') allowed', [signature])).rows[0].allowed, false);
  await db.exec('set role anon');
  await assert.rejects(resolve(), /permission denied/);
  await db.exec('reset role');
  await db.query("select set_config('test.uid','',false)");
  assert.deepEqual(await resolve(), []);
  await db.query("select set_config('test.uid',$1,false),set_config('test.org','',false)", [user]);
  assert.deepEqual(await resolve(), []);
});

test('an unexpected resolver baseline is rejected before modifying its definition or any data', async t => {
  const { db, snapshot } = await fixture(t, { apply: false });
  await db.exec(baseline.replace('  v_margin numeric;', '  v_margin numeric; -- unexpected deployed edit'));
  const definition = async () => (await db.query(`select pg_get_functiondef('${signature}'::regprocedure) source`)).rows[0].source;
  const beforeDefinition = await definition(), beforeData = await snapshot();
  await assert.rejects(db.exec(migration), /QUOTE_RESOLVER_CATALOG_BASELINE_CHANGED/);
  assert.equal(await definition(), beforeDefinition);
  assert.deepEqual(await snapshot(), beforeData);
});
