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
create table catalog_external_sources(id uuid default gen_random_uuid(),organization_id uuid,source_key text,is_active boolean,license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb);
create table catalog_products(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,product_code text,normalized_code text generated always as(normalize_part_code(product_code))stored,description text,description_tr text,weight_kg numeric,ean text,origin text,hs_code text,oem_no text,vehicle text,vehicle_model text,market_segment text,dimensions jsonb,updated_at timestamptz default now());
create table catalog_product_source_records(organization_id uuid,catalog_product_id uuid,source_key text,source_url text,source_product_id text,source_version text,payload_fingerprint text,unique(organization_id,catalog_product_id,source_key,payload_fingerprint));
create table catalog_observation_audit_ledger(organization_id uuid,actor_id uuid,action text,evidence_reference text,payload jsonb);
create table price_guard(value numeric);insert into price_guard values(99.25);
insert into organizations values('${org}');insert into profiles values('${actor}','${org}','superadmin',true);insert into brands values('${brand}','${org}','Kolbenschmidt');
insert into catalog_products(organization_id,brand_id,product_code,description,ean,origin,hs_code,oem_no)values('${org}','${brand}','41504600','Owner description','4028977841316','TR','001234','OLD');
insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)values('${org}','wilmink_kolbenschmidt_v1',true,'internal_review_required','none','bounded','{"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":true,"allowed_brands":["Kolbenschmidt"],"allowed_evidence_hosts":["www.wilminkengineparts.com"],"approval_actor":"owner","publication_approval_reference":"request"}');`);
 for(const file of ['20261019225343_catalog_brand_engine.sql','20261019230301_catalog_brand_retry_checkpoints.sql','20261021191250_kolbenschmidt_wilmink_discovery.sql'])await db.exec(readFileSync(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.exec("set request.jwt.claim.role='service_role'");return db;}
async function ready(db){
 const j=await rpc(db,'start_catalog_wilmink_scan',[org,actor,crypto.randomUUID()]),claim=await rpc(db,'claim_catalog_brand_job',[org,j.id]);
 const before=(await db.query('select to_jsonb(p)b from catalog_products p')).rows[0].b;
 const product=wilminkReview(parseWilminkProduct(html,{sourceUrl:url}),before),page={pageUrl:WILMINK_BRAND_URL,page:1,pageFingerprint:'a'.repeat(64),urls:[url],nextUrl:WILMINK_BRAND_URL+'?page=2',lastPage:349};
 const cp={page,captured:[product]};await rpc(db,'checkpoint_catalog_brand_job',[org,j.id,claim.lease_token,0,null,cp,'pending',null,false,null]);return {j:claim,page,product};
}
test('source scan is idempotent, seals a reviewed child and next page atomically without changing catalog or prices',async()=>{const db=await setup();try{
 const {j,page,product}=await ready(db),again=await rpc(db,'start_catalog_wilmink_scan',[org,actor,crypto.randomUUID()]);assert.equal(again.id,j.id);
 const before=(await db.query('select to_jsonb(p)b from catalog_products p')).rows[0].b;
 const result=await rpc(db,'complete_catalog_wilmink_discovery',[org,j.id,j.lease_token,page,[product]]);assert.equal(result.matched,1);assert.equal(result.observed,1);
 assert.deepEqual((await db.query('select to_jsonb(p)b from catalog_products p')).rows[0].b,before);assert.equal((await db.query('select value::float from price_guard')).rows[0].value,99.25);
 const child=(await db.query('select status,next_index,manifest from catalog_brand_jobs where id=$1',[result.review_job])).rows[0];assert.equal(child.status,'reviewed');assert.equal(child.next_index,1);assert.deepEqual(child.manifest.codes,['41504600']);
 const receipt=(await db.query('select source_product_id,source_url from catalog_product_source_records')).rows[0];assert.deepEqual(receipt,{source_product_id:'WG1380527',source_url:url});
 const status=await rpc(db,'get_catalog_wilmink_status',[org]);assert.equal(status.pages,1);assert.equal(status.lastPage,349);assert.equal(status.matched,1);assert.equal(status.active,1);
 await rpc(db,'schedule_catalog_brand_job',[org,result.review_job,true]);const apply=await rpc(db,'claim_catalog_brand_job',[org,result.review_job]);
 const applied=await rpc(db,'apply_catalog_brand_job_item',[org,apply.id,apply.lease_token,0]);assert.equal(applied.fields.origin,'source_missing');assert.equal(applied.fields.description,'source_missing');assert(applied.changes.oem_no.startsWith('OLD; '));
 assert.equal((await db.query('select origin,hs_code,description from catalog_products')).rows[0].description,'Owner description');assert.equal((await db.query('select value::float from price_guard')).rows[0].value,99.25);
}finally{await db.close();}});
test('wrong source URL, immutable checkpoint, current tenant, actor and lease are enforced before any stage receipt',async()=>{const db=await setup();try{
 const {j,page,product}=await ready(db),args=[org,j.id,j.lease_token,page,[product]];
 await assert.rejects(rpc(db,'complete_catalog_wilmink_discovery',[actor,...args.slice(1)]),/LEASE_INVALID/);
 await assert.rejects(rpc(db,'complete_catalog_wilmink_discovery',[org,j.id,crypto.randomUUID(),page,[product]]),/LEASE_INVALID/);
 await assert.rejects(rpc(db,'complete_catalog_wilmink_discovery',[org,j.id,j.lease_token,{...page,nextUrl:WILMINK_BRAND_URL+'?page=3'},[product]]),/RECEIPT_INVALID/);
 const evil={...product,sourceUrl:'https://evil.invalid/en/piston/wg1380527'},badpage={...page,urls:[evil.sourceUrl]};await db.query('update catalog_brand_job_items set checkpoint=$1 where job_id=$2',[JSON.stringify({page:badpage,captured:[evil]}),j.id]);
 await assert.rejects(rpc(db,'complete_catalog_wilmink_discovery',[org,j.id,j.lease_token,badpage,[evil]]),/PRODUCT_URL_INVALID/);
 await db.exec("set request.jwt.claim.role='anon'");await assert.rejects(rpc(db,'start_catalog_wilmink_scan',[org,actor,crypto.randomUUID()]),/SERVICE_REQUIRED/);
 assert.equal((await db.query("select has_function_privilege('authenticated','complete_catalog_wilmink_discovery(uuid,uuid,uuid,jsonb,jsonb)','execute') allowed")).rows[0].allowed,false);
 assert.equal((await db.query('select count(*)::int n from catalog_product_source_records')).rows[0].n,0);
}finally{await db.close();}});
test('source revocation preserves pending work and an out-of-assortment signal never changes canonical lifecycle',async()=>{const db=await setup();try{
 const {j,page,product}=await ready(db);await db.exec('update catalog_external_sources set is_active=false');
 await assert.rejects(rpc(db,'complete_catalog_wilmink_discovery',[org,j.id,j.lease_token,page,[product]]),/SOURCE_UNAVAILABLE/);
 assert.equal((await db.query('select next_index from catalog_brand_jobs where id=$1',[j.id])).rows[0].next_index,0);
 assert.equal((await db.query('select count(*)::int n from catalog_product_source_records')).rows[0].n,0);
}finally{await db.close();}});
