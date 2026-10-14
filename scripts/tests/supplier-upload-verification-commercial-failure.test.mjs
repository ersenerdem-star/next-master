import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import {consumeUploadVerification} from '../../apps/engine/supplier-price-shadow/src/upload-verification-consumer.mjs';
import {createWorkerService} from '../../apps/engine/supplier-price-shadow/src/worker-service.mjs';

function fixture(bytes,extension='csv'){
 const id=()=>randomUUID(),request=id(),session=id(),release=id(),org=id(),actor=id(),lease=id(),object=id(),handoff=id();
 const source=Buffer.from(bytes),sha=createHash('sha256').update(source).digest('hex');
 const state={status:'queued',attempt:0,completed:0,fetches:0,settlements:[],rpcCalls:[],failCompletion:false};
 const rpc=async(name,args)=>{
  state.rpcCalls.push({name,args});
  if(name==='claim_supplier_price_upload_verification'){
   if(state.status!=='queued')return {status:'empty',published:false};
   state.status='verifying';state.attempt++;
   return {status:'claimed',published:false,request_id:request,session_id:session,release_id:release,
    organization_id:org,actor_id:actor,lease_token:lease,attempt:state.attempt};
  }
  if(name==='begin_supplier_price_upload_verification')return {session_id:session,release_id:release,
   organization_id:org,actor_id:actor,object_id:object,storage_bucket:'supplier-price-imports',
   source_file_bytes:source.length,source_file_sha256:state.wrongSha?'a'.repeat(64):sha,
   object_version:'sealed-version',object_updated_at:'2026-10-14T18:00:00Z',
   source_file_path:`${org}/supplier-price/${session}/fixture.${extension}`};
  if(name==='complete_supplier_price_verified_upload'){
   state.completed++;
   if(state.failCompletion)throw Error('synthetic lost completion response');
   return {status:'verified',session_id:session,release_id:release,handoff_id:handoff,
    workflow_id:`supplier-price-verified:v1:${release}`,queue_name:'supplier-price-verified-shadow',
    source_bytes:source.length,source_sha256:sha,total_rows:2,published:false};
  }
  if(name==='settle_supplier_price_upload_verification'){
   state.settlements.push(args);
   assert.equal(args.input_request_id,request);assert.equal(args.input_lease_token,lease);
   assert.equal(args.input_worker_id,'guard-test-worker');
   state.status=args.input_action==='retry'?'queued':args.input_action;
   if(state.settleLost)throw Error('synthetic lost rejection settlement');
   return {request_id:request,session_id:session,release_id:release,status:state.status,published:false,...state.settlePatch};
  }
  throw Error('Unexpected RPC '+name);
 };
 const consume=options=>consumeUploadVerification({rpc,workerId:'guard-test-worker',
  supabaseUrl:'https://staging.example.invalid',serviceRoleKey:'sb_secret_synthetic_only',
  fetchImpl:async()=>{state.fetches++;return new Response(source);},...options});
 return {state,consume};
}
const csv=(header,value)=>`Product_Code,Buy_Price_EUR,Price_Date,${header}\nA,7.50,2026-10-06,\nB,8.50,2026-10-06,${value}\n`;

test('actual original-source CSV rejection settles failed on attempt1, keeps no handoff and is never reclaimed',async t=>{
 for(const [header,value,code]of [['Stock Quantity','0','SOURCE_UNSUPPORTED_STOCK_QTY'],
  ['Order Multiple','0','SOURCE_UNSUPPORTED_ORDER_MULTIPLE'],['Valid Until','2026-11-14','SOURCE_UNSUPPORTED_VALID_TO']])await t.test(header,async()=>{
  const f=fixture(csv(header,value));
  const result=await f.consume();assert.equal(result.status,'rejected');assert.equal(result.errorCode,code);assert.equal(result.published,false);
  assert.equal(f.state.attempt,1);assert.equal(f.state.status,'failed');assert.equal(f.state.completed,0);
  assert.equal(f.state.settlements.length,1);assert.equal(f.state.settlements[0].input_action,'failed');
  assert.equal(f.state.settlements[0].input_error_code,code);
  assert.deepEqual(await f.consume(),{status:'empty',published:false});assert.equal(f.state.fetches,1);
  assert(!f.state.rpcCalls.some(x=>/stage|compatibility|publish|handoff/.test(x.name)));
 });
});

test('actual original XLSX numeric zero rejects on the first verification attempt',async()=>{
 const book=new ExcelJS.Workbook();book.addWorksheet('Prices').addRows([
  ['Product_Code','Buy_Price_EUR','Price_Date','Order_Multiple'],['A',7.5,'2026-10-06',''],['B',8.5,'2026-10-06',0]]);
 const f=fixture(await book.xlsx.writeBuffer(),'xlsx');
 const result=await f.consume();assert.equal(result.status,'rejected');assert.equal(f.state.attempt,1);assert.equal(f.state.completed,0);
 assert.equal(f.state.settlements[0].input_action,'failed');assert.equal(f.state.settlements[0].input_error_code,'SOURCE_UNSUPPORTED_ORDER_MULTIPLE');
});

test('only the exact structured field contract becomes a permanent public code; arbitrary diagnostics stay private and retryable',async t=>{
 for(const patch of [{code:undefined},{fields:['stock_qty','https://sensitive.invalid/key']},{fields:['__proto__']},
  {fields:[]},{fields:['stock_qty','stock_qty']},{sourceRowNumber:0},{sourceRowNumber:10000001}])await t.test(JSON.stringify(patch),async()=>{
  const f=fixture(csv('Stock_Qty',''));
  const failure=Object.assign(Error('SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD:raw-sensitive-value'),
   {code:'SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD',fields:['stock_qty'],sourceRowNumber:2},patch);
  await assert.rejects(f.consume({verify:async()=>{throw failure;}}));
  assert.equal(f.state.settlements[0].input_action,'retry');
  assert.equal(f.state.settlements[0].input_error_code,'SOURCE_VERIFICATION_UNCONFIRMED');
  assert(!JSON.stringify(f.state.settlements).includes('sensitive'));
 });
});

test('multiple real unsupported fields yield one deterministic allowlisted code without persisting raw source values',async()=>{
 const f=fixture('Product_Code,Buy_Price_EUR,Stock_Qty,Order_Multiple\nA,7.50,sensitive-cell,12\nB,8.50,,\n');
 assert.equal((await f.consume()).status,'rejected');
 assert.equal(f.state.settlements[0].input_error_code,'SOURCE_UNSUPPORTED_ORDER_MULTIPLE');
 assert(!JSON.stringify(f.state.settlements).includes('sensitive-cell'));assert.equal(f.state.completed,0);
});

test('foreign, incomplete or lost rejection settlement never reports a confirmed business outcome',async t=>{
 for(const patch of [{request_id:randomUUID()},{session_id:randomUUID()},{release_id:randomUUID()},
  {status:'queued'},{published:true},{lost:true}])await t.test(Object.keys(patch)[0],async()=>{
  const f=fixture(csv('Stock_Qty','0'));
  if(patch.lost)f.state.settleLost=true;else f.state.settlePatch=patch;
  await assert.rejects(f.consume());assert.equal(f.state.settlements.length,1);assert.equal(f.state.completed,0);
 });
});

test('confirmed source rejection leaves service healthy and the next actual good file is verified and dispatched',async()=>{
 const bad=fixture(csv('Stock_Qty','0')),good=fixture(csv('Stock_Qty',''));
 const logs=[];let verification=0,dispatches=0;
 const service=createWorkerService({verify:()=>verification++===0?bad.consume():good.consume(),
  dispatch:async()=>({status:++dispatches===1?'empty':'enqueued',published:false}),
  probe:async()=>({busy:false,failed:false}),log:line=>logs.push(JSON.parse(line))});
 await service.cycle();assert.equal(service.snapshot().ready,true);assert.equal(service.snapshot().errorCode,null);
 assert.equal(bad.state.status,'failed');assert.equal(bad.state.attempt,1);assert.equal(bad.state.completed,0);
 assert.equal(logs[0].errorCode,'SOURCE_UNSUPPORTED_STOCK_QTY');assert.equal(logs[0].status,'rejected');
 await service.cycle();assert.equal(service.snapshot().ready,true);assert.equal(service.snapshot().phase,'enqueued');
 assert.equal(service.snapshot().completedCycles,2);assert.equal(good.state.completed,1);assert.equal(good.state.status,'verified');
 assert.equal(dispatches,2);
});

test('service rejects malformed or unrecognized source rejection receipts',async()=>{
 for(const patch of [{errorCode:'RAW_SOURCE_VALUE'},{releaseId:'wrong'},{sessionId:null},{requestId:null},{published:true}]){
  const service=createWorkerService({verify:async()=>({status:'rejected',requestId:randomUUID(),sessionId:randomUUID(),
   releaseId:randomUUID(),errorCode:'SOURCE_UNSUPPORTED_STOCK_QTY',published:false,...patch}),
   dispatch:async()=>{throw Error('must not dispatch');},probe:async()=>({busy:false,failed:false}),log:()=>{}});
  await assert.rejects(service.cycle(),/SERVICE_VERIFICATION_RESPONSE/);assert.equal(service.snapshot().ready,false);
 }
});

test('blank fields still complete verification; checksum rejection and unknown completion keep their existing semantics',async t=>{
 await t.test('blank',async()=>{const f=fixture(csv('Stock_Qty',''));const result=await f.consume();
  assert.equal(result.status,'verified');assert.equal(f.state.completed,1);assert.equal(f.state.settlements[0].input_action,'verified');});
 await t.test('checksum',async()=>{const f=fixture(csv('Stock_Qty',''));f.state.wrongSha=true;await assert.rejects(f.consume());
  assert.equal(f.state.completed,0);assert.equal(f.state.settlements[0].input_action,'failed');assert.equal(f.state.settlements[0].input_error_code,'SOURCE_VERIFICATION_REJECTED');});
 await t.test('unknown acceptance',async()=>{const f=fixture(csv('Stock_Qty',''));f.state.failCompletion=true;await assert.rejects(f.consume());
  assert.equal(f.state.completed,1);assert.equal(f.state.settlements[0].input_action,'retry');assert.equal(f.state.settlements[0].input_error_code,'SOURCE_VERIFICATION_UNCONFIRMED');});
});
