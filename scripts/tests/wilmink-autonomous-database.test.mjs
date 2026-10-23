import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {parseWilminkProduct,wilminkReview,WILMINK_BRAND_URL} from '../../netlify/functions/_shared/catalog/wilmink-kolbenschmidt.mjs';
const org='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',brand='00000000-0000-4000-8000-000000000003';
const html=readFileSync(new URL('./fixtures/wilmink-kolbenschmidt-41504600.html',import.meta.url),'utf8'),url='https://www.wilminkengineparts.com/en/piston/wg1380527';
const rpc=async(db,name,args=[])=> (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
create function auth.role()returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
create function current_profile_org_id()returns uuid language sql as $$select '${org}'::uuid$$;create function current_profile_role()returns text language sql as $$select 'superadmin'$$;
create function normalize_part_code(text)returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
create table organizations(id uuid primary key);create table profiles(id uuid,organization_id uuid,role text,is_active boolean);create table brands(id uuid primary key,organization_id uuid,name text);
create table catalog_external_sources(base_url text,id uuid default gen_random_uuid(),organization_id uuid,source_key text,is_active boolean,license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb);
create table catalog_products(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,product_code text,normalized_code text generated always as(normalize_part_code(product_code))stored,description text,description_tr text,weight_kg numeric,ean text,origin text,hs_code text,oem_no text,vehicle text,vehicle_model text,market_segment text,dimensions jsonb,updated_at timestamptz default now());
create table catalog_product_source_records(organization_id uuid,catalog_product_id uuid,source_key text,source_url text,source_product_id text,source_version text,payload_fingerprint text,unique(organization_id,catalog_product_id,source_key,payload_fingerprint));
create table catalog_observation_audit_ledger(organization_id uuid,actor_id uuid,action text,evidence_reference text,payload jsonb);
create table price_guard(value numeric);insert into price_guard values(99.25);
insert into organizations values('${org}');insert into profiles values('${actor}','${org}','superadmin',true);insert into brands values('${brand}','${org}','Kolbenschmidt');
insert into catalog_products(organization_id,brand_id,product_code,description,ean,origin,hs_code,oem_no)values('${org}','${brand}','41504600','Owner description','4028977841316','TR','001234','OLD');
insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)values('${org}','wilmink_kolbenschmidt_v1',true,'internal_review_required','none','bounded','{"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":true,"allowed_brands":["Kolbenschmidt"],"allowed_evidence_hosts":["www.wilminkengineparts.com"],"approval_actor":"owner","publication_approval_reference":"request"}');`);
 for(const file of ['20261019225343_catalog_brand_engine.sql','20261019230301_catalog_brand_retry_checkpoints.sql','20261021191250_kolbenschmidt_wilmink_discovery.sql','20261021192534_wilmink_ean_hold_reporting.sql','20261022105853_wilmink_elring_ina_support.sql','20261022111100_wilmink_support_hold_details.sql'])await db.exec(readFileSync(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.exec("set request.jwt.claim.role='service_role'");return db;}

const supportUrl='https://www.wilminkengineparts.com/en/shaft-seal-crankshaft/wg1194774',supportBrand='00000000-0000-4000-8000-000000000004';
async function supportReady(db){
 await db.query("insert into brands values($1,$2,'Elring')",[supportBrand,org]);
 await db.query("insert into catalog_products(organization_id,brand_id,product_code,description,ean,origin,hs_code,oem_no)values($1,$2,'750.330','Owner description','4041248525906','TR','001234','OLD')",[org,supportBrand]);
 await db.query(`insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)values($1,'wilmink_elring_support_v1',true,'internal_review_required','none','bounded',$2)`,[org,JSON.stringify({brand_engine_read_allowed:true,brand_engine_enrichment_allowed:true,allowed_brands:['Elring'],allowed_evidence_hosts:['www.wilminkengineparts.com'],approval_actor:'owner',publication_approval_reference:'request'})]);
 const j=await rpc(db,'start_catalog_wilmink_support',[org,actor,crypto.randomUUID(),'Elring',[supportUrl]]),claim=await rpc(db,'claim_catalog_brand_job',[org,j.id]);
 const before=(await db.query('select to_jsonb(p)b from catalog_products p where brand_id=$1',[supportBrand])).rows[0].b;
 const fixture=readFileSync(new URL('./fixtures/wilmink-elring-product.html',import.meta.url),'utf8');
 const product=wilminkReview(parseWilminkProduct(fixture,{sourceUrl:supportUrl,expectedBrand:'Elring'}),before);
 const page={pageUrl:null,page:null,pageFingerprint:'a'.repeat(64),urls:[supportUrl],nextUrl:null,lastPage:null};
 await rpc(db,'checkpoint_catalog_brand_job',[org,j.id,claim.lease_token,0,null,{page,captured:[product]},'pending',null,false,null]);return {j:claim,page,product,before};
}

async function activate(db){
 await db.exec("update catalog_external_sources set metadata=metadata||'{\"approval_reference\":\"user-wilmink-support-elring-ina-continue-2026-10-22\"}'::jsonb where source_key='wilmink_elring_support_v1'");
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261023114529_catalog_wilmink_autonomous_completion.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261023120415_catalog_wilmink_progress.sql',import.meta.url),'utf8'));
}
test('autonomous admission queues only sealed owner-approved packages, preserves facts and prices, and is idempotent',async()=>{const db=await setup();try{
 const {j,page,product}=await supportReady(db);const sealed=await rpc(db,'complete_catalog_wilmink_support',[org,j.id,j.lease_token,page,[product]]);
 await activate(db);const admitted=await rpc(db,'admit_catalog_wilmink_application');assert.equal(admitted.id,sealed.review_job);assert.equal(admitted.status,'queued');assert.equal(await rpc(db,'admit_catalog_wilmink_application'),null);
 assert.deepEqual((await db.query('select observation from catalog_brand_job_items where job_id=$1',[admitted.id])).rows[0].observation,product);
 const claim=await rpc(db,'claim_catalog_brand_job',[org,admitted.id]);await db.exec("update catalog_external_sources set metadata=metadata||'{\"automatic_apply\":false}'::jsonb where source_key='wilmink_elring_support_v1'");await assert.rejects(rpc(db,'apply_catalog_wilmink_automatic_item',[org,admitted.id,claim.lease_token,0]),/REVOKED/);await db.exec("update catalog_external_sources set metadata=metadata||'{\"automatic_apply\":true}'::jsonb where source_key='wilmink_elring_support_v1'");
 const applied=await rpc(db,'apply_catalog_wilmink_automatic_item',[org,admitted.id,claim.lease_token,0]);assert(applied.changes.oem_no.startsWith('OLD; '));
 const progress=await rpc(db,'get_catalog_wilmink_application_progress',[org,'wilmink_elring_support_v1']);assert.equal(progress.updatedProducts,1);assert.equal(progress.pendingProducts,0);assert(progress.lastAppliedAt);assert.equal((await rpc(db,'get_catalog_wilmink_application_progress',[actor,'wilmink_elring_support_v1'])).updatedProducts,0);
 assert.deepEqual((await db.query('select description,origin,hs_code from catalog_products where brand_id=$1',[supportBrand])).rows[0],{description:'Owner description',origin:'TR',hs_code:'001234'});
 assert.equal((await db.query('select value::float from price_guard')).rows[0].value,99.25);
 assert.equal((await db.query("select manifest->'automatic_application'->>'policy' policy from catalog_brand_jobs where id=$1",[admitted.id])).rows[0].policy,'wilmink-missing-only.v1');
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'admit_catalog_wilmink_application()','execute') ok",[role])).rows[0].ok,false);
 assert.equal((await db.query("select prosecdef from pg_proc where proname='admit_catalog_wilmink_application'")).rows[0].prosecdef,false);
}finally{await db.close();}});
test('revocation, manual jobs, malformed observations and pricing fields cannot gain automatic admission',async()=>{const db=await setup();try{
 const {j,page,product}=await supportReady(db);const sealed=await rpc(db,'complete_catalog_wilmink_support',[org,j.id,j.lease_token,page,[product]]);await activate(db);
 await db.exec("update catalog_external_sources set is_active=false where source_key='wilmink_elring_support_v1'");assert.equal(await rpc(db,'admit_catalog_wilmink_application'),null);
 await db.exec("update catalog_external_sources set is_active=true where source_key='wilmink_elring_support_v1'");
 for(const patch of [{fields:{price:123}},{fields:[]},{issues:{}},{brand:'INA'},{sourceUrl:'https://example.invalid/en/test/wg123'}]){
  await db.query('update catalog_brand_job_items set observation=$1 where job_id=$2',[JSON.stringify({...product,...patch}),sealed.review_job]);assert.equal(await rpc(db,'admit_catalog_wilmink_application'),null);
 }
 await db.query('update catalog_brand_job_items set observation=$1 where job_id=$2',[JSON.stringify(product),sealed.review_job]);
 await db.query("update catalog_brand_jobs set manifest=manifest-'discovery_job' where id=$1",[sealed.review_job]);assert.equal(await rpc(db,'admit_catalog_wilmink_application'),null);
 assert.equal((await db.query('select value::float from price_guard')).rows[0].value,99.25);
}finally{await db.close();}});
test('only transient failed Wilmink discovery recovers after cooldown; checkpoint and source access are retained',async()=>{const db=await setup();try{
 const {j}=await supportReady(db);await activate(db);
 await db.query("update catalog_brand_jobs set status='failed',error_message='fetch failed',updated_at=now()-interval '5 minutes' where id=$1",[j.id]);assert.equal(await rpc(db,'next_catalog_brand_dispatch'),null);
 await db.query("update catalog_brand_jobs set updated_at=now()-interval '1 hour' where id=$1",[j.id]);assert.equal((await rpc(db,'next_catalog_brand_dispatch')).id,j.id);
 const before=(await db.query('select checkpoint from catalog_brand_job_items where job_id=$1',[j.id])).rows[0].checkpoint;
 await rpc(db,'schedule_catalog_brand_job',[org,j.id,false]);assert.deepEqual((await db.query('select checkpoint from catalog_brand_job_items where job_id=$1',[j.id])).rows[0].checkpoint,before);
 await db.query("update catalog_brand_jobs set status='failed',error_message='WILMINK_HTTP_403',updated_at=now()-interval '1 hour' where id=$1",[j.id]);assert.equal(await rpc(db,'next_catalog_brand_dispatch'),null);
}finally{await db.close();}});
