import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('new vendor creates one supplier atomically without changing historical prices or existing identities', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated;
    create function public.normalize_part_code(input text) returns text language sql immutable as $$
      select regexp_replace(upper(coalesce(input, '')), '[^A-Z0-9]', '', 'g') $$;
    create table public.vendors(id uuid primary key, organization_id uuid not null,
      display_name text not null default '', company_name text not null default '',
      first_name text not null default '', last_name text not null default '');
    create table public.suppliers(id uuid primary key default gen_random_uuid(), organization_id uuid not null,
      name text not null, normalized_name text generated always as (public.normalize_part_code(name)) stored,
      is_active boolean not null default true, price_usage_enabled boolean not null default true,
      unique (organization_id, normalized_name));
    create table public.old_purchase_orders(id integer primary key, vendor_id uuid, supplier_name text, cost numeric);
    insert into public.suppliers(id,organization_id,name,is_active,price_usage_enabled) values
      ('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000001','GroupAuto',false,false),
      ('00000000-0000-0000-0000-000000000098','00000000-0000-0000-0000-000000000001','Ab-C',true,true);
    insert into public.old_purchase_orders values (1,null,'GroupAuto',99.95);
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261121121955_vendor_supplier_create_sync.sql', import.meta.url), 'utf8'));
  const org='00000000-0000-0000-0000-000000000001'; const org2='00000000-0000-0000-0000-000000000002';
  const add=(id,organization,name)=>db.query('insert into public.vendors(id,organization_id,display_name) values ($1,$2,$3)',[id,organization,name]);
  const rows=(sql,params=[])=>db.query(sql,params).then(x=>x.rows);
  await add('00000000-0000-0000-0000-000000000101',org,'Leyo');
  assert.deepEqual(await rows('select name,is_active,price_usage_enabled from public.suppliers where organization_id=$1 and name=$2',[org,'Leyo']),[{name:'Leyo',is_active:true,price_usage_enabled:true}]);
  await add('00000000-0000-0000-0000-000000000102',org,'GroupAuto');
  assert.deepEqual(await rows("select id,name,is_active,price_usage_enabled from public.suppliers where name='GroupAuto'"),[{id:'00000000-0000-0000-0000-000000000099',name:'GroupAuto',is_active:false,price_usage_enabled:false}]);
  assert.deepEqual(await rows('select * from public.old_purchase_orders'),[{id:1,vendor_id:null,supplier_name:'GroupAuto',cost:'99.95'}]);
  await assert.rejects(()=>add('00000000-0000-0000-0000-000000000103',org,'LE-YO'), /same supplier identity already exists/);
  assert.equal((await rows("select count(*)::int as n from public.vendors where display_name='LE-YO'"))[0].n,0);
  await assert.rejects(()=>add('00000000-0000-0000-0000-000000000104',org,'Group Auto'), /same supplier identity already exists/);
  await assert.rejects(()=>add('00000000-0000-0000-0000-000000000106',org,'ABC'), /supplier with a similar name already exists/);
  assert.equal((await rows("select count(*)::int as n from public.vendors where display_name='ABC'"))[0].n,0);
  await add('00000000-0000-0000-0000-000000000105',org2,'Leyo');
  assert.equal((await rows("select count(*)::int as n from public.suppliers where name='Leyo'"))[0].n,2);
  await db.exec("update public.vendors set display_name='Leyo changed' where id='00000000-0000-0000-0000-000000000101'");
  assert.deepEqual(await rows('select name from public.suppliers where organization_id=$1 and name=$2',[org,'Leyo']),[{name:'Leyo'}]);
  await db.exec("delete from public.vendors where id='00000000-0000-0000-0000-000000000101'");
  assert.equal((await rows('select count(*)::int as n from public.suppliers where organization_id=$1 and name=$2',[org,'Leyo']))[0].n,1);
});
