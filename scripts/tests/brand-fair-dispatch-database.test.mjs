import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
const org='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002',brand='00000000-0000-0000-0000-000000000003';
async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
create function auth.role()returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;grant usage on schema auth to service_role;
create function current_profile_org_id()returns uuid language sql as $$select null::uuid$$;create function current_profile_role()returns text language sql as $$select 'superadmin'$$;
create function normalize_part_code(text)returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
create table organizations(id uuid primary key);create table profiles(id uuid,organization_id uuid,role text,is_active boolean);create table brands(id uuid primary key,organization_id uuid,name text);
create table catalog_external_sources(id uuid default gen_random_uuid(),organization_id uuid,source_key text,is_active boolean,license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb);
create table catalog_products(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,product_code text,normalized_code text generated always as(normalize_part_code(product_code))stored,description text,description_tr text,weight_kg numeric,ean text,origin text,hs_code text,oem_no text,vehicle text,vehicle_model text,market_segment text,dimensions jsonb,updated_at timestamptz default now());
insert into organizations values('${org}');insert into profiles values('${actor}','${org}','superadmin',true);insert into brands values('${brand}','${org}','Denso');
insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)values('${org}','denso_official_v1',true,'internal_review_required','none','bounded','{"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":true,"allowed_brands":["Denso"],"allowed_evidence_hosts":["www.denso-am.eu"],"approval_actor":"owner","publication_approval_reference":"request"}');
insert into catalog_products(organization_id,brand_id,product_code,origin,hs_code)values('${org}','${brand}','DCRI100360','TR','001234');`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20261019225343_catalog_brand_engine.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../../supabase/migrations/20261019230301_catalog_brand_retry_checkpoints.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../../supabase/migrations/20261022140101_catalog_brand_fair_dispatch.sql',import.meta.url),'utf8'));await db.exec("grant select on public.catalog_external_sources to service_role;set request.jwt.claim.role='service_role'");return db;}
const rpc=async(db,name,args)=> (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;

async function source(db,key,brands){await db.query("insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)values($1,$2,true,'internal_review_required','none','bounded',$3)",[org,key,JSON.stringify({allowed_brands:brands})]);}
async function job(db,{source='denso_official_v1',brand='Denso',status='queued',age='3 hours',cursor=0,total=1,mode='stage',retry=null,lease=null}={}){
 const r=await db.query("insert into catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items,next_index,status,mode,updated_at,retry_after,lease_expires_at)values($1,$2,gen_random_uuid(),$3,$4,$5,$6,$7,now()-$8::interval,$9,$10)returning id",[org,actor,JSON.stringify({brand,source_key:source,adapter:'brand-exact.v1',codes:['A']}),total,cursor,status,mode,age,retry,lease]);return r.rows[0].id;
}
test('large old correction backlog cannot starve a quieter source; selection is read-only and the existing lease still wins',async()=>{const db=await setup();try{
 await source(db,'bulk',['FAG']);await source(db,'wilmink_elring_support_v1',['Elring']);
 const bulk=await job(db,{source:'bulk',brand:'FAG',status:'paused',age:'2 days',cursor:17,total:100,mode:'publish'});
 await job(db,{source:'bulk',brand:'FAG',status:'completed',age:'1 minute',cursor:1});
 const helper=await job(db,{source:'wilmink_elring_support_v1',brand:'Elring',age:'3 hours'});
 const before=(await db.query('select jsonb_agg(to_jsonb(j) order by id)v from catalog_brand_jobs j')).rows[0].v;
 const next=await rpc(db,'next_catalog_brand_dispatch',[]);assert.equal(next.id,helper);assert.deepEqual(Object.keys(next).sort(),['id','organization_id','status']);
 assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(j) order by id)v from catalog_brand_jobs j')).rows[0].v,before);
 const claim=await rpc(db,'claim_catalog_brand_job',[org,helper]);assert(claim.lease_token);assert.equal(await rpc(db,'next_catalog_brand_dispatch',[]),null);
 assert.equal(await rpc(db,'claim_catalog_brand_job',[org,bulk]),null);
 assert.deepEqual((await db.query('select next_index,mode from catalog_brand_jobs where id=$1',[bulk])).rows[0],{next_index:17,mode:'publish'});
}finally{await db.close();}});
test('a recently served brand does not monopolize another brand on the same source',async()=>{const db=await setup();try{
 await source(db,'shared',['FAG','INA']);await job(db,{source:'shared',brand:'FAG',status:'paused',age:'2 days'});await job(db,{source:'shared',brand:'FAG',status:'completed',age:'1 minute',cursor:1});
 const ina=await job(db,{source:'shared',brand:'INA',age:'2 hours'});assert.equal((await rpc(db,'next_catalog_brand_dispatch',[])).id,ina);
}finally{await db.close();}});
test('retry windows, source revocation and failed jobs remain blocked; expired leases can recover',async()=>{const db=await setup();try{
 await source(db,'revoked',['Elring']);await job(db,{source:'revoked',brand:'Elring',age:'3 days'});await db.exec("update catalog_external_sources set is_active=false where source_key='revoked'");
 await job(db,{status:'failed',age:'3 days'});await job(db,{status:'paused',age:'2 days',retry:new Date(Date.now()+3600000).toISOString()});
 assert.equal(await rpc(db,'next_catalog_brand_dispatch',[]),null);
 const expired=await job(db,{status:'running',age:'1 hour',lease:new Date(Date.now()-3600000).toISOString()});assert.equal((await rpc(db,'next_catalog_brand_dispatch',[])).id,expired);
}finally{await db.close();}});
test('the invoker selector is service-only and uses service table grants rather than definer privileges',async()=>{const db=await setup();try{
 const id=await job(db);await db.exec('set role service_role');assert.equal((await rpc(db,'next_catalog_brand_dispatch',[])).id,id);await db.exec('reset role');
 await db.exec("set request.jwt.claim.role='anon'");await assert.rejects(rpc(db,'next_catalog_brand_dispatch',[]),/SERVICE_REQUIRED/);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'next_catalog_brand_dispatch()','execute') ok",[role])).rows[0].ok,false);
 assert.equal((await db.query("select prosecdef from pg_proc where proname='next_catalog_brand_dispatch'")).rows[0].prosecdef,false);
}finally{await db.close();}});
