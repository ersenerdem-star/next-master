import test, {beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const sql=await readFile(new URL('../../supabase/migrations/20261015181100_supplier_verified_completion_brand_audit.sql',import.meta.url),'utf8');
const foundation=await readFile(new URL('../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql',import.meta.url),'utf8');
const start=foundation.indexOf('CREATE OR REPLACE FUNCTION supplier_price_validation_internal.cross_brand_audit(');
const audit=foundation.slice(start,foundation.indexOf('$captured_function$;',start));
await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create schema supplier_price_validation_internal;
 create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
 create function public.normalize_part_code(text) returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
 create table brands(id uuid primary key,organization_id uuid,name text);
 create table suppliers(id uuid primary key,organization_id uuid);
 create table supplier_price_releases(id uuid primary key,organization_id uuid,supplier_id uuid,brand_id uuid,status text,
   source_verification_required boolean,total_rows bigint,current_cursor bigint,processed_rows bigint,accepted_rows bigint,
   rejected_rows bigint,warning_rows bigint,conflict_rows bigint,brand_identity_audit jsonb,error_code text,error_message text,
   validated_at timestamptz,updated_at timestamptz,worker_version text,review_revision integer default 0);
 create table supplier_price_release_rows(release_id uuid,source_row_number bigint,product_code text,normalized_code text,
   row_status text,buy_price numeric,currency text,valid_from date);
 create table supplier_price_release_events(release_id uuid,event_type text,stage text,status text,cursor bigint,processed_rows bigint,total_rows bigint,worker_version text,error_code text,error_message text);
 create table catalog_products(organization_id uuid,brand_id uuid,normalized_code text);
 create table supplier_prices(organization_id uuid,brand_id uuid,normalized_code text,is_active boolean);
 create table supplier_current_price_pointers(organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,publication_id uuid);
 create table supplier_price_publications(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,status text);`);
await db.exec(audit);await db.exec(sql);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),supplier=id(2),brand=id(3),otherBrand=id(4),release=id(5);
beforeEach(async()=>{
 await db.exec(`reset role;select set_config('request.jwt.claim.role','service_role',false);
 truncate brands,suppliers,supplier_price_releases,supplier_price_release_rows,supplier_price_release_events,catalog_products,supplier_prices,supplier_current_price_pointers,supplier_price_publications;`);
 await db.query('insert into brands values($1,$2,\'FAG\'),($3,$2,\'Other\')',[brand,org,otherBrand]);
 await db.query('insert into suppliers values($1,$2)',[supplier,org]);
});
after(async()=>db.close());
async function seed(codes=['61/1','611']){
 await db.query(`insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,status,source_verification_required,total_rows,current_cursor,processed_rows)
 values($1,$2,$3,$4,'staged',true,$5,$5,$5)`,[release,org,supplier,brand,codes.length]);
 for(const [i,code] of codes.entries())await db.query("insert into supplier_price_release_rows values($1,$2,$3,$3,'accepted',12.3,'EUR',current_date)",[release,i+1,code]);
}
const finish=async(n=2)=>(await db.query('select * from complete_supplier_price_release_duckdb_validation($1,$2,$2,0,0,0,0,0,1)',[release,n])).rows[0];
const saved=async()=>(await db.query('select * from supplier_price_releases where id=$1',[release])).rows[0];

test('clean import automatically completes real brand audit, preserves exact SKUs and never publishes',async()=>{
 await seed();const result=await finish();assert.equal(result.publishable,true);
 const r=await saved();assert.equal(r.status,'validated');assert.equal(r.brand_identity_audit.checked,true);
 assert.equal(r.brand_identity_audit.review_required,false);assert.equal(r.error_code,null);assert.equal(r.accepted_rows,2);
 assert.equal((await db.query('select count(*)::int n from supplier_current_price_pointers')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from supplier_price_publications')).rows[0].n,0);
 const first=r.brand_identity_audit;await finish();assert.deepEqual((await saved()).brand_identity_audit,first);
 assert.equal((await db.query('select count(*)::int n from supplier_price_release_events')).rows[0].n,1);
});
test('real cross-brand bulk overlap stays held and replay cannot clear it or a later admin decision',async()=>{
 const codes=Array.from({length:100},(_,i)=>`F${i}`);await seed(codes);
 await db.query('insert into catalog_products select $1,$2,product_code from supplier_price_release_rows',[org,otherBrand]);
 assert.equal((await finish(100)).publishable,false);assert.equal((await saved()).error_code,'CROSS_BRAND_BULK_OVERLAP');
 await db.exec('truncate catalog_products');assert.equal((await finish(100)).publishable,false);
 await db.exec("update supplier_price_releases set error_code='ADMIN_REVIEW_HOLD',review_revision=2");
 await finish(100);assert.equal((await saved()).error_code,'ADMIN_REVIEW_HOLD');assert.equal((await saved()).review_revision,2);
});
test('unavailable comparison remains held instead of pretending the import is clear',async()=>{
 await seed();await db.exec('begin;drop table catalog_products');
 try{assert.equal((await finish()).publishable,false);assert.equal((await saved()).error_code,'BRAND_IDENTITY_COMPARISON_UNAVAILABLE');}
 finally{await db.exec('rollback');}
});
test('invalid staged rows, incomplete cursor and unverified sources fail before any audit',async()=>{
 await seed();
 for(const [column,value,pattern] of [['current_cursor',1,/cursor coverage/],['source_verification_required',false,/not ready/]]){
  const old=(await saved())[column];await db.query(`update supplier_price_releases set ${column}=$1`,[value]);
  await assert.rejects(finish(),pattern);await db.query(`update supplier_price_releases set ${column}=$1`,[old]);
 }
 await db.exec('update supplier_price_release_rows set buy_price=0 where source_row_number=1');
 await assert.rejects(finish(),/STAGED_RELEASE_ROW_INTEGRITY_FAILED/);
 assert.equal((await saved()).status,'staged');assert.equal((await saved()).brand_identity_audit,null);
});
test('service-only access and read-committed lock contract remain enforced',async()=>{
 await seed();await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
 await assert.rejects(finish(),/requires service role/);
 const signature='public.complete_supplier_price_release_duckdb_validation(uuid,integer,integer,integer,integer,integer,integer,integer,integer)';
 const grants=(await db.query("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') member,has_function_privilege('service_role',$1,'execute') worker",[signature])).rows[0];
 assert.deepEqual(grants,{anon:false,member:false,worker:true});
 await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
 await db.exec('begin isolation level repeatable read');
 try{await assert.rejects(finish(),/REQUIRES_READ_COMMITTED/);}finally{await db.exec('rollback');}
});
