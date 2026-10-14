import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {compactRpcTransportError,compactRpcHttpError,retryCompactRpcStep,COMPACT_RPC_MAX_ATTEMPTS}
 from '../../apps/engine/supplier-price-shadow/src/compact-rpc-retry.mjs';
import {createCompactVerifiedWorkflow}
 from '../../apps/engine/supplier-price-shadow/src/compact-verified-workflow.mjs';

const heartbeat='heartbeat_supplier_price_release_batch';
const timeout=()=>Object.assign(Error('secret provider URL must not survive'),{name:'TimeoutError'});
const transport=(name=heartbeat)=>compactRpcTransportError(name,timeout());

test('only reviewed RPC transport errors retry with four bounded attempts and safe error data',async()=>{
 const sleeps=[];let attempts=0;
 const error=transport();
 await assert.rejects(retryCompactRpcStep(async()=>{attempts++;throw error;},{sleep:async ms=>sleeps.push(ms)}),e=>e===error);
 assert.equal(attempts,COMPACT_RPC_MAX_ATTEMPTS);assert.deepEqual(sleeps,[250,500,1000]);
 assert.doesNotMatch(JSON.stringify(error)+error.stack,/secret provider/);assert.equal(error.cause,undefined);
 for(const original of [Error('STAGED_RELEASE_ROW_INTEGRITY_FAILED'),Error('VERIFIED_MANIFEST_CHANGED'),
  Object.assign(Error('cancelled'),{name:'AbortError'}),new TypeError('malformed arguments'),
  Object.assign(Error('fake'),{rpcName:heartbeat,retryable:true})]){
  attempts=0;
  await assert.rejects(retryCompactRpcStep(async()=>{attempts++;throw compactRpcTransportError(heartbeat,original);},
   {sleep:async()=>assert.fail('domain error must not sleep')}),e=>e===original);
  assert.equal(attempts,1);
 }
 for(const name of ['claim_supplier_price_upload_verification','publish_supplier_price_release','unknown']){
  const original=timeout();assert.equal(compactRpcTransportError(name,original),original);
 }
 for(const error of [new TypeError('fetch failed'),Object.assign(new TypeError('terminated'),{cause:{code:'UND_ERR_SOCKET'}}),
  Object.assign(Error('sensitive network detail'),{code:'ECONNRESET'})]){
  let attempts=0;await retryCompactRpcStep(async()=>{if(++attempts===1)throw compactRpcTransportError(heartbeat,error);},
   {sleep:async()=>{}});assert.equal(attempts,2);
 }
 const tls=Object.assign(Error('certificate failure'),{code:'SELF_SIGNED_CERT_IN_CHAIN'});
 assert.equal(compactRpcTransportError(heartbeat,tls),tls);
 const wrappedTls=Object.assign(new TypeError('fetch failed'),{cause:tls});
 assert.equal(compactRpcTransportError(heartbeat,wrappedTls),wrappedTls);
});

test('gateway failures retry; structured SQL, authentication and integrity errors never retry',async()=>{
 for(const status of [408,425,429,500,502,503,504]){
  for(const body of [{},{raw:'gateway HTML containing secret URL'}]){
   let attempts=0;
   const result=await retryCompactRpcStep(async()=>{if(++attempts===1)throw compactRpcHttpError(heartbeat,status,body);return 'ok';},
    {sleep:async()=>{}});
   assert.equal(result,'ok');assert.equal(attempts,2);
  }
 }
 for(const [status,body] of [[401,{}],[403,{}],[400,{}],[409,{}],[500,{code:'P0001',message:'integrity failed'}],
  [503,{code:'42501',message:'access denied'}],[502,{error:'STAGED_RELEASE_ROW_INTEGRITY_FAILED'}],
  [500,{message:'SHADOW_RETRY_PAYLOAD_DIFFERS'}],[429,{code:'P0001'}],[500,null]]){
  let attempts=0;
  await assert.rejects(retryCompactRpcStep(async()=>{attempts++;throw compactRpcHttpError(heartbeat,status,body);},
   {sleep:async()=>assert.fail('permanent error must not sleep')}),new RegExp(`SERVICE_RPC_HTTP_${status}`));
  assert.equal(attempts,1);
 }
});

test('worker tags only compact service transport failures and preserves legacy HTTP errors',async()=>{
 // Exercise the actual worker function without launching its service or reading env credentials.
 const source=readFileSync(new URL('../../apps/engine/supplier-price-shadow/src/worker.mjs',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('async function callRpc('),source.indexOf('\nasync function claimReleaseBatch('));
 function worker({compact=true,service=true,fetchImpl}){
  return vm.runInNewContext(code+';callRpc',{
   COMPACT_HISTORY:compact,process:{argv:['node','worker',service?'--service':'--operator-recover']},
   SERVICE_RPC_NAMES:new Set([heartbeat]),SUPABASE_URL:'https://example.invalid',SERVICE_ROLE_KEY:'test-key',
   requireEnv:(_name,value)=>value,supabaseApiHeaders:()=>({}),AbortSignal,
   compactRpcHttpError,compactRpcTransportError,fetch:fetchImpl,
  });
 }
 for(const phase of ['request','body']){
  let requests=0;
  const rpc=worker({fetchImpl:async()=>{
   requests++;if(phase==='request'&&requests===1)throw timeout();
   return {ok:true,status:200,text:async()=>{if(phase==='body'&&requests===1)throw timeout();return '{"ok":true}';}};
  }});
  const result=await retryCompactRpcStep(()=>rpc(heartbeat,{}),{sleep:async()=>{}});
  assert.equal(result.ok,true);assert.equal(requests,2);
 }
 for(const mode of [{compact:false,service:true},{compact:true,service:false}]){
  let requests=0;const error=timeout();const rpc=worker({...mode,fetchImpl:async()=>{requests++;throw error;}});
  await assert.rejects(retryCompactRpcStep(()=>rpc(heartbeat,{}),{sleep:async()=>assert.fail()}),e=>e===error);
  assert.equal(requests,1);
 }
 const rpc=worker({fetchImpl:async()=>({ok:false,status:500,text:async()=>'{"code":"P0001","message":"domain secret"}'})});
 await assert.rejects(retryCompactRpcStep(()=>rpc(heartbeat,{}),{sleep:async()=>assert.fail()}),/SERVICE_RPC_HTTP_500/);
 for(const status of [401,403,500]){
  let requests=0;const failedBody=worker({fetchImpl:async()=>{requests++;
   return {ok:false,status,text:async()=>{throw timeout();}};}});
  await assert.rejects(retryCompactRpcStep(()=>failedBody(heartbeat,{}),{sleep:async()=>assert.fail()}),new RegExp(`SERVICE_RPC_HTTP_${status}`));
  assert.equal(requests,1);
 }
});

const releaseId='11111111-1111-4111-8111-111111111111',handoffId='22222222-2222-4222-8222-222222222222';
const org='33333333-3333-4333-8333-333333333333',sourceSHA='a'.repeat(64),manifestSHA='b'.repeat(64);
const input={releaseId,handoffId};
function fixture({failName,afterCommit=false,permanent=false,failCount=1,expireAfterFailure=false}={}){
 const state={cursor:0,owner:null,active:null,expired:false,failures:0,validations:0,validationEvents:0,stageWrites:0,reclaims:0};
 const calls=[],history=[],rows=new Map(),batches=new Map();
 const release={id:releaseId,handoff_id:handoffId,total_rows:3,source_date:'2026-10-14',
  source_file_path:org+'/source.csv',source_file_sha256:sourceSHA,source_file_bytes:1000};
 const receipt={bucket:'supplier-price-prepared',key:`${org}/${releaseId}/${manifestSHA}/manifest.json`,sha256:manifestSHA,
  validation:{engine:'duckdb',totalRows:3,currencyCount:1,publishable:true}};
 const DBOS={async runStep(fn,{name}){const result=await fn();history.push({name,output:JSON.stringify(result)});return result;},
  async sleep(){state.expired=true;}};
 const source={async prepare(){return receipt;},async scan({claim}){
  const values=Array.from({length:claim.cursor_end-claim.cursor_start+1},(_,i)=>({source_row_number:claim.cursor_start+i,
   normalized_code:'CODE'+(claim.cursor_start+i),row_status:'accepted'}));
  return {rows:values,batchRows:values.length,cursorEnd:claim.cursor_end,acceptedRows:values.length,warningRows:0,rejectedRows:0,
   checksum:sourceSHA,prepared:true,sourceRows:3};
 }};
 function committed(name,args){
  if(name==='get_supplier_price_verified_manifest')return release;
  if(name==='claim_supplier_price_verified_release_batch'){
   if(state.cursor===3)return {status:'complete',release_id:releaseId};
   if(state.active&&!state.expired)return {status:'busy'};
   if(state.active)state.reclaims++;
   const start=state.cursor+1,end=Math.min(3,state.cursor+2);
   const batch=state.active??{id:`44444444-4444-4444-8444-${String(start).padStart(12,'0')}`,start,end,completed:false};
   state.active=batch;batches.set(batch.id,batch);state.owner=args.input_worker_id;state.expired=false;
   return {status:'claimed',release_id:releaseId,batch_id:batch.id,cursor_start:start,cursor_end:end};
  }
  if(name==='complete_supplier_price_release_duckdb_validation'){
   assert.equal(state.cursor,3);assert.equal(rows.size,3);state.validations++;
   if(!state.validated){state.validated=true;state.validationEvents++;}
   return [{status:'validated',release_id:releaseId,publishable:true}];
  }
  const batch=batches.get(args.input_batch_id),stage=name==='stage_supplier_price_release_batch';
  if(name==='finalize_supplier_price_release_shadow_batch'&&batch.completed)
   return [{status:'finalized',batch_id:batch.id,release_id:releaseId,current_cursor:state.cursor,release_status:state.cursor===3?'staged':'parsing'}];
  if(state.expired||args.input_worker_id!==state.owner)return [{status:'stale',batch_id:batch.id,
   [stage?'release_id_result':'release_id']:releaseId}];
  if(stage){
   for(const row of args.input_rows){const prior=rows.get(row.source_row_number);if(prior)assert.deepEqual(prior,row);
    else{rows.set(row.source_row_number,row);state.stageWrites++;}}
   return [{status:'staged',batch_id:batch.id,release_id_result:releaseId,staged_rows:args.input_rows.length}];
  }
  if(name===heartbeat)return [{status:'heartbeat',batch_id:batch.id,release_id:releaseId,
   processed_rows:args.input_processed_rows,current_cursor:args.input_cursor}];
  if(name==='finalize_supplier_price_release_shadow_batch'){
   assert.equal(batch.start,state.cursor+1);batch.completed=true;state.cursor=batch.end;state.active=null;
   return [{status:'finalized',batch_id:batch.id,release_id:releaseId,current_cursor:state.cursor,release_status:state.cursor===3?'staged':'parsing'}];
  }
  assert.fail('unexpected RPC '+name);
 }
 const rpc=async(name,args)=>{
  calls.push({name,args:structuredClone(args)});
  const failing=name===failName&&state.failures<failCount;
  if(failing){state.failures++;if(afterCommit)committed(name,args);if(expireAfterFailure)state.expired=true;
   throw permanent?Error('STAGED_RELEASE_ROW_INTEGRITY_FAILED'):transport(name);}
  return committed(name,args);
 };
 const run=()=>createCompactVerifiedWorkflow({DBOS,rpc,source,requireMode(){},batchSize:2})(input);
 return {state,calls,history,rows,run};
}

test('heartbeat timeout before commit retries inside the same durable step and completes exact rows',async()=>{
 const baseline=fixture();await baseline.run();
 const f=fixture({failName:heartbeat});assert.equal((await f.run()).status,'validated');
 assert.deepEqual(f.history.map(s=>s.name),baseline.history.map(s=>s.name));
 assert.equal(f.state.stageWrites,3);assert.equal(f.state.validationEvents,1);assert.equal(f.state.cursor,3);
 assert.equal(f.calls.filter(c=>c.name===heartbeat).length,3);
 assert.ok(f.history.every(s=>Buffer.byteLength(s.output)<4096));
});

for(const failName of ['claim_supplier_price_verified_release_batch','stage_supplier_price_release_batch',heartbeat,
 'finalize_supplier_price_release_shadow_batch','complete_supplier_price_release_duckdb_validation']){
 test('unknown successful commit is safely replayed: '+failName,async()=>{
  const f=fixture({failName,afterCommit:true});assert.equal((await f.run()).status,'validated');
  assert.equal(f.state.cursor,3);assert.equal(f.state.stageWrites,3);assert.equal(f.rows.size,3);
  assert.equal(f.state.validationEvents,1);assert.equal(f.state.failures,1);
  const retry=f.calls.filter(c=>c.name===failName);assert.deepEqual(retry[0].args,retry[1].args);
  if(failName==='claim_supplier_price_verified_release_batch')assert.equal(f.state.reclaims,1);
 });
}

test('timeout crossing lease expiry returns stale, then reclaims and exactly rescans staged rows',async()=>{
 const f=fixture({failName:heartbeat,expireAfterFailure:true});await f.run();
 assert.equal(f.state.reclaims,1);assert.equal(f.state.stageWrites,3);assert.equal(f.rows.size,3);assert.equal(f.state.cursor,3);
 const stages=f.calls.filter(c=>c.name==='stage_supplier_price_release_batch');
 assert.equal(stages[0].args.input_batch_id,stages[1].args.input_batch_id);
 assert.notEqual(stages[0].args.input_worker_id,stages[1].args.input_worker_id);
 assert.deepEqual(stages[0].args.input_rows,stages[1].args.input_rows);
});

test('exhausted transport and domain failure stay terminal without false finalization or validation',async()=>{
 for(const options of [{failCount:4},{permanent:true}]){
  const f=fixture({failName:heartbeat,...options});await assert.rejects(f.run(),/timeout|INTEGRITY_FAILED/);
  assert.equal(f.state.failures,options.permanent?1:4);assert.equal(f.state.cursor,0);
  assert.equal(f.state.validations,0);assert.equal(f.rows.size,2);
  assert.equal(f.history.some(s=>s.name==='compact-heartbeat-v5'),false);
  assert.equal(f.calls.some(c=>c.name==='finalize_supplier_price_release_shadow_batch'),false);
 }
});
