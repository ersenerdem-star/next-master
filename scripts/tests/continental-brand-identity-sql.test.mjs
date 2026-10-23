import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const migration=await readFile(new URL('../../supabase/migrations/20261023185017_continental_automotive_brand_identity.sql',import.meta.url),'utf8');
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema supplier_price_validation_internal;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function current_profile_org_id() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.org',true),'')::uuid$$;
create function normalize_part_code(text) returns text language sql immutable as $$select regexp_replace(upper(coalesce($1,'')),'[^A-Z0-9]','','g')$$;
create table brands(id uuid primary key,organization_id uuid,name text,normalized_name text generated always as(normalize_part_code(name)) stored);
create table suppliers(id uuid primary key,organization_id uuid,name text);
create table supplier_price_releases(id uuid primary key,organization_id uuid,supplier_id uuid,brand_id uuid,status text,total_rows bigint);
create table supplier_price_release_rows(id uuid default gen_random_uuid(),release_id uuid,source_row_number bigint,product_code text,normalized_code text,row_status text default 'accepted',description text,buy_price numeric,currency text default 'EUR',valid_from date default current_date,valid_to date,notes text,moq integer,order_multiple integer,stock_qty integer);
create table supplier_price_publications(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,status text);
create table supplier_current_price_pointers(organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,publication_id uuid);
create table catalog_products(id uuid default gen_random_uuid(),organization_id uuid,brand_id uuid,normalized_code text,product_code text);
create table catalog_product_source_records(organization_id uuid,catalog_product_id uuid,source_key text);
create table supplier_prices(id uuid default gen_random_uuid(),organization_id uuid,supplier_id uuid,brand_id uuid,normalized_code text,product_code text,is_active boolean default true,buy_price numeric,currency text default 'EUR',valid_from date default current_date,valid_to date,description text,notes text,moq integer,order_multiple integer,stock_qty integer);
`);
await db.exec(migration);
await db.exec(`revoke all on function cloud_current_supplier_commercial_options_core(uuid,text,text) from public,anon,authenticated;
revoke all on function cloud_current_supplier_price_options_batch(jsonb) from public,anon;
grant execute on function cloud_current_supplier_price_options_batch(jsonb) to authenticated;`);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),otherOrg=id(2),supplier=id(3),ctam=id(4),alias=id(5),gates=id(6),dayco=id(7),bare=id(8),tires=id(9),air=id(10),release=id(11);
const audit=async()=> (await db.query('select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a;
const price=async(brand='Continental CTAM',code='6PK1870',organization=org)=>(await db.query('select * from cloud_current_supplier_commercial_options_core($1,$2,$3)',[organization,code,brand])).rows;
beforeEach(async()=>{
 await db.exec(`reset role;truncate brands,suppliers,supplier_price_releases,supplier_price_release_rows,supplier_price_publications,supplier_current_price_pointers,supplier_prices,catalog_products,catalog_product_source_records;`);
 for(const [key,name] of [[ctam,'Continental CTAM'],[alias,'Contitech'],[gates,'Gates'],[dayco,'Dayco'],[bare,'Continental'],[tires,'Continental Tires'],[air,'ContiTech Air Spring']])await db.query('insert into brands(id,organization_id,name) values($1,$2,$3)',[key,org,name]);
 await db.query("insert into suppliers values($1,$2,'GroupAuto')",[supplier,org]);
 await db.query("insert into supplier_price_releases values($1,$2,$3,$4,'published',1)",[release,org,supplier,ctam]);
 await db.query("insert into supplier_price_release_rows(release_id,source_row_number,product_code,normalized_code,buy_price,moq,order_multiple,stock_qty) values($1,1,'6PK1870','6PK1870',10,3,2,0)",[release]);
 await db.query("insert into supplier_price_publications values($1,$2,$3,$4,$5,'published')",[id(12),org,supplier,ctam,release]);
 await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,supplier,ctam,release,id(12)]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.org',$2,false)",[id(50),org]);
});
after(()=>db.close());
test('Contitech, CTAM and bare Continental PK request share the canonical published price and commercial fields',async()=>{
 for(const name of ['Contitech','CONTITECH','Continental CTAM','Continental']){
  const rows=await price(name);assert.equal(rows.length,1);assert.equal(rows[0].brand_id,ctam);assert.equal(rows[0].brand,'Continental CTAM');assert.equal(rows[0].buy_price,'10');assert.equal(rows[0].moq,3);assert.equal(rows[0].order_multiple,2);assert.equal(rows[0].stock_qty,0);
 }
});
test('tires, air springs, VDO and ambiguous non-PK Continental do not cross into CTAM',async()=>{
 for(const name of ['Continental Tires','ContiTech Air Spring','VDO/Continental'])assert.deepEqual(await price(name),[]);
 await db.query("insert into supplier_price_release_rows(release_id,product_code,normalized_code,buy_price) values($1,'CT1234','CT1234',11)",[release]);
 assert.deepEqual(await price('Continental','CT1234'),[]);assert.equal((await price('Contitech','CT1234')).length,1);
});
test('exact supplier SKU punctuation is retained and tenant scope cannot leak',async()=>{
 assert.deepEqual(await price('Contitech','6/PK1870'),[]);assert.deepEqual(await price('Contitech','6PK1870',otherOrg),[]);
});
test('alias-aware bulk scope and single price agree under authenticated org; anonymous is refused',async()=>{
 await db.exec('set role authenticated');
 const a=(await db.query("select * from cloud_current_supplier_price_options_batch('[{\"brand\":\"Contitech\",\"code\":\"6PK1870\"},{\"brand\":\"Continental\",\"code\":\"6PK1870\"},{\"brand\":\"Continental Tires\",\"code\":\"6PK1870\"}]')")).rows;
 assert.deepEqual(a.map(x=>x.has_published_scope),[true,true,false]);assert.equal(a[0].options[0].brand,'Continental CTAM');assert.deepEqual(a[2].options,[]);
 await assert.rejects(db.query("select * from supplier_price_validation_internal.cross_brand_audit($1)",[release]),/permission denied/);
 await db.exec('reset role;set role anon');await assert.rejects(db.query("select * from cloud_current_supplier_price_options_batch('[]')"),/permission denied/);
});
test('invalid pointer remains a fallback barrier and expired rows remain unavailable',async()=>{
 await db.query("insert into supplier_prices(organization_id,supplier_id,brand_id,normalized_code,product_code,buy_price) values($1,$2,$3,'6PK1870','6PK1870',1)",[org,supplier,ctam]);
 await db.exec("update supplier_price_publications set status='superseded'");assert.deepEqual(await price('Contitech'),[]);
 await db.exec("update supplier_price_publications set status='published';update supplier_price_release_rows set valid_to=current_date-1");assert.deepEqual(await price('Contitech'),[]);
});
async function overlap({incoming='6PK1870',source='6PK1870',other=gates}={}){
 await db.exec('truncate supplier_price_release_rows,supplier_current_price_pointers,supplier_price_publications');
 await db.query('insert into supplier_price_release_rows(release_id,source_row_number,product_code,normalized_code,buy_price) values($1,1,$2,$2,10)',[release,incoming]);
 await db.query('insert into supplier_prices(organization_id,supplier_id,brand_id,normalized_code,product_code,buy_price) values($1,$2,$3,normalize_part_code($4),$4,10)',[org,supplier,other,source]);
}
test('standard PK dimensions across belt makers are informational with exact-source evidence',async()=>{
 await overlap();const a=await audit();assert.equal(a.policy,'cross-brand-v3');assert.equal(a.review_required,false);assert.deepEqual(a.brands,[]);assert.deepEqual(a.shared_dimension_matches,[{brand_name:'Gates',matching_codes:1}]);
});
test('nonstandard punctuation, manufacturer codes and other product families still trigger genuine overlap',async()=>{
 for(const config of [{incoming:'6/PK1870'},{source:'6/PK1870'},{incoming:'CT1234',source:'CT1234'},{other:tires},{other:air}]){
  await db.exec('truncate supplier_prices');await overlap(config);assert.equal((await audit()).review_required,true,JSON.stringify(config));
 }
});
test('same automotive family is not a competing brand, while unknown comparisons still hold',async()=>{
 await overlap({incoming:'CT1234',source:'CT1234',other:alias});assert.equal((await audit()).review_required,false);
 await db.exec('begin;drop table catalog_product_source_records');try{assert.equal((await audit()).checked,false);}finally{await db.exec('rollback');}
});
test('migration preserves existing core grants and refuses to hide any active alias source',async()=>{
 const before=(await db.query("select proacl,proconfig,prosecdef from pg_proc where oid='cloud_current_supplier_commercial_options_core(uuid,text,text)'::regprocedure")).rows[0];
 await db.exec(migration);const after=(await db.query("select proacl,proconfig,prosecdef from pg_proc where oid='cloud_current_supplier_commercial_options_core(uuid,text,text)'::regprocedure")).rows[0];assert.deepEqual(after,before);
 await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,supplier,alias,release,id(12)]);
 await assert.rejects(db.exec(migration),/CONTITECH_ACTIVE_SOURCE_REQUIRES_REVIEW/);
});
