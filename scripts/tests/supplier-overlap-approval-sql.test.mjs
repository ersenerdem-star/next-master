import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createFoundationTestDb, seedFoundationTestScope } from './fixtures/price-engine-foundation-db.mjs';

const foundation = await readFile(new URL('../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql',import.meta.url),'utf8');
const publication = await readFile(new URL('../../supabase/migrations/20261014110614_supplier_price_production_publication_decision.sql',import.meta.url),'utf8');
const migration = await readFile(new URL('../../supabase/migrations/20261014162139_supplier_admin_release_action_queue.sql',import.meta.url),'utf8');
const compatibility = await readFile(new URL('../../supabase/migrations/20261014175649_supplier_source_commercial_compatibility_guard.sql',import.meta.url),'utf8');
const overlap = await readFile(new URL('../../supabase/migrations/20261123162458_supplier_overlap_superadmin_approval.sql',import.meta.url),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),supplier=id(3),brand=id(5),actor=id(7),authSession=id(8),owner=id(50);
const staging='kaxsqafdevabkxofwdod',production='zjgueqijumzlfioihnkt';
const iat=Math.floor(Date.now()/1000)-60,exp=iat+3600;
const auth=(target=staging)=>[target,actor,org,authSession,iat,exp];
async function admin(db,sql,args=[]) { await db.exec('RESET ROLE'); return db.query(sql,args); }
async function rpc(db,name,args) {
  await db.exec("SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false)");
  return (await db.query(`SELECT public.${name}(${args.map((_,n)=>`$${n+1}`).join(',')}) value`,args)).rows[0].value;
}
async function fixture(t,{target=staging,enabled=true,withProduction=true}={}) {
  const db=await createFoundationTestDb(); t.after(()=>db.close());
  await db.exec(foundation); if(withProduction) await db.exec(publication); await db.exec(migration); for(const file of ['20261013140015_supplier_price_guard_active_legacy_delete.sql'])await db.exec(await readFile('supabase/migrations/'+file,'utf8')); await db.exec(compatibility); await db.exec(`
 create table public.test_overlap_control(n int not null, extra_code text not null default 'CODE102'); insert into public.test_overlap_control(n) values(2);
 create or replace function supplier_price_validation_internal.cross_brand_audit(input_release_id uuid)
 returns jsonb language plpgsql set search_path='' as $body$
 declare v_release public.supplier_price_releases%rowtype;v_result jsonb;
 begin
 select * into strict v_release from public.supplier_price_releases where id=input_release_id;
 with ranked as (select '00000000-0000-4000-8000-000000000006'::uuid brand_id,code,false historical from (select 'CODE101' code union all select extra_code from public.test_overlap_control) x), dimension_matches as (select brand_id,code from ranked where false),counts as (select 2 n) select jsonb_build_object('policy','cross-brand-v3','checked',true,'checked_at',clock_timestamp(),
 'review_required',true,'selected_brand_id',v_release.brand_id,'selected_brand_name','Brand',
 'distinct_incoming_codes',(select n from counts),'ratio_threshold_percent',5,'ratio_comparison','strictly_greater',
 'matching_brand_count',1,'brands',jsonb_build_array(jsonb_build_object('brand_id','00000000-0000-4000-8000-000000000006',
 'brand_name','Other','matching_codes',(select n from public.test_overlap_control),'incoming_percent',100,'sample_codes',jsonb_build_array('CODE101'))),
 'historical_brands','[]'::jsonb) into v_result;
   return v_result;
 end;
 $body$;
 `); await db.exec(overlap); await seedFoundationTestScope(db);
  if(enabled) await db.query('UPDATE supplier_price_ingestion_internal.admin_release_action_control SET enabled=true,expected_project_ref=$1',[target]);
  return db;
}
async function seed(db,n,{held=true,rows=2,prefix=`CODE${n}`,revision=0}={}) {
  await admin(db,'SELECT 1');
  const release=id(n),path=`fixture/${release}.csv`,hash=createHash('sha256').update(path).digest('hex');
  const audit=held?{policy:'cross-brand-v1',checked:false,review_required:true,reason:'BRAND_IDENTITY_COMPARISON_PENDING'}:{policy:'cross-brand-v1',checked:true,review_required:false};
  await db.query(`INSERT INTO public.supplier_price_releases(id,organization_id,supplier_id,brand_id,status,validated_at,
    total_rows,processed_rows,current_cursor,accepted_rows,rejected_rows,warning_rows,conflict_rows,review_revision,
    source_verification_required,uploaded_at,source_file_path,source_file_sha256,brand_identity_audit,error_code,created_by)
    VALUES($1,$2,$3,$4,'validated',now(),$5,$5,$5,$5,0,0,0,$6,true,now(),$7,$8,$9,$10,$11)`,
  [release,org,supplier,brand,rows,revision,path,hash,audit,held?'BRAND_IDENTITY_COMPARISON_PENDING':null,actor]);
  await db.query(`INSERT INTO public.supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status)
    SELECT $1,i,$2||i::text,$2||i::text,12.34,'EUR',current_date,'accepted' FROM generate_series(1,$3::int)i`,[release,prefix,rows]);
  await db.query(`INSERT INTO public.supplier_price_upload_sessions(id,organization_id,release_id,idempotency_key,storage_object_path,file_name,content_type,total_bytes,uploaded_bytes,status,created_by,expires_at)
    VALUES($1,$2,$3,$4,$5,'source.csv','text/csv',100,100,'uploaded',$6,now()+interval '1 day')`,[id(n+1000),org,release,`fixture-${n}`,path,actor]);
  await db.query(`INSERT INTO storage.objects(id,bucket_id,name,version,updated_at,metadata) VALUES($1,'supplier-price-imports',$2,'object-v1',now(),'{"size":100}')`,[id(n+2000),path]);
  await db.query(`INSERT INTO supplier_price_ingestion_internal.handoffs(id,session_id,release_id,organization_id,storage_bucket,source_path,source_sha256,source_bytes,total_rows,object_id,object_version,object_updated_at,workflow_id,status,enqueued_at)
    SELECT $1,$2,$3,$4,o.bucket_id,o.name,$5,100,$6,o.id,o.version,o.updated_at,$7,'enqueued',now() FROM storage.objects o WHERE id=$8`,
  [id(n+3000),id(n+1000),release,org,hash,rows,`supplier-price-verified:v1:${release}`,id(n+2000)]);
  return release;
}
const evidence=(db,release,target=staging)=>rpc(db,'get_supplier_release_action_evidence',[...auth(target),release]);
const enqueue=(db,request,kind='review',target=staging)=>rpc(db,'request_supplier_release_action',[...auth(target),kind,request]);
const claim=(db,target=staging,lease=owner)=>rpc(db,'claim_supplier_release_action',[target,lease]);
const execute=(db,decision,target=staging,lease=owner)=>rpc(db,'execute_supplier_release_action',[target,decision,lease]);
const fail=(db,decision,code='ACTION_EXECUTION_FAILED',target=staging,lease=owner)=>rpc(db,'fail_supplier_release_action',[target,decision,lease,code]);
async function reviewRequest(db,release,decision=id(30),target=staging,action='recheck') {
  const e=await evidence(db,release,target);
  return {releaseId:release,decisionId:decision,action,reason:action==='recheck'?'comparison_repaired':'wrong_brand_file',expectedRevision:e.reviewRevision,expectedStatus:e.status,expectedError:e.errorCode,expectedAudit:e.brandIdentityAudit};
}
const publishRequest=(release,decision=id(31),revision=0,previous=null)=>({releaseId:release,decisionId:decision,expectedReviewRevision:revision,expectedPreviousPublicationId:previous});



async function seedOverlap(db,n=10){
 const release=await seed(db,n); await admin(db,'SELECT 1');
 const result=(await db.query('select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a;
 await db.query("update supplier_price_releases set error_code='CROSS_BRAND_BULK_OVERLAP',brand_identity_audit=$2 where id=$1",[release,result]);
 return release;
}
const approvalRequest=(e,decision=id(30))=>({releaseId:e.releaseId,decisionId:decision,action:'approve_overlap',reason:'cross_brand_overlap_accepted',
 expectedRevision:e.reviewRevision,expectedStatus:e.status,expectedError:e.errorCode,expectedAudit:e.brandIdentityAudit,
 expectedSourceSha256:e.sourceSha256,expectedMatchSha256:e.overlapMatchFingerprint,expectedRowsSha256:e.overlapRowsFingerprint,expectedPreviousPublicationId:e.currentPublicationId});

test('price changed between evidence and decision rejects approval',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),before=await evidence(db,release),request=approvalRequest(before);
 await admin(db,"update supplier_price_release_rows set buy_price=50 where release_id=$1 and source_row_number=1",[release]);
 await enqueue(db,request);await claim(db);
 await assert.rejects(()=>execute(db,request.decisionId),/REVIEW_STALE_EVIDENCE/);
 const next=await evidence(db,release);assert.notEqual(next.overlapRowsFingerprint,before.overlapRowsFingerprint);
 assert.equal((await admin(db,'select count(*)::int n from supplier_price_validation_internal.overlap_approvals')).rows[0].n,0);
});

test('superadmin approval pins source, audit and rows but does not publish or change prices; stale rows revoke it',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),before=await evidence(db,release);
 assert.equal(before.canApproveOverlap,true);assert.equal(before.overlapApproved,false);
 const request=approvalRequest(before),q=await enqueue(db,request);assert.equal(q.status,'queued');
 await claim(db);const r=await execute(db,request.decisionId);assert.equal(r.status,'overlap_approved');assert.equal(r.published,false);
 assert.equal((await enqueue(db,request)).replayed,true);
 await admin(db,'SELECT 1');assert.equal((await db.query('select count(*)::int n from supplier_current_price_pointers')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from supplier_prices')).rows[0].n,0);
 const after=await evidence(db,release);assert.equal(after.overlapApproved,true);assert.equal(after.reviewRevision,1);
 await admin(db,"update supplier_price_release_rows set buy_price=50 where release_id=$1 and source_row_number=1",[release]);
 const dirty=await evidence(db,release);assert.equal(dirty.overlapApproved,false);
 assert.equal((await admin(db,'select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a.review_required,true);
});

test('ordinary admin and unrelated error cannot approve; expected source and evidence are bound',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),e=await evidence(db,release),req=approvalRequest(e);
 for(const patch of [{expectedSourceSha256:'a'.repeat(64)},{expectedAudit:{}},{expectedPreviousPublicationId:id(95)}])
  await assert.rejects(enqueue(db,{...req,...patch}),/ACTION_STALE_EVIDENCE/);
 await admin(db,"update profiles set role='admin' where id=$1",[actor]);await assert.rejects(enqueue(db,req),/ACTION_STALE_EVIDENCE/);
 await admin(db,"update profiles set role='superadmin' where id=$1",[actor]);
 await admin(db,"update supplier_price_releases set error_code='OTHER_ERROR' where id=$1",[release]);
 await assert.rejects(enqueue(db,{...req,expectedError:'OTHER_ERROR'}),/ACTION_STALE_EVIDENCE/);
});

test('changed audit evidence after acceptance is rejected without publication',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),e=await evidence(db,release),req=approvalRequest(e);
 await enqueue(db,req);await claim(db);await admin(db,'update public.test_overlap_control set n=1');
 await assert.rejects(execute(db,req.decisionId),/REVIEW_STALE_EVIDENCE/);
 const state=await admin(db,'select (select count(*) from supplier_current_price_pointers)::int pointers,(select count(*) from supplier_price_validation_internal.overlap_approvals)::int approvals');
 assert.deepEqual(state.rows[0],{pointers:0,approvals:0});
});

test('role loss and changed row validation after acceptance both fail closed',async t=>{
 for(const patch of ["update profiles set role='admin' where id=$1","update supplier_price_releases set warning_rows=1 where id=$1"]){
  const db=await fixture(t),release=await seedOverlap(db),e=await evidence(db,release),req=approvalRequest(e);
  await enqueue(db,req);await claim(db);await admin(db,patch,[patch.includes('profiles')?actor:release]);
  await assert.rejects(execute(db,req.decisionId),/REVIEW_(ACTOR_DENIED|ROWS_NOT_CLEAR)/);
 }
});

test('approval cannot authorize a different release or mutated audit, pointer or source',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),req=approvalRequest(await evidence(db,release));
 await enqueue(db,req);await claim(db);await execute(db,req.decisionId);await admin(db,'SELECT 1');
 let current=(await db.query('select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a;
 assert.equal(current.superadmin_overlap_approved,true);
 await db.exec('update public.test_overlap_control set n=1');
 current=(await db.query('select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a;assert.equal(current.review_required,true);
 await db.exec('update public.test_overlap_control set n=2');
 const other=await seedOverlap(db,11);assert.equal((await admin(db,'select supplier_price_validation_internal.cross_brand_audit($1) a',[other])).rows[0].a.review_required,true);
 await admin(db,"update supplier_price_releases set source_file_sha256=repeat('a',64) where id=$1",[release]);
 assert.equal((await admin(db,'select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a.review_required,true);
});

test('private approval state and function cannot be accessed directly by ordinary roles',async t=>{
 const db=await fixture(t);for(const role of ['anon','authenticated','service_role']){
  const result=await admin(db,"select has_table_privilege($1,'supplier_price_validation_internal.overlap_approvals','insert') w,has_table_privilege($1,'supplier_price_validation_internal.overlap_approvals','select') r,has_function_privilege($1,'supplier_price_validation_internal.overlap_approval_valid(uuid,jsonb)','execute') x",[role]);
  assert.deepEqual(result.rows[0],{w:false,r:false,x:false});
 }
});

test('same-count unseen overlap changes stale the exact fingerprint and operator can recheck',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),req=approvalRequest(await evidence(db,release));
 await enqueue(db,req);await claim(db);await execute(db,req.decisionId);
 await admin(db,"update public.test_overlap_control set extra_code='DIFFERENT_UNSAMPLED_CODE'");
 const stale=await evidence(db,release);assert.equal(stale.overlapApproved,false);assert.equal(stale.overlapApprovalStale,true);assert.equal(stale.canPublish,false);assert.equal(stale.canReview,true);
 const recheck={releaseId:release,decisionId:id(31),action:'recheck',reason:'comparison_repaired',expectedRevision:stale.reviewRevision,expectedStatus:stale.status,expectedError:stale.errorCode,expectedAudit:stale.brandIdentityAudit};
 await enqueue(db,recheck);await claim(db);const receipt=await execute(db,recheck.decisionId);assert.equal(receipt.status,'review_required');
 const after=await evidence(db,release);assert.equal(after.errorCode,'CROSS_BRAND_BULK_OVERLAP');assert.equal(after.canApproveOverlap,true);assert.equal(after.canPublish,false);
});

test('changed pointer after approval is stale and causes no pointer movement',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),req=approvalRequest(await evidence(db,release));await enqueue(db,req);await claim(db);await execute(db,req.decisionId);
 const previous=await seed(db,12,{held:false});await admin(db,'SELECT 1');
 await db.exec('alter table supplier_price_publications disable trigger supplier_publications_require_source_compatibility');
 await db.query("insert into supplier_price_publications(id,release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at) values($1,$2,$3,$4,$5,'published',1,now())",[id(99),previous,org,supplier,brand]);
 await db.query('insert into supplier_current_price_pointers(organization_id,supplier_id,brand_id,publication_id,release_id) values($1,$2,$3,$4,$5)',[org,supplier,brand,id(99),previous]);
 await db.exec('alter table supplier_price_publications enable trigger supplier_publications_require_source_compatibility');
 const stale=await evidence(db,release);assert.equal(stale.canPublish,false);assert.equal(stale.overlapApproved,false);assert.equal(stale.overlapApprovalStale,true);assert.equal(stale.canReview,true);
 assert.equal((await admin(db,'select publication_id from supplier_current_price_pointers where organization_id=$1 and supplier_id=$2 and brand_id=$3',[org,supplier,brand])).rows[0].publication_id,id(99));
});

test('migration installs against production replay and current v3 cross-brand function',async()=>{
 const {createFullReplayDb}=await import('./fixtures/price-engine-full-replay-db.mjs'); const db=await createFullReplayDb();
 try {
  const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));
  for(const item of manifest.migration_order)await db.exec(await readFile(item.file,'utf8'));
  for(const n of ['20261014162139_supplier_admin_release_action_queue','20261014165817_price_list_legacy_scope_compatibility','20261014171235_master_price_mixed_supplier_scopes','20261014175649_supplier_source_commercial_compatibility_guard','20261014183349_supplier_upload_safe_commercial_error_status','20261014193018_supplier_commercial_fields_v2_ingestion','20261014193456_supplier_commercial_fields_v2_readers','20261023185017_continental_automotive_brand_identity'])await db.exec(await readFile('supabase/migrations/'+n+'.sql','utf8'));
  await db.exec(overlap);
 } finally {await db.close();}
});

async function installCompatReceipt(db,release){
 await admin(db,`insert into supplier_price_ingestion_internal.source_compatibility_receipts(release_id,handoff_id,organization_id,supplier_id,brand_id,source_path,source_sha256,source_bytes,total_rows,policy)
 select r.id,h.id,r.organization_id,r.supplier_id,r.brand_id,r.source_file_path,r.source_file_sha256,h.source_bytes,r.total_rows,'supplier-price-commercial-fields-v1'
 from supplier_price_releases r join supplier_price_ingestion_internal.handoffs h on h.release_id=r.id where r.id=$1`,[release]);
}
async function fixturePublisherContract(db){
 await admin(db,`do $do$ declare definition text;begin
  definition:=pg_get_functiondef('supplier_price_ingestion_internal.admin_publish_staging(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)'::regprocedure);
  execute replace(definition,'v_identity->>''policy'' is distinct from ''cross-brand-v1''','coalesce(v_identity->>''policy'','''') not in (''cross-brand-v1'',''cross-brand-v2'',''cross-brand-v3'')');end $do$;`);
}

test('publication remains a separate decision; stale hidden matches block even a direct malicious publish request',async t=>{
 const db=await fixture(t),release=await seedOverlap(db);await installCompatReceipt(db,release);await fixturePublisherContract(db);
 const req=approvalRequest(await evidence(db,release));await enqueue(db,req);await claim(db);await execute(db,req.decisionId);
 const ready=await evidence(db,release);assert.equal(ready.canPublish,true);assert.equal(ready.overlapApproved,true);
 await admin(db,"update public.test_overlap_control set extra_code='UNSAMPLED_DIFFERENT'");
 const stale=await evidence(db,release);assert.equal(stale.canPublish,false);assert.equal(stale.overlapApprovalStale,true);
 const publish=publishRequest(release,id(31),ready.reviewRevision,null);await enqueue(db,publish,'publish');await claim(db);
 const receipt=await execute(db,publish.decisionId);assert.equal(receipt.published,false);assert.equal(receipt.status,'review_required');
 assert.equal((await admin(db,'select count(*)::int n from supplier_current_price_pointers')).rows[0].n,0);
});

test('clean approved release requires and completes a separate confirmed publication',async t=>{
 const db=await fixture(t),release=await seedOverlap(db);await installCompatReceipt(db,release);await fixturePublisherContract(db);
 const req=approvalRequest(await evidence(db,release));await enqueue(db,req);await claim(db);await execute(db,req.decisionId);
 const ready=await evidence(db,release);assert.equal(ready.canPublish,true);assert.equal(ready.overlapApproved,true);
 assert.equal((await admin(db,'select count(*)::int n from supplier_current_price_pointers')).rows[0].n,0);
 const publish=publishRequest(release,id(31),ready.reviewRevision,null);await enqueue(db,publish,'publish');await claim(db);
 const receipt=await execute(db,publish.decisionId);assert.equal(receipt.status,'published');assert.equal(receipt.published,true);
 assert.equal((await admin(db,'select count(*)::int n from supplier_current_price_pointers')).rows[0].n,1);
 assert.equal((await enqueue(db,publish,'publish')).replayed,true);
 const displayed=await evidence(db,release);assert.equal(displayed.overlapApprovalStale,false);assert.equal(displayed.overlapApproved,true);
});


test('changed unsampled matching code between evidence and approval is rejected',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),seen=await evidence(db,release),req=approvalRequest(seen);
 await enqueue(db,req);await claim(db);await admin(db,"update test_overlap_control set extra_code='DIFFERENT_AFTER_DISPLAY'");
 await assert.rejects(execute(db,req.decisionId),/REVIEW_STALE_EVIDENCE/);
 assert.equal((await admin(db,'select count(*)::int n from supplier_price_validation_internal.overlap_approvals')).rows[0].n,0);
});

test('approver loses superadmin role after approval: unpublished approval becomes stale',async t=>{
 const db=await fixture(t),release=await seedOverlap(db),req=approvalRequest(await evidence(db,release));
 await enqueue(db,req);await claim(db);await execute(db,req.decisionId);
 await admin(db,"update profiles set role='admin' where id=$1",[actor]);
 const stale=await evidence(db,release);assert.equal(stale.overlapApprovalStale,true);assert.equal(stale.canPublish,false);assert.equal(stale.canReview,true);
});

for(const target of [staging,production]) test(`PostgreSQL 17 full production audit ${target} integration and fenced approvals`, {skip:process.env.NEXT_MASTER_OVERLAP_POSTGRES!=='1',timeout:180000},async t=>{
 const exec=promisify(execFile), password=randomBytes(24).toString('hex'),container=`nm-overlap-pg-${randomBytes(6).toString('hex')}`;
 let db;
 try{
  await exec('docker',['run','--detach','--rm','--name',container,'--cpus','1','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
  const port=Number((await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/:(\d+)$/)[1]);
  for(let n=0;n<50;n++){try{const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',password,database:'postgres'});await c.connect();db=c;break;}catch{await delay(200);}}
  assert.ok(db,'postgres container started');db.exec=q=>db.query(q);db.close=()=>db.end();
  const {createFullReplayDb}=await import('./fixtures/price-engine-full-replay-db.mjs');await createFullReplayDb({db});
  const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));
  for(const item of manifest.migration_order)await db.exec(await readFile(item.file,'utf8'));
  for(const n of ['20261014162139_supplier_admin_release_action_queue','20261014165817_price_list_legacy_scope_compatibility','20261014171235_master_price_mixed_supplier_scopes','20261014175649_supplier_source_commercial_compatibility_guard','20261014183349_supplier_upload_safe_commercial_error_status','20261014193018_supplier_commercial_fields_v2_ingestion','20261014193456_supplier_commercial_fields_v2_readers','20261023185017_continental_automotive_brand_identity'])await db.exec(await readFile('supabase/migrations/'+n+'.sql','utf8'));
  // Exact pg_get_functiondef snapshot read from production; never replaces live code.
  await db.exec(await readFile('scripts/tests/fixtures/price-engine-live-cross-brand-audit.sql','utf8'));
  await db.exec(await readFile('scripts/tests/fixtures/price-engine-live-staging-publisher.sql','utf8'));
  await db.exec(await readFile('scripts/tests/fixtures/price-engine-live-production-publisher.sql','utf8'));
  await db.exec(overlap);
  await db.query("insert into organizations(id,name) values ($1,'Org')",[org]);
  await db.query("insert into suppliers(id,organization_id,name) values ($1,$2,'Supplier')",[supplier,org]);
  await db.query("insert into brands(id,organization_id,name) values ($1,$2,'Brand')",[brand,org]);
  await db.query("insert into profiles(id,organization_id,role,is_active,email,permissions) values ($1,$2,'superadmin',true,'test@example.invalid',$3)",[actor,org,{'supplier_prices.manage':true}]);
  await db.query('insert into auth.users(id) values ($1)',[actor]);
  await db.query("insert into auth.sessions(id,user_id,not_after) values ($1,$2,now()+interval '1 day')",[authSession,actor]);
  await db.query('update supplier_price_ingestion_internal.admin_release_action_control set enabled=true,expected_project_ref=$1',[target]);
  if(target===production)await db.query("update supplier_price_ingestion_internal.production_publication_control set enabled=true,activation_decision_id=$1,activated_by=$2,activated_at=now()",[id(99),actor]);
  await db.query("insert into brands(id,organization_id,name) values ($1,$2,'Cross Brand')",[id(9),org]);
  for(let i=1;i<=11;i++)await db.query(`insert into supplier_prices(organization_id,supplier_id,brand_id,product_code,buy_price,currency,valid_from,is_active)
   values($1,$2,$3,$4,1,'EUR',current_date,true)`,[org,supplier,id(9),`CODE10${String(i).padStart(3,'0')}`]);
  async function realRelease(n){const r=await seed(db,n,{rows:30,prefix:'CODE10'});await admin(db,"update supplier_price_release_rows set product_code='CODE10'||lpad(source_row_number::text,3,'0'), normalized_code='CODE10'||lpad(source_row_number::text,3,'0') where release_id=$1",[r]);await admin(db,'update supplier_price_upload_sessions u set checksum_sha256=r.source_file_sha256 from supplier_price_releases r where r.id=u.release_id and r.id=$1',[r]);const a=(await admin(db,'select supplier_price_validation_internal.cross_brand_audit($1) a',[r])).rows[0].a;assert.equal(a.policy,'cross-brand-v3');assert.equal(a.review_required,true);await admin(db,"update supplier_price_releases set error_code='CROSS_BRAND_BULK_OVERLAP',brand_identity_audit=$2 where id=$1",[r,a]);await installCompatReceipt(db,r);return r;}
  const release=await realRelease(10), before=await evidence(db,release,target), req=approvalRequest(before,id(30));assert.equal(before.canApproveOverlap,true);
  await admin(db,"update profiles set role='admin' where id=$1",[actor]);await assert.rejects(enqueue(db,req,'review',target),/ACTION_STALE_EVIDENCE/);await admin(db,"update profiles set role='superadmin' where id=$1",[actor]);
  await enqueue(db,req,'review',target);await claim(db,target);await assert.rejects(execute(db,req.decisionId,target,id(999)),/LEASE|ACTION/);const approved=await execute(db,req.decisionId,target);assert.equal(approved.status,'overlap_approved');assert.equal(approved.published,false);
  const ready=await evidence(db,release,target);assert.equal(ready.overlapApproved,true);assert.equal(ready.canPublish,true);
  assert.equal((await admin(db,'select count(*)::int n from supplier_current_price_pointers')).rows[0].n,0);
  await admin(db,"update supplier_prices set product_code='CODE10012' where brand_id=$1 and normalized_code='CODE10011'",[id(9)]);
  const stale=await evidence(db,release,target);assert.equal(stale.overlapApprovalStale,true);assert.equal(stale.canPublish,false);
  const actual=(await admin(db,'select supplier_price_validation_internal.cross_brand_audit($1) a',[release])).rows[0].a;
  assert.deepEqual(actual.brands[0].sample_codes,before.brandIdentityAudit.brands[0].sample_codes);assert.equal(actual.brands[0].matching_codes,11);
  const changedRelease=await realRelease(14), seen=await evidence(db,changedRelease,target), changedReq=approvalRequest(seen,id(35));
  await enqueue(db,changedReq,'review',target);await claim(db,target);
  await admin(db,"update supplier_prices set product_code='CODE10013' where brand_id=$1 and normalized_code='CODE10012'",[id(9)]);
  await assert.rejects(execute(db,changedReq.decisionId,target),/REVIEW_STALE_EVIDENCE/);await fail(db,changedReq.decisionId,'ACTION_EXECUTION_FAILED',target);
  const pointerRelease=await realRelease(13), pointerReq=approvalRequest(await evidence(db,pointerRelease,target),id(34));await enqueue(db,pointerReq,'review',target);await claim(db,target);await execute(db,pointerReq.decisionId,target);assert.equal((await evidence(db,pointerRelease,target)).overlapApproved,true);
  const clean=await realRelease(11), cleanReq=approvalRequest(await evidence(db,clean,target),id(31));await enqueue(db,cleanReq,'review',target);await claim(db,target);await execute(db,cleanReq.decisionId,target);
  const cleanReady=await evidence(db,clean,target);assert.equal(cleanReady.canPublish,true);
  const publish=publishRequest(clean,id(32),cleanReady.reviewRevision,null);await enqueue(db,publish,'publish',target);await claim(db,target);const p=await execute(db,publish.decisionId,target);assert.equal(p.published,true);assert.equal((await evidence(db,clean,target)).overlapApprovalStale,false);
  const pointerStale=await evidence(db,pointerRelease,target);assert.equal(pointerStale.overlapApprovalStale,true);assert.equal(pointerStale.canPublish,false);
  const r2=await realRelease(12), e2=await evidence(db,r2,target), req2=approvalRequest(e2,id(33));await enqueue(db,req2,'review',target);await claim(db,target);await admin(db,'update supplier_price_release_rows set buy_price=99 where release_id=$1 and source_row_number=1',[r2]);await assert.rejects(execute(db,req2.decisionId,target),/REVIEW_STALE_EVIDENCE/);
  t.diagnostic(JSON.stringify({postgres:17,realAudit:true,approvalSeparateFromPublish:true,staleMatch:true,staleRow:true,superadmin:true,leaseFence:true}));
 }finally{if(db)await db.end().catch(()=>{});await exec('docker',['rm','--force',container],{timeout:20000}).catch(()=>{});}
});
