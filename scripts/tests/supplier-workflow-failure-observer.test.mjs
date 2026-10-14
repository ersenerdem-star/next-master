import test from 'node:test';
import assert from 'node:assert/strict';
import {observeFailedVerifiedWorkflows} from '../../apps/engine/supplier-price-shadow/src/workflow-failure-observer.mjs';
import {createWorkerService} from '../../apps/engine/supplier-price-shadow/src/worker-service.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const releaseId='10000000-0000-0000-0000-000000000001',handoffId='20000000-0000-0000-0000-000000000002';
const workflowID=`supplier-price-verified:v1:${releaseId}`;
const version={workflowName:'supplier-price-verified-release-v5',applicationVersion:'0.9.0-compact-history'};
const failedAt=Date.parse('2026-10-14T14:00:00.000Z'),updatedAt='2026-10-14T13:59:59.123456+00:00';
const failed={...version,workflowID,status:'ERROR',input:[{releaseId,handoffId}],completedAt:failedAt};
const context={id:releaseId,handoff_id:handoffId,workflow_id:workflowID,status:'parsing',current_cursor:25000,
 processed_rows:25000,error_code:null,updated_at:updatedAt};
function harness({failedRows=[failed],busy=[],contexts=[context],result={status:'marked',release_id:releaseId,published:false},onContext}={}){
 const calls=[];
 const rpc=async(name,args)=>{
  calls.push({name,args});
  if(name==='get_supplier_price_workflow_failure_context'){onContext?.();return contexts;}
  assert.equal(name,'mark_supplier_price_processing_interrupted');return result;
 };
 return {calls,run:overrides=>observeFailedVerifiedWorkflows({rpc,failed:failedRows,busy,...version,now:()=>failedAt+1000,...overrides})};
}

test('terminal main workflow emits one exact identity/cursor/timestamp CAS marker and never writes data rows',async()=>{
 const h=harness();assert.deepEqual(await h.run(),{marked:1,skipped:0,incomplete:false});
 assert.deepEqual(h.calls,[
  {name:'get_supplier_price_workflow_failure_context',args:{input_release_ids:[releaseId]}},
  {name:'mark_supplier_price_processing_interrupted',args:{input_release_id:releaseId,input_handoff_id:handoffId,
   input_workflow_id:workflowID,input_expected_cursor:25000,input_expected_updated_at:updatedAt,
   input_failed_at:'2026-10-14T14:00:00.000Z'}},
 ]);
});

test('active same-input recovery suppresses the original ERROR marker for all active DBOS states',async()=>{
 for(const status of ['PENDING','ENQUEUED','DELAYED']){
  const h=harness({busy:[{...failed,workflowID:'operator-recovery-unique',forkedFrom:workflowID,status}]});
  assert.equal((await h.run()).marked,0);assert.equal(h.calls.length,0);
 }
 const other=harness({busy:[{...failed,status:'PENDING',input:[{releaseId:'30000000-0000-0000-0000-000000000003',handoffId}]}]});
 assert.equal((await other.run()).marked,1);
});

test('a failed direct recovery fork uses its newer failure time while keeping canonical SQL identity',async()=>{
 const h=harness({failedRows:[failed,{...failed,workflowID:'operator-recovery-unique',forkedFrom:workflowID,
  completedAt:failedAt+500,status:'MAX_RECOVERY_ATTEMPTS_EXCEEDED'}]});
 await h.run();assert.equal(h.calls.length,2);
 assert.equal(h.calls[1].args.input_workflow_id,workflowID);
 assert.equal(h.calls[1].args.input_failed_at,'2026-10-14T14:00:00.500Z');
});

test('known recovery generations retain canonical identity; unknown or cyclic lineage stays unmarked',async()=>{
 const first={...failed,workflowID:'first-recovery',forkedFrom:workflowID,completedAt:failedAt+200};
 const second={...failed,workflowID:'second-recovery',forkedFrom:first.workflowID,completedAt:failedAt+500};
 const h=harness({failedRows:[failed,first,second]});
 assert.equal((await h.run()).marked,1);assert.equal(h.calls[1].args.input_failed_at,'2026-10-14T14:00:00.500Z');
 for(const rows of [[failed,second],[{...first,forkedFrom:second.workflowID},second]]){
  const denied=harness({failedRows:rows});assert.equal((await denied.run()).incomplete,true);assert.equal(denied.calls.length,0);
 }
});

test('capped, malformed or unrecognized history cannot prove recovery is idle',async()=>{
 for(const change of [
  {failedRows:Array(100).fill(failed)}, {busy:Array(100).fill({...failed,status:'PENDING'})},
  {busy:[{...failed,status:'PENDING',input:[]}]}, {failedRows:[{...failed,completedAt:undefined}]},
  {failedRows:[{...failed,completedAt:failedAt+100000}]}, {failedRows:[{...failed,workflowID:'unrelated'}]},
  {failedRows:[{...failed,applicationVersion:'unknown'}]},
 ]){
  const h=harness(change);assert.equal((await h.run()).incomplete,true);assert.equal(h.calls.length,0);
 }
});

test('progress, terminal business states, domain errors and existing owned markers are never overwritten',async()=>{
 for(const patch of [
  {updated_at:'2026-10-14T14:00:00.001Z'}, {status:'validated'}, {status:'published'}, {status:'cancelled'},
  {error_code:'VALIDATION_REVIEW_REQUIRED'}, {error_code:'SUPPLIER_PROCESSING_INTERRUPTED'},
 ]){
  const h=harness({contexts:[{...context,...patch}]});assert.equal((await h.run()).marked,0);assert.equal(h.calls.length,1);
 }
 const orphan=harness({contexts:[]});assert.equal((await orphan.run()).marked,0);assert.equal(orphan.calls.length,1);
});

test('all contexts are validated before any marker, and stale SQL CAS responses remain skips',async()=>{
 for(const patch of [{id:handoffId},{handoff_id:releaseId},{workflow_id:'unrelated'},{current_cursor:-1},
  {updated_at:'invalid'},{error_code:'raw provider secret'},{processed_rows:'25000'}]){
  const h=harness({contexts:[{...context,...patch}]});await assert.rejects(h.run(),/SERVICE_FAILURE_CONTEXT_RESPONSE/);
  assert.equal(h.calls.length,1);
 }
 const skipped=harness({result:{status:'skipped',release_id:releaseId,published:false}});
 assert.deepEqual(await skipped.run(),{marked:0,skipped:1,incomplete:false});
 const wrongReceipt=harness({result:{status:'marked',release_id:handoffId,published:false}});
 await assert.rejects(wrongReceipt.run(),/SERVICE_FAILURE_MARKER_RESPONSE/);
});

test('abort after read prevents late marker mutations; service history deadline passes cancellation into probe',async()=>{
 const controller=new AbortController(),h=harness({onContext:()=>controller.abort()});
 await assert.rejects(h.run({signal:controller.signal}),{name:'AbortError'});assert.equal(h.calls.length,1);
 let mutated=false;
 const service=createWorkerService({verify:async()=>({status:'empty',published:false}),dispatch:async()=>({status:'empty',published:false}),
  probe:async({signal})=>{await delay(20);signal.throwIfAborted();mutated=true;return {busy:false,failed:false};},historyTimeoutMs:1});
 await assert.rejects(service.cycle(),/SERVICE_HISTORY_TIMEOUT/);await delay(25);assert.equal(mutated,false);
});
