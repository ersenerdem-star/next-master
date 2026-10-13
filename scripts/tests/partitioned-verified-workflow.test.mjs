import test from 'node:test';
import assert from 'node:assert/strict';
import {createPartitionedVerifiedWorkflow} from '../../apps/engine/supplier-price-shadow/src/partitioned-verified-workflow.mjs';

const releaseId='fed8b4fe-402e-40c5-967c-df587c91acdd';
const handoffId='c99838e8-b11f-4036-8d22-b4aaf59585ab';
const batchId='11111111-1111-4111-8111-111111111111';
const DBOS={runStep:fn=>fn(),sleep:async()=>{throw Error('unexpected sleep');}};
const release={id:releaseId,handoff_id:handoffId,total_rows:2};
const receipt={validation:{engine:'duckdb',totalRows:2,currencyCount:1,publishable:true}};

test('v4 workflow validates persisted rows only after the final staged batch',async()=>{
 const calls=[];
 const rpc=async(name,args)=>{
  calls.push(name);
  if(name==='get_supplier_price_verified_manifest')return release;
  if(name==='claim_supplier_price_verified_release_batch')return {status:'claimed',release_id:releaseId,batch_id:batchId,cursor_start:1,cursor_end:2};
  if(name==='stage_supplier_price_release_batch')return {status:'staged',release_id_result:releaseId,batch_id:batchId,staged_rows:2};
  if(name==='heartbeat_supplier_price_release_batch')return {status:'heartbeat',batch_id:batchId,current_cursor:2,processed_rows:2};
  if(name==='finalize_supplier_price_release_shadow_batch')return {status:'finalized',release_id:releaseId,batch_id:batchId,current_cursor:2,processed_rows:2,release_status:'staged'};
  if(name==='complete_supplier_price_release_duckdb_validation'){
   assert.equal(args.input_accepted_rows,2);
   return {status:'validated',release_id:releaseId,publishable:true};
  }
  throw Error(name);
 };
 const source={prepare:async()=>receipt,scan:async()=>({rows:[{source_row_number:1},{source_row_number:2}],
  batchRows:2,cursorEnd:2,acceptedRows:2,warningRows:0,rejectedRows:0})};
 const run=createPartitionedVerifiedWorkflow({DBOS,rpc,source,requireMode:()=>{},batchSize:2});
 const result=await run({releaseId,handoffId});
 assert.equal(result.status,'validated');assert.equal(result.published,false);
 assert.ok(calls.indexOf('complete_supplier_price_release_duckdb_validation')>
  calls.indexOf('finalize_supplier_price_release_shadow_batch'));
});

test('v4 workflow does not claim a batch for an unpublishable file',async()=>{
 const calls=[];
 const rpc=async name=>{calls.push(name);if(name==='get_supplier_price_verified_manifest')return release;throw Error(name);};
 const source={prepare:async()=>({validation:{engine:'duckdb',totalRows:2,publishable:false}}),
  scan:async()=>{throw Error('scan must not run');}};
 const run=createPartitionedVerifiedWorkflow({DBOS,rpc,source,requireMode:()=>{},batchSize:2});
 await assert.rejects(run({releaseId,handoffId}),/FILE_VALIDATION_BLOCKED/);
 assert.deepEqual(calls,['get_supplier_price_verified_manifest']);
});
