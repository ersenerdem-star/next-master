import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile,mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {buildMigrationPlan,migrationBody,runProductionMigrations,parseMigrationArgs,safeMigrationFailure,readMigrationPassword,
 IDENTITY_SQL,EXCLUSIVE_RUN_SQL,TRANSACTION_SETUP_SQL,RESUME22_LOCKS_SQL,RESUME22_QUIET_WAIT_MS}
 from '../ops/run-price-engine-production-migrations.mjs';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
import {RESUME22_JOURNAL_SHA256,validateResume22Evidence} from '../ops/price-engine-migration-resume22.mjs';

const repo=new URL('../../',import.meta.url),hash=value=>createHash('sha256').update(value).digest('hex');
const manifestBytes=await readFile(new URL('../ops/price-engine-production-manifest.json',import.meta.url));
const expectedManifestSha256=hash(manifestBytes);
const plan=await buildMigrationPlan({manifestBytes,expectedManifestSha256});
// Derive the current metadata shape from the captured production-schema fixture.
// Historical remote evidence is immutable; new runtime objects remain absent.
const baselineDb=await createFullReplayDb();
let baseline;
try { baseline=(await baselineDb.query(plan.preflight_sql)).rows[0].price_engine_preflight; }
finally { await baselineDb.close(); }
const secret='synthetic-password-must-never-be-output';
const connection={host:'db.zjgueqijumzlfioihnkt.supabase.co',user:'postgres',database:'postgres',port:5432,
 password:secret,ssl:{ca:'synthetic-private-ca',rejectUnauthorized:true},transaction:false};
function harness({onQuery,onRecord,tls=true,indexMissing=false,exclusive=true,reconciliation,reconciliationSnapshot,now,wait}={}){
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
   if(sql===RESUME22_LOCKS_SQL)return {rows:[{table_present:true,other_locks:0}]};
   if(sql===plan.preflight_sql)return {rows:[{price_engine_preflight:structuredClone(baseline)}]};
   if(reconciliation&&sql===reconciliation.sql)return {rows:[{resume22_snapshot:
    structuredClone(reconciliationSnapshot??reconciliation.expected)}]};
   if(sql===plan.indexPlan.verification_sql){
    const missing=typeof indexMissing==='function'?indexMissing(queries.filter(q=>q===sql).length):indexMissing;
    return {rows:[{index_prebuild_snapshot:{snapshot_version:1,
    server_version_num:'170006',search_path:'pg_catalog',lock_timeout:'5s',statement_timeout:'30min',
    idle_in_transaction_session_timeout:'30s',normalizer:plan.indexPlan.normalizer,
    indexes:plan.indexPlan.operations.map((item,index)=>({name:item.name,schema:'public',table:item.table,
     table_present:true,table_kind:'r',present:!(typeof missing==='string'?item.name===missing:missing&&index===0),kind:'i',actual_table_schema:'public',
     actual_table:item.table,unique:false,valid:true,ready:true,live:true,definition:item.expected_definition}))}}]};
   }
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
 {regeneratePlan:async()=>plan,...(reconciliation?{buildResumeReconciliation:async()=>reconciliation}:{}),
 ...(now?{now}:{}),...(wait?{wait}:{}),createClient:async config=>{
  constructors++;assert.equal(config.options,'');assert.equal(config.ssl.rejectUnauthorized,true);
  assert.equal(config.password,secret);assert.equal(Object.hasOwn(config,'connectionString'),false);return client;
 }});
 return {run,queries,events,get customer(){return customer;},get constructors(){return constructors;},
  get maxActive(){return maxActive;},get ends(){return ends;}};
}
const apply={apply:true,alignErsen:true};
const resumeEvidence={bytes:await readFile(new URL('./fixtures/price-engine-migration-attempt-20261014a.jsonl',import.meta.url)),
 expectedSha256:RESUME22_JOURNAL_SHA256};
const resumeConnection={...connection,host:'aws-0-eu-west-1.pooler.supabase.com',user:'postgres.zjgueqijumzlfioihnkt'};
const mockReconciliation={sql:'SELECT synthetic_resume22_state',parameters:[],expected:{snapshot_version:1,prefix:'exact21'}};

test('explicit inspected resume runs only22..62 and retains21 prior receipts plus atomic CAS29',async()=>{
 const h=harness({reconciliation:mockReconciliation});
 const result=await h.run({...apply,connection:resumeConnection,resumeEvidence});
 assert.equal(result.status,'completed');assert.equal(result.outcome,'remaining-41-committed');
 assert.deepEqual(result.completed.map(row=>row.position),Array.from({length:41},(_,i)=>i+22));
 assert.deepEqual(result.resume.previously_committed.map(row=>row.position),Array.from({length:21},(_,i)=>i+1));
 assert.equal(result.resume.journal_sha256,RESUME22_JOURNAL_SHA256);
 assert.equal(h.queries.filter(sql=>sql==='BEGIN').length,41);assert.equal(h.queries.filter(sql=>sql==='COMMIT').length,41);
 assert.equal(h.queries.some(sql=>plan.entries.slice(0,21).some(entry=>entry.sql===sql)),false);
 assert.equal(h.queries.filter(sql=>sql===plan.alignment_sql).length,1);assert.equal(h.customer,'A');
 assert.ok(h.queries.indexOf(EXCLUSIVE_RUN_SQL)<h.queries.indexOf(mockReconciliation.sql));
 assert.ok(h.queries.indexOf(mockReconciliation.sql)<h.queries.indexOf('BEGIN'));
 assert.equal(h.queries.filter(sql=>sql===RESUME22_LOCKS_SQL).length,1);
 assert.ok(h.queries.indexOf(RESUME22_LOCKS_SQL)<h.queries.indexOf('BEGIN'));
 const inspect=harness({reconciliation:mockReconciliation});
 assert.equal((await inspect.run({connection:resumeConnection,resumeEvidence})).status,'inspected');
 assert.equal(inspect.queries.includes('BEGIN'),false);assert.equal(inspect.queries.includes('SET default_transaction_read_only = on'),true);
 assert.equal(inspect.queries.includes(RESUME22_LOCKS_SQL),false);
});

test('resumed22 waits without a transaction for natural lock release and fails closed at130s',async()=>{
 for(const staysBusy of [false,true]){
  let clock=0,polls=0;const sleeps=[];
  const h=harness({reconciliation:mockReconciliation,now:()=>clock,wait:async ms=>{sleeps.push(ms);clock+=ms;},
   onQuery({sql,queries}){
    if(sql!==RESUME22_LOCKS_SQL)return;
    assert.equal(queries.includes('BEGIN'),false,'No DDL transaction during read-only lock polling');
    return {rows:[{table_present:true,other_locks:staysBusy||++polls<=2?1:0}]};
   }});
  const result=await h.run({...apply,connection:resumeConnection,resumeEvidence});
  assert.equal(h.queries.filter(sql=>sql==='SET statement_timeout = \'2s\'').length,1);
  assert.ok(sleeps.every(ms=>ms===2000));
  assert.equal(h.queries.some(sql=>/pg_cancel_backend|pg_terminate_backend/i.test(sql)),false);
  if(staysBusy){
   assert.equal(clock,RESUME22_QUIET_WAIT_MS);assert.equal(result.failure.code,'RESUME22_QUIET_WINDOW_TIMEOUT');
   assert.equal(result.failure.position,22);assert.equal(result.outcome,'no-migration-started');
   assert.equal(h.queries.includes('BEGIN'),false);assert.equal(h.queries.includes('ROLLBACK'),false);
   assert.equal(result.migration_ddl_attempted,0);assert.equal(result.resume.previously_committed.length,21);
  }else{
   assert.equal(result.status,'completed');assert.equal(clock,4000);
   assert.equal(h.queries.filter(sql=>sql===plan.entries[21].sql).length,1);
   assert.equal(h.queries.filter(sql=>sql==="SET LOCAL lock_timeout = '1s'").length,41);
  }
 }
 const h=harness({reconciliation:mockReconciliation,onQuery({sql}){
  if(sql===RESUME22_LOCKS_SQL)throw Object.assign(Error(secret),{code:'57014'});
 }});
 const result=await h.run({...apply,connection:resumeConnection,resumeEvidence});
 assert.equal(result.failure.code,'57014');assert.equal(h.queries.includes('BEGIN'),false);
 assert.equal(h.queries.filter(sql=>sql===RESUME22_LOCKS_SQL).length,1);
 assert.equal(JSON.stringify(result).includes(secret),false);
});

test('resume rejects altered journal, schema drift or target change before any transaction',async()=>{
 assert.equal(validateResume22Evidence(resumeEvidence.bytes,RESUME22_JOURNAL_SHA256,plan).from_position,22);
 for(const bytes of [Buffer.concat([resumeEvidence.bytes,Buffer.from('\n')]),
  Buffer.from(resumeEvidence.bytes.toString().replace('failed-transaction-rolled-back','unknown-requires-read-only-reconciliation')),
  Buffer.from(resumeEvidence.bytes.toString().replace('migration-rolled-back','commit-requested'))]){
  assert.throws(()=>validateResume22Evidence(bytes,hash(bytes),plan),/RESUME22_EVIDENCE_UNCONFIRMED/);
  const h=harness({reconciliation:mockReconciliation});
  assert.equal((await h.run({...apply,connection:resumeConnection,resumeEvidence:{bytes,expectedSha256:RESUME22_JOURNAL_SHA256}})).failure.code,'RESUME22_EVIDENCE_UNCONFIRMED');
  assert.equal(h.constructors,0);
 }
 const changedPlan=structuredClone(plan);changedPlan.entries[20].sha256='a'.repeat(64);
 assert.throws(()=>validateResume22Evidence(resumeEvidence.bytes,RESUME22_JOURNAL_SHA256,changedPlan),/RESUME22_EVIDENCE_UNCONFIRMED/);
 const drift=harness({reconciliation:mockReconciliation,reconciliationSnapshot:{snapshot_version:1,prefix:'already22'}});
 assert.equal((await drift.run({...apply,connection:resumeConnection,resumeEvidence})).failure.code,'RESUME22_DATABASE_STATE_CHANGED');
 assert.equal(drift.queries.includes('BEGIN'),false);
 const wrong=harness({reconciliation:mockReconciliation});
 assert.equal((await wrong.run({...apply,resumeEvidence})).failure.code,'RESUME22_TARGET_CHANGED');assert.equal(wrong.constructors,0);
 const args=['--project-ref','zjgueqijumzlfioihnkt','--manifest-sha256',expectedManifestSha256];
 for(const extra of [['--resume-evidence','a'],['--resume-evidence-sha256',RESUME22_JOURNAL_SHA256],['--resume-from','22']])
  assert.throws(()=>parseMigrationArgs([...args,...extra]),/RUNNER_ARGUMENT_INVALID/);
});

test('resumed COMMIT uncertainty preserves prior receipt chain and never retries22 or replays foundation',async()=>{
 const h=harness({reconciliation:mockReconciliation,onQuery({sql}){if(sql==='COMMIT')throw Object.assign(Error(secret),{code:'ECONNRESET'});}});
 const result=await h.run({...apply,connection:resumeConnection,resumeEvidence});
 assert.equal(result.outcome,'unknown-requires-read-only-reconciliation');assert.equal(result.completed.length,0);
 assert.equal(result.resume.previously_committed.length,21);assert.equal(result.failure.position,22);
 assert.equal(h.queries.filter(sql=>sql===plan.entries[21].sql).length,1);assert.equal(h.queries.includes(plan.entries[22].sql),false);
 assert.equal(h.queries.includes(plan.entries[0].sql),false);assert.equal(h.queries.includes('ROLLBACK'),false);
 assert.equal(JSON.stringify(result).includes(secret),false);
});

test('exact62 plan preserves order and all source hashes; only wrappers1/49 are excluded',async()=>{
 assert.equal(plan.entries.length,62);assert.deepEqual(plan.entries.filter(e=>e.wrapped).map(e=>e.position),[1,49]);
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

test('apply serializes all62 transactions and couples the only customer CAS to transaction29',async()=>{
 const h=harness(),result=await h.run(apply);
 assert.equal(result.status,'completed');assert.equal(result.completed.length,62);assert.equal(h.maxActive,1);assert.equal(h.ends,1);
 assert.equal(h.customer,'A');assert.equal(h.queries.filter(q=>q==='BEGIN').length,62);
 assert.equal(h.queries.filter(q=>q==='COMMIT').length,62);assert.equal(h.queries.includes('ROLLBACK'),false);
 assert.deepEqual(h.queries.filter(sql=>plan.entries.some(e=>e.sql===sql)),plan.entries.map(e=>e.sql));
 assert.equal(h.queries.filter(sql=>sql===plan.alignment_sql).length,1);
 const cas=h.queries.indexOf(plan.alignment_sql);assert.equal(h.queries[cas+1],plan.entries[28].sql);
 for(const entry of plan.entries){
  const start=h.events.findIndex(event=>event.event==='migration-start'&&event.position===entry.position);
  const requested=h.events.findIndex(event=>event.event==='commit-requested'&&event.position===entry.position);
  const committed=h.events.findIndex(event=>event.event==='migration-committed'&&event.position===entry.position);
  assert.ok(start<requested&&requested<committed);
 }
 for(const sql of TRANSACTION_SETUP_SQL)assert.equal(h.queries.filter(q=>q===sql).length,62);
 assert.equal(JSON.stringify([result,h.events]).includes(secret),false);
});

test('index disappearing after initial preflight stops before the first source migration can build it',async()=>{
 const entry=plan.entries.find(item=>item.file===plan.indexPlan.operations[0].source.file);
 assert.equal(entry.position,21);
 const h=harness({indexMissing:verification=>verification>1}),result=await h.run(apply);
 assert.equal(result.failure.code,'PREBUILT_INDEXES_UNCONFIRMED');assert.equal(result.failure.position,entry.position);
 assert.equal(result.outcome,'stopped-after-confirmed-commits');assert.equal(result.completed.length,entry.position-1);
 assert.equal(h.queries.filter(q=>q===plan.indexPlan.verification_sql).length,2);
 assert.equal(h.queries.filter(q=>q==='BEGIN').length,entry.position-1);
 assert.equal(h.queries.filter(q=>q==='COMMIT').length,entry.position-1);
 assert.equal(h.queries.includes(entry.sql),false);
 assert.equal(h.events.some(event=>event.event==='migration-start'&&event.position===entry.position),false);
});

test('compact index disappearing after its forward blocks the historical wide CREATE before BEGIN',async()=>{
 const compact=plan.indexPlan.operations.find(item=>item.name==='idx_supplier_prices_export_search');
 const source=plan.entries.find(item=>item.file===compact.source.file);
 const superseded=plan.entries.find(item=>item.file===compact.superseded_in[0].file);
 assert.equal(source.position,36);assert.equal(superseded.position,37);
 let sourceApplied=false;
 const h=harness({onQuery({entry}){if(entry?.file===source.file)sourceApplied=true;},
  indexMissing:()=>sourceApplied?compact.name:false});
 const result=await h.run(apply);
 assert.equal(result.failure.code,'PREBUILT_INDEXES_UNCONFIRMED');assert.equal(result.failure.position,37);
 assert.equal(result.completed.length,36);assert.equal(result.outcome,'stopped-after-confirmed-commits');
 assert.equal(h.queries.filter(sql=>sql==='BEGIN').length,36);
 assert.equal(h.queries.filter(sql=>sql==='COMMIT').length,36);
 assert.equal(h.queries.includes(superseded.sql),false);
 assert.equal(h.events.some(event=>event.event==='migration-start'&&event.position===37),false);
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

test('real captured PG17 fixture proves foundation rollback, all62 per-file transactions and atomic CAS29',async()=>{
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
