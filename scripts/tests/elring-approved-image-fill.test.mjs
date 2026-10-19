import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../../supabase/migrations/20261019212836_elring_approved_image_fill.sql',import.meta.url),'utf8');
test('bounded image fill preserves policy, evidence, existing images and replay',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth; create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
 create table organizations(id uuid primary key); create table brands(id uuid primary key,organization_id uuid,name text);
 create table catalog_external_sources(id uuid primary key,organization_id uuid,source_key text,license_posture text,is_active boolean,metadata jsonb);
 create table catalog_import_runs(id uuid primary key,organization_id uuid,input_scope jsonb);
 create table catalog_import_stage(run_id uuid,organization_id uuid,row_index integer,source_payload jsonb,source_key text,product_code text,normalized_code text,source_url text,source_fingerprint text);
 create table catalog_products(id uuid primary key,organization_id uuid,brand_id uuid,normalized_code text,image_url text,updated_at timestamptz);
 insert into organizations values('00000000-0000-0000-0000-000000000001');
 insert into brands values('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Elring');
 insert into catalog_external_sources values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','tecalliance_elring','allowed',false,'{"internal_catalog_persistence_allowed":true}');
 insert into catalog_import_runs values('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','{"source_key":"tecalliance_elring","collection_verified":true,"manifest_fingerprint":"proof"}');`);
 await db.exec(migration);
 await db.exec(`set request.jwt.claim.role='service_role';
 insert into catalog_elring_image_jobs(run_id,organization_id,source_id,brand_id,approval_actor,approval_reference,approved_until,manifest_fingerprint)
 values('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','operator','explicit approval',now()+interval '1 hour','proof');`);
 const url='https://digital-assets.tecalliance.services/images/1600/'+'a'.repeat(40)+'.jpg';
 for(let i=0;i<3;i++){
 const code=`00${i}`;
 const payload={fields:{product_code:code,image_url:url},raw:{mfrName:'ELRING',dataSupplierId:10,articleNumber:code,images:[{assetSource:'article',imageURL1600:url}]}};
 await db.query('insert into catalog_import_stage values($1,$2,$3,$4,$5,$6,$6,$7,$8)',['00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',i,payload,'tecalliance_elring',code,'https://web.tecalliance.net/elring/en/home','evidence']);
 if(i<2)await db.query('insert into catalog_products values($1,$2,$3,$4,$5,now())',[`00000000-0000-0000-0000-00000000001${i}`,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',code,i?'https://existing.example/image.jpg':null]);
 }
 const call=(batch=25)=>db.query('select fill_approved_elring_images($1,$2) as result',['00000000-0000-0000-0000-000000000004',batch]);
 await assert.rejects(call(26),/Invalid image batch/);
 await db.exec("set request.jwt.claim.role='anon'"); await assert.rejects(call(),/Service role required/);
 await db.exec("set request.jwt.claim.role='service_role'; update catalog_external_sources set is_active=true");
 await assert.rejects(call(),/scope mismatch/);await db.exec('update catalog_external_sources set is_active=false');
 await db.exec("update catalog_import_stage set source_payload=jsonb_set(source_payload,'{raw,mfrName}','\"OTHER\"') where row_index=0");
 await assert.rejects(call(),/evidence mismatch/);
 assert.equal((await db.query('select count(*)::int n from catalog_elring_image_events')).rows[0].n,0);
 await db.exec("update catalog_import_stage set source_payload=jsonb_set(source_payload,'{raw,mfrName}','\"ELRING\"') where row_index=0");
 const first=(await call(1)).rows[0].result;assert.equal(first.scanned,1);assert.equal(first.applied,1);assert.equal(first.status,'running');
 const last=(await call()).rows[0].result;assert.equal(last.scanned,3);assert.equal(last.applied,1);assert.equal(last.status,'completed');
 assert.deepEqual((await db.query('select outcome from catalog_elring_image_events order by row_index')).rows.map(x=>x.outcome),['applied','preserved','product_missing']);
 assert.equal((await call()).rows[0].result.applied,1);
 assert.equal((await db.query('select count(*)::int n from catalog_elring_image_events')).rows[0].n,3);
 assert.equal((await db.query('select is_active from catalog_external_sources')).rows[0].is_active,false);
 }finally{await db.close();}
});
test('image-only updates preserve search text while search inputs still rebuild it',async()=>{
 const db=new PGlite();try{
 const columns=['product_code','normalized_code','ean','normalized_ean','description','oem_no','normalized_oem','vehicle','vehicle_model','hs_code','origin','market_segment','lifecycle_status','lifecycle_note','search_text','image_url'];
 await db.exec(`create table brands(id uuid primary key,name text); create table catalog_products(id integer,brand_id uuid,${columns.map(c=>c+' text').join(',')});
 create function catalog_product_search_text(variadic terms text[]) returns text language sql as $$select array_to_string(terms,' ')$$;
 insert into catalog_products(id,product_code,description) values(1,'000.140','Seal Ring');`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261019213231_catalog_image_update_search_guard.sql',import.meta.url),'utf8'));
 await db.exec('create trigger search_guard before insert or update on catalog_products for each row execute function set_catalog_product_search_text()');
 await db.exec("update catalog_products set image_url='https://example.com/image.jpg' where id=1");
 assert.equal((await db.query('select search_text from catalog_products')).rows[0].search_text,null);
 await db.exec("update catalog_products set description='New description' where id=1");
 assert.match((await db.query('select search_text from catalog_products')).rows[0].search_text,/New description/);
 await db.exec("insert into catalog_products(id,product_code,description) values(2,'002','Inserted description')");
 assert.match((await db.query('select search_text from catalog_products where id=2')).rows[0].search_text,/Inserted description/);
 }finally{await db.close();}
});
