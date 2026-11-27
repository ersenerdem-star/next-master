import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../../supabase/migrations/20261127101916_report_supplier_comparison_offers.sql', import.meta.url), 'utf8');
const org='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const brand='33333333-3333-4333-8333-333333333333';
const actor='44444444-4444-4444-8444-444444444444';
const id=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;

async function fixture(t) {
  let db;
  if (process.env.TEST_POSTGRES_URL) {
    const {default:pg}=await import('pg');
    const admin=new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();
    const database='report_offers_'+Math.random().toString(36).slice(2);await admin.query(`create database ${database}`);
    const url=new URL(process.env.TEST_POSTGRES_URL);url.pathname='/'+database;
    const client=new pg.Client({connectionString:url.toString()});await client.connect();
    t.after(async()=>{await client.end();await admin.query(`drop database ${database}`);await admin.end();});
    db={exec:(sql)=>client.query(sql),query:(sql,args)=>client.query(sql,args)};
  } else {db=new PGlite();t.after(()=>db.close());}
  await db.exec(`do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;end$$;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function public.current_profile_org_id() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
    create function public.is_superadmin() returns boolean language sql stable as $$select coalesce(current_setting('test.super',true),'')='true'$$;
    create function public.profile_has_permission(p text) returns boolean language sql stable as $$select p='reports.view' and coalesce(current_setting('test.reports',true),'')='true'$$;
    create function public.normalize_catalog_product_code(p text) returns text language sql immutable as $$select upper(regexp_replace(btrim(coalesce(p,'')),'[[:space:]]+','','g'))$$;
    create function public.normalize_part_code(p text) returns text language sql immutable as $$select regexp_replace(upper(coalesce(p,'')),'[^A-Z0-9]','','g')$$;
    create table public.brands(id uuid,organization_id uuid,name text);
    create table public.suppliers(id uuid,organization_id uuid,name text,price_usage_enabled boolean);
    create table public.supplier_current_price_pointers(organization_id uuid,brand_id uuid,supplier_id uuid,release_id uuid,publication_id uuid);
    create table public.supplier_price_publications(id uuid,release_id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,status text);
    create table public.supplier_price_release_rows(id uuid,release_id uuid,normalized_code text,product_code text,buy_price numeric,valid_from date,notes text,moq integer,order_multiple integer,stock_qty integer,valid_to date,row_status text,currency text);
    create table public.supplier_prices(id uuid,organization_id uuid,brand_id uuid,supplier_id uuid,normalized_code text,product_code text,buy_price numeric,valid_from date,notes text,moq integer,order_multiple integer,stock_qty integer,valid_to date,is_active boolean,currency text);
    create schema supplier_manual_price_internal;
    create table supplier_manual_price_internal.entries(id uuid,organization_id uuid,brand_id uuid,supplier_id uuid,product_code text,exact_code text,buy_price numeric,valid_from date,notes text,moq integer,order_multiple integer,active boolean);
    create function public.supplier_price_usage_enabled(o uuid,s uuid) returns boolean language sql stable as $$select coalesce((select price_usage_enabled from public.suppliers where organization_id=o and id=s),false)$$;
    insert into public.brands values('${brand}','${org}','Mann'),('${id(999)}','${other}','Other');
    select set_config('test.uid','${actor}',false),set_config('test.org','${org}',false),set_config('test.reports','true',false);
  `);
  await db.exec(migration);
  return db;
}

test('all offers preserve exact part identity, current supplier scope and manual overrides past 25 results',async t=>{
  const db=await fixture(t);
  for(let n=1;n<=30;n++){
    const supplier=id(n),row=id(100+n);
    await db.query(`insert into suppliers values($1,$2,$3,true)`,[supplier,org,`Supplier ${n}`]);
    await db.query(`insert into supplier_prices values($1,$2,$3,$4,'00123','00/123',$5,'2026-01-01',null,1,1,10,null,true,'EUR')`,[row,org,brand,supplier,n]);
  }
  // A manual value overrides the matching supplier/SKU; another SKU and a
  // disabled supplier must never leak into the requested row.
  await db.query(`insert into supplier_manual_price_internal.entries values($1,$2,$3,$4,'00/123','00/123',0.5,'2026-01-01','Manual',2,1,true)`,[id(300),org,brand,id(30)]);
  await db.query(`insert into suppliers values($1,$2,'Disabled',false)`,[id(40),org]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,'00123','00/123',0.1,'2026-01-01',null,1,1,null,null,true,'EUR')`,[id(400),org,brand,id(40)]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,'00123','00123',0.01,'2026-01-01',null,1,1,null,null,true,'EUR')`,[id(401),org,brand,id(1)]);
  await db.query(`update supplier_prices set stock_qty=0 where supplier_id=$1`,[id(2)]);
  await db.query(`insert into suppliers values($1,$2,'Future',true),($3,$2,'Expired',true)`,[id(41),org,id(42)]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,'00123','00/123',0.2,current_date+1,null,1,1,null,null,true,'EUR'),($5,$2,$3,$6,'00123','00/123',0.3,'2026-01-01',null,1,1,null,current_date-1,true,'EUR')`,[id(402),org,brand,id(41),id(403),id(42)]);
  const {rows}=await db.query(`select * from public.report_supplier_comparison_offers($1,$2)`,[brand,'00/123']);
  assert.equal(rows.length,30);assert.equal(rows[0].supplier_name,'Supplier 30');assert.equal(Number(rows[0].buy_price),0.5);
  assert.equal(rows[0].notes,'Manual');assert.equal(rows[0].moq,2);assert.equal(rows.at(-1).supplier_name,'Supplier 29');
  assert.equal(rows.find(r=>r.supplier_name==='Supplier 2').stock_qty,0,'zero stock remains an explicit value and does not hide the offer');
  assert.equal(rows.filter(r=>r.supplier_name==='Supplier 30').length,1);
  assert.ok(!rows.some(r=>r.supplier_name==='Disabled'));
  assert.deepEqual((await db.query(`select * from public.report_supplier_comparison_offers($1,$2)`,[brand,'00123'])).rows.map(x=>Number(x.buy_price)),[0.01]);
});

test('published pointers fence legacy and tenant/role access are enforced',async t=>{
  const db=await fixture(t), supplier=id(1), release=id(501), publication=id(502);
  await db.query(`insert into suppliers values($1,$2,'Publisher',true)`,[supplier,org]);
  await db.query(`insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)`,[org,brand,supplier,release,publication]);
  await db.query(`insert into supplier_price_publications values($1,$2,$3,$4,$5,'published')`,[publication,release,org,supplier,brand]);
  await db.query(`insert into supplier_price_release_rows values($1,$2,'PART','PART',9,'2026-01-01','listed',1,1,4,null,'accepted','EUR')`,[id(503),release]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,'PART','PART',1,'2026-01-01',null,1,1,4,null,true,'EUR')`,[id(504),org,brand,supplier]);
  assert.equal(Number((await db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand])).rows[0].buy_price),9);
  await db.query(`insert into supplier_manual_price_internal.entries values($1,$2,$3,$4,'PART','PART',8,'2026-01-01','manual override',1,1,true)`,[id(505),org,brand,supplier]);
  const before=(await db.query(`select row_to_json(x) as row from (select (select count(*) from supplier_prices) l,(select count(*) from supplier_manual_price_internal.entries) m,(select count(*) from supplier_current_price_pointers) p) x`)).rows;
  const overridden=(await db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand])).rows;
  assert.equal(overridden.length,1);assert.equal(Number(overridden[0].buy_price),8);assert.equal(overridden[0].notes,'manual override');
  const after=(await db.query(`select row_to_json(x) as row from (select (select count(*) from supplier_prices) l,(select count(*) from supplier_manual_price_internal.entries) m,(select count(*) from supplier_current_price_pointers) p) x`)).rows;
  assert.deepEqual(after,before,'a report read does not change prices or publication pointers');
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[id(999)]),/SUPPLIER_COMPARISON_BRAND_INVALID/);
  await db.exec(`select set_config('test.reports','false',false)`);
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand]),/SUPPLIER_COMPARISON_ACCESS_DENIED/);
  await db.exec(`select set_config('test.uid','',false),set_config('test.super','true',false)`);
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand]),/SUPPLIER_COMPARISON_ACCESS_DENIED/);
});
