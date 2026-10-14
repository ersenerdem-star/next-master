import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
const exec=promisify(execFile),file='supabase/migrations/20261014202040_catalog_storage_complete_read_fence.sql';
let db,container,connection,historical,beforeHistory;
const org=randomUUID(),actor=randomUUID(),brand=randomUUID(),owner='read-fence-worker',hash='a'.repeat(64);
async function admin(q,args=[]){await db.exec('reset role');return db.query(q,args);}
async function rpc(name,args){await db.exec("reset role;set role service_role");await db.query("select set_config('request.jwt.claim.role','service_role',false),set_config('request.jwt.claim.sub',$1,false)",[actor]);return(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}
const payload=(start,end)=>Array.from({length:end-start+1},(_,i)=>({row_index:start+i,brand:'ReadFence',product_code:'FENCE'+String(start+i).padStart(6,'0'),description:'Complete source row '+(start+i),lifecycle_status:'active'}));
async function seed(){
 const run=randomUUID(),source=randomUUID(),token=randomUUID(),object=randomUUID(),path=`${org}/catalog/${run}/source.csv`;
 await admin("insert into catalog_import_runs(id,organization_id,created_by,mode,status,processing_queued_at,input_scope)values($1,$2,$3,'upsert','running',now(),$4)",[run,org,actor,JSON.stringify({source_kind:'storage_csv',source_id:source})]);
 await db.query("insert into storage.objects(id,bucket_id,name,version,metadata,created_at,updated_at)values($1,'catalog-imports',$2,'v1','{\"size\":100}',now(),now())",[object,path]);
 await db.query(`insert into catalog_import_sources(id,run_id,organization_id,created_by,storage_object_path,file_name,content_type,total_bytes,admitted_checksum_sha256,checksum_sha256,idempotency_key,status,storage_object_id,sealed_object_version,verified_at,verified_lease_generation,lease_owner,lease_token,lease_generation,lease_expires_at)
 values($1,$2,$3,$4,$5,'source.csv','text/csv',100,$6,$6,$2::uuid::text,'processing',$7,'v1',now(),1,$8,$9,1,now()+interval '15 minutes')`,[source,run,org,actor,path,hash,object,owner,token]);
 return{run,source,token,generation:1,owner};
}
const stage=(f,start,end,final=false)=>rpc('stage_catalog_import_storage_batch_system',[f.run,org,actor,f.owner,f.token,f.generation,JSON.stringify(payload(start,end)),end,final]);
const complete=(f,n)=>rpc('complete_catalog_import_storage_read_system',[f.run,org,actor,f.owner,f.token,f.generation,n]);
const validate=f=>rpc('validate_catalog_import_storage_batch_system',[f.run,org,actor,1000]);
const finalize=f=>rpc('finalize_catalog_import_batch_system',[f.run,org,actor,1000]);
const snap=async f=>(await admin(`select jsonb_build_object('run',to_jsonb(r),'source',to_jsonb(s),
 'stage_rows',(select count(*)from catalog_import_stage where run_id=r.id),
 'products',(select count(*)from catalog_products where organization_id=r.organization_id),
 'batches',(select jsonb_agg(to_jsonb(b)order by cursor_end)from catalog_import_source_batches b where run_id=r.id)) snapshot
 from catalog_import_runs r join catalog_import_sources s on s.run_id=r.id where r.id=$1`,[f.run])).rows[0].snapshot;
async function tx(fn){await admin('begin');try{await fn();}finally{await db.query('rollback');await db.exec('reset role');}}
before(async()=>{
 if(process.env.RUN_CATALOG_READ_FENCE_PG==='1'){
  container=`nm-catalog-read-fence-${process.pid}-${randomBytes(4).toString('hex')}`;const password=randomBytes(24).toString('hex');
  await exec('docker',['run','--detach','--rm','--name',container,'--cpus','0.5','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=read_fence_test','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
  const port=Number((await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)[1]);
  pg.types.setTypeParser(20,Number);pg.types.setTypeParser(1082,x=>x);connection={host:'127.0.0.1',port,user:'postgres',password,database:'read_fence_test'};
  let lastConnectCode;for(let i=0;i<240;i++){const c=new pg.Client({...connection,connectionTimeoutMillis:1000});try{await c.connect();db=c;break;}catch(e){lastConnectCode=e.code;await c.end().catch(()=>{});await delay(250);}}
  assert.ok(db,'isolated PG readiness failed: '+lastConnectCode);db.exec=q=>db.query(q);db.close=()=>db.end();db=await createFullReplayDb({db});
 }else db=await createFullReplayDb();
 const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));
 for(const entry of manifest.migration_order)await db.exec(await readFile(entry.file,'utf8'));
 await db.query("insert into organizations(id,name)values($1,'Read fence test')",[org]);
 await db.query("insert into profiles(id,organization_id,email,role,is_active)values($1,$2,'fixture@example.invalid','admin',true)",[actor,org]);
 await db.query("insert into brands(id,organization_id,name)values($1,$2,'ReadFence')",[brand,org]);
 // Reproduce the actual staging failure before applying the new forward.
 historical=await seed();await stage(historical,0,86,false);assert.equal((await validate(historical)).status,'validated');assert.equal((await finalize(historical)).status,'finalized');
 beforeHistory=await snap(historical);assert.equal(beforeHistory.stage_rows,87);assert.equal(beforeHistory.products,87);
 await db.exec('reset role');await db.exec(await readFile(file,'utf8'));
});
after(async()=>{try{await db?.close();}finally{if(container)await exec('docker',['rm','--force',container]).catch(()=>{});}});

test('reproduces87/2501 premature completion before fix; preserves its historical receipt/state',async()=>{
 const after=await snap(historical);
 // The only schema change is two nullable source columns; historical data is untouched.
 delete after.source.read_completed_at;delete after.source.read_complete_rows;assert.deepEqual(after,beforeHistory);
 assert.equal((await admin("select count(*) n from catalog_storage_internal.read_completion_receipts")).rows[0].n,0);
 const old=await snap(historical);assert.equal((await finalize(historical)).has_more,false);assert.deepEqual(await snap(historical),old);
});
test('active partial source cannot validate or finalize through service, browser or direct status transition',async()=>{
 const f=await seed();await stage(f,0,86,false);const before=await snap(f);
 await assert.rejects(validate(f),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 await assert.rejects(finalize(f),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 await assert.rejects(rpc('finalize_catalog_import_batch',[f.run,1000]),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 await assert.rejects(rpc('finalize_catalog_import',[f.run]),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 await assert.rejects(admin("update catalog_import_runs set status='validated' where id=$1",[f.run]),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 await assert.rejects(admin("update catalog_import_runs set status='validation_failed' where id=$1",[f.run]),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 await assert.rejects(complete(f,2501),/CATALOG_STORAGE_READ_COUNT_MISMATCH/);
 await assert.rejects(complete(f,87),/CATALOG_STORAGE_READ_RECEIPTS_INCOMPLETE/);
 await assert.rejects(rpc('mark_catalog_import_storage_processing_queued_system',[f.run,org,actor,f.owner,f.token,f.generation]),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 assert.deepEqual(await snap(f),before);
});
test('final batch alone is insufficient before independent total-row confirmation',async()=>{
 const f=await seed();await stage(f,0,1,true);await assert.rejects(validate(f),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 await assert.rejects(complete(f,2501),/CATALOG_STORAGE_READ_COUNT_MISMATCH/);
 assert.equal((await snap(f)).run.status,'running');
});
test('2501 rows survive fenced generation reclaim, exact full-read replay, validation and finalization',async()=>{
 const f=await seed();await stage(f,0,86,false);
 await admin("update catalog_import_sources set lease_expires_at=now()-interval '1 second' where id=$1",[f.source]);
 const claim=await rpc('claim_catalog_import_storage_source_system',[f.source,org,actor,'recovered',900]);assert.equal(claim.claimed,true);assert.equal(claim.lease_generation,2);
 await assert.rejects(stage(f,87,173,false),/CATALOG_STORAGE_LEASE_FENCE/);
 f.owner='recovered';f.token=claim.lease_token;f.generation=2;
 await rpc('complete_catalog_import_storage_upload_system',[f.run,org,actor,f.owner,f.token,2,100,hash]);
 const stageTimes=[];for(let start=87;start<2501;start+=1000){const at=performance.now();await stage(f,start,Math.min(start+999,2500),start+999>=2500);stageTimes.push({rows:Math.min(1000,2501-start),milliseconds:Math.round(performance.now()-at)});}
 const c=await complete(f,2501);assert.equal(c.read_complete_rows,2501);assert.equal(c.replayed,false);
 const saved=await snap(f);const replay=await complete(f,2501);assert.equal(replay.replayed,true);assert.deepEqual(await snap(f),saved);
 await assert.rejects(complete(f,2500),/CATALOG_STORAGE_READ_RECEIPT_CONFLICT/);
 const validateTimes=[];let v;do{const at=performance.now();v=await validate(f);validateTimes.push(Math.round(performance.now()-at));}while(v.has_more);assert.equal(v.status,'validated');if(connection)console.log(JSON.stringify({localPg17:'0.5CPU/1GB',stageBatches:stageTimes,validationBatchMilliseconds:validateTimes,network:'localhost',syntheticRowPayload:true}));
 let result;do{result=await finalize(f);}while(result.has_more);assert.equal(result.status,'finalized');
 const final=await snap(f);assert.equal(final.stage_rows,2501);assert.equal(final.run.processed_rows,2501);assert.equal(final.source.status,'completed');assert.equal(final.source.read_complete_rows,2501);
 assert.equal((await admin("select count(*) n from catalog_storage_internal.read_completion_receipts where run_id=$1",[f.run])).rows[0].n,1);
 assert.equal((await admin("select count(distinct row_index) n from catalog_import_stage where run_id=$1",[f.run])).rows[0].n,2501);
});
test('stage/receipt gaps, overlap, nonfinal tails and deleted stage rows fail before readiness',async()=>{
 for(const kind of ['gap','incomplete','no-final','missing-stage']){
  const f=await seed();await stage(f,0,1,false);await stage(f,2,3,true);
  if(kind==='gap')await admin("update catalog_import_source_batches set cursor_start=1,payload_rows=1 where source_id=$1 and cursor_start=0",[f.source]);
  if(kind==='incomplete')await admin("update catalog_import_source_batches set completed_at=null where source_id=$1 and cursor_start=0",[f.source]);
  if(kind==='no-final')await admin("update catalog_import_source_batches set is_final=false where source_id=$1",[f.source]);
  if(kind==='missing-stage')await admin("delete from catalog_import_stage where run_id=$1 and row_index=2",[f.run]);
  await assert.rejects(complete(f,4),/CATALOG_STORAGE_READ_(RECEIPTS_INCOMPLETE|STAGE_INCOMPLETE)/);
  await assert.rejects(validate(f),/CATALOG_STORAGE_SOURCE_NOT_READY/);
 }
});
test('old staged+queued without EOF proof can be reclaimed and fully re-read; old owner cannot seal',async()=>{
 const f=await seed();await stage(f,0,1,true);await admin("update catalog_import_sources set lease_expires_at=now()-interval '1 second' where id=$1",[f.source]);
 const c=await rpc('claim_catalog_import_storage_source_system',[f.source,org,actor,'new-reader',900]);assert.equal(c.claimed,true);
 await assert.rejects(complete(f,2),/CATALOG_STORAGE_LEASE_FENCE/);
 f.owner='new-reader';f.token=c.lease_token;f.generation=c.lease_generation;
 await rpc('complete_catalog_import_storage_upload_system',[f.run,org,actor,f.owner,f.token,f.generation,100,hash]);
 assert.equal((await complete(f,2)).read_complete_rows,2);
 assert.equal((await rpc('claim_catalog_import_storage_source_system',[f.source,org,actor,'another',900])).status,'handed_off');
});
test('sealed rows and proof binding are immutable while validation results remain writable',async()=>{
 const f=await seed();await stage(f,0,1,true);await complete(f,2);
 await assert.rejects(admin("update catalog_import_sources set read_complete_rows=3 where id=$1",[f.source]),/CATALOG_STORAGE_READ_RECEIPT_IMMUTABLE/);
 await assert.rejects(admin("update catalog_storage_internal.read_completion_receipts set total_rows=3,cursor_row=2 where source_id=$1",[f.source]),/CATALOG_STORAGE_READ_RECEIPT_IMMUTABLE/);
 await assert.rejects(admin("delete from catalog_import_stage where run_id=$1",[f.run]),/CATALOG_STORAGE_STAGE_SEALED/);
 await assert.rejects(admin("update catalog_import_stage set description='tampered' where run_id=$1",[f.run]),/CATALOG_STORAGE_STAGE_SEALED/);
 await assert.rejects(rpc('stage_catalog_import_chunk',[f.run,JSON.stringify(payload(2,2))]),/CATALOG_STORAGE_READ_ALREADY_COMPLETE/);
 assert.equal((await validate(f)).status,'validated');
});
test('safeNULL input, foreign identity and direct API receipt access fail closed',async()=>{
 await assert.rejects(rpc('complete_catalog_import_storage_read_system',[null,null,null,null,null,null,null]),/CATALOG_STORAGE_READ_INPUT_INVALID/);
 const f=await seed();await stage(f,0,1,true);
 await assert.rejects(rpc('complete_catalog_import_storage_read_system',[f.run,randomUUID(),actor,f.owner,f.token,1,2]),/CATALOG_STORAGE_ACTOR_INVALID/);
 const grants=(await admin("select has_function_privilege('anon','complete_catalog_import_storage_read_system(uuid,uuid,uuid,text,uuid,bigint,bigint)','EXECUTE') anon,has_function_privilege('authenticated','complete_catalog_import_storage_read_system(uuid,uuid,uuid,text,uuid,bigint,bigint)','EXECUTE') authenticated,has_function_privilege('service_role','complete_catalog_import_storage_read_system(uuid,uuid,uuid,text,uuid,bigint,bigint)','EXECUTE') service")).rows[0];
 assert.deepEqual(grants,{anon:false,authenticated:false,service:true});
 for(const role of ['anon','authenticated','service_role']){await db.exec('reset role;set role '+role);await assert.rejects(db.query("select * from catalog_storage_internal.read_completion_receipts"),/permission denied/);}
 await db.exec('reset role');
});
test('real PostgreSQL competing source lock blocks legacy direct transition without deadlock or partial writes',{skip:!process.env.RUN_CATALOG_READ_FENCE_PG},async()=>{
 const f=await seed();await stage(f,0,1,false);const other=new pg.Client(connection);await other.connect();
 try{await other.query('begin');await other.query('select id from catalog_import_sources where id=$1 for update',[f.source]);
  await db.exec("reset role;set statement_timeout='2s'");await assert.rejects(validate(f),/CATALOG_STORAGE_SOURCE_NOT_READY/);
  await assert.rejects(admin("update catalog_import_runs set status='validated' where id=$1",[f.run]),/CATALOG_STORAGE_SOURCE_NOT_READY/);
  assert.equal((await db.query("select status from catalog_import_runs where id=$1",[f.run])).rows[0].status,'running');
 }finally{await other.query('rollback');await other.end();await db.exec('reset statement_timeout');}
});


test('EOF lookup is read-only, rejects different identities and permits first ingest without a persisted checksum',async()=>{
 const f=await seed();await admin("update catalog_import_sources set checksum_sha256=null where id=$1",[f.source]);
 const args=[f.run,org,actor,f.source,hash,100];const before=await snap(f);
 assert.deepEqual(await rpc('get_catalog_import_storage_read_completion_system',args),{read_complete:false});
 assert.deepEqual(await snap(f),before);
 await assert.rejects(rpc('get_catalog_import_storage_read_completion_system',[f.run,org,actor,f.source,hash,101]),/CATALOG_STORAGE_READ_RECEIPT_CONFLICT/);
 await assert.rejects(rpc('get_catalog_import_storage_read_completion_system',[f.run,org,actor,randomUUID(),hash,100]),/CATALOG_STORAGE_SOURCE_SCOPE/);
 assert.deepEqual(await rpc('get_catalog_import_storage_read_completion_system',[historical.run,org,actor,historical.source,null,100]),{read_complete:false});
 await assert.rejects(rpc('get_catalog_import_storage_read_completion_system',[null,null,null,null,null,null]),/CATALOG_STORAGE_READ_INPUT_INVALID/);
});
test('EOF-before-checkpoint replay survives terminal finalization and normal Storage cleanup tombstone',async()=>{
 const f=await seed();await stage(f,0,1,true);await complete(f,2);
 const args=[f.run,org,actor,f.source,null,100];const read=await rpc('get_catalog_import_storage_read_completion_system',args);assert.equal(read.read_complete,true);assert.equal(read.total_rows,2);assert.equal(read.source_sha256,hash);
 await assert.rejects(admin("update catalog_import_sources set storage_object_id=null where id=$1",[f.source]),/CATALOG_STORAGE_READ_RECEIPT_IMMUTABLE/);
 await validate(f);await finalize(f);
 const receipt=(await admin("select to_jsonb(c) r from catalog_storage_internal.read_completion_receipts c where source_id=$1",[f.source])).rows[0].r;
 await admin("delete from storage.objects where id=$1",[receipt.storage_object_id]);
 await admin("update catalog_import_sources set storage_object_id=null,updated_at=now() where id=$1",[f.source]);
 const before=await snap(f);const final=await rpc('get_catalog_import_storage_read_completion_system',args);
 assert.equal(final.read_complete,true);assert.equal(final.run_status,'finalized');assert.equal(final.source_status,'completed');assert.equal(final.source_path,receipt.source_path);
 assert.deepEqual(await snap(f),before);assert.deepEqual((await admin("select to_jsonb(c) r from catalog_storage_internal.read_completion_receipts c where source_id=$1",[f.source])).rows[0].r,receipt);
 await assert.rejects(rpc('get_catalog_import_storage_read_completion_system',[f.run,org,actor,f.source,'b'.repeat(64),100]),/CATALOG_STORAGE_READ_RECEIPT_CONFLICT/);
 await assert.rejects(admin("update catalog_import_sources set storage_object_id=$2 where id=$1",[f.source,randomUUID()]),/CATALOG_STORAGE_READ_RECEIPT_IMMUTABLE/);
});
test('source-less browser catalog imports retain the existing validation/finalization behavior',async()=>{
 const run=randomUUID();await admin("insert into catalog_import_runs(id,organization_id,created_by,mode,status)values($1,$2,$3,'upsert','running')",[run,org,actor]);
 await rpc('stage_catalog_import_chunk',[run,JSON.stringify(payload(2600,2600).map(r=>({...r,row_index:0})))]);
 const f={run};assert.equal((await validate(f)).status,'validated');assert.equal((await finalize(f)).status,'finalized');
});


test('full EOF with incomplete validation counts cannot enter or finish finalization',async()=>{
 const f=await seed();await stage(f,0,3,true);await complete(f,4);
 await admin("update catalog_import_runs set status='validated',staged_rows=2,valid_rows=2,error_rows=0,insert_rows=2,update_rows=0,skip_rows=0,validation_cursor=1 where id=$1",[f.run]);
 await assert.rejects(finalize(f),/CATALOG_STORAGE_VALIDATION_INCOMPLETE/);
 await assert.rejects(rpc('finalize_catalog_import_batch',[f.run,1000]),/CATALOG_STORAGE_VALIDATION_INCOMPLETE/);
 await assert.rejects(admin("update catalog_import_runs set status='finalized',processed_rows=2,finalize_cursor=1 where id=$1",[f.run]),/CATALOG_STORAGE_FINALIZATION_INCOMPLETE/);
 // Complete validation from a supported fresh cursor; no forced publication.
 await admin("update catalog_import_runs set validation_cursor=-1,status='running' where id=$1",[f.run]);
 assert.equal((await validate(f)).status,'validated');assert.equal((await finalize(f)).status,'finalized');
});
