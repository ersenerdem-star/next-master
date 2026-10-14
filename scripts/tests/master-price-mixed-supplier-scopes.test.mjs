import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
const dir='supabase/migrations/';
const forward='20261014171235_master_price_mixed_supplier_scopes.sql';
const prior='20261014165817_price_list_legacy_scope_compatibility.sql';
const sql=await readFile(dir+forward,'utf8');
const db=new PGlite();
await db.exec(await readFile('scripts/tests/catalog-export-source-pg.setup.sql','utf8'));
await db.exec(`alter table supplier_prices add column valid_to date;
 create table supplier_price_releases(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,accepted_rows bigint);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function public.current_profile_org_id() returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon,service_role;`);
for(const name of ['20261013140024_supplier_price_export_quote_eligibility.sql','20261014085226_catalog_export_source_contracts.sql','20261014090955_catalog_export_version_source_state.sql','20261014094441_master_export_linear_page_join.sql','20261013140011_master_pointer_scope_fail_closed.sql',prior,forward])await db.exec(await readFile(dir+name,'utf8'));
const id=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),brand=id(2),supplier=id(3),otherSupplier=id(4),actor=id(5);
async function legacy(n,code,price,opts={}){
 const o={supplier:otherSupplier,date:'2026-01-01',until:null,active:true,currency:'EUR',org,brand,...opts};
 await db.query(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,description,oem_no,notes,buy_price,currency,valid_from,valid_to,is_active)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id(n),o.org,o.supplier,o.brand,code,'Legacy '+code,'OEM '+code,'Note '+code,price,o.currency,o.date,o.until,o.active]);
}
async function publish(n,rows,opts={}){
 const o={supplier,status:'published',...opts};
 await db.query('insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status)values($1,$2,$3,$4,$5,$6)',[id(n),org,brand,o.supplier,id(n+1),o.status]);
 await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,brand,o.supplier,id(n+1),id(n)]);
 await db.query('insert into supplier_price_releases values($1,$2,$3,$4,$5)',[id(n+1),org,o.supplier,brand,rows.length]);
 for(const [i,r]of rows.entries())await db.query(`insert into supplier_price_release_rows(id,release_id,normalized_code,product_code,description,oem_no,notes,buy_price,currency,valid_from,row_status)
 values($1,$2,$3,$3,$4,$5,$6,$7,'EUR',$8,'accepted')`,[n*100+i,id(n+1),r.code,'Published '+r.code,'OEM '+r.code,'Note '+r.code,r.price,r.date||'2026-01-01']);
}
async function catalog(n,code){await db.query('insert into catalog_products(id,organization_id,brand_id,product_code,normalized_code,description)values($1,$2,$3,$4,public.normalize_part_code($4),$5)',[id(n),org,brand,code,'Catalog '+code]);}
const page=async(scope='priced',after=null,size=1000,search='')=>(await db.query('select * from public.cloud_catalog_master_export_page_v3($1,$2,$3,$4,$5,null,$6,.1,.15)',[org,brand,scope,search,after,size])).rows;
const preview=async(search='',number=1,size=50)=>(await db.query('select public.cloud_master_published_price_page_v3($1,$2,$3,$4,.1,.15) result',[search,brand,number,size])).rows[0].result;
const catalogPreview=async(search='',number=1,size=50)=>(await db.query('select * from public.cloud_master_page_fast($1,$2,$3,$4,.1,.15)',[search,brand,number,size])).rows;
const version=async()=>(await db.query('select public.get_catalog_master_export_version($1,$2) version',[org,brand])).rows[0].version;
beforeEach(async()=>{
 await db.exec('reset role;truncate supplier_prices,supplier_price_release_rows,supplier_current_price_pointers,supplier_price_publications,supplier_price_releases,catalog_products,supplier_price_rollups,item_code_references,brands,suppliers');
 await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('test.org',$2,false)",[actor,org]);
 await db.query('insert into brands values($1,$2,$3)',[brand,org,'Brand']);
 await db.query('insert into suppliers(id,organization_id,name)values($1,$2,\'Published supplier\'),($3,$2,\'Legacy supplier\')',[supplier,org,otherSupplier]);
});
after(async()=>db.close());

test('mixed suppliers retain cheapest/second/counts in comparison, priced export and catalog scope without stale rollup resurrection',async()=>{
 await publish(100,[{code:'A',price:100},{code:'B',price:50}]);
 await legacy(20,'A',1,{supplier});await legacy(21,'REMOVED',1,{supplier});
 await legacy(22,'A',80);await legacy(23,'C',30);
 for(const[i,c]of ['A','C','D'].entries())await catalog(30+i,c);
 await db.query('insert into supplier_price_rollups(organization_id,brand_id,normalized_code,product_code,cheapest_price,cheapest_supplier_id)values($1,$2,\'REMOVED\',\'REMOVED\',1,$3)',[org,brand,supplier]);
 const rows=await page();assert.deepEqual(rows.map(r=>r.cursor_code),['A','B','C']);
 assert.equal(rows[0].cheapest_price,'80');assert.equal(rows[0].second_price,'100');assert.equal(rows[0].supplier_count,2);assert.equal(rows[0].sales_a,'88.00');assert.equal(rows[0].sales_b,'92.00');assert.equal(rows[0].sales_c,null);
 const catalogRows=await page('catalog');assert.deepEqual(catalogRows.map(r=>[r.product_code,r.cheapest_price,r.supplier_count]),[['A','80',2],['C','30',1],['D',null,0]]);
 const uiCatalog=await catalogPreview();assert.deepEqual(uiCatalog.map(r=>[r.product_code,r.cheapest_price,r.supplier_count,r.total_count]),[['A','80',2,null],['C','30',1,null],['D',null,0,null]]);
 const p=await preview('A');assert.equal(p.has_published_scope,true);assert.equal(p.rows[0].cheapest_price,80);assert.equal(p.rows[0].second_price,100);assert.equal(p.rows[0].supplier_count,2);
 assert.deepEqual((await preview('REMOVED')).rows,[]);
});

test('invalid pointer suppresses only its supplier, including mismatched publication binding',async()=>{
 await publish(100,[{code:'A',price:100}],{status:'superseded'});await legacy(20,'OLD',1,{supplier});await legacy(21,'A',80);
 assert.deepEqual((await page()).map(r=>[r.cursor_code,r.cheapest_price]),[['A','80']]);assert.equal((await preview('A')).rows[0].supplier_count,1);
 await db.query('update supplier_price_publications set status=\'published\',organization_id=$1',[id(99)]);
 assert.deepEqual((await page()).map(r=>r.cheapest_price),['80']);assert.equal((await preview('A')).rows[0].cheapest_price,80);
 await publish(200,[],{supplier:otherSupplier,status:'superseded'});assert.deepEqual(await page(),[]);assert.deepEqual((await preview()).rows,[]);
});

test('latest legacy exact-SKU identity wins before comparison and invalid source rows stay excluded',async()=>{
 await publish(100,[]);await legacy(20,'61/1',1,{date:'2025-01-01'});await legacy(21,'61/1',50);await legacy(22,'611',20);
 for(const[i,o]of [{active:false},{until:'2020-01-01'},{date:'2999-01-01'},{currency:'USD'},{org:id(99)}].entries())await legacy(30+i,'BAD'+i,1,o);
 await legacy(40,'-',1);await legacy(41,'ZERO',0);
 assert.deepEqual((await page()).map(r=>[r.cursor_code,r.cheapest_price]),[['61/1','50'],['611','20']]);
 assert.equal((await preview('61/1')).rows[0].cheapest_price,50);assert.equal((await preview('611')).rows[0].cheapest_price,20);
});

test('mixed keyset pages count union once and bound search across both sources',async()=>{
 await publish(100,[{code:'A',price:10},{code:'C',price:30},{code:'Z',price:50}]);await legacy(20,'B',20);await legacy(21,'C',25);
 let after=null;const codes=[];for(let n=0;n<5;n++){const rows=await page('priced',after,1);if(!rows.length)break;assert.equal(rows[0].total_count,after===null?4:null);codes.push(rows[0].cursor_code);after=rows[0].cursor_code;}
 assert.deepEqual(codes,['A','B','C','Z']);assert.deepEqual((await page('priced',null,10,'OEMB')).map(r=>r.cursor_code),['B']);
 assert.deepEqual((await preview('',2,2)).rows.map(r=>r.product_code),['C','Z']);
});

test('catalog UUID cursor retains duplicate display codes and legacy-only source remains available',async()=>{
 await legacy(20,'A',20);await catalog(30,'A');await catalog(31,'A');await catalog(32,'B');
 const rows=[];let code=null,afterId=null;
 for(let n=0;n<4;n++){
  const next=(await db.query("select product_id,product_code,cheapest_price,total_count from public.cloud_catalog_master_export_page_v3($1,$2,'catalog','',$3,$4,1,.1,.15)",[org,brand,code,afterId])).rows;
  if(!next.length)break;assert.equal(next[0].total_count,code===null?3:null);rows.push(next[0]);code=next[0].product_code;afterId=next[0].product_id;
 }
 assert.deepEqual(rows.map(r=>r.product_id),[id(30),id(31),id(32)]);
 assert.deepEqual(rows.map(r=>r.cheapest_price),['20','20',null]);
 assert.equal((await preview()).has_published_scope,false);
 assert.deepEqual((await catalogPreview('',2,1)).map(r=>[r.product_id,r.total_count]),[[id(31),null]]);
 assert.deepEqual((await page()).map(r=>r.cursor_code),['A']);
});

test('published-only export and authenticated preview outputs preserve prior behavior',async()=>{
 await publish(100,[{code:'61/1',price:100},{code:'611',price:50},{code:'DUP',price:40,date:'2025-01-01'},{code:'DUP',price:45}]);await publish(200,[{code:'61/1',price:90},{code:'TIE',price:40}],{supplier:otherSupplier});
 await catalog(20,'61/1');await catalog(21,'611');
 await db.exec(await readFile(dir+'20261014094441_master_export_linear_page_join.sql','utf8'));await db.exec(await readFile(dir+'20261013140011_master_pointer_scope_fail_closed.sql','utf8'));
 const oldPriced=await page();const oldCatalog=await page('catalog');const oldPreview=await preview();
 await db.exec(sql);assert.deepEqual(await page(),oldPriced);assert.deepEqual(await page('catalog'),oldCatalog);assert.deepEqual(await preview(),oldPreview);
});

test('raw annotations invalidate master snapshots but rollup-only refresh does not',async()=>{
 await legacy(20,'A',20);let before=await version();
 await db.query('insert into supplier_price_rollups(organization_id,brand_id,normalized_code,refreshed_at)values($1,$2,\'A\',now())',[org,brand]);assert.equal(await version(),before);
 await db.query('update supplier_prices set notes=\'changed without touching timestamp\' where id=$1',[id(20)]);assert.notEqual(await version(),before);
 before=await version();await db.query('update supplier_prices set oem_no=\'new OEM\' where id=$1',[id(20)]);assert.notEqual(await version(),before);
 await publish(100,[{code:'A',price:30}],{supplier:otherSupplier});before=await version();await db.query('update supplier_prices set notes=\'hidden legacy\'');assert.equal(await version(),before);
});

test('preview keeps verified actor/org/input guards and export/version remain service-only',async()=>{
 await db.exec('set role authenticated');assert.equal((await preview()).has_published_scope,false);assert.deepEqual(await catalogPreview(),[]);await assert.rejects(page(),/permission denied/);await db.exec('reset role');
 await db.query("select set_config('request.jwt.claim.sub','',false)");await assert.rejects(preview(),/MASTER_AUTH_REQUIRED/);await assert.rejects(catalogPreview(),/MASTER_AUTH_REQUIRED/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('test.org',$2,false)",[actor,id(99)]);await assert.rejects(preview(),/MASTER_BRAND_SCOPE_INVALID/);await assert.rejects(catalogPreview(),/MASTER_BRAND_SCOPE_INVALID/);
 await db.query("select set_config('test.org',$1,false)",[org]);await assert.rejects(preview('',101),/MASTER_PAGE_INPUT_INVALID/);
 for(const fn of ['cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric)','get_catalog_master_export_version(uuid,uuid,text)']){
  const{rows:[r]}=await db.query("select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service",['public.'+fn]);assert.deepEqual(r,{anon:false,authenticated:false,service:true});
 }
});

test('both forward migrations replay after immutable62 production chain',async()=>{
 const fixture=await createFullReplayDb();try{
 const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));assert.equal(manifest.migration_order.length,62);
 for(const item of manifest.migration_order)await fixture.exec(await readFile(item.file,'utf8'));
 await fixture.exec(await readFile(dir+prior,'utf8'));await fixture.exec(sql);await fixture.exec(sql);
 assert.equal((await fixture.query('select count(*) n from public.cloud_catalog_master_export_page_v3($1,$2)',[org,brand])).rows[0].n,0);
 }finally{await fixture.close();}
});
