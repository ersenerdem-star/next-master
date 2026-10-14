import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';

const migration='supabase/migrations/20261014165817_price_list_legacy_scope_compatibility.sql';
const sql=await readFile(migration,'utf8');
const db=new PGlite();
await db.exec(await readFile('scripts/tests/export-quote-eligibility-pg.setup.sql','utf8'));
await db.exec(`alter table brands add column organization_id uuid;
 create table supplier_prices(id uuid primary key,organization_id uuid,supplier_id uuid,brand_id uuid,
 product_code text,description text,buy_price numeric,currency text,valid_from date,valid_to date,
 is_active boolean,updated_at timestamptz default now());
 create or replace function public.normalize_catalog_product_code(input_code text)
 returns text language sql immutable as $$select upper(regexp_replace(btrim(input_code),'[[:space:]]+','','g'))$$;`);
await db.exec(sql);
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),otherOrg=id(2),brand=id(3),otherBrand=id(4),supplier=id(5),secondSupplier=id(6),thirdSupplier=id(7);
const legacy=async(n,code,price,options={})=>{
 const o={org,brand,supplier,currency:'EUR',date:'2026-01-01',until:null,active:true,description:'Legacy '+code,...options};
 await db.query(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,description,buy_price,currency,valid_from,valid_to,is_active,updated_at)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'2026-01-01T00:00:00Z')`,[id(n),o.org,o.supplier,o.brand,code,o.description,price,o.currency,o.date,o.until,o.active]);
};
const published=async(n,rows,options={})=>{
 const o={org,brand,supplier,status:'published',...options};
 await db.query(`insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status) values($1,$2,$3,$4,$5,$6)`,[id(n),o.org,o.brand,o.supplier,id(n+1),o.status]);
 await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[o.org,o.brand,o.supplier,id(n+1),id(n)]);
 for(const [i,r] of rows.entries())await db.query(`insert into supplier_price_release_rows(id,release_id,normalized_code,product_code,description,buy_price,currency,valid_from,row_status)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id(n+10+i),id(n+1),r.code,r.code,r.description||'Published '+r.code,r.price,r.currency||'EUR',r.date||'2026-01-01',r.status||'accepted']);
};
const page=async(audience='admin',margin='.10',after=null,size=1000,scope={})=>(await db.query(`select normalized_code,product_code,sales_price::text,price_date::text,total_count::text from public.${audience==='admin'?'cloud_admin_price_list_page_fast':'cloud_portal_customer_price_list_page_fast'}($1,$2,$3,$4,null,$5,$6)`,[scope.org||org,scope.brand||brand,scope.type||'A',margin,after,size])).rows;
const version=async()=>(await db.query('select public.get_admin_price_list_export_version($1,$2) version',[org,brand])).rows[0].version;
const brands=async()=>(await db.query('select * from public.cloud_admin_price_list_brands($1)',[org])).rows;
beforeEach(async()=>{
 await db.exec('reset role;truncate supplier_prices,supplier_price_release_rows,supplier_current_price_pointers,supplier_price_publications,catalog_products,supplier_price_rollups,item_code_references,brands');
 await db.query('insert into brands(id,name,organization_id) values($1,$2,$3),($4,$5,$6)',[brand,'Geba',org,otherBrand,'Other',otherOrg]);
});
after(async()=>db.close());

test('legacy-only brand exports full scope with identical admin decimal and portal percentage/custom margins',async()=>{
 await legacy(100,'61/1','72.93');await legacy(101,'611','60.56');
 assert.deepEqual(await brands(),[{id:brand,name:'Geba'}]);
 assert.deepEqual(await page('admin','.10'),await page('portal','10'));
 assert.deepEqual((await page('portal','12.5',null,1000,{type:'A'})).map(r=>r.sales_price),['82.05','68.13']);
 assert.deepEqual((await page('admin','.15',null,1000,{type:'B'})).map(r=>r.sales_price),['83.87','69.64']);
 assert.equal((await page())[0].total_count,'2');
});

test('newest valid legacy row per exact SKU/supplier wins before cheapest supplier selection',async()=>{
 await legacy(100,'A','1',{date:'2025-01-01'});await legacy(101,'A','100',{date:'2026-01-01'});
 await legacy(102,'A','90',{supplier:secondSupplier});
 await legacy(103,'B','40');await legacy(104,'B','50');
 assert.deepEqual((await page('admin','0')).map(r=>[r.normalized_code,r.sales_price]),[['A','90.00'],['B','50.00']]);
});

test('publication replaces only its supplier scope; another legacy supplier stays eligible and stale removed SKUs do not resurrect',async()=>{
 await legacy(100,'OLD','1');await legacy(101,'A','1');await legacy(102,'A','80',{supplier:secondSupplier});
 await legacy(103,'B','20',{supplier:secondSupplier});
 await published(200,[{code:'A',price:'100'},{code:'C',price:'30'}]);
 assert.deepEqual((await page('admin','0')).map(r=>[r.normalized_code,r.sales_price]),[['A','80.00'],['B','20.00'],['C','30.00']]);
 assert.equal((await page())[0].total_count,'3');
});

test('invalid publication pointer closes only its scope rather than falling back or hiding another supplier',async()=>{
 await legacy(100,'A','1');await legacy(101,'B','2',{supplier:secondSupplier});
 await published(200,[{code:'A',price:'3'}],{status:'superseded'});
 assert.deepEqual((await page()).map(r=>r.normalized_code),['B']);
 await published(300,[],{supplier:secondSupplier,status:'superseded'});
 assert.deepEqual(await page(),[]);assert.deepEqual(await brands(),[]);
});

test('source eligibility excludes inactive expired future foreign-currency rejected placeholder and foreign-tenant rows',async()=>{
 await legacy(100,'VALID','10');
 for(const [i,o] of [{active:false},{until:'2020-01-01'},{date:'2999-01-01'},{currency:'USD'},{org:otherOrg}].entries())await legacy(110+i,'NO'+i,'1',o);
 await legacy(120,'-','1');await legacy(121,'ZERO','0');await legacy(122,'NULLDATE','1',{date:null});
 await published(200,[{code:'PUB',price:'5'},{code:'REJECT',price:'1',status:'rejected'},{code:'FUTURE',price:'1',date:'2999-01-01'}],{supplier:secondSupplier});
 assert.deepEqual((await page()).map(r=>r.normalized_code),['PUB','VALID']);
 assert.equal((await page())[0].total_count,'2');
});

test('mixed-source keyset pages are complete deterministic and count only first page',async()=>{
 for(const [i,c]of ['A','AA','B','61/1','611'].entries())await legacy(100+i,c,'20');
 await published(200,[{code:'A',price:'10'},{code:'AB',price:'30'},{code:'Z',price:'5'}],{supplier:secondSupplier});
 const all=[];let after=null;
 for(let n=0;n<10;n++){
  const rows=await page('portal','10',after,2);if(!rows.length)break;
  assert.equal(rows[0].total_count,after===null?'7':null);all.push(...rows);after=rows.at(-1).normalized_code;
 }
 assert.deepEqual(all.map(r=>r.normalized_code),['61/1','611','A','AA','AB','B','Z']);
 assert.equal(new Set(all.map(r=>r.normalized_code)).size,7);
});

test('published-only exports preserve prior valid output across both margin units and continuation pages',async()=>{
 await published(200,[{code:'61/1',price:'72.93'},{code:'611',price:'60.56'},{code:'Z',price:'7.11'},
  {code:'DUP',price:'10',date:'2025-01-01'},{code:'DUP',price:'20',date:'2026-01-01'},
  {code:'TIE',price:'30',date:'2025-01-01'}]);
 await published(300,[{code:'61/1',price:'70'},{code:'B',price:'5.5'},
  {code:'TIE',price:'30',date:'2026-01-01'}],{supplier:secondSupplier});
 const cases=[['admin','.10',null],['admin','.15','611'],['admin','.10','DUP'],
  ['portal','12.5',null],['portal','10','611'],['portal','10','DUP']];
 await db.exec(await readFile('supabase/migrations/20261013140024_supplier_price_export_quote_eligibility.sql','utf8'));
 const baseline=[];for(const args of cases)baseline.push(await page(...args,2));
 await db.exec(sql);
 for(const [i,args]of cases.entries()){
  const normalize=rows=>rows.map(r=>({...r,total_count:r.total_count==='0'?null:r.total_count}));
  assert.deepEqual(normalize(await page(...args,2)),normalize(baseline[i]));
 }
});

test('mismatched publication tenant binding cannot authorize release rows or revive its legacy scope',async()=>{
 await legacy(100,'A','1');await legacy(101,'B','2',{supplier:secondSupplier});
 await published(200,[{code:'A',price:'3'}]);
 await db.query('update supplier_price_publications set organization_id=$1 where id=$2',[otherOrg,id(200)]);
 assert.deepEqual((await page()).map(r=>r.normalized_code),['B']);
});

test('raw legacy edits and same-count replacements invalidate snapshot before rollup refresh; owned legacy changes do not',async()=>{
 await legacy(100,'A','10');await legacy(101,'B','20');
 let before=await version();await db.query('update supplier_prices set buy_price=11 where id=$1',[id(100)]);
 assert.notEqual(await version(),before);
 before=await version();await db.query('delete from supplier_prices where id=$1',[id(101)]);await legacy(102,'C','20');assert.notEqual(await version(),before);
 await published(200,[{code:'A',price:'30'}]);before=await version();
 await db.query('update supplier_prices set buy_price=1 where id=$1',[id(100)]);assert.equal(await version(),before);
 await db.exec("set timezone='Europe/Istanbul'");assert.equal(await version(),before);await db.exec("set timezone='UTC'");
});

test('all source and pricing RPCs remain service-only, and the forward can replay',async()=>{
 await db.exec(sql);
 const signatures=['cloud_price_list_source_page(uuid,uuid,text,integer)','cloud_admin_price_list_brands(uuid)','cloud_admin_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)','cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)','get_admin_price_list_export_version(uuid,uuid)'];
 for(const fn of signatures){
  const {rows:[r]}=await db.query(`select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service`,['public.'+fn]);
  assert.deepEqual(r,{anon:false,authenticated:false,service:true});
 }
 await db.exec('set role authenticated');await assert.rejects(page(),/permission denied/);await db.exec('reset role');
});

test('forward installs after actual production baseline and immutable reviewed62 migration chain',async()=>{
 const fixture=await createFullReplayDb();
 try{
  const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));
  assert.equal(manifest.migration_order.length,62);
  for(const migration of manifest.migration_order)await fixture.exec(await readFile(migration.file,'utf8'));
  await fixture.exec(sql);await fixture.exec(sql);
  assert.equal((await fixture.query("select count(*)::int n from public.cloud_admin_price_list_brands('10000000-0000-4000-8000-000000000001')")).rows[0].n,0);
 }finally{await fixture.close();}
});
