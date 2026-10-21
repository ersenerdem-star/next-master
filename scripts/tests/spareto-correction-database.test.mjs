import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
const org='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',brand='00000000-0000-4000-8000-000000000003';
const source='spareto_schaeffler_correction_v1',image='https://cdn.spareto.com/variants/images/001/234/567/original/part.jpg?123';
const rpc=async(db,name,args=[])=> (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
async function setup(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema supplier_price_ingestion_internal;
 create function auth.role()returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
 create function current_profile_org_id()returns uuid language sql as $$select '${org}'::uuid$$;
 create function current_profile_role()returns text language sql as $$select 'superadmin'$$;
 create function normalize_part_code(text)returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
 create function normalize_catalog_product_code(text)returns text language sql immutable as $$select upper(regexp_replace($1,'[[:space:]]','','g'))$$;
 create table organizations(id uuid primary key);create table profiles(id uuid,organization_id uuid,role text,is_active boolean);create table brands(id uuid primary key,organization_id uuid,name text);
 create table catalog_external_sources(id uuid default gen_random_uuid(),organization_id uuid,source_key text,is_active boolean,license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb);
 create table catalog_products(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,product_code text,normalized_code text generated always as(normalize_part_code(product_code))stored,description text,description_tr text,ean text,origin text,hs_code text,weight_kg numeric,dimensions jsonb,oem_no text,vehicle text,vehicle_model text,market_segment text,image_url text,lifecycle_status text default 'active',lifecycle_note text,updated_at timestamptz default now());
 create table catalog_product_source_records(id uuid default gen_random_uuid(),organization_id uuid,catalog_product_id uuid,source_key text,source_url text,source_product_id text,source_version text,payload_fingerprint text,unique(organization_id,catalog_product_id,source_key,payload_fingerprint));
 create table catalog_observation_audit_ledger(organization_id uuid,actor_id uuid,action text,evidence_reference text,payload jsonb);
 create table supplier_price_ingestion_internal.catalog_enrichment_jobs(organization_id uuid,brand_id uuid,status text,lease_until timestamptz);
 create table supplier_price_ingestion_internal.catalog_secondary_reviews(id uuid,organization_id uuid,job_id uuid,source_row_number bigint,product_id uuid,brand_id uuid,product_code text,official_evidence jsonb,status text,before_values jsonb,observation jsonb,proposal jsonb,application jsonb,attempts integer default 0,next_attempt_at timestamptz default now(),lease_token uuid,lease_until timestamptz,error_code text,created_at timestamptz default now(),updated_at timestamptz default now());
 create function supplier_price_ingestion_internal.secondary_source_allowed(uuid,uuid,boolean default false)returns boolean language sql as $$select false$$;
 create table price_guard(price numeric);insert into price_guard values(99.25);
 insert into organizations values('${org}');insert into profiles values('${actor}','${org}','superadmin',true);insert into brands values('${brand}','${org}','INA');
 insert into catalog_products(organization_id,brand_id,product_code,description,ean,origin,hs_code,weight_kg,oem_no,market_segment,image_url)values('${org}','${brand}','712036010','Mounting, manu','4005108359810','TR','84824000',0.037,'002311125','pc','https://cdn.spareto.com/variants/images/old.jpg');`);
 for(const file of ['20261019225343_catalog_brand_engine.sql','20261019230301_catalog_brand_retry_checkpoints.sql','20261021183654_schaeffler_spareto_reviewed_corrections.sql','20261021184629_schaeffler_correction_decimal_codes.sql'])await db.exec(readFileSync(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.query(`insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)values($1,$2,true,'internal_review_required','none','bounded',$3)`,[org,source,JSON.stringify({allowed_brands:['INA','FAG','LUK'],correction_read_allowed:true,correction_apply_allowed:true,approval_actor:actor,publication_approval_reference:'human-request',approval_expires_at:new Date(Date.now()+86400000).toISOString(),approved_fields:['description','oem_no','market_segment','image_url']})]);
 await db.exec("set request.jwt.claim.role='service_role'");return db;
}
async function ready(db){
 const j=await rpc(db,'start_catalog_spareto_correction',[org,actor,'INA',['712036010'],crypto.randomUUID()]);
 const claim=await rpc(db,'claim_catalog_brand_job',[org,j.id]);
 const before=(await db.query('select to_jsonb(p) b from catalog_products p')).rows[0].b;
 const observation={brand:'INA',code:'712036010',sourceBrand:'INA',exactIdentity:true,sourceKey:source,sourceUrl:'https://spareto.com/products/ina-bearing/712-0360-10',fingerprint:'a'.repeat(64),before,fields:{description:'Bearing, manual transmission',ean:before.ean,oem_no:'002311125A',origin:'CN',hs_code:'848240',weight_kg:99},eanCandidates:[before.ean],imageCandidate:image,imageEvidence:{scope:'primary_product_meta',candidates:[image]},segmentEvidence:{status:'source_missing'},proposal:{status:'reviewed',patch:{description:'Bearing, manual transmission',oem_no:'002311125; 002311125A',image_url:image}}};
 await rpc(db,'checkpoint_catalog_brand_job',[org,j.id,claim.lease_token,0,observation,{},'observed',null,false,null]);return {j:claim,observation};
}
test('decimal commas and existing brand suffixes remain exact article identity during admission',async()=>{const db=await setup();try{
 await db.query('insert into catalog_products(organization_id,brand_id,product_code)values($1,$2,$3)',[org,brand,'LR17X20X20,5 /INA/']);
 const j=await rpc(db,'start_catalog_spareto_correction',[org,actor,'INA',['LR17X20X20,5 /INA/'],crypto.randomUUID()]);assert.deepEqual(j.manifest.codes,['LR17X20X20,5 /INA/']);
}finally{await db.close();}});
test('owner-approved correction changes populated description/image, adds OEMs, preserves commercial fields and is idempotent',async()=>{const db=await setup();try{
 const {j}=await ready(db);const args=[org,j.id,j.lease_token,0];const r=await rpc(db,'apply_catalog_spareto_correction_item',args);assert.equal(r.status,'completed');assert.equal(r.fields.description,'applied');assert.deepEqual(await rpc(db,'apply_catalog_spareto_correction_item',args),r);
 assert.deepEqual((await db.query('select description,oem_no,image_url,origin,hs_code,weight_kg::float,ean,market_segment from catalog_products')).rows[0],{description:'Bearing, manual transmission',oem_no:'002311125; 002311125A',image_url:image,origin:'TR',hs_code:'84824000',weight_kg:.037,ean:'4005108359810',market_segment:'pc'});
 assert.equal((await db.query('select price::float from price_guard')).rows[0].price,99.25);assert.equal((await db.query('select count(*)::int n from catalog_observation_audit_ledger')).rows[0].n,1);
}finally{await db.close();}});
test('current EAN changes hold every field, while unrelated manual field edits are preserved individually',async()=>{for(const ean of [false,true]){const db=await setup();try{
 const {j}=await ready(db);await db.exec(ean?"update catalog_products set ean='9999999999999'":"update catalog_products set description='Manual correction'");
 const r=await rpc(db,'apply_catalog_spareto_correction_item',[org,j.id,j.lease_token,0]);
 if(ean){assert.equal(r.status,'held');assert.equal((await db.query('select description from catalog_products')).rows[0].description,'Mounting, manu');}
 else{assert.equal(r.fields.description,'changed_since_review');assert.equal((await db.query('select description from catalog_products')).rows[0].description,'Manual correction');}
}finally{await db.close();}}});
test('source revocation, anonymous callers, wrong tenant and stale lease cannot apply a correction',async()=>{const db=await setup();try{
 const {j}=await ready(db);const args=[org,j.id,j.lease_token,0];
 await assert.rejects(rpc(db,'apply_catalog_spareto_correction_item',[actor,j.id,j.lease_token,0]),/LEASE_OR_MANIFEST/);
 await assert.rejects(rpc(db,'apply_catalog_spareto_correction_item',[org,j.id,crypto.randomUUID(),0]),/LEASE_OR_MANIFEST/);
 await db.exec("update catalog_external_sources set is_active=false");await assert.rejects(rpc(db,'apply_catalog_spareto_correction_item',args),/APPROVAL_REQUIRED/);
 await db.exec("set request.jwt.claim.role='anon'");await assert.rejects(rpc(db,'apply_catalog_spareto_correction_item',args),/SERVICE_REQUIRED/);
 assert.equal((await db.query("select has_function_privilege('anon','apply_catalog_spareto_correction_item(uuid,uuid,uuid,integer)','execute') allowed")).rows[0].allowed,false);
}finally{await db.close();}});
test('prices and arbitrary image URLs cannot be smuggled into a sealed correction',async()=>{for(const variant of ['price','image']){const db=await setup();try{
 const {j,observation}=await ready(db);const obs=structuredClone(observation);
 if(variant==='price')obs.proposal.patch.buy_price=1;else{obs.imageCandidate='https://evil.invalid/wrong.jpg';obs.imageEvidence.candidates=[obs.imageCandidate];obs.proposal.patch.image_url=obs.imageCandidate;}
 // Deliberately construct a malformed sealed receipt as a privileged test.
 await db.query('update catalog_brand_job_items set observation=$1 where job_id=$2',[JSON.stringify(obs),j.id]);
 await assert.rejects(rpc(db,'apply_catalog_spareto_correction_item',[org,j.id,j.lease_token,0]),variant==='price'?/FIELD_NOT_APPROVED/:/IMAGE_NOT_APPROVED/);
 assert.equal((await db.query('select description from catalog_products')).rows[0].description,'Mounting, manu');
}finally{await db.close();}}});
test('Spareto transport stays globally single-reader and same-brand primary activity defers only its own correction',async()=>{const db=await setup();try{
 const {j}=await ready(db);assert.equal(await rpc(db,'reserve_catalog_spareto_correction',[org,j.id,j.lease_token]),true);
 assert.equal(await rpc(db,'claim_supplier_catalog_secondary_review'),null);
 await db.exec("insert into supplier_price_ingestion_internal.catalog_secondary_reviews(status,lease_until)values('running',now()+interval '60 seconds')");assert.equal(await rpc(db,'reserve_catalog_spareto_correction',[org,j.id,j.lease_token]),false);
 await db.exec('delete from supplier_price_ingestion_internal.catalog_secondary_reviews');
 await db.query("insert into supplier_price_ingestion_internal.catalog_enrichment_jobs values($1,$2,'running',now()+interval '60 seconds')",[org,brand]);
 assert.equal((await rpc(db,'apply_catalog_spareto_correction_item',[org,j.id,j.lease_token,0])).status,'deferred');
 await db.query('update supplier_price_ingestion_internal.catalog_enrichment_jobs set brand_id=$1',[actor]);
 assert.equal((await rpc(db,'apply_catalog_spareto_correction_item',[org,j.id,j.lease_token,0])).status,'completed');
}finally{await db.close();}});
