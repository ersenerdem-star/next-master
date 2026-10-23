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
  await db.exec(foundation); if(withProduction) await db.exec(publication); await db.exec(migration); await seedFoundationTestScope(db);
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
async function state(db) {
  return (await admin(db,`SELECT jsonb_build_object('releases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM supplier_price_releases r),
    'publications',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM supplier_price_publications p),
    'pointers',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY release_id),'[]') FROM supplier_current_price_pointers p),
    'reviewDecisions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') FROM supplier_price_validation_internal.review_decisions d),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM supplier_price_release_events e),
    'actions',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY decision_id),'[]') FROM supplier_price_ingestion_internal.admin_release_actions a)) value`)).rows[0].value;
}

test('closed target, actual database session and service-only ACLs protect all new adapters',async t=>{
  const db=await fixture(t,{enabled:false}),release=await seed(db,10);
  await assert.rejects(evidence(db,release),/ACTION_NOT_ENABLED/);
  await admin(db,'UPDATE supplier_price_ingestion_internal.admin_release_action_control SET enabled=true,expected_project_ref=$1',[staging]);
  await assert.rejects(evidence(db,release,production),/ACTION_NOT_ENABLED/);
  for(const role of ['anon','authenticated']) {
    await db.exec(`RESET ROLE; SET ROLE ${role}; SELECT set_config('request.jwt.claim.role','service_role',false)`);
    for(const [name,args] of [['get_supplier_release_action_evidence',[...auth(),release]],['request_supplier_release_action',[...auth(),'publish',publishRequest(release)]],['claim_supplier_release_action',[staging,owner]],['execute_supplier_release_action',[staging,id(30),owner]],['fail_supplier_release_action',[staging,id(30),owner,'ACTION_EXECUTION_FAILED']]])
      await assert.rejects(db.query(`select public.${name}(${args.map((_,n)=>`$${n+1}`).join(',')})`,args),/permission denied/);
  }
  await db.exec("RESET ROLE; SET ROLE service_role; SELECT set_config('request.jwt.claim.role','authenticated',false)");
  await assert.rejects(db.query('SELECT public.claim_supplier_release_action($1,$2)',[staging,owner]),/ACTION_SERVICE_REQUIRED/);
  const grants=(await admin(db,`SELECT has_table_privilege('service_role','supplier_price_ingestion_internal.admin_release_actions','UPDATE') table_write,
    has_schema_privilege('service_role','supplier_price_ingestion_internal','USAGE') schema_access,
    has_function_privilege('service_role','supplier_price_ingestion_internal.admin_publish_staging(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)','EXECUTE') helper_access`)).rows[0];
  assert.deepEqual(grants,{table_write:false,schema_access:false,helper_access:false});
  for(const changed of [[staging,id(999),org,authSession,iat,exp],[staging,actor,id(2),authSession,iat,exp],[staging,actor,org,id(999),iat,exp],[staging,actor,org,authSession,iat,iat+1],[staging,actor,org,authSession,exp+1000,exp+2000]])
    await assert.rejects(rpc(db,'get_supplier_release_action_evidence',[...changed,release]),/ACTION_(SESSION|ACTOR)_DENIED/);
  await assert.rejects(evidence(db,id(999)),/ACTION_SCOPE_DENIED/);
  await admin(db,"UPDATE profiles SET is_active=null WHERE id=$1",[actor]);
  await assert.rejects(evidence(db,release),/ACTION_ACTOR_DENIED/);
});

test('enqueue pins exact review evidence and immutable decision; active release has only one action',async t=>{
  const db=await fixture(t),release=await seed(db,10),request=await reviewRequest(db,release);
  for(const patch of [{extra:true},{expectedRevision:'0'},{expectedRevision:1},{expectedStatus:'staged'},{expectedAudit:{}},{expectedError:null},{action:'waive'},{reason:'override'}])
    await assert.rejects(enqueue(db,{...request,...patch}),/ACTION_(INPUT_INVALID|STALE_EVIDENCE)/);
  const before=await state(db),queued=await enqueue(db,request);
  assert.deepEqual(queued,{releaseId:release,decisionId:id(30),action:'recheck',status:'queued',errorCode:null,published:false,replayed:false});
  assert.deepEqual(await enqueue(db,request),{...queued,replayed:true});
  await assert.rejects(enqueue(db,{...request,expectedRevision:1}),/ACTION_DECISION_CONFLICT/);
  await assert.rejects(enqueue(db,{...request,decisionId:id(99)}),/ACTION_ALREADY_PENDING/);
  const after=await state(db); assert.deepEqual(after.releases,before.releases); assert.deepEqual(after.events,before.events); assert.equal(after.actions.length,1);
  assert.equal(after.actions[0].accepted_auth_session_id,authSession);
  const e=await evidence(db,release); assert.equal(e.canReview,false); assert.equal(e.reviewOperation.status,'queued'); assert.equal(e.reviewOperation.receipt,null);
  await admin(db,'SELECT 1');
  await assert.rejects(db.query('UPDATE supplier_price_ingestion_internal.admin_release_actions SET accepted_token_exp=accepted_token_exp+1'),/ACTION_IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM supplier_price_ingestion_internal.admin_release_actions'),/ACTION_IMMUTABLE/);
});

test('actual full review then guarded staging publication, replay and pointer supersession preserve one business effect',async t=>{
  const db=await fixture(t),release=await seed(db,10),request=await reviewRequest(db,release);
  assert.equal((await evidence(db,release)).canReview,true);
  await enqueue(db,request); const claimed=await claim(db); assert.equal(claimed.action,'review');
  await assert.rejects(execute(db,id(30),staging,id(999)),/ACTION_STALE_LEASE/);
  const reviewed=await execute(db,id(30));
  assert.deepEqual(reviewed,{releaseId:release,decisionId:id(30),action:'recheck',status:'rechecked_clear',reviewRevision:1,errorCode:null,published:false,replayed:false});
  const snapshot=await state(db); assert.deepEqual(await execute(db,id(30)),{...reviewed,replayed:true}); assert.deepEqual(await enqueue(db,request),{...reviewed,replayed:true}); assert.deepEqual(await state(db),snapshot);
  const clear=await evidence(db,release); assert.equal(clear.canPublish,true); assert.equal(clear.brandIdentityAudit.checked,true); assert.equal(clear.brandIdentityAudit.distinct_incoming_codes,2); assert.equal(clear.reviewOperation.receipt.replayed,true);
  const pubRequest=publishRequest(release,id(31),1); await enqueue(db,pubRequest,'publish'); await claim(db);
  const published=await execute(db,id(31)); assert.equal(published.status,'published'); assert.equal(published.published,true); assert.equal(published.isCurrent,true);
  const postPublish=await state(db); assert.equal(postPublish.publications.length,1); assert.equal(postPublish.reviewDecisions.length,1);
  assert.deepEqual(await fail(db,id(31)),{...published,replayed:true}); assert.deepEqual(await state(db),postPublish,'late failure cannot alter completed result');
  const second=await seed(db,11,{held:false}); const nextEvidence=await evidence(db,second); assert.equal(nextEvidence.currentPublicationId,published.publicationId,'evidence returns previous scope pointer, not only candidate pointer');
  await assert.rejects(enqueue(db,publishRequest(second,id(32)),'publish'),/ACTION_STALE_POINTER/);
  await enqueue(db,publishRequest(second,id(32),0,published.publicationId),'publish'); await claim(db); const next=await execute(db,id(32));
  assert.equal(next.version,2); const replay=await execute(db,id(31)); assert.equal(replay.isCurrent,false); assert.equal(replay.publicationId,published.publicationId);
  assert.equal((await evidence(db,release)).publishOperation.receipt.isCurrent,false);
  assert.equal((await state(db)).pointers[0].publication_id,next.publicationId);
  await admin(db,'SELECT 1'); await assert.rejects(db.query('DELETE FROM supplier_price_ingestion_internal.admin_staging_publication_decisions'),/ACTION_IMMUTABLE/);
});

test('production queue invokes original publisher and cannot bypass its separate closed publication control',async t=>{
  const db=await fixture(t,{target:production}),release=await seed(db,10,{held:false}),request=publishRequest(release);
  assert.equal((await evidence(db,release,production)).canPublish,false,'closed production switch disables the button');
  await admin(db,'UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=true,activation_decision_id=$1,activated_by=$2,activated_at=now()',[id(99),actor]);
  assert.equal((await evidence(db,release,production)).canPublish,true,'enabled switch plus a ready release allows explicit publication');
  await admin(db,'UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=false');
  await enqueue(db,request,'publish',production);await claim(db,production);
  const before=await state(db);await assert.rejects(execute(db,id(31),production),/PRODUCTION_PUBLICATION_NOT_ENABLED/);assert.deepEqual(await state(db),before);
  await admin(db,'UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=true,activation_decision_id=$1,activated_by=$2,activated_at=now()',[id(99),actor]);
  const receipt=await execute(db,id(31),production);assert.equal(receipt.published,true);
  const ledgers=(await admin(db,`SELECT (SELECT count(*)::int FROM supplier_price_ingestion_internal.production_publication_decisions) production,(SELECT count(*)::int FROM supplier_price_ingestion_internal.admin_staging_publication_decisions) staging`)).rows[0];
  assert.deepEqual(ledgers,{production:1,staging:0});
});

test('V3 staging parity does not depend on production-only publisher or controls',async t=>{
  const db=await fixture(t,{withProduction:false}),release=await seed(db,10,{held:false});
  const absence=(await admin(db,"SELECT to_regclass('supplier_price_ingestion_internal.production_publication_control') c,to_regprocedure('public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)') f")).rows[0];
  assert.deepEqual(absence,{c:null,f:null});
  assert.equal((await evidence(db,release)).canPublish,true,'V3 eligibility does not need production-only controls');
  await enqueue(db,publishRequest(release),'publish');await claim(db);assert.equal((await execute(db,id(31))).published,true);
});

test('missing production publication control fails eligibility closed',async t=>{
  const db=await fixture(t,{target:production,withProduction:false}),release=await seed(db,10,{held:false});
  assert.equal((await evidence(db,release,production)).canPublish,false);
});

test('fresh cross-brand audit after queue acceptance holds publication and preserves current pointer',async t=>{
  const db=await fixture(t),release=await seed(db,10,{held:false,rows:100,prefix:'OVERLAP'});
  await enqueue(db,publishRequest(release),'publish');await claim(db);
  await admin(db,"INSERT INTO brands(id,organization_id,name) VALUES($1,$2,'Different')",[id(12),org]);
  await db.query(`INSERT INTO catalog_products(id,organization_id,brand_id,product_code,normalized_code)
    SELECT md5('overlap'||i)::uuid,$1,$2,'OVERLAP'||i,'OVERLAP'||i FROM generate_series(1,100)i`,[org,id(12)]);
  const receipt=await execute(db,id(31));assert.equal(receipt.status,'review_required');assert.equal(receipt.errorCode,'CROSS_BRAND_BULK_OVERLAP');assert.equal(receipt.published,false);
  const s=await state(db);assert.equal(s.publications.length,0);assert.equal(s.pointers.length,0);assert.equal(s.releases[0].brand_identity_audit.review_required,true);assert.equal(s.actions[0].status,'completed');
  assert.deepEqual(await execute(db,id(31)),{...receipt,replayed:true});
});

test('execution rechecks database session, token, actor and exact queued CAS before mutation',async t=>{
  const db=await fixture(t),release=await seed(db,10),request=await reviewRequest(db,release);await enqueue(db,request);await claim(db);
  for(const [mutate,restore,error] of [
    ["UPDATE profiles SET session_revoked_at=clock_timestamp()","UPDATE profiles SET session_revoked_at=null",/ACTION_SESSION_DENIED/],
    ["UPDATE profiles SET is_active=false","UPDATE profiles SET is_active=true",/ACTION_ACTOR_DENIED/],
    ["UPDATE profiles SET role='staff'","UPDATE profiles SET role='superadmin'",/ACTION_ACTOR_DENIED/],
    ["UPDATE auth.sessions SET not_after=now()-interval '1 second'","UPDATE auth.sessions SET not_after=now()+interval '1 day'",/ACTION_SESSION_DENIED/],
    ["UPDATE supplier_price_releases SET review_revision=1","UPDATE supplier_price_releases SET review_revision=0",/REVIEW_STALE_EVIDENCE/]
  ]) { await admin(db,mutate);const before=await state(db);await assert.rejects(execute(db,id(30)),error);assert.deepEqual(await state(db),before);await admin(db,restore); }
  await admin(db,'DELETE FROM auth.sessions WHERE id=$1',[authSession]);await assert.rejects(execute(db,id(30)),/ACTION_SESSION_DENIED/);
  const failed=await fail(db,id(30));assert.equal(failed.status,'failed');assert.equal((await enqueue(db,request).catch(e=>({error:e.message}))).error,'ACTION_SESSION_DENIED');
});

test('post-action session expiry rolls back domain changes and receipt atomically',async t=>{
  const db=await fixture(t),release=await seed(db,10),request=await reviewRequest(db,release);await enqueue(db,request);await claim(db);
  // Fault injection only in the local fixture: expiry becomes authoritative after the real full review.
  await admin(db,'SELECT 1'); await db.exec(`CREATE FUNCTION public.fixture_expire_session() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second';RETURN NEW;END$$;
    CREATE TRIGGER fixture_expire_session AFTER INSERT ON supplier_price_validation_internal.review_decisions FOR EACH ROW EXECUTE FUNCTION public.fixture_expire_session()`);
  const before=await state(db);await assert.rejects(execute(db,id(30)),/ACTION_SESSION_DENIED/);assert.deepEqual(await state(db),before,'review rows, audit, decision ledger and receipt all roll back');
  await admin(db,'DROP TRIGGER fixture_expire_session ON supplier_price_validation_internal.review_decisions');
  assert.equal((await execute(db,id(30))).status,'rechecked_clear');
});

test('expired lease reclaims same immutable request; stale owner cannot execute or fail; max attempts are bounded',async t=>{
  const db=await fixture(t),release=await seed(db,10),request=await reviewRequest(db,release);await enqueue(db,request);
  const lease1=id(51),lease2=id(52);await claim(db,staging,lease1);
  assert.deepEqual(await claim(db),{status:'empty'});
  await admin(db,"UPDATE supplier_price_ingestion_internal.admin_release_actions SET lease_expires_at=now()-interval '1 second'");
  assert.equal((await claim(db,staging,lease2)).decision_id,id(30));
  await assert.rejects(execute(db,id(30),staging,lease1),/ACTION_STALE_LEASE/);await assert.rejects(fail(db,id(30),'ACTION_EXECUTION_FAILED',staging,lease1),/ACTION_STALE_LEASE/);
  for(let n=0;n<2;n++) {await admin(db,"UPDATE supplier_price_ingestion_internal.admin_release_actions SET lease_expires_at=now()-interval '1 second'");await claim(db);}
  const e=await evidence(db,release);assert.equal(e.reviewOperation.status,'failed');assert.equal(e.reviewOperation.errorCode,'ACTION_RETRY_EXHAUSTED');
  const replay=await enqueue(db,request);assert.equal(replay.status,'failed');assert.equal(replay.replayed,true);assert.equal(replay.action,'recheck');
  const s=await state(db);assert.equal(s.actions[0].attempt,3);assert.equal(s.reviewDecisions.length,0);assert.equal(s.releases[0].review_revision,0);
});

test('evidence is bounded in UTF8 and queued scope/source binding cannot silently change',async t=>{
  const db=await fixture(t),release=await seed(db,10),request=await reviewRequest(db,release);await enqueue(db,request);await claim(db);
  await admin(db,"UPDATE supplier_price_releases SET source_file_sha256=repeat('b',64) WHERE id=$1",[release]);
  const before=await state(db);await assert.rejects(execute(db,id(30)),/ACTION_SOURCE_REQUIRED/);assert.deepEqual(await state(db),before);
  await admin(db,'UPDATE supplier_price_releases r SET source_file_sha256=h.source_sha256 FROM supplier_price_ingestion_internal.handoffs h WHERE h.release_id=r.id');
  await admin(db,"INSERT INTO brands(id,organization_id,name) VALUES($1,$2,'Changed scope')",[id(12),org]);
  await admin(db,'UPDATE supplier_price_releases SET brand_id=$1 WHERE id=$2',[id(12),release]);
  await assert.rejects(execute(db,id(30)),/ACTION_SCOPE_DENIED/);
  await admin(db,'UPDATE supplier_price_releases SET brand_id=$1,total_rows=0 WHERE id=$2',[brand,release]);
  const e=await evidence(db,release);assert.equal(e.totalRows,0);assert.equal(e.canPublish,false);
  await admin(db,"UPDATE supplier_price_releases SET brand_identity_audit=jsonb_build_object('detail',repeat('é',9000)) WHERE id=$1",[release]);
  await assert.rejects(evidence(db,release),/ACTION_EVIDENCE_TOO_LARGE/);
});

test('review never waives missing-price conflicts and explicit rejection preserves source rows',async t=>{
  const db=await fixture(t),release=await seed(db,10);
  await admin(db,'UPDATE supplier_price_release_rows SET buy_price=null WHERE release_id=$1 AND source_row_number=1',[release]);
  await enqueue(db,await reviewRequest(db,release));await claim(db);const reviewed=await execute(db,id(30));
  assert.equal(reviewed.status,'review_required');assert.equal(reviewed.errorCode,'VALIDATION_REVIEW_REQUIRED');assert.equal((await evidence(db,release)).canPublish,false);
  const request=await reviewRequest(db,release,id(32),staging,'reject');await enqueue(db,request);await claim(db);
  const rejected=await execute(db,id(32));assert.equal(rejected.action,'reject');assert.equal(rejected.status,'rejected');assert.equal(rejected.reviewRevision,2);
  const s=await state(db);assert.equal(s.releases[0].status,'cancelled');assert.equal(s.publications.length,0);
  assert.equal((await admin(db,'SELECT count(*)::int n FROM supplier_price_release_rows')).rows[0].n,2);
  await assert.rejects(enqueue(db,publishRequest(release,id(33),2),'publish'),/ACTION_STATE_DENIED/);
});

// Reconstruct only the same captured baseline used by the PGlite fixture. No provider credentials or network host input.
async function realPgBaseline(db) {
  const baseline=JSON.parse(await readFile(new URL('./fixtures/price-engine-production-baseline.json',import.meta.url),'utf8'));
  const quote=x=>'"'+x.replaceAll('"','""')+'"';
  const type=c=>c.type==='aal_level'?'auth.aal_level':c.type==='_text'?'text[]':c.type;
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE SCHEMA extensions;CREATE TYPE auth.aal_level AS ENUM('aal1','aal2','aal3');
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('request.jwt.claim.role',true),'')$$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;`);
  for(const [name,columns] of Map.groupBy(baseline.columns,c=>`${c.schema}.${c.table}`))
    await db.exec(`CREATE TABLE ${name}(${columns.map(c=>`${quote(c.name)} ${type(c)}`).join(',')}${columns.some(c=>c.name==='id')?',PRIMARY KEY(id)':''})`);
  for(const table of baseline.additionalTables)
    await db.exec(`CREATE TABLE public.${quote(table.name)}(${table.columns.map(c=>`${quote(c.name)} ${c.type}`).join(',')},${table.constraints.find(c=>c.type==='p').definition})`);
  await db.exec(`CREATE TABLE storage.buckets(${baseline.buckets.map(c=>`${quote(c.name)} ${c.type}`).join(',')},PRIMARY KEY(id));
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;
    GRANT SELECT ON public.profiles TO authenticated;CREATE POLICY fixture_broad_storage ON storage.objects TO anon,authenticated USING(true) WITH CHECK(true);`);
  for(const fn of [...baseline.dependencyFunctions,...baseline.functions]) await db.exec(fn.definition);
}

test('isolated PostgreSQL17 concurrent worker fencing and discarded commit reply recover one review/publication',
  {skip:process.env.RUN_SUPPLIER_ACTION_PG_RUNTIME!=='1',timeout:90000},async t=>{
  const exec=promisify(execFile),container=`nm-actions-pg-${process.pid}-${randomBytes(4).toString('hex')}`,password=randomBytes(24).toString('hex');
  const clients=[];let db;
  try {
    await exec('docker',['run','--detach','--rm','--name',container,'--cpus','0.5','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=supplier_actions_test','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
    const port=(await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);assert.ok(port,'bind only loopback');
    const config={host:'127.0.0.1',port:Number(port[1]),user:'postgres',password,database:'supplier_actions_test',connectionTimeoutMillis:1000};
    for(let n=0;n<60;n++) {const candidate=new pg.Client(config);try{await candidate.connect();db=candidate;break;}catch{await candidate.end().catch(()=>{});await delay(250);}}
    assert.ok(db);clients.push(db);db.exec=sql=>db.query(sql);
    const peer=new pg.Client(config);await peer.connect();clients.push(peer);peer.exec=sql=>peer.query(sql);
    await realPgBaseline(db);await db.exec(foundation);await db.exec(publication);await db.exec(migration);await seedFoundationTestScope(db);
    await db.query('UPDATE supplier_price_ingestion_internal.admin_release_action_control SET enabled=true,expected_project_ref=$1',[staging]);
    const release=await seed(db,10),request=await reviewRequest(db,release);await enqueue(db,request);await claim(db);
    // Function's effects and receipt share the outer transaction. Before commit no peer can steal or double-execute.
    await db.exec('BEGIN');const reviewed=await execute(db,id(30));assert.equal(reviewed.status,'rechecked_clear');
    assert.deepEqual(await claim(peer,staging,id(51)),{status:'empty'});
    await assert.rejects(execute(peer,id(30),staging,id(51)),e=>e.code==='55P03');
    await db.exec('COMMIT'); // Simulate the HTTP caller discarding the committed response.
    const replay=await execute(peer,id(30),staging,id(51));assert.equal(replay.replayed,true);assert.equal(replay.reviewRevision,1);
    let s=await state(db);assert.equal(s.reviewDecisions.length,1);assert.equal(s.releases[0].review_revision,1);assert.equal(s.actions.length,1);
    await enqueue(db,publishRequest(release,id(31),1),'publish');await claim(db);
    await db.exec('BEGIN');const published=await execute(db,id(31));assert.equal(published.published,true);
    assert.deepEqual(await claim(peer,staging,id(51)),{status:'empty'});await db.exec('COMMIT');
    assert.deepEqual(await execute(peer,id(31),staging,id(51)),{...published,replayed:true});
    assert.deepEqual(await fail(peer,id(31),'ACTION_EXECUTION_TIMEOUT',staging,id(51)),{...published,replayed:true});
    s=await state(db);assert.equal(s.publications.length,1);assert.equal(s.pointers.length,1);assert.equal(s.actions.length,2);
    // Statement rollback before commit leaves the original claim recoverable, with no hidden partial decision ledger.
    const second=await seed(db,11),secondRequest=await reviewRequest(db,second,id(32));await enqueue(db,secondRequest);await claim(db);
    await db.exec('BEGIN');assert.equal((await execute(db,id(32))).status,'rechecked_clear');await db.exec('ROLLBACK');
    await admin(db,"UPDATE supplier_price_ingestion_internal.admin_release_actions SET lease_expires_at=now()-interval '1 second' WHERE decision_id=$1",[id(32)]);
    assert.equal((await claim(peer,staging,id(52))).decision_id,id(32));await assert.rejects(execute(db,id(32)),/ACTION_STALE_LEASE/);
    assert.equal((await execute(peer,id(32),staging,id(52))).reviewRevision,1);
    s=await state(db);assert.equal(s.reviewDecisions.length,2);assert.equal(s.actions.find(a=>a.decision_id===id(32)).attempt,2);
    t.diagnostic(JSON.stringify({postgres:17,cpu:0.5,memoryMiB:1024,queueClaimSkipLocked:true,concurrentExecutionLockTimeout:'55P03',
      discardedReviewCommitReplyReconciled:true,discardedPublishCommitReplyReconciled:true,publicationCount:1,
      reviewRevisionPerRelease:1,rolledBackExecutionReclaimed:true,remoteAccess:false}));
  } finally {
    for(const client of clients) await client.end().catch(()=>{});
    await exec('docker',['rm','--force',container],{timeout:20000}).catch(()=>{});
  }
});

async function currentEvidenceAdapters(db){
 await admin(db,`create table public.catalog_product_source_records(organization_id uuid,catalog_product_id uuid);`);
}
const percentMigration=await readFile(new URL('../../supabase/migrations/20261023181019_supplier_brand_five_percent_review_rule.sql',import.meta.url),'utf8');
test('actual production publish reproduces v2 adapter rejection, then v3 completes the same fenced decision',async t=>{
 const db=await fixture(t,{target:production});await currentEvidenceAdapters(db);
 await admin(db,'UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=true,activation_decision_id=$1,activated_by=$2,activated_at=now()',[id(99),actor]);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261023175926_supplier_brand_audit_current_source_evidence.sql',import.meta.url),'utf8'));
 const release=await seed(db,10,{held:false});
 const definitionBefore=(await admin(db,"select proacl,proconfig,prosecdef from pg_proc where oid='public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)'::regprocedure")).rows[0];
 const decision=id(30);await enqueue(db,publishRequest(release,decision),'publish',production);await claim(db,production);
 await assert.rejects(execute(db,decision,production),/PRODUCTION_PUBLICATION_IDENTITY_NOT_CLEAR/);
 await db.exec('reset role');await db.exec(percentMigration);
 const definitionAfter=(await admin(db,"select proacl,proconfig,prosecdef from pg_proc where oid='public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)'::regprocedure")).rows[0];
 assert.deepEqual(definitionAfter,definitionBefore);
 const result=await execute(db,decision,production);assert.equal(result.status,'published');assert.equal(result.published,true);
 const saved=(await admin(db,'select status,brand_identity_audit from supplier_price_releases where id=$1',[release])).rows[0];
 assert.equal(saved.status,'published');assert.equal(saved.brand_identity_audit.policy,'cross-brand-v3');assert.equal(saved.brand_identity_audit.review_required,false);
 assert.equal((await execute(db,decision,production)).replayed,true);
 assert.equal((await admin(db,'select count(*)::int n from supplier_price_publications')).rows[0].n,1);
 const nextRelease=await seed(db,11,{held:false}),nextDecision=id(31);
 await enqueue(db,publishRequest(nextRelease,nextDecision,0,result.publicationId),'publish',production);await claim(db,production);
 const next=await execute(db,nextDecision,production);
 await admin(db,'update supplier_price_ingestion_internal.production_publication_control set reversal_enabled=true');
 const reversed=await rpc(db,'reverse_supplier_price_publication_production',[production,org,supplier,brand,actor,id(90),nextDecision,next.publicationId,0]);
 assert.equal(reversed.reversed,true);assert.equal(reversed.restored_publication_id,result.publicationId);
});
test('actual staging adapter publishes after a fresh v3 audit and unknown policy remains refused',async t=>{
 const db=await fixture(t);await currentEvidenceAdapters(db);await db.exec('reset role');await db.exec(percentMigration);
 const release=await seed(db,10,{held:false}),decision=id(30);
 await enqueue(db,publishRequest(release,decision),'publish');await claim(db);
 const result=await execute(db,decision);assert.equal(result.status,'published');
 const audit=(await admin(db,'select brand_identity_audit from supplier_price_releases where id=$1',[release])).rows[0].brand_identity_audit;
 assert.equal(audit.policy,'cross-brand-v3');
 const definition=(await admin(db,"select pg_get_functiondef('supplier_price_ingestion_internal.admin_publish_staging(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)'::regprocedure) d")).rows[0].d;
 assert.match(definition,/not in \('cross-brand-v1','cross-brand-v2','cross-brand-v3'\)/);
 await db.exec('reset role');
 const auditDef=(await db.query("select pg_get_functiondef('supplier_price_validation_internal.cross_brand_audit(uuid)'::regprocedure) d")).rows[0].d;
 await db.exec(auditDef.replaceAll('cross-brand-v3','unknown-policy'));
 const nextRelease=await seed(db,11,{held:false}),nextDecision=id(31);
 await enqueue(db,publishRequest(nextRelease,nextDecision,0,result.publicationId),'publish');await claim(db);
 await assert.rejects(execute(db,nextDecision),/PRODUCTION_PUBLICATION_IDENTITY_NOT_CLEAR/);

});

test('five-percent migration supports staging without installing production publication capabilities',async t=>{
 const db=await fixture(t,{withProduction:false});await currentEvidenceAdapters(db);await db.exec(percentMigration);
 const missing=(await db.query("select to_regprocedure('public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)') f")).rows[0];assert.equal(missing.f,null);
 const release=await seed(db,10,{held:false});await enqueue(db,publishRequest(release,id(30)),'publish');await claim(db);
 assert.equal((await execute(db,id(30))).published,true);
});
