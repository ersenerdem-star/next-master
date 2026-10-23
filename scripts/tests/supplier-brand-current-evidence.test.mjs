import test, {beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create schema supplier_price_validation_internal;create schema supplier_price_ingestion_internal;
 create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
 create function public.normalize_part_code(text) returns text language sql immutable set search_path to public as $$select regexp_replace(upper(coalesce($1,'')), '[^A-Z0-9]', '', 'g')$$;
 create table brands(id uuid primary key,organization_id uuid,name text);
 create table suppliers(id uuid primary key,organization_id uuid);
 create table supplier_price_releases(id uuid primary key,organization_id uuid,supplier_id uuid,brand_id uuid,status text,
   source_verification_required boolean,total_rows bigint,current_cursor bigint,processed_rows bigint,accepted_rows bigint,
   rejected_rows bigint,warning_rows bigint,conflict_rows bigint,brand_identity_audit jsonb,error_code text,error_message text,
   validated_at timestamptz,published_at timestamptz,uploaded_at timestamptz,source_file_sha256 text,source_file_path text,
   updated_at timestamptz,worker_version text,review_revision integer default 0);
 create table supplier_price_ingestion_internal.handoffs(release_id uuid,organization_id uuid,source_sha256 text,source_path text,total_rows bigint);
 create table supplier_price_release_batches(release_id uuid,status text,row_count integer);
 create table supplier_price_release_rows(release_id uuid,source_row_number bigint,product_code text,normalized_code text,
   row_status text,buy_price numeric,currency text,valid_from date);
 create table supplier_price_release_events(release_id uuid,event_type text,stage text,status text,cursor bigint,processed_rows bigint,total_rows bigint,worker_version text,error_code text,error_message text);
 create table catalog_products(id uuid default gen_random_uuid(),organization_id uuid,brand_id uuid,normalized_code text);
 create table catalog_product_source_records(organization_id uuid,catalog_product_id uuid,source_key text);
 create table supplier_prices(organization_id uuid,brand_id uuid,normalized_code text,is_active boolean);
 create table supplier_current_price_pointers(organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,publication_id uuid);
 create table supplier_price_publications(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,status text);`);

await db.exec(await readFile(new URL('../../supabase/migrations/20261023175926_supplier_brand_audit_current_source_evidence.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../../supabase/migrations/20261015181100_supplier_verified_completion_brand_audit.sql',import.meta.url),'utf8'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),supplier=id(2),brand=id(3),other=id(4),release=id(5);
after(()=>db.close());
beforeEach(async()=>{
 await db.exec(`truncate catalog_product_source_records,catalog_products,supplier_prices,supplier_price_releases,supplier_price_release_rows,supplier_price_publications,supplier_current_price_pointers,brands,suppliers,supplier_price_release_events;
 select set_config('request.jwt.claim.role','service_role',false);`);
 await db.query("insert into brands values($1,$2,'Mahle'),($3,$2,'Gates')",[brand,org,other]);
 await db.query('insert into suppliers values($1,$2)',[supplier,org]);
 await db.query("insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,status,total_rows,current_cursor,processed_rows,source_verification_required) values($1,$2,$3,$4,'staged',100,100,100,true)",[release,org,supplier,brand]);
 await db.query("insert into supplier_price_release_rows select $1,n,'AC-'||n,'AC-'||n,'accepted',12,'EUR',current_date from generate_series(1,100)n",[release]);
 await db.query("insert into catalog_products(organization_id,brand_id,normalized_code) select $1,$2,'AC'||n from generate_series(1,100)n",[org,other]);
});
const audit=async()=> (await db.query('select supplier_price_validation_internal.cross_brand_audit($1) result',[release])).rows[0].result;
const prove=async(scope=org)=>db.query("insert into catalog_product_source_records select $1,id,'canonical-source' from catalog_products",[scope]);
test('historical 100% cross-brand catalogue membership is retained and informational; no publication or data rewrite',async()=>{
 const before=(await db.query('select * from catalog_products order by normalized_code')).rows;
 const result=await audit();assert.equal(result.policy,'cross-brand-v2');assert.equal(result.review_required,false);
 assert.deepEqual(result.brands,[]);assert.equal(result.historical_brands[0].matching_codes,100);
 assert.equal(result.historical_brands[0].sample_codes.length,10);
 assert.deepEqual((await db.query('select * from catalog_products order by normalized_code')).rows,before);
 assert.equal((await db.query('select count(*)::int n from supplier_current_price_pointers')).rows[0].n,0);
});
test('canonical source provenance still blocks even without an active collector registration',async()=>{
 await prove();const r=await audit();assert.equal(r.review_required,true);assert.equal(r.brands[0].matching_codes,100);assert.deepEqual(r.historical_brands,[]);
});
test('cross-tenant provenance cannot turn unsupported catalogue membership into blocking evidence',async()=>{
 await prove(id(20));assert.equal((await audit()).review_required,false);
 await db.query('update catalog_products set organization_id=$1',[id(20)]);
 assert.deepEqual((await audit()).historical_brands,[]);
});
test('active legacy price evidence holds; archived/inactive legacy does not',async()=>{
 await db.query('insert into supplier_prices select organization_id,brand_id,normalized_code,false from catalog_products');
 assert.equal((await audit()).review_required,false);
 await db.exec('update supplier_prices set is_active=true');assert.equal((await audit()).review_required,true);
 await db.query('update supplier_prices set organization_id=$1',[id(20)]);assert.equal((await audit()).review_required,false);
});
async function published(){
 await db.query("insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,status) values($1,$2,$3,$4,'published')",[id(10),org,supplier,other]);
 await db.query("insert into supplier_price_publications values($1,$2,$3,$4,$5,'published')",[id(11),org,supplier,other,id(10)]);
 await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,supplier,other,id(10),id(11)]);
 await db.query("insert into supplier_price_release_rows select $1,n,'AC/'||n,'AC'||n,'accepted',12,'EUR',current_date from generate_series(1,100)n",[id(10)]);
}
test('current published source blocks with identical bounded/large-path evidence; superseded or invalid pointers do not',async()=>{
 await published();const small=await audit();assert.equal(small.review_required,true);assert.deepEqual(small.historical_brands,[]);
 await db.query('update supplier_price_releases set total_rows=50000 where id=$1',[release]);
 const large=await audit();delete small.checked_at;delete large.checked_at;assert.deepEqual(large,small);
 await db.exec("update supplier_price_publications set status='superseded'");assert.equal((await audit()).review_required,false);
 await db.exec("update supplier_price_publications set status='published';update supplier_current_price_pointers set publication_id=gen_random_uuid()");
 assert.equal((await audit()).review_required,false);
});
test('duplicate codes and multiple sources count once; samples remain bounded',async()=>{
 await prove();await published();await prove();
 await db.query("insert into supplier_price_release_rows select $1,200,'AC/1','AC1','accepted',12,'EUR',current_date",[release]);
 const r=await audit();assert.equal(r.distinct_incoming_codes,100);assert.equal(r.brands[0].matching_codes,100);assert.equal(r.brands[0].sample_codes.length,10);
});
test('absolute threshold is preserved and empty input remains held',async()=>{
 await db.query('delete from supplier_price_release_rows where release_id=$1',[release]);
 assert.equal((await audit()).review_required,true);
 await db.query("insert into supplier_price_release_rows select $1,n,'X'||n,'X'||n,'accepted',12,'EUR',current_date from generate_series(1,7000)n",[release]);
 await db.query("insert into supplier_prices select $1,$2,'X'||n,true from generate_series(1,5000)n",[org,other]);
 assert.equal((await audit()).review_required,true);
});
test('missing provenance infrastructure fails closed and direct API grants remain revoked',async()=>{
 await db.exec('begin;drop table catalog_product_source_records');
 try {const r=await audit();assert.equal(r.checked,false);assert.equal(r.review_required,true);} finally {await db.exec('rollback');}
 const grants=(await db.query("select has_function_privilege('anon','supplier_price_validation_internal.cross_brand_audit(uuid)','execute') a,has_function_privilege('authenticated','supplier_price_validation_internal.cross_brand_audit(uuid)','execute') b,has_function_privilege('service_role','supplier_price_validation_internal.cross_brand_audit(uuid)','execute') c")).rows[0];
 assert.deepEqual(grants,{a:false,b:false,c:false});
});
test('actual completion guard uses separated evidence and never auto-publishes',async()=>{
 const r=(await db.query('select * from complete_supplier_price_release_duckdb_validation($1,100,100,0,0,0,0,0,1)',[release])).rows[0];
 assert.equal(r.publishable,true);
 const saved=(await db.query('select status,error_code,brand_identity_audit,published_at from supplier_price_releases where id=$1',[release])).rows[0];
 assert.equal(saved.status,'validated');assert.equal(saved.error_code,null);assert.equal(saved.published_at,null);
 assert.equal(saved.brand_identity_audit.policy,'cross-brand-v2');assert.equal(saved.brand_identity_audit.historical_brands[0].matching_codes,100);
});
test('actual completion guard retains the genuine wrong-brand hold',async()=>{
 await prove();const r=(await db.query('select * from complete_supplier_price_release_duckdb_validation($1,100,100,0,0,0,0,0,1)',[release])).rows[0];
 assert.equal(r.publishable,false);assert.equal((await db.query('select error_code from supplier_price_releases where id=$1',[release])).rows[0].error_code,'CROSS_BRAND_BULK_OVERLAP');
});
