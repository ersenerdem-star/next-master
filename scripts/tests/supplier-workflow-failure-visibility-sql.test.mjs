import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFoundationTestDb, seedFoundationTestScope } from './fixtures/price-engine-foundation-db.mjs';

const foundation = await readFile(new URL('../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../../supabase/migrations/20261014144957_supplier_price_workflow_failure_visibility.sql', import.meta.url), 'utf8');
const detailed = await readFile(new URL('../../supabase/migrations/20261019090417_supplier_processing_failure_reason.sql', import.meta.url),'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const release = id(9), session = id(10), handoff = id(12), workflow = `supplier-price-verified:v1:${release}`;
const code = 'SUPPLIER_PROCESSING_INTERRUPTED';
const contextSql = 'SELECT to_jsonb(c) value FROM public.get_supplier_price_workflow_failure_context($1::uuid[]) c';
const markerSql = 'SELECT public.mark_supplier_price_processing_interrupted($1,$2,$3,$4,$5,$6) value';

async function fixture(t) {
  const db = await createFoundationTestDb();
  t.after(() => db.close());
  await db.exec(foundation);
  await seedFoundationTestScope(db);
  await db.exec(migration);
  await db.query(`INSERT INTO public.supplier_price_releases(id,organization_id,supplier_id,brand_id,source_file_path,
    source_file_sha256,created_by,source_verification_required,status,total_rows,current_cursor,processed_rows,
    accepted_rows,uploaded_at,updated_at)
    VALUES($1,$2,$3,$4,'verified-source.csv',$5,$6,true,'parsing',1000,500,600,600,
      date_trunc('second',now()-interval '1 hour'),date_trunc('second',now()-interval '1 minute'))`,
  [release,id(1),id(3),id(5),'a'.repeat(64),id(7)]);
  await db.query(`INSERT INTO public.supplier_price_upload_sessions(id,organization_id,release_id,idempotency_key,
    storage_object_path,file_name,content_type,total_bytes,uploaded_bytes,status,created_by,expires_at)
    VALUES($1,$2,$3,'observer-fixture','verified-source.csv','source.csv','text/csv',100,100,'uploaded',$4,now()+interval '1 day')`,
  [session,id(1),release,id(7)]);
  await db.query(`INSERT INTO storage.objects(id,bucket_id,name,version,updated_at,metadata)
    VALUES($1,'supplier-price-imports','verified-source.csv','object-v1',date_trunc('second',now()-interval '1 hour'),' {"size":100}')`,[id(11)]);
  await db.query(`INSERT INTO supplier_price_ingestion_internal.handoffs(id,session_id,release_id,organization_id,
    storage_bucket,source_path,source_sha256,source_bytes,total_rows,object_id,object_version,object_updated_at,workflow_id,status,enqueued_at)
    SELECT $1,$2,$3,$4,o.bucket_id,o.name,$5,100,1000,o.id,o.version,o.updated_at,$6,'enqueued',now()-interval '1 minute'
    FROM storage.objects o WHERE o.id=$7`,[handoff,session,release,id(1),'a'.repeat(64),workflow,id(11)]);
  return db;
}
async function admin(db, sql, args=[]) {
  await db.exec('RESET ROLE');
  return db.query(sql,args);
}
async function service(db, sql, args=[]) {
  await db.exec("SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false)");
  return db.query(sql,args);
}
async function context(db) { return (await service(db,contextSql,[[release]])).rows[0]?.value; }
async function args(db) {
  const c = await context(db);
  const failedAt = (await service(db,"SELECT clock_timestamp()::text value")).rows[0].value;
  return [release,handoff,workflow,c.current_cursor,c.updated_at,failedAt];
}
async function mark(db, values) { return (await service(db,markerSql,values || await args(db))).rows[0].value; }
async function snapshot(db) {
  return (await admin(db,`SELECT jsonb_build_object(
    'release',(SELECT to_jsonb(r) FROM public.supplier_price_releases r WHERE id=$1),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM public.supplier_price_release_events e),
    'rows',(SELECT count(*) FROM public.supplier_price_release_rows),
    'batches',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY id),'[]') FROM public.supplier_price_release_batches b),
    'pointers',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM public.supplier_current_price_pointers p),
    'publications',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM public.supplier_price_publications p)) value`,[release])).rows[0].value;
}

test('detailed marker retains CAS/lease/authority fences and safe status reason with old-worker compatibility',async t=>{
 const db=await fixture(t);await db.exec(detailed);
 const values=await args(db);
 const sql='SELECT public.mark_supplier_price_processing_interrupted($1,$2,$3,$4,$5,$6,$7) value';
 for(const role of ['anon','authenticated']){
  await db.exec(`RESET ROLE; SET ROLE ${role}`);
  await assert.rejects(db.query(sql,[...values,'validation_database_timeout']),/permission denied/);
 }
 await assert.rejects(service(db,sql,[...values,'raw SQL secret']),/SUPPLIER_WORKFLOW_OBSERVER_INPUT/);
 const stale=[...values];stale[3]++;
 assert.equal((await service(db,sql,[...stale,'validation_database_timeout'])).rows[0].value.status,'skipped');
 assert.equal((await service(db,sql,[...values,'validation_database_timeout'])).rows[0].value.status,'marked');
 const after=await snapshot(db);
 assert.equal(after.release.status,'failed');assert.equal(after.release.error_code,code);
 assert.equal(after.release.error_message,'SUPPLIER_FAILURE_VALIDATION_DATABASE_TIMEOUT');
 assert.equal(after.events.length,1);assert.equal(after.rows,0);assert.equal(after.pointers.length,0);
 const token=(await admin(db,"SELECT floor(extract(epoch from now()))::bigint iat,floor(extract(epoch from now()+interval '1 hour'))::bigint exp")).rows[0];
 const status=(await service(db,'SELECT public.get_supplier_price_upload_status($1,$2,$3,$4,$5,$6) value',[session,id(7),id(1),id(8),token.iat,token.exp])).rows[0].value;
 assert.equal(status.failure_reason,'SUPPLIER_FAILURE_VALIDATION_DATABASE_TIMEOUT');
 assert.equal(status.published,false);
 assert.equal((await mark(db,values)).status,'skipped');
});

test('SQL observer is service-only, bounded, sealed to canonical identity, and exposes no source rows', async t => {
  const db = await fixture(t);
  const c = await context(db);
  assert.deepEqual(Object.keys(c).sort(),['id','handoff_id','workflow_id','status','current_cursor','processed_rows','error_code','updated_at'].sort());
  assert.equal(c.id,release); assert.equal(c.handoff_id,handoff); assert.equal(c.workflow_id,workflow);
  assert.equal(c.current_cursor,500); assert.equal(c.processed_rows,600);
  for (const status of ['queued','dispatching','enqueued']) {
    await admin(db,'UPDATE supplier_price_ingestion_internal.handoffs SET status=$1 WHERE id=$2',[status,handoff]);
    assert.deepEqual(await context(db),c,'DBOS failure remains visible if enqueue acknowledgement was lost');
  }
  for (const ids of [null,[],[release,null],[release,release],Array.from({length:101},(_,n)=>id(n+200))]) {
    await assert.rejects(service(db,contextSql,[ids]),/SUPPLIER_WORKFLOW_OBSERVER_INPUT/);
  }
  assert.deepEqual((await service(db,contextSql,[[id(900)]])).rows,[]);
  const values = await args(db);
  for (const role of ['anon','authenticated']) {
    await db.exec(`RESET ROLE; SET ROLE ${role}; SELECT set_config('request.jwt.claim.role','service_role',false)`);
    await assert.rejects(db.query(contextSql,[[release]]),/permission denied/);
    await assert.rejects(db.query(markerSql,values),/permission denied/);
  }
  await db.exec("RESET ROLE; SET ROLE service_role; SELECT set_config('request.jwt.claim.role','authenticated',false)");
  await assert.rejects(db.query(contextSql,[[release]]),/SUPPLIER_WORKFLOW_OBSERVER_DENIED/);
  await assert.rejects(db.query(markerSql,values),/SUPPLIER_WORKFLOW_OBSERVER_DENIED/);
  const privileges=(await admin(db,`SELECT has_function_privilege('service_role',
    'supplier_price_ingestion_internal.clear_processing_interrupted_on_progress()','EXECUTE') helper,
    has_table_privilege('service_role','public.supplier_price_releases','UPDATE') write`)).rows[0];
  assert.deepEqual(privileges,{helper:false,write:false});
  for (const [sql,params] of [
    ["UPDATE supplier_price_ingestion_internal.handoffs SET workflow_id='foreign-workflow' WHERE id=$1",[handoff]],
    ["UPDATE supplier_price_ingestion_internal.handoffs SET workflow_id=$1,source_sha256=$2 WHERE id=$3",[workflow,'b'.repeat(64),handoff]],
    ["UPDATE supplier_price_ingestion_internal.handoffs SET source_sha256=$1,organization_id=$2 WHERE id=$3",['a'.repeat(64),id(2),handoff]],
  ]) {
    await admin(db,sql,params);
    assert.deepEqual((await service(db,contextSql,[[release]])).rows,[]);
    await assert.rejects(mark(db,values),/SUPPLIER_WORKFLOW_OBSERVER_IDENTITY/);
  }
});

test('SQL marker changes only operational error and timestamp, audits once, and replays without any write', async t => {
  const db = await fixture(t), values = await args(db), before = await snapshot(db);
  assert.deepEqual(await mark(db,values),{status:'marked',release_id:release,published:false});
  const after = await snapshot(db), expected = structuredClone(before);
  expected.release.error_code=code;
  expected.release.error_message='Processing stopped before completion. Operational review is required.';
  expected.release.updated_at=after.release.updated_at;
  expected.events=after.events;
  assert.deepEqual(after,expected);
  assert.equal(after.events.length,1);
  assert.deepEqual(Object.fromEntries(['release_id','event_type','stage','status','cursor','processed_rows','total_rows','worker_version','error_code'].map(k=>[k,after.events[0][k]])),
    {release_id:release,event_type:'processing_interrupted',stage:'processing',status:'parsing',cursor:500,processed_rows:600,total_rows:1000,worker_version:'workflow-failure-observer-v1',error_code:code});
  assert.deepEqual(await mark(db,values),{status:'already_marked',release_id:release,published:false});
  assert.deepEqual(await snapshot(db),after);
  await admin(db,'SELECT 1'); await db.exec(migration);
  assert.deepEqual(await snapshot(db),after,'forward migration replay must not change rows or repeat events');
});

test('SQL CAS, failure time, malformed identifiers and domain review cannot overwrite state', async t => {
  const db = await fixture(t), values = await args(db), before = await snapshot(db);
  for (const changed of [
    [...values.slice(0,3),501,...values.slice(4)],
    [...values.slice(0,4),'2001-01-01T00:00:00Z',values[5]],
    [...values.slice(0,5),'2001-01-01T00:00:00Z'],
  ]) assert.equal((await mark(db,changed)).status,'skipped');
  for (const [index,value,pattern] of [
    [0,null,/OBSERVER_INPUT/],[1,null,/OBSERVER_INPUT/],[1,id(999),/OBSERVER_IDENTITY/],
    [2,`supplier-price-verified:v1:${id(999)}`,/OBSERVER_INPUT/],
    [3,-1,/OBSERVER_INPUT/],[3,10000001,/OBSERVER_INPUT/],
    [4,null,/OBSERVER_INPUT/],[4,'infinity',/OBSERVER_INPUT/],
    [5,'infinity',/OBSERVER_INPUT/],[5,'2999-01-01T00:00:00Z',/OBSERVER_INPUT/],
  ]) { const changed=[...values]; changed[index]=value; await assert.rejects(mark(db,changed),pattern); }
  assert.deepEqual(await snapshot(db),before);
  await admin(db,"UPDATE public.supplier_price_releases SET error_code='VALIDATION_REVIEW_REQUIRED',error_message='Domain review' WHERE id=$1",[release]);
  const domain=await snapshot(db);
  assert.equal((await mark(db,await args(db))).status,'skipped');
  assert.deepEqual(await snapshot(db),domain);
  await admin(db,"UPDATE public.supplier_price_releases SET error_code=null,error_message='Message-only domain diagnostic' WHERE id=$1",[release]);
  const messageOnly=await snapshot(db);
  assert.equal((await mark(db,await args(db))).status,'skipped');
  assert.deepEqual(await snapshot(db),messageOnly);
  await admin(db,`UPDATE public.supplier_price_releases SET error_code=null,error_message=null,
    brand_identity_audit='{"review_required":true}' WHERE id=$1`,[release]);
  const review=await snapshot(db);
  assert.equal((await mark(db,await args(db))).status,'skipped');
  assert.deepEqual(await snapshot(db),review);
});

test('SQL active claim guard covers queued/running/retrying leases and permits only expired recovery', async t => {
  const db = await fixture(t);
  await admin(db,`INSERT INTO public.supplier_price_release_batches(release_id,batch_number,cursor_start,cursor_end,
    row_count,status,lease_owner,lease_expires_at) VALUES($1,1,500,600,100,'running','active-fork',now()+interval '1 hour')`,[release]);
  for (const status of ['queued','running','retrying']) {
    await admin(db,'UPDATE public.supplier_price_release_batches SET status=$1',[status]);
    const before=await snapshot(db);
    assert.equal((await mark(db,await args(db))).status,'skipped');
    assert.deepEqual(await snapshot(db),before);
  }
  await admin(db,"UPDATE public.supplier_price_release_batches SET lease_expires_at=now()-interval '1 second'");
  assert.equal((await mark(db,await args(db))).status,'marked');
});

test('SQL progress clears only the owned marker; old failure cannot mark a recovered release again', async t => {
  const db=await fixture(t), values=await args(db);
  await mark(db,values);
  await admin(db,"UPDATE public.supplier_price_releases SET status='staged',updated_at=clock_timestamp() WHERE id=$1",[release]);
  assert.equal((await context(db)).error_code,code,'status/heartbeat without progress does not clear');
  await admin(db,'UPDATE public.supplier_price_releases SET current_cursor=600 WHERE id=$1',[release]);
  const progressed=await snapshot(db);
  assert.equal(progressed.release.error_code,null); assert.equal(progressed.release.error_message,null);
  const fresh=await args(db); fresh[5]=values[5];
  assert.equal((await mark(db,fresh)).status,'skipped');
  assert.deepEqual(await snapshot(db),progressed);
  assert.equal((await mark(db,await args(db))).status,'marked','a distinct later failure can be reported');
  await admin(db,`UPDATE public.supplier_price_releases SET current_cursor=700,error_code='VALIDATION_REVIEW_REQUIRED',
    error_message='Keep domain error' WHERE id=$1`,[release]);
  const domain=await snapshot(db);
  assert.equal(domain.release.error_code,'VALIDATION_REVIEW_REQUIRED'); assert.equal(domain.release.error_message,'Keep domain error');
});

test('SQL validated and published completion clears owned marker without touching prices or another error', async t => {
  const db=await fixture(t);
  for (const status of ['validated','published']) {
    await admin(db,"UPDATE public.supplier_price_releases SET status='parsing',error_code=null,error_message=null,updated_at=now()-interval '1 minute' WHERE id=$1",[release]);
    await mark(db,await args(db));
    const before=await snapshot(db);
    await admin(db,'UPDATE public.supplier_price_releases SET status=$1 WHERE id=$2',[status,release]);
    const after=await snapshot(db);
    assert.equal(after.release.error_code,null); assert.equal(after.release.error_message,null);
    assert.deepEqual(after.pointers,before.pointers); assert.deepEqual(after.publications,before.publications);
    assert.equal((await mark(db,await args(db))).status,'skipped');
  }
  await admin(db,"UPDATE public.supplier_price_releases SET error_code='BRAND_IDENTITY_MISMATCH',error_message='Preserve',status='validated' WHERE id=$1",[release]);
  await admin(db,"UPDATE public.supplier_price_releases SET status='published',current_cursor=current_cursor+1 WHERE id=$1",[release]);
  const after=await snapshot(db);
  assert.equal(after.release.error_code,'BRAND_IDENTITY_MISMATCH'); assert.equal(after.release.error_message,'Preserve');
});

test('upload status retains all identity/session gates while exposing operational marker and fresh release timestamp', async t => {
  const db=await fixture(t);
  const token=(await admin(db,"SELECT floor(extract(epoch from now()))::bigint iat,floor(extract(epoch from now()+interval '1 hour'))::bigint exp")).rows[0];
  const values=[session,id(7),id(1),id(8),token.iat,token.exp];
  const sql='SELECT public.get_supplier_price_upload_status($1,$2,$3,$4,$5,$6) value';
  const before=(await service(db,sql,values)).rows[0].value;
  assert.equal(before.error_code,null); assert.ok(before.release_updated_at);
  await mark(db,await args(db));
  const after=(await service(db,sql,values)).rows[0].value;
  assert.equal(after.error_code,code); assert.equal(after.release_status,'parsing');
  assert.equal(after.processed_rows,600); assert.equal(after.published,false);
  assert.notEqual(after.release_updated_at,before.release_updated_at);
  assert.equal(after.updated_at,before.updated_at,'transfer timestamp semantics retained');
  for (const [index,value] of [[0,id(99)],[1,id(99)],[2,id(2)],[3,id(99)],[4,0],[5,1]]) {
    const changed=[...values]; changed[index]=value;
    await assert.rejects(service(db,sql,changed),/UPLOAD_STATUS_DENIED/);
  }
  for (const sqlChange of [
    "UPDATE public.profiles SET is_active=false",
    "UPDATE public.profiles SET is_active=true,role='customer'",
    "UPDATE public.profiles SET role='superadmin',session_revoked_at=clock_timestamp()",
    "UPDATE public.profiles SET session_revoked_at=null; UPDATE auth.sessions SET not_after=now()-interval '1 second'",
  ]) {
    await db.exec('RESET ROLE'); await db.exec(sqlChange);
    await assert.rejects(service(db,sql,values),/UPLOAD_STATUS_DENIED/);
  }
});
