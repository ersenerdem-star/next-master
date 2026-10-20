import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../../supabase/migrations/20261020174458_elring_completion_audit.sql',import.meta.url),'utf8');
const org='00000000-0000-0000-0000-000000000001',brand='00000000-0000-0000-0000-000000000002',source='00000000-0000-0000-0000-000000000003',run='00000000-0000-0000-0000-000000000004';
test('completion preserves image history, source pause, populated fields and atomic cursor',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create function auth.role() returns text language sql as $$select current_setting('test.role',true)$$;
 create table organizations(id uuid primary key);
 create table brands(id uuid primary key,organization_id uuid,name text);
 create table catalog_external_sources(id uuid primary key,organization_id uuid,source_key text,is_active boolean,license_posture text,metadata jsonb);
 create table catalog_import_runs(id uuid primary key,organization_id uuid,status text,staged_rows integer,input_scope jsonb);
 create table catalog_import_stage(run_id uuid,organization_id uuid,row_index integer,source_key text,product_code text,normalized_code text,source_fingerprint text,source_payload jsonb);
 create table catalog_provider_stage_publications(run_id uuid,brand_id uuid,source_id uuid,status text,processed_rows integer);
 create table catalog_products(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,product_code text,normalized_code text,
  description text,weight_kg numeric,origin text,hs_code text,ean text,oem_no text,dimensions jsonb,vehicle text,vehicle_model text,market_segment text,image_url text,lifecycle_status text,lifecycle_note text,updated_at timestamptz);
 create table catalog_elring_image_events(run_id uuid,row_index integer,outcome text,product_code text,candidate text,evidence_fingerprint text);
 create function enrich_elring_provider_stage_batch(uuid,uuid,integer,integer) returns jsonb language plpgsql as $$
 begin
 if not (select is_active from catalog_external_sources) then raise exception 'Source not active in transaction'; end if;
 update catalog_products set dimensions='{"length_mm":10}' where dimensions is null;
 return jsonb_build_object('processed',least($4,2-$3));end $$;
 create function apply_elring_provider_lifecycle_batch(uuid,uuid,integer,integer) returns jsonb language sql as $$select jsonb_build_object('processed',least($4,2-$3),'relations_inserted',1,'no_explicit_signal',least($4,2-$3))$$;
 insert into organizations values('${org}');insert into brands values('${brand}','${org}','Elring');
 insert into catalog_external_sources values('${source}','${org}','tecalliance_elring',false,'allowed','{"internal_catalog_persistence_allowed":true}');
 insert into catalog_import_runs values('${run}','${org}','staged',2,'{"source_key":"tecalliance_elring","collection_verified":true,"manifest_fingerprint":"proof"}');
 insert into catalog_provider_stage_publications values('${run}','${brand}','${source}','completed',2);`);
 await db.exec(migration);
 for(let i=0;i<2;i++){
  const code=`00${i}`,candidate='https://digital-assets.tecalliance.services/images/1600/'+'a'.repeat(40)+'.jpg';
  await db.query('insert into catalog_import_stage values($1,$2,$3,$4,$5,$5,$6,$7)',[run,org,i,'tecalliance_elring',code,'fp'+i,{fields:{image_url:candidate},raw:{mfrName:'ELRING',dataSupplierId:10,articleNumber:code,images:[{assetSource:'article',imageURL1600:candidate}]}}]);
  await db.query('insert into catalog_products(organization_id,brand_id,product_code,normalized_code,image_url) values($1,$2,$3,$3,$4)',[org,brand,code,i?'https://existing.example/image.jpg':null]);
  await db.query('insert into catalog_elring_image_events values($1,$2,$3,$4,$5,$6)',[run,i,'product_missing',code,candidate,'fp'+i]);
 }
 for(const phase of ['images','enrichment','lifecycle'])await db.query(`insert into catalog_elring_completion_jobs(run_id,phase,organization_id,source_id,brand_id,manifest_fingerprint,approval_reference,approved_until) values($1,$2,$3,$4,$5,'proof','explicit instruction',now()+interval '1 day')`,[run,phase,org,source,brand]);
 const call=(phase='images',n=25)=>db.query('select run_elring_completion_batch($1,$2,$3) as result',[run,phase,n]);
 await db.exec("set test.role='anon'");await assert.rejects(call(),/Service role required/);
 await db.exec("set test.role='service_role'");await assert.rejects(call('images',26),/Invalid completion batch/);
 await db.exec("update catalog_elring_completion_jobs set approved_until=now()-interval '1 second' where phase='images'");await assert.rejects(call(),/approval missing or expired/);
 await db.exec("update catalog_elring_completion_jobs set approved_until=now()+interval '1 day';update catalog_external_sources set is_active=true");await assert.rejects(call(),/scope mismatch/);
 await db.exec("update catalog_external_sources set is_active=false;update catalog_import_stage set source_fingerprint='tampered' where row_index=1");
 await assert.rejects(call(),/evidence mismatch/);
 assert.equal((await db.query('select count(*)::int n from catalog_elring_completion_events')).rows[0].n,0);
 assert.equal((await db.query("select image_url from catalog_products where product_code='000'")).rows[0].image_url,null);
 await db.exec("update catalog_import_stage set source_fingerprint='fp1' where row_index=1");
 const first=(await call('images',1)).rows[0].result;assert.equal(first.cursor,0);assert.equal(first.changed,1);
 const last=(await call()).rows[0].result;assert.equal(last.status,'completed');assert.equal(last.processed,2);assert.equal(last.changed,1);
 assert.equal((await db.query("select image_url from catalog_products where product_code='001'")).rows[0].image_url,'https://existing.example/image.jpg');
 assert.equal((await call()).rows[0].result.processed,2);
 assert.equal((await db.query("select count(*)::int n from catalog_elring_image_events where outcome='product_missing'")).rows[0].n,2);
 const enriched=(await call('enrichment')).rows[0].result;assert.equal(enriched.changed,2);assert.equal(enriched.status,'completed');
 assert.equal((await db.query('select is_active from catalog_external_sources')).rows[0].is_active,false);
 const lifecycle=(await call('lifecycle')).rows[0].result;assert.equal(lifecycle.totals.relations_inserted,1);assert.equal(lifecycle.totals.no_explicit_signal,2);
 assert.equal((await db.query('select is_active from catalog_external_sources')).rows[0].is_active,false);
 for(const role of ['anon','authenticated'])assert.equal((await db.query(`select has_function_privilege($1,'run_elring_completion_batch(uuid,text,integer)','execute') as allowed`,[role])).rows[0].allowed,false);
 await db.exec(`alter table catalog_import_stage add column source_url text default 'https://web.tecalliance.net/elring/en/home';
 create table catalog_product_source_records(organization_id uuid,catalog_product_id uuid,source_key text,source_url text,source_product_id text,source_version text,payload_fingerprint text,
  unique(organization_id,catalog_product_id,source_key,payload_fingerprint));
 create table product_attribute_conflicts(organization_id uuid,product_id uuid,brand_id uuid,product_code text,field_name text,existing_value text,incoming_value text,
  normalized_incoming_value text,source_type text,source_reference text,status text default 'pending_review',last_detected_at timestamptz,detection_count integer default 1,
  constraint product_attribute_conflicts_field_name_check check(field_name in ('description','origin','hs_code','weight_kg','ean')));
 create unique index conflict_key on product_attribute_conflicts(organization_id,product_id,field_name,normalized_incoming_value) where status='pending_review';
 create function normalize_product_conflict_value(text,text) returns text language sql as $$select lower($2)$$;
 create function catalog_provider_jsonb_sha256(jsonb) returns text language sql as $$select md5($1::text)||md5($1::text)$$;
 create function apply_catalog_provider_enrichment_protocol(jsonb,text,text) returns jsonb language plpgsql as $$
 begin update catalog_products set vehicle=coalesce(vehicle,$1->0->>'vehicle'),vehicle_model=coalesce(vehicle_model,$1->0->>'vehicle_model')
 where product_code=$1->0->>'product_code';return '{}'::jsonb;end $$;
 update catalog_import_stage set source_payload=jsonb_set(source_payload,'{raw,genericArticles}','[{"legacyArticleId":42,"linkageTargetTypes":["V"]}]');
 update catalog_products set vehicle='MANUAL',vehicle_model='Existing model' where product_code='000';`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261020175239_catalog_provider_conflict_fields.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261020180048_catalog_provider_conflict_fields_validate.sql',import.meta.url),'utf8'));
 await assert.rejects(db.exec("insert into product_attribute_conflicts(field_name) values('arbitrary_field')"),/check constraint/);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261020175001_elring_complete_fitment_apply.sql',import.meta.url),'utf8'));
 await db.query(`insert into catalog_elring_completion_jobs(run_id,phase,organization_id,source_id,brand_id,manifest_fingerprint,approval_reference,approved_until) values($1,'fitment',$2,$3,$4,'proof','explicit instruction',now()+interval '1 day')`,[run,org,source,brand]);
 const fitment={product_code:'000',stage_fingerprint:'fp0',complete:true,evidence_manifest_sha256:'a'.repeat(64),coverage:[{article_id:42,target_type:'PO',pairs_count:1,resolved_count:1,target_keys:['P:123'],pairs_fingerprint:'b'.repeat(64),complete:true}],vehicles:[{target_type:'P',target_id:123,manuDesc:'AUDI',modelDesc:'A4'}]};
 const fit=(index,evidence)=>db.query('select apply_elring_complete_vehicle_fitment($1,$2,$3) as result',[run,index,evidence]);
 await assert.rejects(fit(0,{...fitment,complete:false}),/Complete vehicle evidence required/);
 await assert.rejects(fit(0,{...fitment,coverage:[]}),/Incomplete vehicle linkage coverage/);
 await assert.rejects(fit(0,{...fitment,vehicles:[]}),/Vehicle target coverage mismatch|Vehicle details missing/);
 await assert.rejects(fit(0,{...fitment,vehicles:[{target_type:'P',target_id:999,manuDesc:'AUDI',modelDesc:'A4'}]}),/Vehicle target coverage mismatch/);
 assert.equal((await fit(0,fitment)).rows[0].result.processed,1);
 assert.equal((await fit(0,fitment)).rows[0].result.processed,1);
 await assert.rejects(fit(0,{...fitment,evidence_manifest_sha256:'c'.repeat(64)}),/Fitment replay evidence mismatch/);
 const product=(await db.query("select vehicle,vehicle_model from catalog_products where product_code='000'")).rows[0];assert.deepEqual(product,{vehicle:'MANUAL',vehicle_model:'Existing model'});
 assert.equal((await db.query('select count(*)::int n from product_attribute_conflicts')).rows[0].n,1);
 const second={...fitment,product_code:'001',stage_fingerprint:'fp1'};
 const done=(await fit(1,second)).rows[0].result;assert.equal(done.status,'completed');assert.equal(done.changed,1);
 assert.equal((await db.query("select vehicle_model from catalog_products where product_code='001'")).rows[0].vehicle_model,'AUDI A4');
 assert.equal((await db.query('select is_active from catalog_external_sources')).rows[0].is_active,false);
 for(const role of ['anon','authenticated'])assert.equal((await db.query(`select has_function_privilege($1,'apply_elring_complete_vehicle_fitment(uuid,integer,jsonb)','execute') as allowed`,[role])).rows[0].allowed,false);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261020175739_elring_bounded_index_maintenance.sql',import.meta.url),'utf8'));
 await assert.rejects(db.query('select maintain_elring_completion_index($1,$2)',[run,'unrelated_index']),/Unapproved maintenance index/);
 await db.exec("create index idx_catalog_products_search_text_trgm on catalog_products using gin(to_tsvector('english',description))");
 assert.equal((await db.query('select maintain_elring_completion_index($1,$2) result',[run,'idx_catalog_products_search_text_trgm'])).rows[0].result.pages,0);
 for(const fn of ['maintain_elring_completion_index(uuid,text)','cancel_elring_completion_maintenance(uuid)'])for(const role of ['anon','authenticated'])assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,fn,'execute'])).rows[0].allowed,false);
 }finally{await db.close();}
});
