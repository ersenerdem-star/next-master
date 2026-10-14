import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const activeGuard = migration('20261013140020_sales_order_active_customer_pricing_guard.sql');
const marginGuard = migration('20261013140022_sales_order_confirmed_current_margin_guard.sql');
const forwardFix = migration('20261014123941_sales_order_historical_operational_edit.sql');
const org = '10000000-0000-4000-8000-000000000001';
const customer = '20000000-0000-4000-8000-000000000001';
const otherCustomer = '20000000-0000-4000-8000-000000000002';

async function database(t, { fixed = true, ambiguous = false, status = 'confirmed', bound = false } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role service_role; create role authenticated; create role anon;
    create table public.organizations(id uuid primary key);
    create table public.customers(id uuid primary key, organization_id uuid,
      display_name text, company_name text, price_list_type text,
      price_list_margin_percent numeric, custom_fields text);
    create table public.customer_price_lists(id uuid primary key, organization_id uuid,
      list_type text, margin_percent numeric, is_active boolean,
      updated_at timestamptz, created_at timestamptz);
    create table public.sales_orders(id text primary key, organization_id uuid,
      customer_id uuid, customer_name text, customer_type text, status text,
      notes text, portal_seen_at timestamptz, updated_at timestamptz,
      confirmed_at timestamptz, lines jsonb);
    create function public.current_profile_org_id() returns uuid language sql
      as $$select '${org}'::uuid$$;
    create function public.current_profile_role() returns text language sql as $$select 'admin'::text$$;
    create function public.is_superadmin() returns boolean language sql as $$select false$$;
    insert into public.organizations values ('${org}');
    insert into public.customers values
      ('${customer}','${org}','Historical account','','A',null,''),
      ('${otherCustomer}','${org}','${ambiguous ? 'Historical account' : 'Other account'}','','A',null,'');
    insert into public.customer_price_lists values
      ('30000000-0000-4000-8000-000000000001','${org}','A',10,true,now(),now());
  `);
  // Seed a genuine pre-migration shape: old 20% line price, today's A margin 10%.
  await db.query(`insert into public.sales_orders
    (id,organization_id,customer_id,customer_name,customer_type,status,notes,lines)
    values ('historical',$1,$2,'Historical account','A',$3,'original note',
      '[{"buy_price":10,"sell_price":12}]')`, [org, bound ? customer : null, status]);
  await db.exec(activeGuard);
  await db.exec(marginGuard);
  if (fixed) await db.exec(forwardFix);
  return db;
}

const snapshot = async db => (await db.query('select to_jsonb(so) as value from public.sales_orders so where id=$1', ['historical'])).rows[0].value;
const commercial = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['notes','portal_seen_at','updated_at'].includes(key)));

async function upsert(db, { notes = 'upsert note', sell = 12, name = 'Historical account', bind = null } = {}) {
  return db.query(`insert into public.sales_orders
    (id,organization_id,customer_id,customer_name,customer_type,status,notes,lines)
    values ('historical',$1,$2,$3,'A','confirmed',$4,$5::jsonb)
    on conflict (id) do update set
      customer_id=excluded.customer_id, customer_name=excluded.customer_name,
      customer_type=excluded.customer_type, status=excluded.status,
      notes=excluded.notes, lines=excluded.lines`,
  [org, bind, name, notes, JSON.stringify([{ buy_price:10, sell_price:sell }])]);
}

test('actual old guards reproduce the notes regression; the forward fix preserves unbound identity and old prices', async t => {
  const db = await database(t, { fixed:false });
  const before = await snapshot(db);
  await assert.rejects(db.exec("update public.sales_orders set notes='note only' where id='historical'"), /margin changed/);
  assert.deepEqual(await snapshot(db), before);
  await db.exec(forwardFix);
  await db.exec("update public.sales_orders set notes='note only',portal_seen_at=now(),updated_at=now() where id='historical'");
  const after = await snapshot(db);
  assert.equal(after.notes, 'note only');
  assert.equal(after.customer_id, null);
  assert.deepEqual(commercial(after), commercial(before));
  await upsert(db);
  assert.equal((await snapshot(db)).customer_id, null);
  assert.deepEqual(commercial(await snapshot(db)), commercial(before));
});

test('changed commercial lines still bind a unique account and require the current margin, including upserts', async t => {
  const db = await database(t);
  await assert.rejects(db.exec(`update public.sales_orders set lines='[{"buy_price":10,"sell_price":13}]' where id='historical'`), /margin changed/);
  await assert.rejects(upsert(db, { sell:13 }), /margin changed/);
  assert.equal((await snapshot(db)).customer_id, null);
  await upsert(db, { sell:11 });
  assert.equal((await snapshot(db)).customer_id, customer);
  assert.equal((await snapshot(db)).lines[0].sell_price, 11);
});

test('ambiguous old account stays unbound for notes and requires explicit resolution for commercial edits', async t => {
  const db = await database(t, { ambiguous:true });
  await db.exec("update public.sales_orders set notes='legacy ambiguous note' where id='historical'");
  await upsert(db);
  assert.equal((await snapshot(db)).customer_id, null);
  await assert.rejects(upsert(db, { sell:11 }), /exactly one account/);
  await upsert(db, { sell:11, bind:customer });
  assert.equal((await snapshot(db)).customer_id, customer);
});

test('confirming an old draft remains a commercial write and cannot keep stale prices', async t => {
  const db = await database(t, { status:'draft' });
  await db.exec("update public.sales_orders set notes='draft note' where id='historical'");
  assert.equal((await snapshot(db)).customer_id, null);
  await assert.rejects(db.exec("update public.sales_orders set status='confirmed',confirmed_at=now() where id='historical'"), /margin changed/);
  await db.exec(`update public.sales_orders set status='confirmed',confirmed_at=now(),lines='[{"buy_price":10,"sell_price":11}]' where id='historical'`);
  assert.equal((await snapshot(db)).customer_id, customer);
});

test('identity and tenant changes cannot use the operational-only exception', async t => {
  const db = await database(t);
  await assert.rejects(upsert(db, { bind:otherCustomer }), /name does not match/);
  await assert.rejects(db.exec(`update public.sales_orders set organization_id='10000000-0000-4000-8000-000000000099',notes='forged' where id='historical'`), /outside the active staff scope/);
  await assert.rejects(upsert(db, { name:'Other account' }), /margin changed/);
  await upsert(db, { name:'Other account', sell:11 });
  assert.equal((await snapshot(db)).customer_id, otherCustomer);
});

test('bound historical notes survive current account changes without permitting commercial profile forgery', async t => {
  const db = await database(t, { bound:true });
  const before = commercial(await snapshot(db));
  await db.query("update public.customers set price_list_type='B' where id=$1", [customer]);
  await db.exec("update public.sales_orders set notes='historical snapshot retained' where id='historical'");
  assert.deepEqual(commercial(await snapshot(db)), before);
  await assert.rejects(db.exec(`update public.sales_orders set lines='[{"buy_price":10,"sell_price":11}]' where id='historical'`), /profile differs/);
});

test('migration replay does not rewrite rows or widen private trigger privileges', async t => {
  const db = await database(t);
  const before = await snapshot(db);
  await db.exec(forwardFix);
  assert.deepEqual(await snapshot(db), before);
  const privileges = (await db.query(`select p.prosecdef, p.proconfig,
    has_schema_privilege('authenticated',n.oid,'USAGE') as schema_access,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='sales_order_guard_private' and p.proname='guard_sales_order_active_customer_pricing'`)).rows[0];
  assert.deepEqual(privileges, { prosecdef:true, proconfig:['search_path=""'], schema_access:false,
    authenticated_execute:false, anon_execute:false, service_execute:false });
});
