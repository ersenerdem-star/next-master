import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import {planSparetoMissingCompletion} from '../../netlify/functions/_shared/catalog/catalog-completion-review.mjs';
import {runSupplierSecondaryReviews,secondaryDispatchHeaders,requireSecondaryDispatch} from '../../netlify/functions/_shared/catalog/supplier-secondary-worker.mts';
import {findExactSparetoProductUrl,fetchExactSparetoSecondary} from '../../netlify/functions/_shared/catalog/spareto-secondary-provider.mjs';
const org='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',brand='00000000-0000-4000-8000-000000000003',job='00000000-0000-4000-8000-000000000004',product='00000000-0000-4000-8000-000000000005',release='00000000-0000-4000-8000-000000000006';
async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema supplier_price_ingestion_internal;
create function auth.role()returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
create function auth.uid()returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function current_profile_org_id()returns uuid language sql as $$select nullif(current_setting('request.org',true),'')::uuid$$;
create function normalize_catalog_product_code(text)returns text immutable language sql as $$select upper(regexp_replace($1,'\\s','','g'))$$;
create table profiles(id uuid,organization_id uuid,role text,is_active boolean);
create table brands(id uuid,organization_id uuid,name text);
create table catalog_external_sources(organization_id uuid,source_key text,is_active boolean,license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb);
create table catalog_products(id uuid primary key,organization_id uuid,brand_id uuid,product_code text,description text,description_tr text,ean text,weight_kg numeric,origin text,hs_code text,oem_no text,vehicle text,vehicle_model text,market_segment text,dimensions jsonb,image_url text,lifecycle_status text default 'active',updated_at timestamptz default now());
create table supplier_price_ingestion_internal.catalog_enrichment_jobs(id uuid primary key,organization_id uuid,brand_id uuid,release_id uuid,status text default 'queued',lease_until timestamptz,source_date date default '2026-10-20');
create table supplier_price_ingestion_internal.catalog_enrichment_changes(job_id uuid,phase text,source_row_number bigint,product_id uuid,product_code text,evidence jsonb,issues jsonb,missing_fields jsonb);
create table supplier_price_ingestion_internal.catalog_enrichment_fields(product_id uuid,field text,applied_value jsonb,source_date date,job_id uuid,primary key(product_id,field));
create table price_guard(value numeric);insert into price_guard values(42.5);
insert into profiles values('${actor}','${org}','superadmin',true);insert into brands values('${brand}','${org}','SKF');
insert into catalog_products(id,organization_id,brand_id,product_code,ean,description)values('${product}','${org}','${brand}','VKBA906','7316575793906','Official description');
insert into supplier_price_ingestion_internal.catalog_enrichment_jobs(id,organization_id,brand_id,release_id) values('${job}','${org}','${brand}','${release}');
insert into catalog_external_sources values('${org}','spareto_secondary_exact_v1',true,'internal_review_required','none','bounded','{"allowed_brands":["SKF"],"secondary_review_read_allowed":true,"secondary_review_apply_allowed":true,"approval_actor":"owner","publication_approval_reference":"request"}');`);
await db.exec(readFileSync('supabase/migrations/20261021163412_supplier_catalog_spareto_review_queue.sql','utf8'));
await db.exec(readFileSync('supabase/migrations/20261021165225_supplier_secondary_field_provenance.sql','utf8'));
await db.exec(`set request.jwt.claim.role='service_role';set request.org='${org}';set request.jwt.claim.sub='${actor}'`);return db;}
const rpc=async(db,name,args=[])=> (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
async function enqueue(db,overrides={}){const evidence={authority:'official',sourceOutcome:'matched',sourceUrl:'https://automotive.skf.com/eur/en/product-catalogue/VKBA906',fingerprint:'a'.repeat(64),sourceEan:'7316575793906',lifecycle:{checks:{replacement:'unsupported',discontinued:'unsupported'}},...overrides};
await db.query("insert into supplier_price_ingestion_internal.catalog_enrichment_changes values($1,'official',1,$2,'VKBA906',$3,'[]','[\"origin\",\"hs_code\"]')",[job,product,JSON.stringify(evidence)]);}
async function staged(db){await enqueue(db);const claim=await rpc(db,'claim_supplier_catalog_secondary_review');const observation={brand:'SKF',code:'VKBA906',sourceUrl:'https://spareto.com/products/skf-wheel-bearing-kit/vkba-906',fingerprint:'b'.repeat(64),observedAt:new Date().toISOString(),exactIdentity:true,fields:{origin:'IT',hs_code:'870870',ean:'7316575793906'},lifecycle:{checks:{replacement:'no_explicit_signal',discontinued:'no_explicit_signal'}}};
const proposal=planSparetoMissingCompletion({brand:'SKF',code:'VKBA906',existing:claim.before,official:claim.official,secondary:observation});
await rpc(db,'finish_supplier_catalog_secondary_review',[claim.id,claim.token,observation,proposal,null]);return {claim,observation,proposal};}

test('only exact official observations enqueue and one fenced secondary reader runs globally',async()=>{const db=await setup();try{
await enqueue(db,{authority:'secondary'});assert.equal((await db.query('select count(*)::int n from supplier_price_ingestion_internal.catalog_secondary_reviews')).rows[0].n,0);
await enqueue(db);const c=await rpc(db,'claim_supplier_catalog_secondary_review');assert(c.id);assert.equal(await rpc(db,'claim_supplier_catalog_secondary_review'),null);
assert.equal((await rpc(db,'read_supplier_catalog_secondary_claim',[c.id,c.token])).code,'VKBA906');await assert.rejects(rpc(db,'read_supplier_catalog_secondary_claim',[c.id,crypto.randomUUID()]),/LEASE_LOST/);
assert.equal((await db.query('select secondary_enqueue_errors from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0].secondary_enqueue_errors,0);
}finally{await db.close();}});
test('secondary stage never mutates catalog; explicit tenant-admin review fills missing fields with audit and idempotency',async()=>{const db=await setup();try{
const {claim}=await staged(db);assert.equal((await db.query('select origin from catalog_products')).rows[0].origin,null);
const r=await rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]);assert.equal(r[0].fields.origin,'applied');
const p=(await db.query('select description,origin,hs_code,lifecycle_status from catalog_products')).rows[0];assert.deepEqual(p,{description:'Official description',origin:'IT',hs_code:'870870',lifecycle_status:'active'});
assert.equal((await db.query('select value::float from price_guard')).rows[0].value,42.5);
const audit=(await db.query('select application from supplier_price_ingestion_internal.catalog_secondary_reviews')).rows[0].application;assert.equal(audit.actor,actor);assert.equal(audit.sourceUrl,'https://spareto.com/products/skf-wheel-bearing-kit/vkba-906');
assert.equal((await rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]))[0].status,'applied');
}finally{await db.close();}});
test('manual edits after review and conflicting EAN preserve canonical data',async()=>{const db=await setup();try{
const {claim}=await staged(db);await db.exec("update catalog_products set origin='TR',ean='9999999999999'");
assert.equal((await rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]))[0].status,'held');assert.equal((await db.query('select hs_code from catalog_products')).rows[0].hs_code,null);
}finally{await db.close();}});
test('populated fields remain protected and deactivating a source prevents reviewed publication',async()=>{const db=await setup();try{
const {claim}=await staged(db);await db.exec("update catalog_products set origin='TR'");const r=await rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]);assert.equal(r[0].fields.origin,'existing_value_preserved');assert.equal((await db.query('select origin from catalog_products')).rows[0].origin,'TR');
}finally{await db.close();}});
test('tenant scope, anonymous access, direct service table writes and revoked source authorization cannot bypass review',async()=>{const db=await setup();try{
const {claim}=await staged(db);const acl=(await db.query("select has_function_privilege('anon','apply_supplier_catalog_secondary_reviews(uuid[])','execute') anon,has_function_privilege('service_role','apply_supplier_catalog_secondary_reviews(uuid[])','execute') service_apply,has_table_privilege('service_role','supplier_price_ingestion_internal.catalog_secondary_reviews','update') direct")).rows[0];assert.deepEqual(acl,{anon:false,service_apply:false,direct:false});
await db.exec("update catalog_external_sources set is_active=false");await assert.rejects(rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]),/NOT_READY/);
await db.exec("update catalog_external_sources set is_active=true;set request.org='00000000-0000-4000-8000-000000000099'");await assert.rejects(rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]),/ADMIN_REQUIRED/);
}finally{await db.close();}});
test('transient source failure preserves one queue item with bounded backoff',async()=>{const db=await setup();try{
await enqueue(db);const c=await rpc(db,'claim_supplier_catalog_secondary_review');const r=await rpc(db,'finish_supplier_catalog_secondary_review',[c.id,c.token,null,null,'SPARETO_HTTP_503']);assert.equal(r.status,'retry_wait');assert.equal(await rpc(db,'claim_supplier_catalog_secondary_review'),null);
assert.equal((await db.query('select count(*)::int n from supplier_price_ingestion_internal.catalog_secondary_reviews')).rows[0].n,1);
}finally{await db.close();}});
test('worker checkpoints only supplemental review receipts and its signature is bound to one queue lease',async()=>{
const id=crypto.randomUUID(),token=crypto.randomUUID(),headers=secondaryDispatchHeaders('key',id,token),req=new Request('https://example.invalid',{headers});requireSecondaryDispatch(req,'key',id,token);assert.throws(()=>requireSecondaryDispatch(req,'key',id,crypto.randomUUID()));
const calls=[];await runSupplierSecondaryReviews({rpc:async(n,a)=>{calls.push({n,a});return null;},firstClaim:{id,token,brand:'SKF',code:'VKBA906',before:{},official:{authority:'official',brand:'SKF',code:'VKBA906',sourceUrl:'https://automotive.skf.com/a',fingerprint:'a'.repeat(64)}},fetchSecondary:async()=>({brand:'SKF',code:'VKBA906',sourceUrl:'https://spareto.com/products/skf/vkba906',fingerprint:'b'.repeat(64),observedAt:new Date().toISOString(),exactIdentity:true,fields:{origin:'IT'}})});
assert.equal(calls[0].n,'finish_supplier_catalog_secondary_review');assert.equal(calls[0].a.input_proposal.fields.origin,'IT');assert(calls.every(c=>!c.n.startsWith('apply_')));
});
const card=(brand='SKF',code='VKBA 906',url='/products/skf/vkba-906')=>`<div data-variant-card-gtm-item-value='{&quot;item_brand&quot;:&quot;${brand}&quot;,&quot;item_id&quot;:&quot;${code}&quot;}'><a href="${url}"><span class='brand'>${brand}</span><span class='part_number'>${code}</span></a></div>`;
test('search resolves only one exact brand/code card and never selects a fuzzy alternative',()=>{
assert.equal(findExactSparetoProductUrl(card('TRW','VKBA 906')+card(),{brand:'SKF',code:'VKBA906'}),'https://spareto.com/products/skf/vkba-906');
assert.throws(()=>findExactSparetoProductUrl(card('SKF','VKBA-906'),{brand:'SKF',code:'VKBA906'}),/NOT_FOUND/);
assert.throws(()=>findExactSparetoProductUrl(card()+card('SKF','VKBA906','/products/skf/other'),{brand:'SKF',code:'VKBA906'}),/AMBIGUOUS/);
});


test('preapproved automatic completion uses the same missing-only guard and retains an independent application receipt',async()=>{const db=await setup();try{
const {claim}=await staged(db);
assert.equal(await rpc(db,'apply_supplier_catalog_secondary_approved',[claim.id]),null);
await db.query("update catalog_external_sources set metadata=metadata||$1::jsonb",[JSON.stringify({approval_actor:actor,secondary_review_automatic_apply_allowed:true,automatic_fields:['origin','hs_code','ean']})]);
const r=await rpc(db,'apply_supplier_catalog_secondary_approved',[claim.id]);assert.equal(r.status,'applied');assert.equal((await db.query('select origin from catalog_products')).rows[0].origin,'IT');
const audit=(await db.query('select application from supplier_price_ingestion_internal.catalog_secondary_applications')).rows[0].application;assert.equal(audit.automatic,true);assert.equal(audit.actor,actor);
await db.exec('delete from supplier_price_ingestion_internal.catalog_enrichment_changes;delete from supplier_price_ingestion_internal.catalog_enrichment_jobs');
assert.equal((await db.query('select count(*)::int n from supplier_price_ingestion_internal.catalog_secondary_reviews')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from supplier_price_ingestion_internal.catalog_secondary_applications')).rows[0].n,1);
assert.equal((await db.query('select value::float from price_guard')).rows[0].value,42.5);
}finally{await db.close();}});


test('a worker never applies source data before sealing its validated receipt',async()=>{
 const calls=[];await runSupplierSecondaryReviews({rpc:async(n,a)=>{calls.push(n);if(n==='finish_supplier_catalog_secondary_review')return {status:'reviewed'};return null;},firstClaim:{id:crypto.randomUUID(),token:crypto.randomUUID(),brand:'SKF',code:'VKBA906',before:{},official:{authority:'official',brand:'SKF',code:'VKBA906',sourceUrl:'https://automotive.skf.com/a',fingerprint:'a'.repeat(64)}},fetchSecondary:async()=>({brand:'SKF',code:'VKBA906',sourceUrl:'https://spareto.com/products/skf/vkba906',fingerprint:'b'.repeat(64),observedAt:new Date().toISOString(),exactIdentity:true,fields:{origin:'IT'}})});
 assert.deepEqual(calls.slice(0,2),['finish_supplier_catalog_secondary_review','apply_supplier_catalog_secondary_approved']);
});
test('missing search results retain request identity and fingerprint without fabricating a product',async()=>{
 try{await fetchExactSparetoSecondary({brand:'SKF',code:'VKBA906'},{wait:async()=>{},fetchImpl:async()=>new Response(card('TRW','VKBA906'))});assert.fail('must reject');}catch(e){assert.equal(e.message,'SPARETO_EXACT_MATCH_NOT_FOUND');assert.equal(new URL(e.evidence.searchUrl).searchParams.get('keywords'),'VKBA906');assert.equal(e.evidence.searchFingerprint.length,64);}
});


test('secondary canonical writes defer during a primary catalog turn without changing either cursor or product',async()=>{const db=await setup();try{
const {claim}=await staged(db);await db.exec("update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='running',lease_until=clock_timestamp()+interval '120 seconds'");
const r=await rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]);assert.equal(r[0].status,'deferred');assert.equal((await db.query('select origin from catalog_products')).rows[0].origin,null);
await db.exec("update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='queued',lease_until=null");assert.equal((await rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]))[0].status,'applied');
}finally{await db.close();}});


test('secondary fill updates the existing field ledger so later supplier-file authority can refresh it',async()=>{const db=await setup();try{
const {claim}=await staged(db);await rpc(db,'apply_supplier_catalog_secondary_reviews',[[claim.id]]);
const ledger=(await db.query("select field,applied_value,source_date::text,job_id from supplier_price_ingestion_internal.catalog_enrichment_fields order by field")).rows;
assert.equal(ledger.length,2);assert.equal(ledger.find(x=>x.field==='origin').applied_value,'IT');assert.equal(ledger[0].job_id,job);assert.equal(ledger[0].source_date,'2026-10-20');
}finally{await db.close();}});
test('a changed product identity is held without poisoning subsequent automatic queue dispatch',async()=>{const db=await setup();try{
const {claim}=await staged(db);await db.query("update catalog_external_sources set metadata=metadata||$1::jsonb",[JSON.stringify({approval_actor:actor,secondary_review_automatic_apply_allowed:true,automatic_fields:['origin','hs_code','ean']})]);
await db.exec("update catalog_products set product_code='VKBA-906'");const r=await rpc(db,'apply_supplier_catalog_secondary_approved',[claim.id]);assert.equal(r.status,'held');assert.equal(await rpc(db,'apply_supplier_catalog_secondary_approved',[]),null);
assert.equal((await db.query('select origin from catalog_products')).rows[0].origin,null);
}finally{await db.close();}});
