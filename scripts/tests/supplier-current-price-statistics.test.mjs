import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const migration=await readFile(new URL('../../supabase/migrations/20261015180022_supplier_current_price_dashboard_statistics.sql',import.meta.url),'utf8');
test('statistics enforce tenant/admin scope, unique brand/SKU and current effective publication rules',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user',true),'')::uuid$$;
 create function public.current_profile_org_id() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
 create function public.profile_has_permission(text) returns boolean language sql stable as $$select current_setting('test.manage',true)='yes'$$;
 create table public.brands(id uuid primary key,organization_id uuid);
 create table public.supplier_current_price_pointers(organization_id uuid,supplier_id uuid,brand_id uuid,release_id uuid,publication_id uuid);
 create table public.supplier_price_publications(id uuid,release_id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,status text);
 create table public.supplier_price_release_rows(release_id uuid,product_code text,normalized_code text,buy_price numeric,currency text,row_status text,valid_from date,valid_to date);
 create table public.supplier_prices(organization_id uuid,supplier_id uuid,brand_id uuid,product_code text,buy_price numeric,currency text,is_active boolean,valid_from date,valid_to date);`);
 await db.exec(migration);
 const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
 const org=id(1),other=id(2),brand=id(3),brand2=id(4),unpriced=id(5),supplier=id(6),supplier2=id(7),release=id(8),pub=id(9);
 await assert.rejects(db.query('select public.get_supplier_current_price_statistics()'),/Authentication required/);
 await db.query("select set_config('test.user',$1,false),set_config('test.org',$2,false),set_config('test.manage','no',false)",[id(10),org]);
 await assert.rejects(db.query('select public.get_supplier_current_price_statistics()'),/access required/);
 await db.exec("select set_config('test.manage','yes',false)");
 for(const [b,o] of [[brand,org],[brand2,org],[unpriced,org],[id(11),other]])await db.query('insert into brands values($1,$2)',[b,o]);
 await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,supplier,brand,release,pub]);
 await db.query("insert into supplier_price_publications values($1,$2,$3,$4,$5,'published')",[pub,release,org,supplier,brand]);
 for(const [code,price,currency,status,day,end] of [['A',2,'EUR','accepted',0,null],['A',3,'EUR','accepted',0,null],['61/1',4,'EUR','accepted',0,null],['611',4,'EUR','accepted',0,null],['FUTURE',2,'EUR','accepted',1,null],['EXPIRED',2,'EUR','accepted',-2,-1],['ZERO',0,'EUR','accepted',0,null],['USD',2,'USD','accepted',0,null],['BAD',2,'EUR','rejected',0,null]]){
  await db.query('insert into supplier_price_release_rows values($1,$2,$2,$3,$4,$5,current_date+$6::int,case when $7::int is null then null else current_date+$7::int end)',[release,code,price,currency,status,day,end]);
 }
 for(const [o,s,b,code] of [[org,supplier,brand,'OLD'],[org,supplier2,brand,'A'],[org,supplier2,brand2,'A'],[other,supplier2,id(11),'FOREIGN']]){
  await db.query("insert into supplier_prices values($1,$2,$3,$4,5,'EUR',true,current_date,null)",[o,s,b,code]);
 }
 const get=async()=> (await db.query('select public.get_supplier_current_price_statistics() as result')).rows[0].result;
 const r=await get();assert.equal(r.totalBrands,3);assert.equal(r.pricedBrands,2);assert.equal(r.pricedParts,4);
 // An invalid current publication suppresses legacy rows in that same scope.
 await db.exec("update supplier_price_publications set status='superseded'");
 const unavailable=await get();assert.equal(unavailable.pricedParts,2);
 const acl=await db.query("select has_function_privilege('anon','public.get_supplier_current_price_statistics()','execute') as anon,has_function_privilege('authenticated','public.get_supplier_current_price_statistics()','execute') as member");
 assert.deepEqual(acl.rows[0],{anon:false,member:true});
 }finally{await db.close();}
});
