import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../../supabase/migrations/20261127102812_report_supplier_comparison_offers.sql', import.meta.url), 'utf8');
const lengthMigration = await readFile(new URL('../../supabase/migrations/20261127141934_supplier_comparison_length_consistency.sql', import.meta.url), 'utf8');
const exportMigration = await readFile(new URL('../../supabase/migrations/20261127115259_supplier_comparison_export_offers.sql', import.meta.url), 'utf8');
const exportNotesMigration = await readFile(new URL('../../supabase/migrations/20261127131813_supplier_comparison_export_notes.sql', import.meta.url), 'utf8');
const noteIndicatorMigration = await readFile(new URL('../../supabase/migrations/20261127141139_supplier_report_note_indicators.sql', import.meta.url), 'utf8');
const usageGateMigration = await readFile(new URL('../../supabase/migrations/20261127141137_supplier_manual_usage_gate_consistency.sql', import.meta.url), 'utf8');
const manualOverlayMigration = await readFile(new URL('../../supabase/migrations/20261112133448_manual_supplier_price_overlay.sql', import.meta.url), 'utf8');
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
  assert.deepEqual((await db.query(`select * from public.report_supplier_comparison_offers($1,'MISSING')`,[brand])).rows,[]);
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'')`,[brand]),/SUPPLIER_COMPARISON_INPUT_INVALID/);
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[id(999)]),/SUPPLIER_COMPARISON_BRAND_INVALID/);
  await db.exec(`set role authenticated`);
  assert.equal(Number((await db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand])).rows[0].buy_price),8);
  await db.exec(`reset role;set role anon`);
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand]),/permission denied/);
  await db.exec(`reset role`);
  await db.exec(`select set_config('test.reports','false',false)`);
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand]),/SUPPLIER_COMPARISON_ACCESS_DENIED/);
  await db.exec(`select set_config('test.uid','',false),set_config('test.super','true',false)`);
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,'PART')`,[brand]),/SUPPLIER_COMPARISON_ACCESS_DENIED/);
});

test('detail and note readers accept the same 256-character exact code without broadening access',async t=>{
  const db=await fixture(t); await db.exec(lengthMigration);
  const code='0'.repeat(254)+'/X';
  await db.query(`insert into suppliers values($1,$2,'Supplier',true)`,[id(1),org]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,$5,$6,5,current_date,'long code note',1,1,null,null,true,'EUR')`,[id(101),org,brand,id(1),code.replace('/',''),code]);
  const result=await db.query(`select * from public.report_supplier_comparison_offers($1,$2)`,[brand,code]);
  assert.equal(result.rows.length,1); assert.equal(result.rows[0].notes,'long code note');
  await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,$2)`,[brand,code+'X']),/INPUT_INVALID/);
  await db.exec(`set role anon`); await assert.rejects(db.query(`select * from public.report_supplier_comparison_offers($1,$2)`,[brand,code]),/permission denied/);
});

test('batch export preserves every current offer, original codes and isolates tenant and role',async t=>{
  const db=await fixture(t);
  await db.exec(`create function public.get_admin_price_list_export_version(uuid,uuid) returns text language sql stable as $$select 'v1'::text$$`);
  await db.exec(exportMigration);
  for(let n=1;n<=30;n++){
    const supplier=id(n);
    await db.query(`insert into suppliers values($1,$2,$3,true)`,[supplier,org,`Supplier ${n}`]);
    await db.query(`insert into supplier_prices values($1,$2,$3,$4,'00123','00/123',$5,current_date,null,1,1,null,null,true,'EUR')`,[id(100+n),org,brand,supplier,n]);
  }
  await db.query(`insert into supplier_manual_price_internal.entries values($1,$2,$3,$4,'00/123','00/123',0.5,current_date,null,1,1,true)`,[id(300),org,brand,id(30)]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,'00123','00123',0.01,current_date,null,1,1,null,null,true,'EUR')`,[id(301),org,brand,id(1)]);
  await db.query(`insert into suppliers values($1,$2,'disabled',false),($3,$2,'future',true)`,[id(40),org,id(41)]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,'00123','00/123',0.2,current_date,null,1,1,null,null,true,'EUR'),($5,$2,$3,$6,'00123','00/123',0.3,current_date+1,null,1,1,null,null,true,'EUR')`,[id(402),org,brand,id(40),id(403),id(41)]);
  const got=(await db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[]) offers`,[org,brand,['00/123','00123']])).rows[0].offers;
  assert.equal(got.length,31);assert.deepEqual(got.filter(x=>x.product_code==='00123').map(x=>Number(x.buy_price)),[0.01]);
  assert.equal(Number(got.find(x=>x.product_code==='00/123').buy_price),0.5);
  const screen=(await db.query(`select supplier_id,buy_price from public.report_supplier_comparison_offers($1,'00/123')`,[brand])).rows;
  assert.deepEqual(got.filter(x=>x.product_code==='00/123').map(x=>[x.supplier_id,Number(x.buy_price)]),screen.map(x=>[x.supplier_id,Number(x.buy_price)]));
  // A pointer fences an older legacy price; manual override wins over publication.
  await db.query(`insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)`,[org,brand,id(1),id(501),id(502)]);
  await db.query(`insert into supplier_price_publications values($1,$2,$3,$4,$5,'published')`,[id(502),id(501),org,id(1),brand]);
  await db.query(`insert into supplier_price_release_rows values($1,$2,'00/123','00/123',41,current_date,null,1,1,null,null,'accepted','EUR')`,[id(503),id(501)]);
  let published=(await db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[]) offers`,[org,brand,['00/123']])).rows[0].offers;
  assert.equal(Number(published.find(x=>x.supplier_id===id(1)).buy_price),41);
  await db.query(`insert into supplier_manual_price_internal.entries values($1,$2,$3,$4,'00/123','00/123',37,current_date,null,1,1,true)`,[id(504),org,brand,id(1)]);
  published=(await db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[]) offers`,[org,brand,['00/123']])).rows[0].offers;
  assert.equal(Number(published.find(x=>x.supplier_id===id(1)).buy_price),37);
  assert.deepEqual((await db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[]) offers`,[org,brand,['missing']])).rows[0].offers,[]);
  await assert.rejects(db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[])`,[org,brand,Array(201).fill('X')]),/SUPPLIER_EXPORT_INPUT_INVALID/);
  await assert.rejects(db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[])`,[other,brand,['00/123']]),/SUPPLIER_EXPORT_BRAND_INVALID/);
  const before=(await db.query(`select public.get_catalog_master_export_version($1,$2,'priced') version`,[org,brand])).rows[0].version;
  await db.query(`update suppliers set price_usage_enabled=false where id=$1`,[id(30)]);
  const after=(await db.query(`select public.get_catalog_master_export_version($1,$2,'priced') version`,[org,brand])).rows[0].version;
  assert.notEqual(after,before,'disabling a manual-only supplier changes the cached export version');
  await db.exec(`set role authenticated`);
  await assert.rejects(db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[])`,[org,brand,['00/123']]),/permission denied/);
  await db.exec(`reset role;set role service_role`);
  assert.equal((await db.query(`select jsonb_array_length(public.cloud_catalog_master_export_offers($1,$2,$3::text[])) n`,[org,brand,['00/123']])).rows[0].n,29);
  await db.exec(`reset role`);
});

test('batch JSON includes more than 1000 offers without row-limit truncation',async t=>{
  const db=await fixture(t);
  await db.exec(`create function public.get_admin_price_list_export_version(uuid,uuid) returns text language sql stable as $$select 'v1'::text$$`);
  await db.exec(exportMigration);
  await db.query(`insert into suppliers select md5('s'||n)::uuid,$1,'S'||n,true from generate_series(1,60) n`,[org]);
  await db.query(`insert into supplier_prices select md5('r'||s||'x'||p)::uuid,$1,$2,md5('s'||s)::uuid,'PART'||p,'PART'||p,s,current_date,null,1,1,null,null,true,'EUR' from generate_series(1,60) s cross join generate_series(1,20) p`,[org,brand]);
  const result=(await db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[]) offers`,[org,brand,Array.from({length:20},(_,n)=>`PART${n+1}`)])).rows[0].offers;
  assert.equal(result.length,1200);assert.equal(result.filter(x=>x.product_code==='PART1').length,60);
});

test('batch exports retain the note of each effective supplier price',async t=>{
  const db=await fixture(t);
  await db.exec(`create function public.get_admin_price_list_export_version(uuid,uuid) returns text language sql stable as $$select 'v1'::text$$`);
  await db.exec(exportMigration);
  await db.exec(exportNotesMigration);
  await db.query(`insert into suppliers values($1,$4,'Manual',true),($2,$4,'Published',true),($3,$4,'Legacy',true)`,[id(1),id(2),id(3),org]);
  await db.query(`insert into supplier_prices values($1,$2,$3,$4,'W11025','W11025',1,current_date,'eski not',1,1,null,null,true,'EUR'),($5,$2,$3,$6,'W11025','W11025',3,current_date,'legacy: hızlı',1,1,null,null,true,'EUR')`,[id(100),org,brand,id(1),id(101),id(3)]);
  await db.query(`insert into supplier_manual_price_internal.entries values($1,$2,$3,$4,'W11025','W11025',2,current_date,'manuel: üç hafta',1,1,true)`,[id(300),org,brand,id(1)]);
  await db.query(`insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)`,[org,brand,id(2),id(501),id(502)]);
  await db.query(`insert into supplier_price_publications values($1,$2,$3,$4,$5,'published')`,[id(502),id(501),org,id(2),brand]);
  await db.query(`insert into supplier_price_release_rows values($1,$2,'W11025','W11025',4,current_date,'yayın notu',1,1,null,null,'accepted','EUR')`,[id(503),id(501)]);
  const offers=(await db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[]) offers`,[org,brand,['W11025']])).rows[0].offers;
  assert.deepEqual(offers.map(x=>[x.supplier_name,x.notes]),[['Manual','manuel: üç hafta'],['Legacy','legacy: hızlı'],['Published','yayın notu']]);
  const screen=(await db.query(`select supplier_name,notes from public.report_supplier_comparison_offers($1,'W11025')`,[brand])).rows;
  assert.deepEqual(offers.map(x=>[x.supplier_name,x.notes]),screen.map(x=>[x.supplier_name,x.notes]));
  await db.exec(`set role authenticated`);
  await assert.rejects(db.query(`select public.cloud_catalog_master_export_offers($1,$2,$3::text[])`,[org,brand,['W11025']]),/permission denied/);
  await db.exec(`reset role;set role service_role`);
  assert.equal((await db.query(`select jsonb_array_length(public.cloud_catalog_master_export_offers($1,$2,$3::text[])) n`,[org,brand,['W11025']])).rows[0].n,3);
  await db.exec(`reset role`);
});

test('indicators include notes from any current supplier without leaking another organization',async t=>{
  const db=await fixture(t);
  await db.exec(`create function public.get_admin_price_list_export_version(uuid,uuid) returns text language sql stable as $$select 'v1'::text$$`);
  await db.exec(exportMigration); await db.exec(exportNotesMigration); await db.exec(noteIndicatorMigration);
  await db.query(`insert into suppliers values($1,$3,'Cheapest',true),($2,$3,'Other',true),($4,$3,'Disabled',false)`,[id(1),id(2),org,id(3)]);
  await db.query(`insert into supplier_prices values
    ($1,$4,$5,$6,'P001','P001',1,current_date,null,1,1,null,null,true,'EUR'),
    ($2,$4,$5,$7,'P001','P001',2,current_date,'other offer note',1,1,null,null,true,'EUR'),
    ($3,$4,$5,$8,'P002','P002',3,current_date,'disabled note',1,1,null,null,true,'EUR')`,
    [id(101),id(102),id(103),org,brand,id(1),id(2),id(3)]);
  const read=()=>db.query(`select public.report_supplier_comparison_note_indicators($1,$2::text[]) v`,[brand,['P001','P002','00/123']]);
  assert.deepEqual((await read()).rows[0].v,{'P001':true,'P002':false,'00/123':false});
  await assert.rejects(db.query(`select public.report_supplier_comparison_note_indicators($1,$2::text[])`,[id(999),['P001']]),/BRAND_INVALID/);
  await assert.rejects(db.query(`select public.report_supplier_comparison_note_indicators($1,$2::text[])`,[brand,Array(51).fill('P001')]),/INPUT_INVALID/);
  await db.exec(`set role authenticated`);
  assert.equal((await read()).rows[0].v.P001,true);
  await db.exec(`reset role;set role anon`); await assert.rejects(read(),/permission denied/); await db.exec(`reset role`);
  await db.exec(`select set_config('test.reports','false',false)`); await assert.rejects(read(),/ACCESS_DENIED/);
});

test('manual price availability uses the independent price usage flag in both order readers',async t=>{
  const db=await fixture(t);
  await db.exec(`alter table brands add column normalized_name text; update brands set normalized_name=upper(name);
    alter table suppliers add column is_active boolean not null default true;
    alter table supplier_prices add column description text;
    alter table supplier_price_release_rows add column description text;
    alter table supplier_manual_price_internal.entries add column description text;
    create schema supplier_price_validation_internal;
    create function supplier_price_validation_internal.canonical_automotive_brand_key(text,text) returns text language sql immutable as $$select upper($1)$$;`);
  const core=manualOverlayMigration.slice(manualOverlayMigration.indexOf('CREATE OR REPLACE FUNCTION public.cloud_current_supplier_commercial_options_core'),manualOverlayMigration.indexOf('-- The pointer changes in the same transaction'));
  const batch=manualOverlayMigration.slice(manualOverlayMigration.indexOf('CREATE OR REPLACE FUNCTION public.cloud_current_supplier_price_options_batch'),manualOverlayMigration.indexOf('-- Service snapshots preserve exact supplier/SKU overrides.'));
  await db.exec(core); await db.exec(batch);
  await db.query(`insert into suppliers(id,organization_id,name,price_usage_enabled,is_active) values($1,$3,'Archived but priced',true,false),($2,$3,'Disabled',false,false)`,[id(1),id(2),org]);
  await db.query(`insert into supplier_manual_price_internal.entries(id,organization_id,brand_id,supplier_id,product_code,exact_code,buy_price,valid_from,notes,moq,order_multiple,active) values
    ($1,$3,$4,$5,'00123','00123',6,current_date,'manual note',1,1,true),
    ($2,$3,$4,$6,'00123','00123',1,current_date,'disabled',1,1,true)`,[id(101),id(102),org,brand,id(1),id(2)]);
  const coreRead=()=>db.query(`select supplier_id,buy_price,notes from public.cloud_current_supplier_commercial_options_core($1,'00123','Mann')`,[org]);
  assert.equal((await coreRead()).rows.length,0,'baseline exposes the inconsistent extra archive gate');
  await db.exec(usageGateMigration);
  let result=(await coreRead()).rows; assert.equal(result.length,1); assert.equal(result[0].supplier_id,id(1)); assert.equal(Number(result[0].buy_price),6);
  assert.equal((await db.query(`select * from public.cloud_current_supplier_commercial_options_core($1,'00123','Mann')`,[other])).rows.length,0);
  const batchResult=(await db.query(`select * from public.cloud_current_supplier_price_options_batch($1::jsonb)`,[JSON.stringify([{code:'00123',brand:'Mann'}])])).rows[0];
  assert.equal(batchResult.has_published_scope,true); assert.equal(batchResult.options.length,1);assert.equal(batchResult.options[0].supplier_id,id(1));
  await db.query(`update suppliers set price_usage_enabled=false where id=$1`,[id(1)]);
  assert.equal((await coreRead()).rows.length,0);
  const disabled=(await db.query(`select * from public.cloud_current_supplier_price_options_batch($1::jsonb)`,[JSON.stringify([{code:'00123',brand:'Mann'}])])).rows[0];
  assert.equal(disabled.has_published_scope,false); assert.deepEqual(disabled.options,[]);
  // Legacy and published price sources keep their existing price/ordering and
  // the manual overlay still replaces the same supplier's published offer.
  await db.query(`update suppliers set price_usage_enabled=true where id=$1`,[id(1)]);
  await db.query(`insert into suppliers(id,organization_id,name,price_usage_enabled,is_active) values($1,$3,'Legacy',true,true),($2,$3,'Published',true,true)`,[id(3),id(4),org]);
  await db.query(`insert into supplier_prices(id,organization_id,brand_id,supplier_id,normalized_code,product_code,buy_price,valid_from,is_active,currency) values($1,$2,$3,$4,'00123','00123',7,current_date,true,'EUR')`,[id(103),org,brand,id(3)]);
  await db.query(`insert into supplier_current_price_pointers values($1,$2,$3,$4,$5),($1,$2,$6,$7,$8)`,[org,brand,id(4),id(501),id(502),id(1),id(503),id(504)]);
  await db.query(`insert into supplier_price_publications values($1,$2,$3,$4,$5,'published'),($6,$7,$3,$8,$5,'published')`,[id(502),id(501),org,id(4),brand,id(504),id(503),id(1)]);
  await db.query(`insert into supplier_price_release_rows(id,release_id,normalized_code,product_code,buy_price,valid_from,row_status,currency) values($1,$2,'00123','00123',8,current_date,'accepted','EUR'),($3,$4,'00123','00123',9,current_date,'accepted','EUR')`,[id(105),id(501),id(106),id(503)]);
  result=(await coreRead()).rows;
  assert.deepEqual(result.map(r=>[r.supplier_id,Number(r.buy_price)]),[[id(1),6],[id(3),7],[id(4),8]]);
});
