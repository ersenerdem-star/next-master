import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
import { createFoundationTestDb, seedFoundationTestScope } from './fixtures/price-engine-foundation-db.mjs';

const foundation = await readFile(new URL('../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql',import.meta.url),'utf8');
const publication = await readFile(new URL('../../supabase/migrations/20261014110614_supplier_price_production_publication_decision.sql',import.meta.url),'utf8');
const queueMigration = await readFile(new URL('../../supabase/migrations/20261014162139_supplier_admin_release_action_queue.sql',import.meta.url),'utf8');
const legacyGuard=await readFile(new URL('../../supabase/migrations/20261013140015_supplier_price_guard_active_legacy_delete.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('../../supabase/migrations/20261014175649_supplier_source_commercial_compatibility_guard.sql',import.meta.url),'utf8');
const policy='supplier-price-commercial-fields-v1';
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
async function fixture(t,{target=staging,enabled=true,withProduction=true,withCompatibility=true}={}) {
  const db=await createFoundationTestDb(); t.after(()=>db.close());
  await db.exec(foundation); if(withProduction) await db.exec(publication); await db.exec(queueMigration); await db.exec(legacyGuard); if(withCompatibility) await db.exec(migration); await seedFoundationTestScope(db);
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
  await db.query('UPDATE supplier_price_upload_sessions SET checksum_sha256=$1 WHERE release_id=$2',[hash,release]);
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
    'productionDecisions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY decision_id),'[]') FROM supplier_price_ingestion_internal.production_publication_decisions d),
    'stagingDecisions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY decision_id),'[]') FROM supplier_price_ingestion_internal.admin_staging_publication_decisions d),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM supplier_price_release_events e),
    'actions',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY decision_id),'[]') FROM supplier_price_ingestion_internal.admin_release_actions a)) value`)).rows[0].value;
}

async function record(db,release,patch={}){
 const binding=(await admin(db,'select h.id handoff,r.source_file_sha256 sha,r.total_rows rows from supplier_price_releases r join supplier_price_ingestion_internal.handoffs h on h.release_id=r.id where r.id=$1',[release])).rows[0];
 return rpc(db,'record_supplier_price_source_compatibility',[release,patch.handoff??binding.handoff,patch.sha??binding.sha,patch.rows??binding.rows,patch.policy??policy]);
}
async function legacy(db,n,fields={}){
 await admin(db,`INSERT INTO supplier_prices(id,organization_id,supplier_id,brand_id,product_code,normalized_code,buy_price,currency,valid_from,is_active,stock_qty,order_multiple,valid_to)
 VALUES($1,$2,$3,$4,$5,$5,12.34,'EUR',current_date,$6,$7,$8,$9)`,[id(n),org,supplier,brand,`CODE${n}`,fields.active??true,fields.stock??null,fields.multiple??null,fields.validTo??null]);
}
async function directPublication(db,release,n=90){return admin(db,`INSERT INTO supplier_price_publications(id,release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)VALUES($1,$2,$3,$4,$5,'published',1,now())`,[id(n),release,org,supplier,brand]);}

test('source receipts require service role and exact sealed source; immutable replay cannot drift',async t=>{
 const db=await fixture(t),release=await seed(db,10,{held:false});
 for(const role of ['anon','authenticated']){
  await db.exec(`RESET ROLE;SET ROLE ${role};SELECT set_config('request.jwt.claim.role','service_role',false)`);
  await assert.rejects(db.query('select record_supplier_price_source_compatibility($1,$2,$3,2,$4)',[release,id(3010),'a'.repeat(64),policy]),/permission denied/);
 }
 await db.exec("RESET ROLE;SET ROLE service_role;SELECT set_config('request.jwt.claim.role','authenticated',false)");
 await assert.rejects(db.query('select record_supplier_price_source_compatibility($1,$2,$3,2,$4)',[release,id(3010),'a'.repeat(64),policy]),/SOURCE_COMPATIBILITY_SERVICE_REQUIRED/);
 for(const patch of [{handoff:id(999)},{sha:'a'.repeat(64)},{rows:3},{policy:'v0'}])await assert.rejects(record(db,release,patch),/UPLOAD_HANDOFF_NOT_READY|SOURCE_COMPATIBILITY_(BINDING|INPUT_INVALID)/);
 await admin(db,"UPDATE storage.objects SET version='changed'");await assert.rejects(record(db,release),/UPLOAD_HANDOFF_NOT_READY/);
 await admin(db,"UPDATE storage.objects SET version='object-v1'");
 await admin(db,"UPDATE supplier_price_upload_sessions SET checksum_sha256=null WHERE release_id=$1",[release]);await assert.rejects(record(db,release),/SOURCE_COMPATIBILITY_BINDING/);
 await admin(db,'UPDATE supplier_price_upload_sessions u SET checksum_sha256=r.source_file_sha256 FROM supplier_price_releases r WHERE r.id=u.release_id');
 const first=await record(db,release);assert.equal(first.status,'recorded');assert.deepEqual(await record(db,release),{...first,status:'replayed'});
 for(const patch of [{handoff:id(999)},{sha:'b'.repeat(64)},{rows:3}])await assert.rejects(record(db,release,patch),/SOURCE_COMPATIBILITY_CONFLICT/);
 const before=(await admin(db,'SELECT to_jsonb(c) row FROM supplier_price_ingestion_internal.source_compatibility_receipts c')).rows;
 await assert.rejects(db.exec('UPDATE supplier_price_ingestion_internal.source_compatibility_receipts SET total_rows=3'),/SOURCE_COMPATIBILITY_IMMUTABLE/);
 await assert.rejects(db.exec('DELETE FROM supplier_price_ingestion_internal.source_compatibility_receipts'),/SOURCE_COMPATIBILITY_IMMUTABLE/);
 assert.deepEqual((await admin(db,'SELECT to_jsonb(c) row FROM supplier_price_ingestion_internal.source_compatibility_receipts c')).rows,before);
 const acl=(await admin(db,`select c.relrowsecurity rls,has_table_privilege('service_role',c.oid,'INSERT')service_insert,has_table_privilege('authenticated',c.oid,'SELECT')browser_select,has_function_privilege('service_role','supplier_price_ingestion_internal.source_publication_blocker(uuid)','EXECUTE')private_helper from pg_class c where c.oid='supplier_price_ingestion_internal.source_compatibility_receipts'::regclass`)).rows[0];
 assert.deepEqual(acl,{rls:true,service_insert:false,browser_select:false,private_helper:false});
});

test('every published insert requires compatible source and exact tuple, without touching historical decisions',async t=>{
 const db=await fixture(t),release=await seed(db,10,{held:false});
 assert.equal((await evidence(db,release)).publicationBlocker,'SOURCE_COMPATIBILITY_REQUIRED');assert.equal((await evidence(db,release)).canPublish,false);
 await assert.rejects(directPublication(db,release),/SOURCE_COMPATIBILITY_REQUIRED/);
 await record(db,release);assert.equal((await evidence(db,release)).publicationBlocker,null);assert.equal((await evidence(db,release)).canPublish,true);
 await admin(db,'SELECT 1');await assert.rejects(db.query("INSERT INTO supplier_price_publications(release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)VALUES($1,$2,$3,$4,'published',1,now())",[release,id(2),supplier,brand]),/PRODUCTION_PUBLICATION_SOURCE_INVALID/);
 await enqueue(db,publishRequest(release),'publish');await claim(db);const done=await execute(db,id(31));assert.equal(done.published,true);
 assert.equal((await evidence(db,release)).publicationBlocker,null);assert.deepEqual(await execute(db,id(31)),{...done,replayed:true});
 assert.equal((await record(db,release)).status,'replayed');
 assert.equal((await admin(db,'select count(*) n from supplier_price_publications')).rows[0].n,1);
});

test('first scope transition rejects each active unsupported value including zero, future and expired rows',async t=>{
 for(const [n,field]of [[101,{stock:0}],[102,{multiple:0}],[103,{validTo:'2000-01-01'}],[104,{stock:7}]]){
  const db=await fixture(t),release=await seed(db,10,{held:false});await record(db,release);await legacy(db,n,field);
  if(n===104)await admin(db,"UPDATE supplier_prices SET valid_from=current_date+1 WHERE id=$1",[id(n)]);
  const e=await evidence(db,release);assert.equal(e.publicationBlocker,'LEGACY_COMMERCIAL_FIELDS_UNSUPPORTED');assert.equal(e.canPublish,false);
  await assert.rejects(directPublication(db,release),/LEGACY_COMMERCIAL_FIELDS_UNSUPPORTED/);
 }
});

test('inactive legacy fields and other supplier/brand scopes do not block; existing brand-wide guard and retention remain',async t=>{
 const db=await fixture(t),release=await seed(db,10,{held:false});await record(db,release);await legacy(db,100,{active:false,stock:0});await legacy(db,101);
 await admin(db,'UPDATE supplier_prices SET supplier_id=$1,stock_qty=9 WHERE id=$2',[id(4),id(101)]);
 assert.equal((await evidence(db,release)).publicationBlocker,null);
 await directPublication(db,release);await admin(db,'INSERT INTO supplier_current_price_pointers(organization_id,supplier_id,brand_id,release_id,publication_id)VALUES($1,$2,$3,$4,$5)',[org,supplier,brand,release,id(90)]);
 await assert.rejects(legacy(db,102),/LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED/);
 await assert.rejects(admin(db,'UPDATE supplier_prices SET stock_qty=0 WHERE id=$1',[id(101)]),/LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED/);
 await assert.rejects(admin(db,'DELETE FROM supplier_prices WHERE id=$1',[id(101)]),/LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED/);
 await admin(db,'DELETE FROM supplier_prices WHERE id=$1',[id(100)]);
 assert.equal((await admin(db,'select count(*) n from supplier_prices where id=$1',[id(100)])).rows[0].n,0);
});

test('production publisher control and historic successful replay remain governed independently',async t=>{
 const db=await fixture(t,{target:production}),release=await seed(db,10,{held:false});await record(db,release);
 assert.equal((await evidence(db,release,production)).canPublish,false);
 await admin(db,'UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=true,activation_decision_id=$1,activated_by=$2,activated_at=now()',[id(99),actor]);
 assert.equal((await evidence(db,release,production)).canPublish,true);
 await enqueue(db,publishRequest(release),'publish',production);await claim(db,production);const done=await execute(db,id(31),production);assert.equal(done.published,true);
 await admin(db,'UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=false');
 assert.deepEqual(await execute(db,id(31),production),{...done,replayed:true});
});

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

test('real PG17 serializes first publication against committed legacy insert and racing stock update',
 {skip:process.env.RUN_SUPPLIER_COMPATIBILITY_PG_RUNTIME!=='1',timeout:90000},async t=>{
 const exec=promisify(execFile),container=`nm-compat-pg-${process.pid}-${randomBytes(4).toString('hex')}`,password=randomBytes(24).toString('hex'),clients=[];
 try{
  await exec('docker',['run','--detach','--rm','--name',container,'--cpus','0.5','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=supplier_compatibility_test','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
  const port=(await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);assert.ok(port);
  const cfg={host:'127.0.0.1',port:Number(port[1]),user:'postgres',password,database:'supplier_compatibility_test',connectionTimeoutMillis:1000};let db;
  for(let i=0;i<60;i++){const c=new pg.Client(cfg);try{await c.connect();db=c;break;}catch{await c.end().catch(()=>{});await delay(250);}}
  assert.ok(db);clients.push(db);db.exec=q=>db.query(q);const peer=new pg.Client(cfg);await peer.connect();clients.push(peer);peer.exec=q=>peer.query(q);
  await realPgBaseline(db);await db.exec(foundation);await db.exec(publication);await db.exec(queueMigration);await db.exec(legacyGuard);await db.exec(migration);await seedFoundationTestScope(db);
  await db.exec("set statement_timeout='10s';set lock_timeout='3s'");await peer.exec("set statement_timeout='10s';set lock_timeout='3s'");
  const release=await seed(db,10,{held:false});await record(db,release);await admin(db,'SELECT 1');
  const peerPid=(await peer.query('select pg_backend_pid() pid')).rows[0].pid;
  async function waiting(){for(let i=0;i<50;i++){const r=await db.query("select wait_event_type,wait_event from pg_stat_activity where pid=$1",[peerPid]);if(r.rows[0]?.wait_event==='advisory')return;await delay(20);}assert.fail('peer must wait on the shared publication advisory lock');}
  await db.exec('BEGIN');await legacy(db,100,{stock:0});
  const publishPending=directPublication(peer,release).then(()=>({ok:true}),error=>({error}));await waiting();await db.exec('COMMIT');
  assert.match((await publishPending).error?.message??'',/PRODUCTION_PUBLICATION_LEGACY_COMMERCIAL_FIELDS_UNSUPPORTED/);
  assert.equal(Number((await db.query('select count(*) n from supplier_price_publications')).rows[0].n),0);
  await admin(db,'DELETE FROM supplier_prices WHERE id=$1',[id(100)]);await legacy(db,101);
  await db.exec('BEGIN');await directPublication(db,release);await db.query('INSERT INTO supplier_current_price_pointers(organization_id,supplier_id,brand_id,release_id,publication_id)VALUES($1,$2,$3,$4,$5)',[org,supplier,brand,release,id(90)]);
  const stockPending=admin(peer,'UPDATE supplier_prices SET stock_qty=0 WHERE id=$1',[id(101)]).then(()=>({ok:true}),error=>({error}));await waiting();await db.exec('COMMIT');
  assert.match((await stockPending).error?.message??'',/LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED/);
  assert.equal((await db.query('select stock_qty from supplier_prices where id=$1',[id(101)])).rows[0].stock_qty,null);
  assert.equal(Number((await db.query('select count(*) n from supplier_current_price_pointers')).rows[0].n),1);
  assert.equal(Number((await db.query('select count(*) n from supplier_price_ingestion_internal.source_compatibility_receipts')).rows[0].n),1);
  t.diagnostic(JSON.stringify({postgres:17,loopbackOnly:true,cpu:0.5,memoryMiB:1024,legacyCommitBeforePublish:'blocked',publicationCommitBeforeStockUpdate:'blocked',advisoryWaitObservedBothDirections:true,sourceReceiptCount:1,remoteAccess:false}));
 }finally{for(const c of clients){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}await exec('docker',['rm','--force',container],{timeout:15000}).catch(()=>{});}
});
test('pre-migration staging and production history stay byte-identical and replay without retroactive attestation',async t=>{
 for(const target of [staging,production]){
  const db=await fixture(t,{withCompatibility:false,target}),release=await seed(db,10,{held:false});
  if(target===production)await admin(db,'UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=true,activation_decision_id=$1,activated_by=$2,activated_at=now()',[id(99),actor]);
  await enqueue(db,publishRequest(release),'publish',target);await claim(db,target);const published=await execute(db,id(31),target);assert.equal(published.published,true);
  const before=await state(db);assert.equal(before[target===production?'productionDecisions':'stagingDecisions'].length,1);
  await admin(db,'SELECT 1');await db.exec(migration);assert.deepEqual(await state(db),before);
  assert.deepEqual(await execute(db,id(31),target),{...published,replayed:true});assert.equal((await evidence(db,release,target)).publicationBlocker,null);
  await assert.rejects(record(db,release),/UPLOAD_HANDOFF_NOT_READY/);
  assert.equal((await admin(db,'select count(*)n from supplier_price_ingestion_internal.source_compatibility_receipts')).rows[0].n,0);
 }
});

test('compatibility guard compiles after immutable62 and all deployed forward migrations',async()=>{
 const db=await createFullReplayDb();try{
  const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));assert.equal(manifest.migration_order.length,62);
  for(const item of manifest.migration_order)await db.exec(await readFile(item.file,'utf8'));
  await db.exec(queueMigration);
  for(const path of ['20261014165817_price_list_legacy_scope_compatibility.sql','20261014171235_master_price_mixed_supplier_scopes.sql'])await db.exec(await readFile('supabase/migrations/'+path,'utf8'));
  await db.exec(migration);
  assert.equal((await db.query('select count(*)n from supplier_price_ingestion_internal.source_compatibility_receipts')).rows[0].n,0);
 }finally{await db.close();}
});
