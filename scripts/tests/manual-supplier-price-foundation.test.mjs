import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('manual price writes are authorized, tenant-scoped, audited and do not alter publications',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
   create schema auth;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
   create table organizations(id uuid primary key);create table profiles(id uuid primary key);
   create table suppliers(id uuid primary key,organization_id uuid,is_active boolean);
   create table brands(id uuid primary key,organization_id uuid);
   create table supplier_price_source_versions(organization_id uuid,brand_id uuid,source_revision bigint,updated_at timestamptz,primary key(organization_id,brand_id));
   create table supplier_price_publications(id uuid primary key);
   create table supplier_current_price_pointers(organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid);
   create function public.current_profile_org_id() returns uuid language sql as $$select nullif(current_setting('test.org',true),'')::uuid$$;
   create function public.is_superadmin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'')='yes'$$;
   create function public.current_profile_role() returns text language sql as $$select 'viewer'::text$$;
   create function public.profile_has_permission(text) returns boolean language sql as $$select false$$;
   create function public.normalize_catalog_product_code(text) returns text language sql immutable as $$select upper(regexp_replace(trim($1),'[[:space:]]+','','g'))$$;`);
  await db.exec((await readFile('supabase/migrations/20261112125119_manual_supplier_price_overlay.sql','utf8')).split('-- Exact, active manual prices')[0]);
  await db.query('insert into organizations values ($1),($2)',[id(1),id(2)]);
  await db.query('insert into profiles values ($1)',[id(3)]);
  await db.query('insert into suppliers values ($1,$2,true),($3,$4,true)',[id(4),id(1),id(5),id(2)]);
  await db.query('insert into brands values ($1,$2)',[id(6),id(1)]);
  await db.query('insert into supplier_current_price_pointers values ($1,$2,$3,$4)',[id(1),id(4),id(6),id(7)]);
  await db.query("select set_config('test.actor',$1,false),set_config('test.org',$2,false),set_config('test.admin','no',false)",[id(3),id(1)]);
  const save=(supplier,price)=>db.query('select public.save_manual_supplier_price($1,$2,$3,$4,$5)',[supplier,id(6),'2004336240',price,'2026-11-12']);
  await assert.rejects(save(id(4),6.46),/ADMIN_REQUIRED/);
  await db.query("select set_config('test.admin','yes',false)");
  await assert.rejects(save(id(5),6.46),/SCOPE_INVALID/);
  await assert.rejects(save(id(4),0),/INPUT_INVALID/);
  await save(id(4),6.46); await save(id(4),7.00);
  assert.equal((await db.query('select count(*)::int n from supplier_manual_price_internal.entries')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from supplier_manual_price_internal.events')).rows[0].n,2);
  assert.equal((await db.query('select source_revision::int n from supplier_price_source_versions')).rows[0].n,2);
  assert.equal((await db.query('select release_id from supplier_current_price_pointers')).rows[0].release_id,id(7));
  assert.equal((await db.query("select has_table_privilege('authenticated','supplier_manual_price_internal.entries','select') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});
