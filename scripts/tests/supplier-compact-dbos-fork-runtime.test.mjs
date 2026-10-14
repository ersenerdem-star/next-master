// Opt-in local-only real SDK/PG proof. This file also serves as its child worker;
// the child refuses every database except its isolated loopback fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createCompactVerifiedWorkflow} from '../../apps/engine/supplier-price-shadow/src/compact-verified-workflow.mjs';

const self=fileURLToPath(import.meta.url),exec=promisify(execFile);
const sdkRequire=createRequire(new URL('../../apps/engine/supplier-price-shadow/scripts/compact-dbos-runtime-child.mjs',import.meta.url));
const {DBOS,DBOSClient}=sdkRequire('@dbos-inc/dbos-sdk');
const OLD='supplier-compact-fork-runtime-original-v5',NEW='supplier-compact-fork-runtime-recovered-v5';
const NAME='supplier-price-verified-release-v5',VERSION='0.9.0-compact-history';
const APP='supplier-compact-fork-local-runtime',QUEUE='supplier-price-verified-shadow';
const releaseId='11111111-1111-4111-8111-111111111111',handoffId='22222222-2222-4222-8222-222222222222';
const input={releaseId,handoffId},sourceHash='a'.repeat(64),rowCount=6,batchSize=2;
const release={id:releaseId,handoff_id:handoffId,total_rows:rowCount,source_file_sha256:sourceHash,
 source_file_bytes:1234,source_file_path:`44444444-4444-4444-8444-444444444444/${releaseId}/source.csv`,source_date:'2026-10-14'};
const quiet={debug(){},info(){},warn(){},error(){}};
const sha=value=>createHash('sha256').update(value).digest('hex');

async function childMain(){
 const connection=new URL(process.env.NM_COMPACT_FORK_TEST_DATABASE_URL||'https://invalid.invalid');
 if(connection.hostname!=='127.0.0.1'||connection.pathname!=='/compact_fork_runtime_test'
  ||!['postgres:','postgresql:'].includes(connection.protocol))throw Error('LOCAL_FORK_DATABASE_REQUIRED');
 const client=new pg.Client({connectionString:connection.href});await client.connect();
 const original=process.env.NM_COMPACT_FORK_TEST_CHILD==='original';
 const log=(kind,owner=null,batch=null,inserted=null,hash=null)=>client.query(
  'insert into runtime_fixture.calls(kind,owner,batch_id,inserted_rows,payload_hash) values($1,$2,$3,$4,$5)',[kind,owner,batch,inserted,hash]);
 const batchState=async args=>(await client.query('select *,expires>clock_timestamp() live from runtime_fixture.batches where batch_id=$1',[args.input_batch_id])).rows[0];
 const stale=(batch,field='release_id')=>({status:'stale',batch_id:batch.batch_id,[field]:releaseId});
 const rpc=async(name,args)=>{
  if(name==='get_supplier_price_verified_manifest')return release;
  if(name==='claim_supplier_price_verified_release_batch'){
   const state=(await client.query('select cursor from runtime_fixture.state')).rows[0];
   if(state.cursor===rowCount)return {status:'complete',release_id:releaseId};
   const start=state.cursor+1,end=Math.min(start+batchSize-1,rowCount);
   const id=`33333333-3333-4333-8333-${String(start).padStart(12,'0')}`;
   const prior=(await client.query('select *,expires>clock_timestamp() live from runtime_fixture.batches where batch_id=$1',[id])).rows[0];
   if(prior?.live&&!prior.completed)return {status:'busy'};
   await client.query(`insert into runtime_fixture.batches(batch_id,cursor_start,cursor_end,owner,expires,attempt)
    values($1,$2,$3,$4,clock_timestamp()+interval '60 seconds',1)
    on conflict(batch_id) do update set owner=excluded.owner,expires=excluded.expires,attempt=runtime_fixture.batches.attempt+1`,
   [id,start,end,args.input_worker_id]);
   await log('claim',args.input_worker_id,id);
   return {status:'claimed',release_id:releaseId,batch_id:id,cursor_start:start,cursor_end:end};
  }
  if(name==='stage_supplier_price_release_batch'){
   const batch=await batchState(args);
   if(!batch.live||batch.owner!==args.input_worker_id)return stale(batch,'release_id_result');
   const payload=JSON.stringify(args.input_rows),hash=sha(payload);
   await client.query('begin');
   try{
    const receipt=(await client.query('select payload_hash from runtime_fixture.receipts where batch_id=$1 for update',[batch.batch_id])).rows[0];
    if(receipt&&receipt.payload_hash!==hash)throw Error('FIXTURE_IMMUTABLE_STAGE_CONFLICT');
    const inserted=await client.query(`insert into runtime_fixture.rows(row_number,payload)
     select (value->>'source_row_number')::int,value from jsonb_array_elements($1::jsonb) on conflict(row_number) do nothing`,[payload]);
    await client.query('insert into runtime_fixture.receipts(batch_id,payload_hash) values($1,$2) on conflict do nothing',[batch.batch_id,hash]);
    await log('stage',args.input_worker_id,batch.batch_id,inserted.rowCount,hash);await client.query('commit');
   }catch(error){await client.query('rollback');throw error;}
   return {status:'staged',release_id_result:releaseId,batch_id:batch.batch_id,staged_rows:args.input_rows.length};
  }
  if(name==='heartbeat_supplier_price_release_batch'){
   const batch=await batchState(args);
   // Untagged TimeoutError models the original pre-retry transport failure.
   if(original&&args.input_cursor===4){await log('heartbeat-timeout',args.input_worker_id,batch.batch_id);
    throw Object.assign(Error('The operation was aborted due to timeout'),{name:'TimeoutError'});}
   if(!batch.live||batch.owner!==args.input_worker_id){await log('heartbeat-stale',args.input_worker_id,batch.batch_id);return stale(batch);}
   await client.query("update runtime_fixture.batches set expires=clock_timestamp()+interval '60 seconds' where batch_id=$1",[batch.batch_id]);
   await log('heartbeat',args.input_worker_id,batch.batch_id);
   return {status:'heartbeat',batch_id:batch.batch_id,release_id:releaseId,current_cursor:args.input_cursor,processed_rows:args.input_processed_rows};
  }
  if(name==='finalize_supplier_price_release_shadow_batch'){
   const batch=await batchState(args);
   if(!batch.live||batch.owner!==args.input_worker_id)return stale(batch);
   await client.query('begin');
   try{
    await client.query('update runtime_fixture.state set cursor=$1',[args.input_cursor]);
    await client.query('update runtime_fixture.batches set completed=true,expires=null where batch_id=$1',[batch.batch_id]);
    await log('finalize',args.input_worker_id,batch.batch_id);await client.query('commit');
   }catch(error){await client.query('rollback');throw error;}
   return {status:'finalized',batch_id:batch.batch_id,release_id:releaseId,current_cursor:args.input_cursor,
    release_status:args.input_cursor===rowCount?'staged':'parsing'};
  }
  if(name==='complete_supplier_price_release_duckdb_validation'){
   const state=(await client.query('select cursor,(select count(*)::int from runtime_fixture.rows) rows from runtime_fixture.state')).rows[0];
   if(state.cursor!==rowCount||state.rows!==rowCount)throw Error('FIXTURE_VALIDATION_INCOMPLETE');
   await client.query('update runtime_fixture.state set validated=true');return {status:'validated',release_id:releaseId,publishable:true};
  }
  throw Error('UNEXPECTED_FIXTURE_RPC');
 };
 const source={prepare:async()=>{
  await log('prepare');return {bucket:'supplier-price-prepared',key:`44444444-4444-4444-8444-444444444444/${releaseId}/${sourceHash}/manifest.json`,
   sha256:sourceHash,validation:{engine:'duckdb',totalRows:rowCount,currencyCount:1,publishable:true}};
 },scan:async({claim})=>{
  await log('scan',null,claim.batch_id);
  const rows=Array.from({length:claim.cursor_end-claim.cursor_start+1},(_,i)=>({source_row_number:claim.cursor_start+i,
   normalized_code:`CODE${claim.cursor_start+i}`,raw_payload:{note:'FORK_PRIVATE_ROW_SENTINEL'.repeat(20)}}));
  return {rows,batchRows:rows.length,cursorEnd:claim.cursor_end,acceptedRows:rows.length,warningRows:0,rejectedRows:0,
   checksum:sourceHash,prepared:true,sourceRows:rowCount};
 }};
 const workflow=DBOS.registerWorkflow(createCompactVerifiedWorkflow({DBOS,rpc,source,requireMode(){},batchSize}),{name:NAME});
 DBOS.setConfig({name:APP,applicationVersion:VERSION,executorID:'supplier-compact-fork-local-01',systemDatabaseUrl:connection.href,
  listenQueues:[QUEUE],systemDatabasePoolSize:5,systemDatabasePollingConcurrency:2,maxConcurrentQueueDispatches:1,logLevel:'error',logger:quiet});
 await DBOS.launch();
 try{
  await DBOS.registerQueue(QUEUE,{concurrency:1});
  if(original){
   const handle=await DBOS.startWorkflow(workflow,{workflowID:OLD,queueName:QUEUE})(input);
   let failed=false;try{await handle.getResult();}catch(error){failed=error.name==='TimeoutError';}
   if(!failed)throw Error('EXPECTED_HEARTBEAT_TIMEOUT_NOT_OBSERVED');
   process.send?.({event:'original-error'});
  }else{
   const result=await DBOS.retrieveWorkflow(NEW).getResult();process.send?.({event:'completed',result});
  }
 }finally{await DBOS.shutdown({deregister:false,workflowCompletionTimeoutMS:1000});await client.end();}
}

function launch(connectionString,mode){
 const child=fork(self,[],{execArgv:[],silent:true,env:{...process.env,NM_COMPACT_FORK_TEST_CHILD:mode,
  NM_COMPACT_FORK_TEST_DATABASE_URL:connectionString}});
 child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 const completion=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 const event=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('LOCAL_FORK_EVENT_TIMEOUT'));},60000);
  child.on('message',message=>{
   clearTimeout(timer);if(message.event==='failed')reject(Error(message.code));else resolve(message);
  });
  child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('LOCAL_FORK_CHILD_FAILED'));});
 });return {child,completion,event};
}
const checkpoints=(client,id)=>client.query(`select function_id,function_name,output,error,serialization,
 child_workflow_id,started_at_epoch_ms,completed_at_epoch_ms from dbos.operation_outputs where workflow_uuid=$1 order by function_id`,[id]).then(r=>r.rows);

if(process.env.NM_COMPACT_FORK_TEST_CHILD){
 childMain().catch(()=>{process.send?.({event:'failed',code:'LOCAL_COMPACT_FORK_FAILED'});process.exitCode=1;});
}else test('real DBOS5.2.11 fork excludes failed heartbeat, preserves old history and reclaims expired lease without duplicate rows',
 {skip:process.env.RUN_SUPPLIER_COMPACT_DBOS_FORK_RUNTIME!=='1',timeout:180000},async t=>{
 const sdk=JSON.parse(await readFile(new URL('../../apps/engine/supplier-price-shadow/node_modules/@dbos-inc/dbos-sdk/package.json',import.meta.url)));
 assert.equal(sdk.version,'5.2.11');
 const container=`nm-compact-fork-${process.pid}-${randomBytes(4).toString('hex')}`,password=randomBytes(24).toString('hex'),children=[];
 let client,history;
 try{
  await exec('docker',['run','--detach','--rm','--name',container,'--cpus','0.5','--memory','1g','--publish','127.0.0.1::5432',
   '--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=compact_fork_runtime_test','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
  const {stdout}=await exec('docker',['port',container,'5432/tcp']);const port=stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];assert.ok(port);
  const connectionString=`postgresql://postgres:${password}@127.0.0.1:${port}/compact_fork_runtime_test`;
  for(let attempt=0;attempt<60;attempt++){
   const candidate=new pg.Client({connectionString,connectionTimeoutMillis:1000});
   try{await candidate.connect();client=candidate;break;}catch{await candidate.end().catch(()=>{});await delay(250);}
  }
  assert.ok(client);
  await client.query(`create schema runtime_fixture;
   create table runtime_fixture.state(cursor int not null default 0,validated boolean not null default false);
   insert into runtime_fixture.state default values;
   create table runtime_fixture.batches(batch_id uuid primary key,cursor_start int,cursor_end int,owner text,expires timestamptz,completed boolean default false,attempt int);
   create table runtime_fixture.rows(row_number int primary key,payload jsonb not null);
   create table runtime_fixture.receipts(batch_id uuid primary key,payload_hash text not null);
   create table runtime_fixture.calls(id bigint generated always as identity,kind text,owner text,batch_id uuid,inserted_rows int,payload_hash text);`);
  const original=launch(connectionString,'original');children.push(original.child);
  assert.equal((await original.event).event,'original-error');assert.equal((await original.completion).code,0);
  history=await DBOSClient.create({systemDatabaseUrl:connectionString,applicationName:APP,systemDatabasePoolSize:1,
   systemDatabasePollingConcurrency:1,observabilityQueryTimeoutMs:15000,logger:quiet});
  const old=await history.getWorkflow(OLD);assert.equal(old.status,'ERROR');assert.equal(old.workflowName,NAME);
  assert.equal(old.applicationVersion,VERSION);assert.equal(old.queueName,QUEUE);assert.deepEqual(old.input,[input]);
  assert.equal(old.error.name,'TimeoutError');
  const steps=await history.listWorkflowSteps(OLD),failed=steps.filter(step=>step.error);
  assert.equal(failed.length,1);assert.equal(failed[0].name,'compact-heartbeat-v5');assert.equal(failed[0].functionID,12);
  const cut=failed[0].functionID,oldSteps=await checkpoints(client,OLD);
  const oldInput=(await client.query('select inputs from dbos.workflow_input where workflow_uuid=$1',[OLD])).rows;
  const oldOutput=(await client.query('select * from dbos.workflow_output where workflow_uuid=$1',[OLD])).rows;
  assert.equal((await client.query('select cursor from runtime_fixture.state')).rows[0].cursor,2);
  assert.equal((await client.query('select count(*)::int n from runtime_fixture.rows')).rows[0].n,4);
  await client.query("update runtime_fixture.batches set expires=clock_timestamp()-interval '1 second' where completed=false");
  assert.equal(await history.getWorkflow(NEW),undefined);
  assert.equal(await history.forkWorkflow(OLD,cut,{newWorkflowID:NEW,applicationVersion:old.applicationVersion,queueName:old.queueName}),NEW);
  const queued=await history.getWorkflow(NEW);assert.equal(queued.status,'ENQUEUED');assert.equal(queued.forkedFrom,OLD);
  assert.equal(queued.applicationName,APP);assert.equal(queued.applicationVersion,VERSION);assert.equal(queued.queueName,QUEUE);assert.deepEqual(queued.input,[input]);
  assert.deepEqual(await checkpoints(client,NEW),oldSteps.filter(step=>step.function_id<cut));
  assert.equal((await checkpoints(client,NEW)).some(step=>step.function_id>=cut),false);
  assert.equal((await history.getWorkflow(OLD)).wasForkedFrom,true);
  // Read-after-unknown-outcome reconciliation uses the predetermined new ID;
  // creating a second fork is unnecessary and could race the same business job.
  await history.destroy();history=await DBOSClient.create({systemDatabaseUrl:connectionString,applicationName:APP,logger:quiet});
  assert.equal((await history.listWorkflows({forkedFrom:OLD,loadInput:false,loadOutput:false})).length,1);
  const resumed=launch(connectionString,'recovered');children.push(resumed.child);
  const done=await resumed.event;assert.equal(done.event,'completed');assert.equal(done.result.status,'validated');assert.equal(done.result.published,false);
  assert.equal((await resumed.completion).code,0);
  assert.equal((await history.getWorkflow(NEW)).status,'SUCCESS');assert.equal((await history.getWorkflow(OLD)).status,'ERROR');
  assert.equal((await history.getWorkflow(OLD)).error.name,'TimeoutError');
  assert.deepEqual(await checkpoints(client,OLD),oldSteps);
  assert.deepEqual((await client.query('select inputs from dbos.workflow_input where workflow_uuid=$1',[OLD])).rows,oldInput);
  assert.deepEqual((await client.query('select * from dbos.workflow_output where workflow_uuid=$1',[OLD])).rows,oldOutput);
  const stageCalls=(await client.query("select owner,batch_id,inserted_rows,payload_hash from runtime_fixture.calls where kind='stage' order by id")).rows;
  assert.deepEqual(stageCalls.map(call=>call.inserted_rows),[2,2,0,2]);
  assert.equal(stageCalls[1].batch_id,stageCalls[2].batch_id);assert.equal(stageCalls[1].payload_hash,stageCalls[2].payload_hash);
  assert.notEqual(stageCalls[1].owner,stageCalls[2].owner);
  assert.equal((await client.query("select count(*)::int n from runtime_fixture.calls where kind='prepare'")).rows[0].n,1);
  assert.equal((await client.query("select count(*)::int n from runtime_fixture.calls where kind='heartbeat-stale'")).rows[0].n,1);
  assert.equal((await client.query('select count(*)::int n from runtime_fixture.rows')).rows[0].n,rowCount);
  assert.equal((await client.query('select count(*)::int n from runtime_fixture.receipts')).rows[0].n,3);
  assert.deepEqual((await client.query('select cursor,validated from runtime_fixture.state')).rows,[{cursor:6,validated:true}]);
  assert.deepEqual((await client.query('select attempt from runtime_fixture.batches order by cursor_start')).rows.map(r=>r.attempt),[1,2,1]);
  const forkSteps=await checkpoints(client,NEW);
  assert.deepEqual(forkSteps.filter(step=>step.function_id<cut),oldSteps.filter(step=>step.function_id<cut));
  assert.equal(JSON.stringify(forkSteps).includes('FORK_PRIVATE_ROW_SENTINEL'),false);
  t.diagnostic(JSON.stringify({sdk:sdk.version,postgres:17,cpu:0.5,memoryMiB:1024,failedFunctionId:cut,copiedSteps:cut,
   oldStatus:'ERROR',forkStatus:'SUCCESS',originalErrorAndCheckpointsPreserved:true,forkAuditPreserved:true,
   oldCursor:2,oldPersistedRows:4,finalRows:6,rowInsertions:stageCalls.map(call=>call.inserted_rows),
   expiredLeaseReclaimed:true,rowsDuplicated:0,published:false,
   scope:'Real DBOS fork/replay on local PG17; modeled SQL lease/idempotency receipts, not the full Supabase RPC schema or a1M timing proof'}));
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await history?.destroy().catch(()=>{});await client?.end().catch(()=>{});
  await exec('docker',['rm','--force',container],{timeout:20000}).catch(()=>{});
 }
});
