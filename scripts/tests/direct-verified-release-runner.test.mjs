import test from 'node:test';
import assert from 'node:assert/strict';
import {runDirectVerifiedRelease} from '../../apps/engine/supplier-price-shadow/src/direct-verified-release-runner.mjs';
const release='fed8b4fe-402e-40c5-967c-df587c91acdd',handoff='c99838e8-b11f-4036-8d22-b4aaf59585ab';
for(const commercialFields of [false,true])test(`direct runner drains leased ${commercialFields?'v2 commercial':'v1'} batches without DBOS`,async()=>{
 let claims=0,staged=0,finalized=0;const calls=[];
 const rpc=async(name,args)=>{
  calls.push(name);
  if(name==='get_supplier_price_verified_manifest')return {id:release,handoff_id:handoff,total_rows:2};
  if(name==='claim_supplier_price_verified_release_batch')return ++claims===1?{status:'claimed',release_id:release,batch_id:'11111111-1111-4111-8111-111111111111',cursor_start:1,cursor_end:2}: {status:'complete'};
  if(name===(commercialFields?'stage_supplier_price_release_batch_v2':'stage_supplier_price_release_batch')){staged++;return {status:'staged',release_id_result:release,batch_id:args.input_batch_id,staged_rows:2};}
  if(name==='heartbeat_supplier_price_release_batch')return {status:'heartbeat',batch_id:args.input_batch_id,current_cursor:2,processed_rows:2};
  if(name==='finalize_supplier_price_release_shadow_batch'){finalized++;return {status:'finalized',release_id:release,batch_id:args.input_batch_id,current_cursor:2,processed_rows:2,release_status:'staged'};}
  if(name==='complete_supplier_price_release_duckdb_validation')return {status:'validated',release_id:release,publishable:true};
  throw Error(name);
 };
 const source={prepare:async()=>({bucket:'supplier-price-prepared',key:'manifest',sha256:'a'.repeat(64),validation:{engine:'duckdb',totalRows:2,currencyCount:1,publishable:true}}),scan:async()=>({rows:[{source_row_number:1,product_code:'X'},{source_row_number:2,product_code:'Y'}],batchRows:2,cursorEnd:2,acceptedRows:2,warningRows:0,rejectedRows:0})};
 const result=await runDirectVerifiedRelease({rpc,source,releaseId:release,handoffId:handoff,workerId:'test-direct',commercialFields});
 assert.equal(result.status,'validated');assert.equal(staged,1);assert.equal(finalized,1);
 assert.ok(calls.indexOf('complete_supplier_price_release_duckdb_validation')>calls.indexOf('finalize_supplier_price_release_shadow_batch'));
});
test('advanced cursor alone never becomes a successful recovery',async()=>{
 const rpc=async name=>{
  if(name==='get_supplier_price_verified_manifest')return {id:release,handoff_id:handoff,total_rows:2};
  if(name==='claim_supplier_price_verified_release_batch')return {status:'complete'};
  if(name==='complete_supplier_price_release_duckdb_validation')throw Error('STAGED_RELEASE_ROW_INTEGRITY_FAILED');
  throw Error(name);
 };
 const source={prepare:async()=>({validation:{engine:'duckdb',totalRows:2,currencyCount:1,publishable:true}}),scan:async()=>{throw Error('scan must not run');}};
 await assert.rejects(runDirectVerifiedRelease({rpc,source,releaseId:release,handoffId:handoff,workerId:'test-direct'}),/STAGED_RELEASE_ROW_INTEGRITY_FAILED/);
});
test('invalid file stops before any SQL batch claim',async()=>{
 const calls=[];
 const rpc=async name=>{calls.push(name);return {id:release,handoff_id:handoff,total_rows:2};};
 const source={prepare:async()=>({validation:{engine:'duckdb',totalRows:2,publishable:false}}),scan:async()=>{throw Error('scan must not run');}};
 await assert.rejects(runDirectVerifiedRelease({rpc,source,releaseId:release,handoffId:handoff,workerId:'test-direct'}),/FILE_VALIDATION_BLOCKED/);
 assert.deepEqual(calls,['get_supplier_price_verified_manifest']);
});
