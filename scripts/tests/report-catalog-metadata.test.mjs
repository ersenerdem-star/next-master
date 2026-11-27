import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../../supabase/migrations/20261127142147_report_catalog_metadata.sql', import.meta.url), 'utf8');
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const brand='33333333-3333-4333-8333-333333333333',actor='44444444-4444-4444-8444-444444444444';
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;

async function fixture(t) {
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;end$$;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function public.current_profile_org_id() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
    create function public.is_superadmin() returns boolean language sql stable as $$select coalesce(current_setting('test.super',true),'')='true'$$;
    create function public.profile_has_permission(p text) returns boolean language sql stable as $$select p='reports.view' and coalesce(current_setting('test.reports',true),'')='true'$$;
    create function public.normalize_catalog_product_code(p text) returns text language sql immutable as $$select upper(regexp_replace(btrim(coalesce(p,'')),'[[:space:]]+','','g'))$$;
    create table public.brands(id uuid,organization_id uuid,name text);
    create table public.catalog_products(id uuid,organization_id uuid,brand_id uuid,product_code text,description text,oem_no text,hs_code text,origin text,weight_kg numeric);
    insert into public.brands values('${brand}','${org}','Mann'),('${id(999)}','${other}','Other');
    select set_config('test.uid','${actor}',false),set_config('test.org','${org}',false),set_config('test.reports','true',false);
  `);
  await db.exec(migration);
  return db;
}

test('visible-price catalog data matches exact brand and raw part identity, never arbitrary duplicates',async t=>{
  const db=await fixture(t);
  await db.query(`insert into catalog_products values
    ($1,$5,$6,'W11025','Oil Filter','23658092','84212300','DE',1.128),
    ($2,$5,$6,'00/123','Slash',null,null,null,null),
    ($3,$5,$6,'00123','Plain',null,null,null,null),
    ($4,$5,$6,'DUPE','First',null,null,null,null),
    ($7,$5,$6,'dupe','Second',null,null,null,null),
    ($8,$9,$10,'W11025','Other organization',null,null,null,null)
    `,[id(1),id(2),id(3),id(4),org,brand,id(5),id(6),other,id(999)]);
  const result=(await db.query(`select public.report_supplier_catalog_metadata($1,$2::text[]) as rows`,[brand,['w11025','00/123','00123','DUPE','missing']])).rows[0].rows;
  assert.equal(result.length,3);
  assert.deepEqual(result.map(x=>[x.input_code,x.description]),[['00/123','Slash'],['00123','Plain'],['w11025','Oil Filter']]);
  assert.equal(result[2].oem_no,'23658092');assert.equal(result[2].origin,'DE');assert.equal(Number(result[2].weight_kg),1.128);
});

test('report permission and input boundaries are enforced',async t=>{
  const db=await fixture(t);
  assert.deepEqual((await db.query(`select public.report_supplier_catalog_metadata($1,$2::text[]) as rows`,[brand,[]])).rows[0].rows,[]);
  await assert.rejects(db.query(`select public.report_supplier_catalog_metadata($1,$2::text[])`,[brand,Array(51).fill('X')]),/SUPPLIER_COMPARISON_INPUT_INVALID/);
  await assert.rejects(db.query(`select public.report_supplier_catalog_metadata($1,$2::text[])`,[id(999),['W11025']]),/SUPPLIER_COMPARISON_BRAND_INVALID/);
  await db.exec(`select set_config('test.reports','false',false)`);
  await assert.rejects(db.query(`select public.report_supplier_catalog_metadata($1,$2::text[])`,[brand,['W11025']]),/SUPPLIER_COMPARISON_ACCESS_DENIED/);
  await db.exec(`set role anon`);
  await assert.rejects(db.query(`select public.report_supplier_catalog_metadata($1,$2::text[])`,[brand,['W11025']]),/permission denied/);
});
