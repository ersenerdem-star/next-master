import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
const dir='supabase/migrations/';let db;
const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),brand=id(2),pub=id(3),legacy=id(4),actor=id(5),otherOrg=id(6);
const query=(sql,args=[])=>db.query(sql,args);
before(async()=>{
 db=await createFullReplayDb();
 const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));
 for(const m of manifest.migration_order)await db.exec(await readFile(m.file,'utf8'));
 for(const n of ['20261014162139_supplier_admin_release_action_queue','20261014165817_price_list_legacy_scope_compatibility','20261014171235_master_price_mixed_supplier_scopes','20261014175649_supplier_source_commercial_compatibility_guard','20261014183349_supplier_upload_safe_commercial_error_status','20261014193018_supplier_commercial_fields_v2_ingestion','20261014193456_supplier_commercial_fields_v2_readers','20261023185017_continental_automotive_brand_identity'])await db.exec(await readFile(dir+n+'.sql','utf8'));
 // Latest exact SKU source contract used in production.
 for(const n of ['20261106111617_supplier_price_usage_historical_confirmation','20261106111627_supplier_price_usage_control','20261106113154_supplier_price_usage_scoped_rollup_refresh','20261106113533_supplier_price_usage_bounded_rollup_source','20261106113731_supplier_price_usage_rollup_join_plan'])await db.exec(await readFile(dir+n+'.sql','utf8'));
 await query("insert into organizations(id,name)values($1,'Org'),($2,'Other')",[org,otherOrg]);
 await query("insert into suppliers(id,organization_id,name)values($1,$2,'Published'),($3,$2,'Legacy'),($4,$5,'Other')",[pub,org,legacy,id(7),otherOrg]);
 await query("insert into brands(id,organization_id,name)values($1,$2,'Bosch')",[brand,org]);
 await query('insert into auth.users(id)values($1)',[actor]);
 await query("insert into profiles(id,organization_id,email,role,is_active,permissions)values($1,$2,'admin@example.invalid','superadmin',true,'{\"supplier_prices.manage\":true}')",[actor,org]);
 await query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 await query("select set_config('request.jwt.claim.role','authenticated',false)");
 // Seed legacy sources before publishing: the protection trigger is intentionally kept enabled.
 for(const [n,supplier,code,price] of [[10,pub,'SKU1',1],[11,legacy,'SKU1',20],[12,legacy,'SKU2',25]])await query(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,buy_price,currency,valid_from,is_active)values($1,$2,$3,$4,$5,$6,'EUR',current_date,true)`,[id(n),org,supplier,brand,code,price]);
 await query("insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,created_by,status,source_date,total_rows,accepted_rows,source_file_path,source_file_sha256)values($1,$2,$3,$4,$5,'published',current_date,1,1,'test/source.csv',repeat('a',64))",[id(20),org,pub,brand,actor]);
 // Seed an already-published receipt; ingestion guards have their own full replay tests.
 await db.exec("alter table supplier_price_publications disable trigger supplier_publications_require_source_compatibility");
 await query("insert into supplier_price_publications(id,release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)values($1,$2,$3,$4,$5,'published',1,now())",[id(21),id(20),org,pub,brand]);
 await db.exec("alter table supplier_price_publications enable trigger supplier_publications_require_source_compatibility");
 await query("insert into supplier_current_price_pointers(organization_id,supplier_id,brand_id,publication_id,release_id)values($1,$2,$3,$4,$5)",[org,pub,brand,id(21),id(20)]);
 await query("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash)values($1,1,'SKU1','SKU1',10,'EUR',current_date,'accepted',repeat('a',64))",[id(20)]);
});
after(async()=>await db?.close());
const options=async()=> (await query('select * from cloud_current_supplier_commercial_options_core($1,$2,$3)',[org,'SKU1','Bosch'])).rows;
const toggle=async(supplier,enabled,expected)=>query('select set_supplier_price_usage($1,$2,$3,$4) receipt',[supplier,enabled,expected,'test operation']);

test('switch removes legacy and published sources before ranking; preserves pointer ownership and source rows',async()=>{
 assert.deepEqual((await options()).map(x=>Number(x.buy_price)),[10,20]);
 const sourcePage=async()=> (await query('select * from cloud_price_list_source_page($1,$2,null,100)',[org,brand])).rows;
 assert.deepEqual((await sourcePage()).map(x=>Number(x.buy_price)),[10,25]);
 await query('delete from catalog_products where organization_id=$1',[org]);
 assert.equal((await query("select * from cloud_portal_published_price_search_page_v3($1,$2,'SKU',24)",[org,brand])).rows.length,1);
 for(const [n,code] of [[31,'SKU1'],[32,'SKU2']])await query("insert into catalog_products(id,organization_id,brand_id,product_code,description)values($1,$2,$3,$4,'Catalog')",[id(n),org,brand,code]);
 const master=async()=> (await query("select * from cloud_master_page_fast('', $1,1,50,.1,.15)",[brand])).rows;
 assert.equal(Number((await master())[0].supplier_count),2);
 const before=(await query('select md5(jsonb_agg(to_jsonb(p) order by id)::text) hash from supplier_prices p')).rows[0].hash;
 const version=(await query('select get_admin_price_list_export_version($1,$2) v',[org,brand])).rows[0].v;
 await toggle(pub,false,true);
 assert.deepEqual((await options()).map(x=>Number(x.buy_price)),[20]);
 assert.deepEqual((await sourcePage()).map(x=>Number(x.buy_price)),[20,25]);
 assert.equal(Number((await master())[0].supplier_count),1);
 assert.equal((await master())[0].second_price,null);
 assert.equal((await query('select count(*)::int n from supplier_current_price_pointers where supplier_id=$1',[pub])).rows[0].n,1);
 await toggle(legacy,false,true);assert.deepEqual(await options(),[]);
 assert.deepEqual(await sourcePage(),[]);
 assert.equal((await master()).every(x=>x.cheapest_price===null),true);
 assert.deepEqual((await query("select * from cloud_catalog_master_export_page_v3($1,$2,'priced','',null,null,100,.1,.15)",[org,brand])).rows,[]);
 const batch=(await query("select * from cloud_current_supplier_price_options_batch('[{\"code\":\"SKU1\",\"brand\":\"Bosch\"}]')")).rows[0];
 assert.equal(batch.has_published_scope,true);assert.deepEqual(batch.options,[]);
 assert.equal((await query('select md5(jsonb_agg(to_jsonb(p) order by id)::text) hash from supplier_prices p')).rows[0].hash,before);
 assert.notEqual((await query('select get_admin_price_list_export_version($1,$2) v',[org,brand])).rows[0].v,version);
 assert.equal((await query('select price_usage_enabled from suppliers where id=$1',[id(7)])).rows[0].price_usage_enabled,true);
 await toggle(pub,true,false);assert.deepEqual((await options()).map(x=>Number(x.buy_price)),[10]);
});
test('compare-and-set prevents stale actions and role/tenant guards prevent unauthorized changes',async()=>{
 await assert.rejects(()=>toggle(pub,false,false),/STALE/);
 await assert.rejects(()=>toggle(id(7),false,true),/NOT_FOUND/);
 await query("select set_config('request.jwt.claim.sub','',false)");
 await assert.rejects(()=>toggle(pub,false,true),/ADMIN_REQUIRED/);
 await query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 assert.equal((await toggle(pub,true,true)).rows[0].receipt.changed,false);
});
