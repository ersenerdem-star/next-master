import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompactVerifiedWorkflow,compactVerifiedStageCheckpoint,COMPACT_CHECKPOINT_MAX_BYTES}
 from '../../apps/engine/supplier-price-shadow/src/compact-verified-workflow.mjs';
import {verifiedWorkflowVersion,requireCompactHistoryConfig,startVersionedVerifiedWorkflow,requireCompactHistoryDrained}
 from '../../apps/engine/supplier-price-shadow/src/verified-workflow-version.mjs';

const releaseId='fed8b4fe-402e-40c5-967c-df587c91acdd';
const handoffId='c99838e8-b11f-4036-8d22-b4aaf59585ab';
const organizationId='22222222-2222-4222-8222-222222222222';
const input={releaseId,handoffId};
const sourceSHA='a'.repeat(64),manifestSHA='b'.repeat(64);
const sentinel='NORMALIZED_ROW_MUST_NEVER_ENTER_DBOS_HISTORY';
const noise={rows:[{product_code:sentinel}],diagnostics:sentinel.repeat(1000)};

// A durable journal that discards an uncheckpointed result after its side
// effect committed. On restart, cached callbacks are skipped, as in DBOS.
function journal(){
 const entries=[];let cursor=0,crashName;
 return {entries,reset(){cursor=0;},crashAfter(name){crashName=name;},
  DBOS:{async runStep(fn,{name}){
   const index=cursor++;
   if(entries[index]){assert.equal(entries[index].name,name);return JSON.parse(entries[index].output);}
   const result=await fn();
   if(crashName===name){crashName=null;throw Error('SIMULATED_PROCESS_EXIT_BEFORE_CHECKPOINT');}
   entries[index]={name,output:JSON.stringify(result)};return JSON.parse(entries[index].output);
  },async sleep(){}}
 };
}
function fixture({totalRows=3,batchSize=2,staleAt,alwaysStale=false,commercialFields=false}={}){
 const history=journal(),calls=[],persisted=new Map(),owners=[];
 const state={cursor:0,owner:null,stageCalls:0,scanCalls:0,prepareCalls:0,staleSent:false,validationCalls:0};
 const release={id:releaseId,handoff_id:handoffId,total_rows:totalRows,source_date:'2026-10-10',
  source_file_path:organizationId+'/source.csv',source_file_sha256:sourceSHA,source_file_bytes:1000};
 const receipt={bucket:'supplier-price-prepared',key:`${organizationId}/${releaseId}/${manifestSHA}/manifest.json`,sha256:manifestSHA,
  validation:{engine:'duckdb',totalRows,currencyCount:1,publishable:true,...noise},...noise};
 const batchId=start=>`11111111-1111-4111-8111-${String(start).padStart(12,'0')}`;
 const rows=(start,end)=>Array.from({length:end-start+1},(_,i)=>({source_row_number:start+i,
  normalized_code:'CODE'+(start+i),...(commercialFields?{stock_qty:i,order_multiple:3,valid_to:'2027-10-14'}:{}),raw_payload:{note:sentinel},row_status:'accepted'}));
 const source={async prepare(){state.prepareCalls++;return structuredClone(receipt);},async scan({claim}){
  state.scanCalls++;const batchRows=claim.cursor_end-claim.cursor_start+1;
  return {rows:rows(claim.cursor_start,claim.cursor_end),cursorEnd:claim.cursor_end,batchRows,
   acceptedRows:batchRows,warningRows:0,rejectedRows:0,checksum:sourceSHA,sourceRows:totalRows,prepared:true};
 }};
 const rpc=async(name,args)=>{
  calls.push({name,args});
  if(name==='get_supplier_price_verified_manifest')return {...release,...noise};
  if(name==='claim_supplier_price_verified_release_batch'){
   owners.push(args.input_worker_id);state.owner=args.input_worker_id;
   if(state.cursor===totalRows)return {status:'complete',release_id:releaseId,...noise};
   return {status:'claimed',release_id:releaseId,batch_id:batchId(state.cursor+1),
    cursor_start:state.cursor+1,cursor_end:Math.min(totalRows,state.cursor+batchSize),...noise};
  }
  const stage=name===(commercialFields?'stage_supplier_price_release_batch_v2':'stage_supplier_price_release_batch');
  if(stage)state.stageCalls++;
  if((name===staleAt&&(!state.staleSent||alwaysStale))||args.input_worker_id&&args.input_worker_id!==state.owner){
   state.staleSent=true;
   return [{status:'stale',batch_id:args.input_batch_id,[stage?'release_id_result':'release_id']:releaseId,...noise}];
  }
  if(stage){
   // The production stage RPC compares existing canonical row contents before
   // ON CONFLICT DO NOTHING; an ambiguous prior commit is never a blind overwrite.
   for(const row of args.input_rows){
    const value=JSON.stringify(row),prior=persisted.get(row.source_row_number);
    if(prior&&prior!==value)throw Error('ROW_REPLAY_MISMATCH');
    persisted.set(row.source_row_number,value);
   }
   return [{status:'staged',batch_id:args.input_batch_id,release_id_result:releaseId,staged_rows:args.input_rows.length,...noise}];
  }
  if(name==='heartbeat_supplier_price_release_batch')return [{status:'heartbeat',batch_id:args.input_batch_id,
   release_id:releaseId,current_cursor:args.input_cursor,processed_rows:args.input_processed_rows,...noise}];
  if(name==='finalize_supplier_price_release_shadow_batch'){
   state.cursor=args.input_cursor;
   return [{status:'finalized',batch_id:args.input_batch_id,release_id:releaseId,current_cursor:state.cursor,
    release_status:state.cursor===totalRows?'staged':'parsing',...noise}];
  }
  if(name==='complete_supplier_price_release_duckdb_validation'){
   assert.equal(state.cursor,totalRows);assert.equal(persisted.size,totalRows);state.validationCalls++;
   return [{status:'validated',release_id:releaseId,publishable:true,...noise}];
  }
  throw Error('UNEXPECTED_RPC:'+name);
 };
 const run=(overrides={})=>{history.reset();return createCompactVerifiedWorkflow({DBOS:history.DBOS,rpc,source,
  requireMode(){},batchSize,commercialFields,...overrides})(input);};
 return {history,calls,persisted,owners,state,release,receipt,source,rpc,run};
}
function assertBoundedHistory(history){
 assert.ok(history.entries.length>0);
 for(const entry of history.entries){
  assert.ok(Buffer.byteLength(entry.output)<=COMPACT_CHECKPOINT_MAX_BYTES,entry.name);
  assert.doesNotMatch(entry.output,new RegExp(sentinel+'|"rows"|"raw_payload"|"diagnostics"|"product_code"'));
 }
}

test('v5 stages complete immutable batches, validates last, and keeps every checkpoint allowlisted and bounded',async()=>{
 const f=fixture();const result=await f.run();
 assert.deepEqual(result,{status:'validated',...input,publishable:true,published:false});
 assert.equal(f.persisted.size,3);assert.equal(f.state.stageCalls,2);assert.equal(f.state.validationCalls,1);
 assert.equal(f.calls.at(-1).name,'complete_supplier_price_release_duckdb_validation');
 assert.equal(f.calls.some(({name})=>/publish|delete|activate/.test(name)),false);
 assertBoundedHistory(f.history);
 const checkpoint=JSON.parse(f.history.entries.find(e=>e.name==='compact-scan-stage-v5').output);
 assert.equal(checkpoint.preparedManifestSha256,manifestSHA);assert.equal(checkpoint.checksum,sourceSHA);
 const callCount=f.calls.length,scanCount=f.state.scanCalls;
 assert.deepEqual(await f.run(),result);
 assert.equal(f.calls.length,callCount);assert.equal(f.state.scanCalls,scanCount);
});

test('commit before checkpoint rescans the same partition and reuses exact SQL receipt without duplicate rows',async()=>{
 const f=fixture();f.history.crashAfter('compact-scan-stage-v5');
 await assert.rejects(f.run(),/SIMULATED_PROCESS_EXIT/);
 assert.equal(f.persisted.size,2);assert.equal(f.state.cursor,0);
 assert.equal(f.history.entries.some(e=>e.name==='compact-scan-stage-v5'),false);
 await f.run();
 assert.equal(f.state.stageCalls,3);assert.equal(f.persisted.size,3);assert.equal(f.state.prepareCalls,1);
 const stages=f.calls.filter(c=>c.name==='stage_supplier_price_release_batch');
 assert.deepEqual(stages[0].args,stages[1].args);assertBoundedHistory(f.history);
});

test('v6 crash replay retains all three fields with exact v2 SQL identity and bounded scalar history',async()=>{
 const f=fixture({commercialFields:true});f.history.crashAfter('compact-scan-stage-v6');
 await assert.rejects(f.run(),/SIMULATED_PROCESS_EXIT/);assert.equal(f.persisted.size,2);assert.equal(f.state.cursor,0);
 await f.run();assert.equal(f.persisted.size,3);assert.equal(f.state.stageCalls,3);
 const stages=f.calls.filter(c=>c.name==='stage_supplier_price_release_batch_v2');
 assert.deepEqual(stages[0].args,stages[1].args);
 assert.equal(f.calls.some(c=>c.name==='stage_supplier_price_release_batch'),false);
 const first=JSON.parse(f.persisted.get(1));assert.deepEqual([first.stock_qty,first.order_multiple,first.valid_to],[0,3,'2027-10-14']);
 assert.ok(f.history.entries.every(e=>e.name.endsWith('-v6')));assertBoundedHistory(f.history);
 const before=f.calls.length;await f.run();assert.equal(f.calls.length,before,'completed v6 replay must not restage');
 const changed=fixture({commercialFields:true});changed.history.crashAfter('compact-scan-stage-v6');
 await assert.rejects(changed.run(),/SIMULATED_PROCESS_EXIT/);const original=changed.source.scan;
 changed.source.scan=async args=>{const r=await original(args);r.rows[0].stock_qty=1;return r;};
 await assert.rejects(changed.run(),/ROW_REPLAY_MISMATCH/);assert.equal(changed.state.validationCalls,0);
});

test('commit before checkpoint plus expired owner records stale and reclaims the same batch with a new owner',async()=>{
 const f=fixture();f.history.crashAfter('compact-scan-stage-v5');
 await assert.rejects(f.run(),/SIMULATED_PROCESS_EXIT/);f.state.owner='another-worker';
 await f.run();
 assert.equal(f.persisted.size,3);assert.equal(f.state.stageCalls,4);
 assert.notEqual(f.owners[0],f.owners[1]);
 const stages=f.calls.filter(c=>c.name==='stage_supplier_price_release_batch');
 assert.equal(stages[0].args.input_batch_id,stages[2].args.input_batch_id);
 assert.notEqual(stages[0].args.input_worker_id,stages[2].args.input_worker_id);
 assertBoundedHistory(f.history);
});

for(const phase of ['stage_supplier_price_release_batch','heartbeat_supplier_price_release_batch',
 'finalize_supplier_price_release_shadow_batch'])test('stale '+phase+' never advances cursor; new owner rescans',async()=>{
 const f=fixture({staleAt:phase});await f.run();
 assert.equal(f.persisted.size,3);assert.equal(f.state.scanCalls,3);assert.notEqual(f.owners[0],f.owners[1]);
 assert.equal(f.state.validationCalls,1);assertBoundedHistory(f.history);
});

test('repeated stale lease is bounded and never marks release validated',async()=>{
 const f=fixture({staleAt:'stage_supplier_price_release_batch',alwaysStale:true});
 await assert.rejects(f.run(),/VERIFIED_REPEATED_STALE_LEASE/);
 assert.equal(f.state.stageCalls,9);assert.equal(f.state.cursor,0);assert.equal(f.state.validationCalls,0);
});

test('checksum failure, incomplete rows, invalid source identity and counters fail before staging',async()=>{
 for(const patch of [{checksum:'c'.repeat(64)},{rows:[]},{sourceRows:999},{prepared:false},
  {acceptedRows:3,warningRows:-1},{rows:[{source_row_number:2},{source_row_number:1}]}]){
  const f=fixture(),original=f.source.scan;f.source.scan=async args=>({...await original(args),...patch});
  await assert.rejects(f.run(),/VERIFIED_SCAN_INTEGRITY|SHADOW_BATCH/);
  assert.equal(f.state.stageCalls,0);assert.equal(f.state.validationCalls,0);assertBoundedHistory(f.history);
 }
 const f=fixture();f.source.scan=async()=>{throw Error('SHARED_PREPARED_PART_CHECKSUM_MISMATCH');};
 await assert.rejects(f.run(),/PART_CHECKSUM_MISMATCH/);assert.equal(f.state.stageCalls,0);
});

test('changed source binding and rejected preparation fail closed without claiming or staging',async()=>{
 const f=fixture();f.receipt.validation.publishable=false;
 await assert.rejects(f.run(),/FILE_VALIDATION_BLOCKED/);assert.equal(f.owners.length,0);
 const g=fixture();let manifests=0;
 await assert.rejects(g.run({rpc:async(name,args)=>{
  const r=await g.rpc(name,args);return name==='get_supplier_price_verified_manifest'&&++manifests===2
   ?{...r,source_file_sha256:'c'.repeat(64)}:r;
 }}),/VERIFIED_MANIFEST_CHANGED/);assert.equal(g.state.stageCalls,0);
});

test('same-row replay with altered contents is refused by the stage receipt contract',async()=>{
 const f=fixture();f.history.crashAfter('compact-scan-stage-v5');await assert.rejects(f.run(),/SIMULATED_PROCESS_EXIT/);
 const original=f.source.scan;f.source.scan=async args=>{
  const r=await original(args);r.rows[0].normalized_code='CHANGED';return r;
 };
 await assert.rejects(f.run(),/ROW_REPLAY_MISMATCH/);assert.equal(f.state.cursor,0);assert.equal(f.state.validationCalls,0);
});

test('wrong or ambiguous stage receipts cannot become durable successful checkpoints',async()=>{
 for(const patch of [{release_id_result:organizationId},{batch_id:organizationId},{staged_rows:0},
  {status:'stale',release_id_result:organizationId}]){
  const f=fixture();await assert.rejects(f.run({rpc:async(name,args)=>{
   const response=await f.rpc(name,args);return name==='stage_supplier_price_release_batch'?[{...response[0],...patch}]:response;
  }}),/SHADOW_STAGE_INCOMPLETE|VERIFIED_STALE_RECEIPT_IDENTITY/);
  assert.equal(f.history.entries.some(e=>e.name==='compact-scan-stage-v5'),false);assert.equal(f.state.validationCalls,0);
 }
 const f=fixture();await assert.rejects(f.run({rpc:async(name,args)=>{
  const response=await f.rpc(name,args);return name==='stage_supplier_price_release_batch'?[response[0],response[0]]:response;
 }}),/VERIFIED_RECEIPT_CARDINALITY/);
});

test('checkpoint size is independent of normalized row payload size',()=>{
 const f=fixture(),claim={release_id:releaseId,batch_id:'11111111-1111-4111-8111-111111111111',cursor_start:1,cursor_end:1000};
 const scan={cursorEnd:1000,batchRows:1000,acceptedRows:1000,warningRows:0,rejectedRows:0,checksum:sourceSHA,
  rows:[{raw_payload:sentinel.repeat(100000)}]};
 const checkpoint=compactVerifiedStageCheckpoint({scan,claim,release:f.release,receipt:f.receipt,
  stageReceipt:{status:'staged',batch_id:claim.batch_id,release_id_result:releaseId,staged_rows:1000,...noise}});
 assert.ok(Buffer.byteLength(JSON.stringify(checkpoint))<512);assert.doesNotMatch(JSON.stringify(checkpoint),/raw_payload|NORMALIZED_ROW/);
});

test('compact gate is off by default, requires prepared source, and production cannot fall back to v4',()=>{
 assert.doesNotThrow(()=>requireCompactHistoryConfig({}));
 assert.equal(verifiedWorkflowVersion().workflowName,'supplier-price-verified-release-v2');
 assert.equal(verifiedWorkflowVersion({sharedPrepared:true}).applicationVersion,'0.8.0-verified-integrity');
 assert.equal(verifiedWorkflowVersion({compact:true,sharedPrepared:true}).applicationVersion,'0.9.0-compact-history');
 for(const env of [{SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED:'yes'},
  {SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED:'1'},
  {SUPPLIER_PRICE_TARGET_ENVIRONMENT:'production'},
  {SUPPLIER_PRICE_TARGET_ENVIRONMENT:'production',SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED:'0'}])
  assert.throws(()=>requireCompactHistoryConfig(env));
 assert.doesNotThrow(()=>requireCompactHistoryConfig({SUPPLIER_PRICE_TARGET_ENVIRONMENT:'production',
  SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED:'1',SUPPLIER_PRICE_SHARED_PREPARED_ENABLED:'1'}));
});

test('commercial v7 measurements are separately default-off and cannot start without compact prepared history',()=>{
 const base={SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED:'1',SUPPLIER_PRICE_SHARED_PREPARED_ENABLED:'1'};
 assert.doesNotThrow(()=>requireCompactHistoryConfig({...base,SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED:'0'}));
 assert.equal(verifiedWorkflowVersion({compact:true,sharedPrepared:true}).workflowName,'supplier-price-verified-release-v5');
 assert.deepEqual(verifiedWorkflowVersion({compact:true,sharedPrepared:true,commercialFields:true}),
  {workflowName:'supplier-price-verified-release-v7',applicationVersion:'0.11.0-measurement-diagnostics'});
 for(const env of [{SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED:'1'},
  {...base,SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED:'true'},
  {...base,SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED:'1',SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED:'0'},
  {...base,SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED:'1',SUPPLIER_PRICE_SHARED_PREPARED_ENABLED:'0'}])
  assert.throws(()=>requireCompactHistoryConfig(env),/SERVICE_COMMERCIAL_FIELDS_CONFIG/);
 assert.doesNotThrow(()=>requireCompactHistoryConfig({...base,SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED:'1'}));
 assert.throws(()=>verifiedWorkflowVersion({commercialFields:true}),/SERVICE_COMMERCIAL_FIELDS_CONFIG/);
});

test('v6 dispatch never repurposes any v5 workflow identity, even a completed prior workflow',async()=>{
 const v5=verifiedWorkflowVersion({compact:true,sharedPrepared:true});
 const v6=verifiedWorkflowVersion({compact:true,sharedPrepared:true,commercialFields:true});let started=0;
 const DBOS={getWorkflowStatus:async()=>({...v5,status:'SUCCESS'}),startWorkflow:()=>()=>{started++;}};
 await assert.rejects(startVersionedVerifiedWorkflow({DBOS,workflow(){},version:v6,workflowID:'same-release',queueName:'queue',input}),/VERIFIED_VERSION_DRAIN_REQUIRED/);
 assert.equal(started,0);
});

test('v6 startup additionally drains every active v5 status without changing default v5 startup queries',async()=>{
 for(const status of ['PENDING','ENQUEUED','DELAYED']){
  const calls=[],history={listWorkflows:async q=>{calls.push(q);return q.workflowName==='supplier-price-verified-release-v5'?[{status}]:[];}};
  await requireCompactHistoryDrained(history);assert.equal(calls.length,4);calls.length=0;
  await assert.rejects(requireCompactHistoryDrained(history,{commercialFields:true}),/VERIFIED_VERSION_DRAIN_REQUIRED/);
  assert.equal(calls.length,5);assert.equal(calls.at(-1).loadInput,false);assert.equal(calls.at(-1).loadOutput,false);
 }
});

test('versioned dispatch starts new v5 only; every prior workflow name or version stays untouched',async()=>{
 const version=verifiedWorkflowVersion({compact:true,sharedPrepared:true}),workflow=()=>{},started=[];
 let existing;
 const DBOS={getWorkflowStatus:async()=>existing,startWorkflow:(fn,options)=>async args=>{started.push({fn,options,args});return 'handle';}};
 const dispatch=()=>startVersionedVerifiedWorkflow({DBOS,workflow,version,workflowID:'immutable-id',queueName:'queue',input});
 assert.equal(await dispatch(),'handle');assert.equal(started[0].fn,workflow);
 for(const prior of [verifiedWorkflowVersion(),verifiedWorkflowVersion({sharedPrepared:true}),
  {...version,applicationVersion:'another'}, {...version,workflowName:'another'}]){
  existing=prior;await assert.rejects(dispatch(),/VERIFIED_VERSION_DRAIN_REQUIRED/);
 }
 assert.equal(started.length,1);existing=version;assert.equal(await dispatch(),'handle');
});

test('startup reads all old versions and blocks acknowledged-outbox pending, enqueued and delayed work',async()=>{
 for(const status of ['PENDING','ENQUEUED','DELAYED'])for(const version of [1,2,3,4]){
  const calls=[];
  await assert.rejects(requireCompactHistoryDrained({async listWorkflows(query){
   calls.push(query);assert.deepEqual(query.status,['PENDING','ENQUEUED','DELAYED']);
   assert.equal(query.loadInput,false);assert.equal(query.loadOutput,false);assert.equal(query.limit,1);
   assert.equal(query.applicationVersion,undefined);
   return query.workflowName===`supplier-price-verified-release-v${version}`?[{status}]:[];
  }}),/VERIFIED_VERSION_DRAIN_REQUIRED/);
  assert.equal(calls.length,version);
 }
 let reads=0;await requireCompactHistoryDrained({async listWorkflows(){reads++;return [];}});assert.equal(reads,4);
});

test('fresh history can initialize, while other schema errors, auth failures and unreadable history block boot',async()=>{
 const missing=Object.assign(Error('relation "dbos.workflow_status" does not exist'),{code:'42P01'});
 await requireCompactHistoryDrained({async listWorkflows(){throw missing;}});
 for(const error of [Object.assign(Error('relation "dbos.workflow_input" does not exist'),{code:'42P01'}),
  Object.assign(Error('permission denied'),{code:'42501'}),Error('connection failed')])
  await assert.rejects(requireCompactHistoryDrained({async listWorkflows(){throw error;}}),e=>e===error);
 await assert.rejects(requireCompactHistoryDrained({async listWorkflows(){return null;}}),/DRAIN_UNCONFIRMED/);
});
