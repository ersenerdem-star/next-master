import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const fixture=new URL('./fixtures/manual-supplier-price-foundation-before-oem.sql',import.meta.url);
const migrationPath=new URL('../../supabase/migrations/20261117110224_manual_supplier_price_catalog_oem_match.sql',import.meta.url);
const signature='public.save_manual_supplier_price(uuid,uuid,text,numeric,date,text,text,integer,integer,integer,text)';

test('catalog OEM copied into a manual price survives the free-form input bound without relaxing identity or price rules',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
   create table organizations(id uuid primary key);create table profiles(id uuid primary key);
   create table suppliers(id uuid primary key,organization_id uuid,is_active boolean);
   create table brands(id uuid primary key,organization_id uuid);
   create table supplier_price_source_versions(organization_id uuid,brand_id uuid,source_revision bigint,updated_at timestamptz,primary key(organization_id,brand_id));
   create table supplier_price_publications(id uuid primary key);
   create table catalog_products(id uuid primary key,organization_id uuid,brand_id uuid,product_code text,oem_no text,description text);
   create table sales_orders(id uuid primary key,document jsonb);
   create function public.current_profile_org_id() returns uuid language sql as $$select nullif(current_setting('test.org',true),'')::uuid$$;
   create function public.is_superadmin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'')='yes'$$;
   create function public.current_profile_role() returns text language sql as $$select 'viewer'::text$$;
   create function public.profile_has_permission(text) returns boolean language sql as $$select false$$;
   create function public.normalize_catalog_product_code(text) returns text language sql immutable as $$select upper(regexp_replace(trim($1),'[[:space:]]+','','g'))$$;
   create index idx_catalog_products_export_exact_code on catalog_products(organization_id,brand_id,public.normalize_catalog_product_code(product_code));`);
  // An override permits re-running against the original, unmodified foundation
  // file in the manual-price worktree; the checked-in snapshot is identical.
  const foundationSource=await readFile(process.env.NM_MANUAL_PRICE_FOUNDATION_SQL||fixture,'utf8');
  const foundation=foundationSource.split('-- Exact, active manual prices')[0];
  assert.equal(foundation,await readFile(fixture,'utf8'));
  await db.exec(foundation);
  await db.query('insert into organizations values($1),($2)',[id(1),id(2)]);
  await db.query('insert into profiles values($1)',[id(3)]);
  await db.query('insert into suppliers values($1,$2,true)',[id(4),id(1)]);
  await db.query('insert into brands values($1,$2),($3,$2),($4,$5)',[id(6),id(1),id(8),id(9),id(2)]);
  await db.query("select set_config('test.actor',$1,false),set_config('test.org',$2,false),set_config('test.admin','yes',false)",[id(3),id(1)]);
  const longOem='OEM-'.repeat(316)+'X';
  assert.equal(longOem.length,1265);
  const putCatalog=(n,org,brand,code,oem)=>db.query('insert into catalog_products values($1,$2,$3,$4,$5,$6)',[id(n),org,brand,code,oem,'Relay Valve']);
  await putCatalog(10,id(1),id(6),'9730110000',longOem);
  await putCatalog(11,id(1),id(6),'0009730110000','  '+longOem+'  ');
  // Isolate the tenant predicate even if an inconsistent row carries another
  // tenant's brand ID: the exception must still refuse that row.
  await putCatalog(12,id(2),id(6),'OTHER_ORG_ONLY',longOem);
  await putCatalog(13,id(1),id(8),'OTHER_BRAND_ONLY',longOem);
  await putCatalog(14,id(1),id(6),'BLANK_OEM','');
  await db.query('insert into supplier_price_publications values($1)',[id(15)]);
  await db.query('insert into sales_orders values($1,$2)',[id(16),JSON.stringify({status:'confirmed',product_code:'9730110000',buy_price:19,description:'Historical description'})]);
  const save=({code='9730110000',price=33,oem=longOem,moq=null,multiple=null,description='Relay Valve',lead=null,notes=null,brand=id(6)}={})=>db.query(
   'select public.save_manual_supplier_price($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result',
   [id(4),brand,code,price,'2026-11-17',description,oem,moq,multiple,lead,notes]);
  await save({code:'HISTORICAL001',price:7.25,oem:'Historical OEM'});
  const historyBefore=(await db.query("select to_jsonb(m) as row from supplier_manual_price_internal.entries m where product_code='HISTORICAL001'")).rows;
  const catalogBefore=(await db.query('select to_jsonb(c) as row from catalog_products c order by id')).rows;
  const ordersBefore=(await db.query('select to_jsonb(s) as row from sales_orders s order by id')).rows;
  const publicationsBefore=(await db.query('select to_jsonb(p) as row from supplier_price_publications p order by id')).rows;
  const writerMetadata=async()=> (await db.query('select proowner,proacl,prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows;
  const metadataBefore=await writerMetadata();
  await assert.rejects(save(),/MANUAL_SUPPLIER_PRICE_INPUT_INVALID/);
  const migration=await readFile(migrationPath,'utf8');
  await db.exec(migration);
  assert.deepEqual(await writerMetadata(),metadataBefore);
  const accepted=await save();
  assert.equal(accepted.rows[0].result.product_code,'9730110000');
  const saved=(await db.query("select product_code,oem_no,buy_price::text from supplier_manual_price_internal.entries where product_code='9730110000'")).rows[0];
  assert.deepEqual(saved,{product_code:'9730110000',oem_no:longOem,buy_price:'33'});
  await save({code:'0009730110000'});
  assert.equal((await db.query("select product_code from supplier_manual_price_internal.entries where product_code='0009730110000'")).rows[0].product_code,'0009730110000');
  // Only the catalog's surrounding whitespace may differ, as in normalizeText.
  await assert.rejects(save({oem:longOem.replace('OEM-','OEM/')}),/INPUT_INVALID/);
  await assert.rejects(save({oem:longOem+' '}),/INPUT_INVALID/);
  await assert.rejects(save({code:'BLANK_OEM',oem:' '.repeat(1265)}),/INPUT_INVALID/);
  await assert.rejects(save({code:'OTHER_ORG_ONLY'}),/INPUT_INVALID/);
  await assert.rejects(save({code:'OTHER_BRAND_ONLY'}),/INPUT_INVALID/);
  await assert.rejects(save({code:'NO_CATALOG_MATCH'}),/INPUT_INVALID/);
  await assert.rejects(save({code:'973-011-0000'}),/INPUT_INVALID/);
  await assert.rejects(save({code:'009730110000'}),/INPUT_INVALID/);
  await assert.rejects(save({price:0}),/INPUT_INVALID/);
  await assert.rejects(save({moq:0}),/INPUT_INVALID/);
  await assert.rejects(save({multiple:0}),/INPUT_INVALID/);
  await assert.rejects(save({lead:-1}),/INPUT_INVALID/);
  await assert.rejects(save({description:'X'.repeat(1001)}),/INPUT_INVALID/);
  await assert.rejects(save({notes:'X'.repeat(2001)}),/INPUT_INVALID/);
  await db.query("select set_config('test.org',$1,false)",[id(2)]);
  await assert.rejects(save(),/SCOPE_INVALID/);
  await db.query("select set_config('test.org',$1,false),set_config('test.admin','no',false)",[id(1)]);
  await assert.rejects(save(),/ADMIN_REQUIRED/);
  await db.query("select set_config('test.admin','yes',false)");
  assert.deepEqual((await db.query("select to_jsonb(m) as row from supplier_manual_price_internal.entries m where product_code='HISTORICAL001'")).rows,historyBefore);
  assert.deepEqual((await db.query('select to_jsonb(c) as row from catalog_products c order by id')).rows,catalogBefore);
  assert.deepEqual((await db.query('select to_jsonb(s) as row from sales_orders s order by id')).rows,ordersBefore);
  assert.deepEqual((await db.query('select to_jsonb(p) as row from supplier_price_publications p order by id')).rows,publicationsBefore);
  assert.equal((await db.query('select count(*)::int n from supplier_manual_price_internal.events')).rows[0].n,3);
  assert.equal((await db.query('select source_revision::int n from supplier_price_source_versions')).rows[0].n,3);
  await assert.rejects(db.exec(migration),/WRITER_BASELINE_CHANGED/);
 } finally {await db.close();}
});
