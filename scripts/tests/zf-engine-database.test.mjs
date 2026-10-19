import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../../supabase/migrations/20261019214518_zf_exact_catalog_engine.sql',import.meta.url),'utf8');
const org='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002',brand='00000000-0000-0000-0000-000000000003';
async function setup(){const db=new PGlite();await db.exec(`
create role anon;create role authenticated;create role service_role;create schema auth;
create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
create function current_profile_org_id() returns uuid language sql as $$select null::uuid$$;
create function current_profile_role() returns text language sql as $$select 'superadmin'$$;
create function normalize_part_code(text) returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
create function catalog_provider_jsonb_sha256(jsonb) returns text language sql as $$select md5($1::text)$$;
create table organizations(id uuid primary key);create table profiles(id uuid,organization_id uuid,role text,is_active boolean);
create table brands(id uuid primary key,organization_id uuid,name text);
create table catalog_external_sources(id uuid default gen_random_uuid(),organization_id uuid,source_key text,is_active boolean,license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb);
create table catalog_products(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,product_code text,normalized_code text generated always as(normalize_part_code(product_code)) stored,description text,weight_kg numeric,ean text,origin text,hs_code text,lifecycle_status text default 'active',lifecycle_note text,updated_at timestamptz default now());
create table item_code_references(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,old_code text,new_code text,reason text,is_active boolean default true,normalized_old_code text generated always as(normalize_part_code(old_code)) stored,normalized_new_code text generated always as(normalize_part_code(new_code)) stored);
create table catalog_product_source_records(id uuid primary key default gen_random_uuid(),organization_id uuid,catalog_product_id uuid,source_key text,source_url text,source_product_id text,source_version text,payload_fingerprint text,unique(organization_id,catalog_product_id,source_key,payload_fingerprint));
create schema extensions;create function extensions.digest(text,text) returns bytea language sql immutable as $$select decode(md5($1),'hex')$$;
create function normalize_catalog_relation_code(text) returns text language sql immutable as $$select regexp_replace(trim(coalesce($1,'')),'\\s+','','g')$$;
create table catalog_product_relations(id uuid primary key default gen_random_uuid(),organization_id uuid,catalog_product_id uuid,relation_type text,related_brand text,related_product_code text,related_oem_no text,related_description text,source_record_id uuid,relation_fingerprint text,unique(organization_id,catalog_product_id,relation_fingerprint));
insert into organizations values('${org}');insert into profiles values('${actor}','${org}','superadmin',true);insert into brands values('${brand}','${org}','Sachs');
insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata) values('${org}','zf_group_official_v2',true,'internal_review_required','none','bounded','{"allowed_brands":["Sachs"],"automated_read_only_approved":true,"internal_observation_allowed":true,"internal_catalog_correction_allowed":true,"approval_actor":"user","publication_approval_reference":"request"}');
insert into catalog_products(organization_id,brand_id,product_code,description,weight_kg,ean) values('${org}','${brand}','318189','Wrong description',4.366,'4013872954728'),('${org}','${brand}','350038','User corrected',4.33,'4059923045922');`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20261019220300_catalog_relation_digest_schema.sql',import.meta.url),'utf8'));await db.exec(migration);await db.exec(readFileSync(new URL('../../supabase/migrations/20261019220052_zf_review_projection_bounds.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../../supabase/migrations/20261019221432_zf_corrupt_weight_baseline.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../../supabase/migrations/20261019222722_zf_reviewed_metadata_quarantine.sql',import.meta.url),'utf8'));await db.exec("set request.jwt.claim.role='service_role'");return db;}
async function rpc(db,name,args){const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');return (await db.query(`select ${name}(${placeholders}) r`,args)).rows[0].r;}
async function start(db,codes=['318189']){const key=crypto.randomUUID();const job=await rpc(db,'start_catalog_zf_job',[org,actor,codes,'Sachs',key]);return {job,key};}
async function receipt(db,code='318189',options={}){
 const before=(await db.query('select to_jsonb(p) v from catalog_products p where product_code=$1',[code])).rows[0].v;
 return{brand:'Sachs',code,sourceUrl:'https://aftermarket.zf.com/tr/catalog/products/'+code,observedAt:new Date().toISOString(),before,
  fields:{description:'Shock Absorber, driver cab suspension',weight_kg:4.42,ean:before.ean,...options.fields},
  raw:{details:{number:code,brandName:'SACHS',status:{value:options.status||'no longer deliverable by the manufacturer'},replacedBy:{values:[{text:'350 038'}]}}},
  replacementCandidates:[{code:'350 038',direction:'replaced_by'}],replacements:[{code:'350 038',direction:'replaced_by',target:{raw:{details:{number:'350 038',brandName:'SACHS'}}}}]};
}
async function ready(db,obs){const {job}=await start(db,[obs.code]);const claim=await rpc(db,'claim_catalog_zf_job',[org,job.id]);await rpc(db,'checkpoint_catalog_zf_job',[org,job.id,claim.lease_token,0,obs,{},'reviewed',null,true,null]);await rpc(db,'schedule_catalog_zf_job',[org,job.id,true]);return rpc(db,'claim_catalog_zf_job',[org,job.id]);}
const apply=(db,j)=>rpc(db,'apply_catalog_zf_job_item',[org,j.id,j.lease_token,0]);
test('database binds manifests, tenant, leases, immutable receipts and reviewed-before-apply',async()=>{const db=await setup();try{
 const {job,key}=await start(db);assert.equal((await rpc(db,'start_catalog_zf_job',[org,actor,['318189'],'Sachs',key])).id,job.id);
 await assert.rejects(rpc(db,'start_catalog_zf_job',[org,actor,['350038'],'Sachs',key]),/key conflict/);
 await assert.rejects(rpc(db,'start_catalog_zf_job',[org,actor,['318189'],'TRW Engine Components',crypto.randomUUID()]),/source unavailable|Invalid ZF/);
 await assert.rejects(rpc(db,'start_catalog_zf_job',[org,actor,['318189','318 189'],'Sachs',crypto.randomUUID()]),/duplicate/);
 await assert.rejects(rpc(db,'schedule_catalog_zf_job',[org,job.id,true]),/Review collection/);
 const j=await rpc(db,'claim_catalog_zf_job',[org,job.id]);assert.equal(await rpc(db,'claim_catalog_zf_job',[org,job.id]),null);
 const obs=await receipt(db);await rpc(db,'checkpoint_catalog_zf_job',[org,job.id,j.lease_token,0,obs,{},'observed',null,false,null]);
 await assert.rejects(rpc(db,'checkpoint_catalog_zf_job',[org,job.id,j.lease_token,0,{...obs,fields:{}},{},'observed',null,false,null]),/immutable/);
 await assert.rejects(rpc(db,'checkpoint_catalog_zf_job',['00000000-0000-0000-0000-000000000099',job.id,j.lease_token,0,obs,{},'observed',null,false,null]),/lease lost/);
 await db.exec("set request.jwt.claim.role='anon'");await assert.rejects(rpc(db,'heartbeat_catalog_zf_job',[org,job.id,j.lease_token]),/Service role/);
 }finally{await db.close();}});
test('applies official corrections once, preserves successor/manual mapping, does not confuse availability with discontinued',async()=>{const db=await setup();try{
 await db.query('insert into item_code_references(organization_id,brand_id,old_code,new_code,reason) values($1,$2,$3,$4,$5)',[org,brand,'318189','350038','User manual']);
 const j=await ready(db,await receipt(db));const projection=(await db.query('select observation from catalog_zf_review_items where job_id=$1',[j.id])).rows[0].observation;assert.equal(projection.raw,undefined);assert.equal(projection.replacements[0].verified,true);assert.equal(projection.replacements[0].target,undefined);const result=await apply(db,j);assert.equal(result.fields.description,'applied');assert.equal(result.fields.weight_kg,'applied');assert.equal(result.relations[0].status,'existing_mapping_preserved');
 const p=(await db.query("select description,weight_kg::float,lifecycle_status from catalog_products where product_code='318189'")).rows[0];assert.equal(p.weight_kg,4.42);assert.equal(p.lifecycle_status,'active');
 assert.equal((await db.query("select description from catalog_products where product_code='350038'")).rows[0].description,'User corrected');
 assert.deepEqual(await apply(db,j),result);assert.equal((await db.query('select count(*)::int n from catalog_zf_item_applications')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from catalog_product_relations')).rows[0].n,1);
 assert.equal((await db.query('select reason from item_code_references')).rows[0].reason,'User manual');
 }finally{await db.close();}});
test('preserves concurrent manual correction, EAN conflicts, and explicit lifecycle changes only',async()=>{const db=await setup();try{
 const obs=await receipt(db);const j=await ready(db,obs);await db.exec("update catalog_products set description='User fixed after review' where product_code='318189'");
 const r=await apply(db,j);assert.equal(r.fields.description,'changed_since_review');assert.equal(r.fields.weight_kg,'applied');
 await rpc(db,'checkpoint_catalog_zf_job',[org,j.id,j.lease_token,0,obs,r,'completed',null,true,null]);
 const obs2=await receipt(db,'318189',{fields:{ean:'9999999999999'},status:'production discontinued'});const j2=await ready(db,obs2);const r2=await apply(db,j2);
 assert.equal(r2.fields.ean,'ean_identity_conflict');assert.equal((await db.query("select lifecycle_status from catalog_products where product_code='318189'")).rows[0].lifecycle_status,'active');
 await rpc(db,'checkpoint_catalog_zf_job',[org,j2.id,j2.lease_token,0,obs2,r2,'completed',null,true,null]);
 const obs3=await receipt(db,'318189',{status:'production discontinued'});const j3=await ready(db,obs3);await apply(db,j3);
 assert.equal((await db.query("select lifecycle_status from catalog_products where product_code='318189'")).rows[0].lifecycle_status,'discontinued');
 }finally{await db.close();}});
test('blocks replacement loops and ambiguous successor sets; does not overwrite a conflicting manual map',async()=>{const db=await setup();try{
 await db.query('insert into item_code_references(organization_id,brand_id,old_code,new_code) values($1,$2,$3,$4)',[org,brand,'350038','318189']);
 const obs=await receipt(db);const j=await ready(db,obs);assert.equal((await apply(db,j)).relations[0].status,'cycle_or_depth_conflict');
 await rpc(db,'checkpoint_catalog_zf_job',[org,j.id,j.lease_token,0,obs,{},'completed',null,true,null]);
 await db.query('insert into item_code_references(organization_id,brand_id,old_code,new_code) values($1,$2,$3,$4)',[org,brand,'318189','999999']);
 const obs2=await receipt(db);const j2=await ready(db,obs2);assert.equal((await apply(db,j2)).relations[0].status,'existing_mapping_conflict');
 }finally{await db.close();}});

test('an explicit but implausibly different official weight is held for product review',async()=>{const db=await setup();try{
 await db.exec("update catalog_products set weight_kg=48.013 where product_code='318189'");
 const j=await ready(db,await receipt(db,'318189',{fields:{weight_kg:2}}));const r=await apply(db,j);
 assert.equal(r.fields.weight_kg,'large_weight_difference_review_required');
 assert.equal((await db.query("select weight_kg::float w from catalog_products where product_code='318189'")).rows[0].w,48.013);
 }finally{await db.close();}});

test('a known foreign SKU title does not make its unrelated weight a trusted baseline',async()=>{const db=await setup();try{
 await db.exec("update catalog_products set description='318189 - Oil filter',weight_kg=.1 where product_code='318189'");
 const j=await ready(db,await receipt(db));const r=await apply(db,j);assert.equal(r.fields.description,'applied');assert.equal(r.fields.weight_kg,'applied');
 assert.equal((await db.query("select weight_kg::float w from catalog_products where product_code='318189'")).rows[0].w,4.42);
 }finally{await db.close();}});

test('explicit Sachs quarantine archives wrong metadata, preserves identity and concurrent edits, and is idempotent',async()=>{const db=await setup();try{
 await db.exec("update catalog_products set description='318189 - Oil filter',weight_kg=.1,origin='TR',hs_code='870880' where product_code='318189'");
 const obs=await receipt(db);obs.unavailable='OFFICIAL_EXACT_MATCH_NOT_FOUND';delete obs.fields;
 const j=await ready(db,obs);await apply(db,j);await rpc(db,'checkpoint_catalog_zf_job',[org,j.id,j.lease_token,0,obs,{},'completed',null,true,null]);
 const args=[org,j.id,0,actor,'User confirmed foreign SKU titles'];
 await db.exec("update catalog_products set description='Manual corrected' where product_code='318189'");
 assert.equal((await rpc(db,'quarantine_reviewed_zf_metadata',args)).status,'changed_since_review');
 await db.exec("update catalog_products set description='318189 - Oil filter' where product_code='318189'");
 assert.equal((await rpc(db,'quarantine_reviewed_zf_metadata',args)).status,'quarantined');
 assert.equal((await rpc(db,'quarantine_reviewed_zf_metadata',args)).status,'already_quarantined');
 const p=(await db.query("select description,weight_kg,ean,origin,hs_code from catalog_products where product_code='318189'")).rows[0];
 assert.deepEqual(p,{description:null,weight_kg:null,ean:'4013872954728',origin:'TR',hs_code:'870880'});
 assert.equal((await db.query('select before_values from catalog_zf_metadata_quarantines')).rows[0].before_values.description,'318189 - Oil filter');
 await db.exec("set request.jwt.claim.role='anon'");await assert.rejects(rpc(db,'quarantine_reviewed_zf_metadata',args),/Service role/);
 }finally{await db.close();}});
