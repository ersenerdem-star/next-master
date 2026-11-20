import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('BorgWarner review threshold is scoped, auditable and still blocks majority overlaps',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema supplier_price_validation_internal;
   create function public.normalize_part_code(text) returns text language sql immutable as $$select regexp_replace(upper(coalesce($1,'')),'[^A-Z0-9]','','g')$$;
   create table public.brands(id uuid,organization_id uuid,name text);
   create table public.suppliers(id uuid,organization_id uuid);
   create table public.supplier_price_releases(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,status text,source_verification_required boolean,accepted_rows bigint,total_rows bigint,rejected_rows bigint,conflict_rows bigint,source_file_sha256 text);
   create table public.supplier_price_release_rows(release_id uuid,source_row_number bigint,product_code text,buy_price numeric,row_status text);
   create table public.catalog_products(id uuid,organization_id uuid,brand_id uuid,normalized_code text,product_code text);
   create table public.catalog_product_source_records(organization_id uuid,catalog_product_id uuid);
   create table public.supplier_prices(organization_id uuid,brand_id uuid,normalized_code text,product_code text,is_active bool);
   create table public.supplier_current_price_pointers(organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,publication_id uuid);
   create table public.supplier_price_publications(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,status text);`);
  await db.exec(readFileSync('supabase/migrations/20261023185017_continental_automotive_brand_identity.sql','utf8').split('-- No live alias source')[0]);
  await db.exec(readFileSync('scripts/tests/fixtures/borgwarner-prior-cross-brand-audit.sql','utf8'));
  await db.exec('revoke all on function supplier_price_validation_internal.cross_brand_audit(uuid) from public, anon, authenticated, service_role');
  await db.exec(readFileSync('supabase/migrations/20261120133731_borgwarner_cross_brand_review_threshold.sql','utf8'));
  const org='00000000-0000-4000-8000-000000000001',supplier='00000000-0000-4000-8000-000000000002',brand='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004',release='00000000-0000-4000-8000-000000000005';
  await db.query('insert into suppliers values($1,$2)',[supplier,org]);
  await db.query("insert into brands values($1,$2,'BorgWarner'),($3,$2,'Febi')",[brand,org,other]);
  await db.query("insert into supplier_price_releases values($1,$2,$3,$4,'staged',true,100,100,0,0,'source')",[release,org,supplier,brand]);
  await db.query("insert into supplier_price_release_rows select $1,n,'C'||n,12.34,'accepted' from generate_series(1,100)n",[release]);
  await db.query("insert into supplier_prices select $1,$2,'C'||n,'C'||n,true from generate_series(1,26)n",[org,other]);
  const audit=async()=> (await db.query('select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a;
  for(const name of ['BorgWarner','BorgWarner (KKK)','BorgWarner (Schwitzer)','BorgWarner (BERU)']){
   await db.query('update brands set name=$1 where id=$2',[name,brand]);let a=await audit();assert.equal(a.ratio_threshold_percent,50);assert.equal(a.review_required,false);assert.equal(a.brands[0].matching_codes,26);
  }
  await db.query("insert into supplier_prices select $1,$2,'C'||n,'C'||n,true from generate_series(27,50)n",[org,other]);assert.equal((await audit()).review_required,false);
  await db.query("insert into supplier_prices values($1,$2,'C51','C51',true)",[org,other]);assert.equal((await audit()).review_required,true);
  await db.query("update brands set name='Bosch' where id=$1",[brand]);await db.exec("delete from supplier_prices where normalized_code not in ('C1','C2','C3','C4','C5')");let a=await audit();assert.equal(a.ratio_threshold_percent,5);assert.equal(a.review_required,false);
  await db.query("insert into supplier_prices values($1,$2,'C6','C6',true)",[org,other]);assert.equal((await audit()).review_required,true);
  await db.exec('delete from supplier_price_release_rows');assert.equal((await audit()).review_required,true);
  const permissions=(await db.query("select has_function_privilege('anon','supplier_price_validation_internal.cross_brand_audit(uuid)','execute') a, has_function_privilege('authenticated','supplier_price_validation_internal.cross_brand_audit(uuid)','execute') b,has_function_privilege('service_role','supplier_price_validation_internal.cross_brand_audit(uuid)','execute') c")).rows[0];
  assert.deepEqual(permissions,{a:false,b:false,c:false});
 }finally{await db.close();}
});
