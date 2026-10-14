import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {buildMigrationPlan,migrationBody,runProductionMigrations,parseMigrationArgs,safeMigrationFailure,readMigrationPassword,
 IDENTITY_SQL,EXCLUSIVE_RUN_SQL,TRANSACTION_SETUP_SQL} from '../ops/run-price-engine-production-migrations.mjs';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';

const repo=new URL('../../',import.meta.url),hash=value=>createHash('sha256').update(value).digest('hex');
const manifestBytes=await readFile(new URL('../ops/price-engine-production-manifest.json',import.meta.url));
const expectedManifestSha256=hash(manifestBytes);
const plan=await buildMigrationPlan({manifestBytes,expectedManifestSha256});
const baseline=JSON.parse(await readFile(new URL('../ops/evidence/price-engine-production-20261014.json',import.meta.url))).data;
const secret='synthetic-password-must-never-be-output';
const connection={host:'db.zjgueqijumzlfioihnkt.supabase.co',user:'postgres',database:'postgres',port:5432,
 password:secret,ssl:{ca:'synthetic-private-ca',rejectUnauthorized:true},transaction:false};
function harness({onQuery,onRecord,tls=true,indexMissing=false,exclusive=true}={}){
 const events=[],queries=[];let active=0,maxActive=0,constructors=0,ends=0,pending=null,customer='C';
 const client=new EventEmitter();client.connection={stream:{encrypted:true,authorized:tls}};
 client.connect=async()=>{};client.end=async()=>{ends++;};
 client.query=async sql=>{
  queries.push(sql);active++;maxActive=Math.max(maxActive,active);
  try{
   await setImmediate();const entry=plan.entries.find(item=>item.sql===sql);
   const overridden=await onQuery?.({sql,entry,queries,client});if(overridden)return overridden;
   if(sql===IDENTITY_SQL)return {rows:[{database_ok:true,role_ok:true,unassumed_role:true,backend_pid:1234,server_version_num:'170006'}]};
   if(sql===EXCLUSIVE_RUN_SQL)return {rows:[{acquired:exclusive}]};
   if(sql===plan.preflight_sql)return {rows:[{price_engine_preflight:structuredClone(baseline)}]};
   if(sql===plan.indexPlan.verification_sql)return {rows:[{index_prebuild_snapshot:{snapshot_version:1,
    server_version_num:'170006',search_path:'pg_catalog',lock_timeout:'5s',statement_timeout:'30min',
    idle_in_transaction_session_timeout:'30s',normalizer:plan.indexPlan.normalizer,
    indexes:plan.indexPlan.operations.map((item,index)=>({name:item.name,schema:'public',table:item.table,
     table_present:true,table_kind:'r',present:!(indexMissing&&index===0),kind:'i',actual_table_schema:'public',
     actual_table:item.table,unique:false,valid:true,ready:true,live:true,definition:item.expected_definition}))}}]};
   if(sql==='BEGIN'){assert.equal(pending,null);pending={customer};return {command:'BEGIN',rows:[]};}
   if(sql==='COMMIT'){assert.ok(pending);customer=pending.customer;pending=null;return {command:'COMMIT',rows:[]};}
   if(sql==='ROLLBACK'){pending=null;return {command:'ROLLBACK',rows:[]};}
   if(sql===plan.alignment_sql){assert.ok(pending);pending.customer='A';return {rows:[]};}
   if(entry){assert.ok(pending);return {rows:[]};}
   assert.match(sql,/^SET /);return {rows:[]};
  }finally{active--;}
 };
 const run=overrides=>runProductionMigrations({plan,connection,record:async event=>{
  await onRecord?.(event);events.push(structuredClone(event));},...overrides},
 {regeneratePlan:async()=>plan,createClient:async config=>{
  constructors++;assert.equal(config.options,'');assert.equal(config.ssl.rejectUnauthorized,true);
  assert.equal(config.password,secret);assert.equal(Object.hasOwn(config,'connectionString'),false);return client;
 }});
 return {run,queries,events,get customer(){return customer;},get constructors(){return constructors;},
  get maxActive(){return maxActive;},get ends(){return ends;}};
}
const apply={apply:true,alignErsen:true};

test('exact60 plan preserves order and all source hashes; only wrappers1/48 are excluded',async()=>{
 assert.equal(plan.entries.length,60);assert.deepEqual(plan.entries.filter(e=>e.wrapped).map(e=>e.position),[1,48]);
 for(const entry of plan.entries)assert.equal(hash(await readFile(new URL(entry.file,repo))),entry.sha256);
 assert.match(plan.entries[28].id,/sales_order_active_customer_pricing_guard$/);
 const reordered=JSON.parse(manifestBytes);[reordered.migration_order[1],reordered.migration_order[2]]=
  [reordered.migration_order[2],reordered.migration_order[1]];
 const bytes=Buffer.from(JSON.stringify(reordered));
 await assert.rejects(buildMigrationPlan({manifestBytes:bytes,expectedManifestSha256:hash(bytes)}),/REVIEWED_MIGRATION_ORDER_CHANGED/);
 await assert.rejects(buildMigrationPlan({manifestBytes,expectedManifestSha256:'f'.repeat(64)}),/MANIFEST_HASH_UNCONFIRMED/);
 await assert.rejects(buildMigrationPlan({manifestBytes,expectedManifestSha256,loadFile:async file=>{
  const bytes=await readFile(new URL(file,repo));return file===plan.entries[0].file?Buffer.concat([bytes,Buffer.from('\n')]):bytes;
 }}),/MIGRATION_HASH_CHANGED/);
});

test('SQL boundary scanner ignores quoted/function/comment text and rejects transaction escape',()=>{
 const body=migrationBody("/* BEGIN; /* COMMIT; */ */ BEGIN; DO $x$ BEGIN RAISE NOTICE 'COMMIT;'; END $x$; SELECT E'a\\\'COMMIT;'; COMMIT; -- end");
 assert.equal(body.wrapped,true);assert.match(body.sql,/DO \$x\$/);
 for(const sql of ['SELECT 1; COMMIT;','BEGIN; SELECT 1; COMMIT; SELECT 2;',
  'BEGIN; SELECT 1; ROLLBACK; COMMIT;','BEGIN; SELECT 1;','SELECT $bad$unterminated'])
  assert.throws(()=>migrationBody(sql),/MIGRATION_/);
});

test('inspect uses fresh baseline and all12 indexes without a transaction or business mutation',async()=>{
 const h=harness(),result=await h.run();
 assert.equal(result.status,'inspected');assert.equal(result.outcome,'read-only');assert.equal(h.customer,'C');
 assert.equal(h.queries.includes('SET default_transaction_read_only = on'),true);
 assert.equal(h.queries.some(sql=>sql==='BEGIN'||sql===plan.alignment_sql||plan.entries.some(e=>e.sql===sql)),false);
 const missing=harness({indexMissing:true});
 assert.equal((await missing.run(apply)).failure.code,'PREBUILT_INDEXES_UNCONFIRMED');
 assert.equal(missing.queries.includes('BEGIN'),false);
});

test('apply serializes all60 transactions and couples the only customer CAS to transaction29',async()=>{
 const h=harness(),result=await h.run(apply);
 assert.equal(result.status,'completed');assert.equal(result.completed.length,60);assert.equal(h.maxActive,1);assert.equal(h.ends,1);
 assert.equal(h.customer,'A');assert.equal(h.queries.filter(q=>q==='BEGIN').length,60);
 assert.equal(h.queries.filter(q=>q==='COMMIT').length,60);assert.equal(h.queries.includes('ROLLBACK'),false);
 assert.deepEqual(h.queries.filter(sql=>plan.entries.some(e=>e.sql===sql)),plan.entries.map(e=>e.sql));
 assert.equal(h.queries.filter(sql=>sql===plan.alignment_sql).length,1);
 const cas=h.queries.indexOf(plan.alignment_sql);assert.equal(h.queries[cas+1],plan.entries[28].sql);
 for(const entry of plan.entries){
  const start=h.events.findIndex(event=>event.event==='migration-start'&&event.position===entry.position);
  const requested=h.events.findIndex(event=>event.event==='commit-requested'&&event.position===entry.position);
  const committed=h.events.findIndex(event=>event.event==='migration-committed'&&event.position===entry.position);
  assert.ok(start<requested&&requested<committed);
 }
 for(const sql of TRANSACTION_SETUP_SQL)assert.equal(h.queries.filter(q=>q===sql).length,60);
 assert.equal(JSON.stringify([result,h.events]).includes(secret),false);
});

test('a timeout in migration29 rolls back the customer CAS and stops without implicit retry',async()=>{
 const h=harness({onQuery({entry}){if(entry?.position===29)throw Object.assign(Error(secret),{code:'57014',detail:secret});}});
 const result=await h.run(apply);
 assert.equal(result.failure.position,29);assert.equal(result.failure.code,'57014');
 assert.equal(result.outcome,'failed-transaction-rolled-back');assert.equal(result.completed.length,28);
 assert.equal(h.customer,'C');assert.equal(h.queries.at(-1),'ROLLBACK');
 assert.equal(h.queries.filter(sql=>sql===plan.entries[28].sql).length,1);
 assert.equal(JSON.stringify([result,h.events]).includes(secret),false);
});

test('uncertain COMMIT or lost durable receipt stops with no rollback claim, reconnect or replay',async()=>{
 for(const failure of ['disconnect','journal']){
  const h=harness({onQuery({sql}){if(failure==='disconnect'&&sql==='COMMIT')throw Object.assign(Error(secret),{code:'ECONNRESET'});},
   onRecord(event){if(failure==='journal'&&event.event==='migration-committed')throw Error(secret);}});
  const result=await h.run(apply);
  assert.equal(result.outcome,'unknown-requires-read-only-reconciliation');assert.equal(result.completed.length,0);
  assert.equal(h.queries.filter(sql=>sql==='COMMIT').length,1);assert.equal(h.queries.includes('ROLLBACK'),false);
  assert.equal(h.queries.includes(plan.entries[1].sql),false);assert.equal(h.constructors,1);assert.equal(h.ends,1);
  assert.equal(JSON.stringify([result,h.events]).includes(secret),false);
 }
 const precommit=harness({onRecord(event){if(event.event==='commit-requested')throw Error(secret);}});
 assert.equal((await precommit.run(apply)).outcome,'failed-transaction-rolled-back');
 assert.equal(precommit.queries.includes('COMMIT'),false);
});

test('target, TLS, explicit alignment, exclusive run and journal guards fail before migration writes',async()=>{
 const target=harness();assert.equal((await target.run({...apply,connection:{...connection,port:6543}})).failure.code,'CONNECTION_TARGET_UNCONFIRMED');
 assert.equal(target.constructors,0);
 const tls=harness({tls:false});assert.equal((await tls.run(apply)).failure.code,'TLS_SESSION_UNVERIFIED');assert.equal(tls.queries.length,0);
 const consent=harness();assert.equal((await consent.run({apply:true})).failure.code,'RUNNER_ARGUMENT_INVALID');assert.equal(consent.constructors,0);
 const exclusive=harness({exclusive:false});assert.equal((await exclusive.run(apply)).failure.code,'ANOTHER_MIGRATION_RUN_ACTIVE');assert.equal(exclusive.queries.includes('BEGIN'),false);
 const journal=harness({onRecord(event){if(event.event==='migration-start')throw Error(secret);}});
 assert.equal((await journal.run(apply)).outcome,'no-migration-started');assert.equal(journal.queries.includes('BEGIN'),false);
 assert.deepEqual(safeMigrationFailure({code:secret,message:secret}),{code:'UNCLASSIFIED_FAILURE'});
 const args=['--project-ref','zjgueqijumzlfioihnkt','--manifest-sha256',expectedManifestSha256];
 assert.equal(parseMigrationArgs(args).mode,'plan');
 for(const extra of [['--resume'],['--plan','--apply'],['--apply'],['--host','wrong']])
  assert.throws(()=>parseMigrationArgs([...args,...extra]),/RUNNER_ARGUMENT_INVALID/);
});

test('credential reader accepts only owned private regular files and never follows symlinks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nm-migration-password-test-')),file=join(dir,'password');
 try{
  await writeFile(file,secret+'\n',{mode:0o600});
  assert.equal(await readMigrationPassword(file),secret);
  await chmod(file,0o644);
  await assert.rejects(readMigrationPassword(file),/PASSWORD_FILE_PERMISSIONS_OR_SIZE_INVALID/);
  await chmod(file,0o600);await symlink(file,join(dir,'link'));
  await assert.rejects(readMigrationPassword(join(dir,'link')),{code:'ELOOP'});
  await writeFile(file,secret+'\nextra-line');await assert.rejects(readMigrationPassword(file),/PASSWORD_FILE_INVALID/);
  await writeFile(file,'');await assert.rejects(readMigrationPassword(file),/PASSWORD_FILE_PERMISSIONS_OR_SIZE_INVALID/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('real captured PG17 fixture proves foundation rollback, all60 per-file transactions and atomic CAS29',async()=>{
 const db=await createFullReplayDb();
 const customer='fd9f8834-7935-4050-8895-fde8a2eb4914',org='1e4c5e99-e387-41aa-a6d3-cbe74558f766';
 const other='11111111-1111-4111-8111-111111111111';
 const begin=async()=>{await db.exec('BEGIN');for(const sql of TRANSACTION_SETUP_SQL)await db.exec(sql);};
 try{
  for(const item of plan.indexPlan.operations)await db.exec(item.source_sql);
  await db.query("INSERT INTO public.organizations(id,name) VALUES($1,'Synthetic migration runner org')",[org]);
  await db.query("INSERT INTO public.customers(id,organization_id,customer_number,price_list_type,custom_fields) VALUES($1,$2,'RUNNER-C','C',$3)",
   [customer,org,'Notes[[NEXT_MASTER_META]]{"price_list_type":"C","unrelated":"preserved"}']);
  await db.query("INSERT INTO public.customers(id,organization_id,customer_number,price_list_type,custom_fields) VALUES($1,$2,'RUNNER-OTHER','Other',$3)",
   [other,org,'[[NEXT_MASTER_META]]{"price_list_margin_percent":20}']);
  const otherBefore=(await db.query('SELECT to_jsonb(c) value FROM public.customers c WHERE id=$1',[other])).rows[0].value;
  await begin();await db.exec(plan.entries[0].sql);
  await assert.rejects(db.exec('SELECT 1/0'),/division by zero/);await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT to_regclass('public.supplier_price_releases') relation")).rows[0].relation,null);
  for(const entry of plan.entries){
   await begin();
   if(entry.position===29){
    await db.exec(plan.alignment_sql);await db.exec(entry.sql);
    await assert.rejects(db.exec('SELECT 1/0'),/division by zero/);await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT price_list_type FROM public.customers WHERE id=$1',[customer])).rows[0].price_list_type,'C');
    assert.equal((await db.query("SELECT to_regprocedure('sales_order_guard_private.guard_sales_order_active_customer_pricing()') f")).rows[0].f,null);
    await begin();await db.exec(plan.alignment_sql);
   }
   await db.exec(entry.sql);await db.exec('COMMIT');
  }
  const aligned=(await db.query('SELECT price_list_type,custom_fields FROM public.customers WHERE id=$1',[customer])).rows[0];
  assert.equal(aligned.price_list_type,'A');
  assert.deepEqual(JSON.parse(aligned.custom_fields.split('[[NEXT_MASTER_META]]')[1]),{price_list_type:'A',unrelated:'preserved'});
  assert.deepEqual((await db.query('SELECT to_jsonb(c) value FROM public.customers c WHERE id=$1',[other])).rows[0].value,otherBefore);
  assert.deepEqual((await db.query('SELECT enabled,reversal_enabled FROM supplier_price_ingestion_internal.production_publication_control')).rows[0],
   {enabled:false,reversal_enabled:false});
 }finally{await db.close();}
});
