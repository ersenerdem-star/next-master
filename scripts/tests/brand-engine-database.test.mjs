import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
const org='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002',brand='00000000-0000-0000-0000-000000000003';
async function setup(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
create function auth.role()returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
create function current_profile_org_id()returns uuid language sql as $$select null::uuid$$;create function current_profile_role()returns text language sql as $$select 'superadmin'$$;
create function normalize_part_code(text)returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
create table organizations(id uuid primary key);create table profiles(id uuid,organization_id uuid,role text,is_active boolean);create table brands(id uuid primary key,organization_id uuid,name text);
create table catalog_external_sources(id uuid default gen_random_uuid(),organization_id uuid,source_key text,is_active boolean,license_posture text,credential_boundary text,rate_limit_posture text,metadata jsonb,display_name text,source_owner text,source_type text,base_url text,robots_posture text,unique(organization_id,source_key));
create table catalog_products(id uuid primary key default gen_random_uuid(),organization_id uuid,brand_id uuid,product_code text,normalized_code text generated always as(normalize_part_code(product_code))stored,description text,description_tr text,weight_kg numeric,ean text,origin text,hs_code text,oem_no text,vehicle text,vehicle_model text,market_segment text,dimensions jsonb,image_url text,lifecycle_status text,updated_at timestamptz default now());
insert into organizations values('${org}');insert into profiles values('${actor}','${org}','superadmin',true);insert into brands values('${brand}','${org}','Denso');
insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)values('${org}','denso_official_v1',true,'internal_review_required','none','bounded','{"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":true,"allowed_brands":["Denso"],"allowed_evidence_hosts":["www.denso-am.eu"],"approval_actor":"owner","publication_approval_reference":"request"}');
insert into catalog_products(organization_id,brand_id,product_code,origin,hs_code)values('${org}','${brand}','DCRI100360','TR','001234');`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20261019225343_catalog_brand_engine.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../../supabase/migrations/20261019230301_catalog_brand_retry_checkpoints.sql',import.meta.url),'utf8'));await db.exec("set request.jwt.claim.role='service_role'");return db;}
const rpc=async(db,name,args)=> (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
async function ready(db,{host='www.denso-am.eu'}={}){const before=(await db.query('select to_jsonb(p)v from catalog_products p')).rows[0].v;
const j=await rpc(db,'start_catalog_brand_job',[org,actor,['DCRI100360'],'Denso',crypto.randomUUID(),'denso_official_v1']);const claim=await rpc(db,'claim_catalog_brand_job',[org,j.id]);const obs={brand:'Denso',sourceKey:'denso_official_v1',code:'DCRI100360',sourceUrl:'https://'+host+'/catalog/part/DCRI100360',fingerprint:'source-hash',before,fields:{description:'Injector Nozzle',weight_kg:.92,ean:'8717613058732',origin:'JP',hs_code:'870880',oem_no:'5821085'}};
await rpc(db,'checkpoint_catalog_brand_job',[org,j.id,claim.lease_token,0,obs,{},'reviewed',null,true,null]);await rpc(db,'schedule_catalog_brand_job',[org,j.id,true]);return {job:await rpc(db,'claim_catalog_brand_job',[org,j.id]),obs};}
test('generic reviewed engine binds source/brand and preserves supplied facts, manual edits and idempotency',async()=>{const db=await setup();try{
const {job:j,obs}=await ready(db);await db.exec("update catalog_products set description='Manual description' where product_code='DCRI100360'");
const args=[org,j.id,j.lease_token,0],r=await rpc(db,'apply_catalog_brand_job_item',args);assert.equal(r.fields.description,'changed_since_review');assert.equal(r.fields.origin,'existing_value_preserved');assert.equal(r.fields.hs_code,'existing_value_preserved');assert.equal(r.fields.weight_kg,'applied');assert.deepEqual(await rpc(db,'apply_catalog_brand_job_item',args),r);
const p=(await db.query('select description,weight_kg::float,origin,hs_code,ean from catalog_products')).rows[0];assert.deepEqual(p,{description:'Manual description',weight_kg:.92,origin:'TR',hs_code:'001234',ean:'8717613058732'});
await assert.rejects(rpc(db,'checkpoint_catalog_brand_job',[org,j.id,j.lease_token,0,{...obs,fields:{}},{},'completed',null,true,null]),/immutable/);
await db.exec("set request.jwt.claim.role='anon'");await assert.rejects(rpc(db,'apply_catalog_brand_job_item',args),/Service role/);
}finally{await db.close();}});
test('official host, tenant and stage-before-publish gates cannot be bypassed',async()=>{const db=await setup();try{
const j=await rpc(db,'start_catalog_brand_job',[org,actor,['DCRI100360'],'Denso',crypto.randomUUID(),'denso_official_v1']);await assert.rejects(rpc(db,'schedule_catalog_brand_job',[org,j.id,true]),/Review collection/);
const {job:bad}=await ready(db,{host:'spareto.com'});await assert.rejects(rpc(db,'apply_catalog_brand_job_item',[org,bad.id,bad.lease_token,0]),/source identity/);await assert.rejects(rpc(db,'apply_catalog_brand_job_item',[actor,bad.id,bad.lease_token,0]),/lease/);
const a=(await db.query("select has_function_privilege('anon','apply_catalog_brand_job_item(uuid,uuid,uuid,integer)','execute') as anon")).rows[0];assert.equal(a.anon,false);
}finally{await db.close();}});
test('an existing conflicting EAN blocks all new metadata even with an exact official article',async()=>{const db=await setup();try{
 await db.exec("update catalog_products set ean='1234567890123'");const {job:j}=await ready(db);const r=await rpc(db,'apply_catalog_brand_job_item',[org,j.id,j.lease_token,0]);assert.equal(r.fields.weight_kg,'ean_identity_conflict');assert.equal(r.fields.description,'ean_identity_conflict');assert.equal((await db.query('select weight_kg from catalog_products')).rows[0].weight_kg,null);
}finally{await db.close();}});

test('transient source retry retains the immutable row and is gated by persisted backoff',async()=>{const db=await setup();try{
 const j=await rpc(db,'start_catalog_brand_job',[org,actor,['DCRI100360'],'Denso',crypto.randomUUID(),'denso_official_v1']);const c=await rpc(db,'claim_catalog_brand_job',[org,j.id]);
 await rpc(db,'checkpoint_catalog_brand_job',[org,j.id,c.lease_token,0,null,{},'failed','DENSO_HTTP_503',false,'paused']);
 const paused=(await db.query('select status,retry_attempts,retry_after>now() deferred,next_index from catalog_brand_jobs')).rows[0];assert.deepEqual(paused,{status:'paused',retry_attempts:1,deferred:true,next_index:0});
 // Scheduler waits for retry_after before rescheduling. Row ownership/cursor is unchanged.
 const resumed=await rpc(db,'schedule_catalog_brand_job',[org,j.id,false]);assert.equal(resumed.next_index,0);assert.equal(resumed.retry_attempts,1);
}finally{await db.close();}});

test('Monroe applies only reviewed gross weight and a missing official image, with safe replay and conflict guards', async () => {
  const db=await setup();
  const officialImage='https://digital-assets.tecalliance.services/images/800/'+'a'.repeat(40)+'.jpg';
  try {
    await db.exec(readFileSync(new URL('../../supabase/migrations/20261125073144_register_monroe_catalog_engine.sql',import.meta.url),'utf8'));
    await db.exec(`
      update brands set name='Monroe';
      insert into catalog_external_sources(organization_id,source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata)
      values('${org}','tecalliance_monroe',true,'internal_review_required','none','bounded',
        '{"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":true,"allowed_brands":["Monroe"],"allowed_evidence_hosts":["web.tecalliance.net"],"approval_actor":"owner","publication_approval_reference":"request"}');
      update catalog_products set product_code='10024', lifecycle_status='active';
    `);
    for (const scenario of ['apply','preserve','changed','ean','invalid','forbidden']) {
      await db.exec(`update catalog_products set image_url=${scenario==='preserve'?"'https://manual.invalid/current'":"null"},weight_kg=null,ean=null`);
      const before=(await db.query('select to_jsonb(p) v from catalog_products p')).rows[0].v;
      const j=await rpc(db,'start_catalog_brand_job',[org,actor,['10024'],'Monroe',crypto.randomUUID(),'tecalliance_monroe']);
      const claim=await rpc(db,'claim_catalog_brand_job',[org,j.id]);
      const observation={brand:'Monroe',sourceKey:'tecalliance_monroe',code:'10024',
        sourceUrl:'https://web.tecalliance.net/tae/en/home',fingerprint:'receipt',before,
        fields:scenario==='forbidden'?{origin:'IT'}:{weight_kg:3.3},sourceFields:{ean:'4000000000001'},imageCandidate:scenario==='invalid'?'https://spareto.com/image.jpg':officialImage,
        secondary:{fields:{origin:'IT',hs_code:'870880'}},lifecycle:{evidence:{discontinued:{source_status:'production discontinued'}}}};
      await rpc(db,'checkpoint_catalog_brand_job',[org,j.id,claim.lease_token,0,observation,{},'reviewed',null,true,null]);
      await rpc(db,'schedule_catalog_brand_job',[org,j.id,true]);
      const publish=await rpc(db,'claim_catalog_brand_job',[org,j.id]);
      const args=[org,j.id,publish.lease_token,0];
      if(scenario==='changed')await db.exec("update catalog_products set image_url='https://manual.invalid/new'");
      if(scenario==='ean')await db.exec("update catalog_products set ean='4000000000002'");
      if(scenario==='forbidden'){
        await assert.rejects(rpc(db,'apply_catalog_monroe_job_item',args),/outside scope/);
        continue;
      }
      const result=await rpc(db,'apply_catalog_monroe_job_item',args);
      const expected={apply:'applied',preserve:'existing_value_preserved',changed:'changed_since_review',ean:'ean_identity_conflict',invalid:'invalid_source_image'};
      assert.equal(result.fields.image_url,expected[scenario]);
      assert.equal(result.fields.weight_kg,scenario==='ean'?'ean_identity_conflict':'applied');
      assert.deepEqual(await rpc(db,'apply_catalog_monroe_job_item',args),result);
      const product=(await db.query('select image_url,origin,hs_code,lifecycle_status from catalog_products')).rows[0];
      assert.deepEqual(product,{image_url:{apply:officialImage,preserve:'https://manual.invalid/current',changed:'https://manual.invalid/new'}[scenario]??null,origin:'TR',hs_code:'001234',lifecycle_status:'active'});
      await rpc(db,'checkpoint_catalog_brand_job',[org,j.id,publish.lease_token,0,observation,result,'completed',null,true,null]);
    }
    assert.equal((await db.query(
      "select has_function_privilege('anon','public.apply_catalog_monroe_job_item(uuid,uuid,uuid,integer)','execute') allowed"
    )).rows[0].allowed,false);
  } finally {
    await db.close();
  }
});

test('Monroe background admission requires explicit scope and seals every non-image field', async () => {
  const db=await setup();
  const migration=(name)=>readFileSync(new URL('../../supabase/migrations/'+name+'.sql',import.meta.url),'utf8');
  const image='https://digital-assets.tecalliance.services/images/800/'+'d'.repeat(40)+'.jpg';
  try {
    await db.exec(migration('20261125073144_register_monroe_catalog_engine'));
    await db.exec(migration('20261125083514_monroe_background_image_review'));
    await db.exec(`
      update brands set name='Monroe';
      update catalog_external_sources set source_key='tecalliance_monroe', metadata=
       '{"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":true,"allowed_brands":["Monroe"],"allowed_evidence_hosts":["web.tecalliance.net"],"approval_actor":"owner","publication_approval_reference":"request","monroe_background_image_only":true}';
      update catalog_products set product_code='10024', lifecycle_status='active';
    `);
    async function stage(fields, policy) {
      const before=(await db.query('select to_jsonb(p) v from catalog_products p')).rows[0].v;
      const job=await rpc(db,'start_catalog_brand_job',[org,actor,['10024'],'Monroe',crypto.randomUUID(),'tecalliance_monroe']);
      if(policy)await db.query("update catalog_brand_jobs set manifest=manifest||'{\"monroe_policy\":\"monroe-image-fill.v1\"}'::jsonb where id=$1",[job.id]);
      const claim=await rpc(db,'claim_catalog_brand_job',[org,job.id]);
      const observation={brand:'Monroe',sourceKey:'tecalliance_monroe',code:'10024',
        sourceUrl:'https://web.tecalliance.net/tae/en/home',before,fields,imageCandidate:image,
        sourceFields:{weight_kg:3.3},secondary:{reportedFields:{hs_code:'870880',origin:'PL'}},
        lifecycle:{checks:{discontinued:'found'}}};
      await rpc(db,'checkpoint_catalog_brand_job',[org,job.id,claim.lease_token,0,observation,{},'reviewed',null,true,null]);
      return job.id;
    }
    await stage({},false);
    const forbidden=await stage({weight_kg:3.3},true);
    assert.equal(await rpc(db,'admit_catalog_monroe_image_application',[]),null);
    await rpc(db,'schedule_catalog_brand_job',[org,forbidden,true]);
    const invalid=await rpc(db,'claim_catalog_brand_job',[org,forbidden]);
    await assert.rejects(rpc(db,'apply_catalog_monroe_job_item',[org,forbidden,invalid.lease_token,0]),/automatic image-only scope/);
    await db.query("update catalog_brand_jobs set status='failed' where id=$1",[forbidden]);
    const eligible=await stage({},true);
    const admission=await rpc(db,'admit_catalog_monroe_image_application',[]);
    assert.equal(admission.id,eligible);
    const publish=await rpc(db,'claim_catalog_brand_job',[org,eligible]);
    const result=await rpc(db,'apply_catalog_monroe_job_item',[org,eligible,publish.lease_token,0]);
    assert.deepEqual(result.changes,{image_url:image});
    assert.deepEqual((await db.query('select weight_kg,origin,hs_code,lifecycle_status from catalog_products')).rows[0],
      {weight_kg:null,origin:'TR',hs_code:'001234',lifecycle_status:'active'});
  } finally {
    await db.close();
  }
});

test('Monroe fitment publication fills only blank reviewed fields and keeps concurrent edits', async () => {
  const db=await setup();
  const migration=(name)=>readFileSync(new URL('../../supabase/migrations/'+name+'.sql',import.meta.url),'utf8');
  try {
    for(const name of ['20261125073144_register_monroe_catalog_engine','20261125083514_monroe_background_image_review',
      '20261125125253_monroe_official_fitment_oem_completion'])await db.exec(migration(name));
    await db.exec(`
      update brands set name='Monroe';
      update catalog_external_sources set source_key='tecalliance_monroe', metadata=
       '{"brand_engine_read_allowed":true,"brand_engine_enrichment_allowed":true,"allowed_brands":["Monroe"],"allowed_evidence_hosts":["web.tecalliance.net"],"approval_actor":"owner","publication_approval_reference":"request","monroe_background_fitment_only":true}';
      update catalog_products set product_code='10024', lifecycle_status='active', image_url='https://manual.invalid/photo';
    `);
    async function stage(fields, evidence) {
      const before=(await db.query('select to_jsonb(p) v from catalog_products p')).rows[0].v;
      const job=await rpc(db,'start_catalog_brand_job',[org,actor,['10024'],'Monroe',crypto.randomUUID(),'tecalliance_monroe']);
      await db.query("update catalog_brand_jobs set manifest=manifest||'{\"monroe_policy\":\"monroe-fitment-fill.v1\"}'::jsonb where id=$1",[job.id]);
      const claim=await rpc(db,'claim_catalog_brand_job',[org,job.id]);
      const observation={brand:'Monroe',sourceKey:'tecalliance_monroe',code:'10024',
        sourceUrl:'https://web.tecalliance.net/tae/en/home',before,fields,fitmentEvidence:evidence};
      await rpc(db,'checkpoint_catalog_brand_job',[org,job.id,claim.lease_token,0,observation,{},'reviewed',null,true,null]);
      return {job,observation};
    }

    const evidence={status:'verified',fingerprint:'a'.repeat(64)};
    const first=await stage({oem_no:'0046412045',vehicle:'FIAT',vehicle_model:'FIAT CINQUECENTO'},evidence);
    const admitted=await rpc(db,'admit_catalog_monroe_fitment_application',[]);
    assert.equal(admitted.id,first.job.id);
    await db.exec("update catalog_products set vehicle_model='Manual model'");
    const active=await rpc(db,'claim_catalog_brand_job',[org,first.job.id]);
    const result=await rpc(db,'apply_catalog_monroe_job_item',[org,first.job.id,active.lease_token,0]);
    assert.deepEqual(result.changes,{oem_no:'0046412045',vehicle:'FIAT'});
    assert.equal(result.fields.vehicle_model,'changed_since_review');
    assert.deepEqual((await db.query('select origin,hs_code,image_url,lifecycle_status,vehicle_model from catalog_products')).rows[0],
      {origin:'TR',hs_code:'001234',image_url:'https://manual.invalid/photo',lifecycle_status:'active',vehicle_model:'Manual model'});
    await rpc(db,'checkpoint_catalog_brand_job',[org,first.job.id,active.lease_token,0,first.observation,result,'completed',null,true,null]);

    const forbidden=await stage({oem_no:'OTHER'},evidence);
    await rpc(db,'schedule_catalog_brand_job',[org,forbidden.job.id,true]);
    const claim=await rpc(db,'claim_catalog_brand_job',[org,forbidden.job.id]);
    await assert.rejects(rpc(db,'apply_catalog_monroe_job_item',[org,forbidden.job.id,claim.lease_token,0]),/automatic fitment scope/);
    await db.query("update catalog_brand_jobs set status='failed' where id=$1",[forbidden.job.id]);

    await db.exec('update catalog_products set vehicle_model=null');
    const unverified=await stage({vehicle_model:'Unconfirmed model'},{status:'requires_review'});
    await rpc(db,'schedule_catalog_brand_job',[org,unverified.job.id,true]);
    const second=await rpc(db,'claim_catalog_brand_job',[org,unverified.job.id]);
    await assert.rejects(rpc(db,'apply_catalog_monroe_job_item',[org,unverified.job.id,second.lease_token,0]),/automatic fitment scope/);
  } finally {
    await db.close();
  }
});
