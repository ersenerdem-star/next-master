import test from 'node:test';
import assert from 'node:assert/strict';
import {runDirectVerifiedRelease} from '../../apps/engine/supplier-price-shadow/src/direct-verified-release-runner.mjs';
const release='fed8b4fe-402e-40c5-967c-df587c91acdd',handoff='c99838e8-b11f-4036-8d22-b4aaf59585ab';
test('direct runner drains leased batches without DBOS',async()=>{
 let cursor=0,claims=0,staged=0,finalized=0;
 const rpc=async(name,args)=>{
  if(name==='get_supplier_price_verified_manifest')return {id:release,handoff_id:handoff,total_rows:2};
  if(name==='claim_supplier_price_verified_release_batch')return ++claims===1?{status:'claimed',release_id:release,batch_id:'11111111-1111-4111-8111-111111111111',cursor_start:1,cursor_end:2}: {status:'complete'};
  if(name==='stage_supplier_price_release_batch'){staged++;return {status:'staged',release_id_result:release,batch_id:args.input_batch_id,staged_rows:2};}
  if(name==='heartbeat_supplier_price_release_batch')return {status:'heartbeat',batch_id:args.input_batch_id,current_cursor:2,processed_rows:2};
  if(name==='finalize_supplier_price_release_shadow_batch'){finalized++;return {status:'finalized',release_id:release,batch_id:args.input_batch_id,current_cursor:2,processed_rows:2,release_status:'staged'};}
  throw Error(name);
 };
 const source={prepare:async()=>({bucket:'supplier-price-prepared',key:'manifest',sha256:'a'.repeat(64)}),scan:async()=>({rows:[{product_code:'X'}],batchRows:2,cursorEnd:2,acceptedRows:2,warningRows:0,rejectedRows:0})};
 const result=await runDirectVerifiedRelease({rpc,source,releaseId:release,handoffId:handoff,workerId:'test-direct'});
 assert.equal(result.status,'staged');assert.equal(staged,1);assert.equal(finalized,1);assert.equal(cursor,0);
});
