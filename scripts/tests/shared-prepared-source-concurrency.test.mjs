import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import ExcelJS from 'exceljs';
import {createSharedPreparedSource,PREPARED_BUCKET,validateSharedPreparedManifest}
 from '../../apps/engine/supplier-price-shadow/src/shared-prepared-source.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function waitFor(predicate){
 const until=Date.now()+5000;
 while(!predicate()){if(Date.now()>until)throw Error('TEST_CONDITION_TIMEOUT');await delay(5);}
}
function streamed(bytes,onRead=()=>{}){
 return new Response(Readable.toWeb(Readable.from((async function*(){
  // Non-aligned chunks exercise exact comparison across arbitrary boundaries.
  for(let offset=0;offset<bytes.length;offset+=37)yield bytes.subarray(offset,offset+37);
  onRead();
 })())));
}
function fixture({count=12,latency=0,sourceBytes,sourceExtension='csv'}={}){
 const csv=sourceBytes||Buffer.from('Product_Code,Buy_Price_EUR,Price_Date\n'+
  Array.from({length:count},(_,i)=>`CODE${i+1},10.50,2026-10-14\n`).join(''));
 const release={id:randomUUID(),handoff_id:randomUUID(),source_file_path:randomUUID()+'/source.'+sourceExtension,
  source_file_sha256:sha(csv),source_file_bytes:csv.length,total_rows:count,source_date:'2026-10-14'};
 const storage=new Map(),events=[],active=new Set(),readBacks=new Set();
 const state={maxActive:0,hook:null,firstPartAt:null,lastPartReadAt:null,sourceReads:0,compatibilityCalls:[],compatibilityHook:null};
 const fetchImpl=async(url,options={})=>{
  const path=decodeURIComponent(new URL(url).pathname),method=options.method||'GET';
  if(path===`/storage/v1/bucket/${PREPARED_BUCKET}`)return Response.json({id:PREPARED_BUCKET,public:false});
  if(path===`/storage/v1/object/supplier-price-imports/${release.source_file_path}`)return streamed(csv,()=>{state.sourceReads++;});
  if(path==='/rest/v1/rpc/record_supplier_price_source_compatibility'){
   assert.equal(method,'POST');assert.ok(state.sourceReads>0,'receipt requires a complete source read');
   const payload=JSON.parse(options.body);state.compatibilityCalls.push(payload);
   assert.deepEqual(payload,{input_release_id:release.id,input_handoff_id:release.handoff_id,
    input_source_sha256:release.source_file_sha256,input_total_rows:release.total_rows,
    input_policy:'supplier-price-commercial-fields-v1'});
   const overridden=await state.compatibilityHook?.(payload);if(overridden)return overridden;
   return Response.json({status:state.compatibilityCalls.length===1?'recorded':'replayed',
    release_id:payload.input_release_id,source_sha256:payload.input_source_sha256,
    total_rows:payload.input_total_rows,policy:payload.input_policy});
  }
  const prefix=`/storage/v1/object/${PREPARED_BUCKET}/`;
  assert.ok(path.startsWith(prefix),'only the intended private bucket is used');
  const key=path.slice(prefix.length),part=Number(/\/part-(\d+)-/.exec(key)?.[1]||0);
  const event={key,part,method};events.push(event);
  if(part){
   state.firstPartAt??=performance.now();
   if(method==='GET'&&!active.has(part)){active.add(part);state.maxActive=Math.max(state.maxActive,active.size);}
   if(latency)await delay(latency);
  }
  const overridden=await state.hook?.({...event,options,storage});
  if(overridden)return overridden;
  if(method==='POST'){
   assert.equal(options.headers['x-upsert'],'false');
   assert.equal(storage.has(key),false,'immutable object must not be overwritten');
   if(!part){
    assert.equal(readBacks.size,count,'ready marker waits for all exact part readbacks');
    assert.equal(active.size,0,'ready marker waits for all workers');
   }
   storage.set(key,Buffer.from(options.body));
   return Response.json({Key:key});
  }
  assert.equal(method,'GET');
  if(!storage.has(key))return Response.json({message:'Object not found'},{status:404});
  return streamed(storage.get(key),()=>{
   if(part){active.delete(part);readBacks.add(part);state.lastPartReadAt=performance.now();}
  });
 };
 const source=createSharedPreparedSource({supabaseUrl:'https://staging.example.invalid',
  serviceRoleKey:'sb_secret_synthetic_only',fetchImpl});
 return {release,csv,storage,events,state,source,readBacks,
  prepare:()=>source.prepare({release,batchSize:1})};
}
async function ownedDirectory(releaseId){
 for(const entry of await readdir(tmpdir())){
  if(!entry.startsWith('supplier-price-shared-'))continue;
  const directory=join(tmpdir(),entry);
  try{if(JSON.parse(await readFile(join(directory,'parts','manifest.json'),'utf8')).release_id===releaseId)return directory;}
  catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
 }
 return null;
}

test('four bounded uploads preserve hashes and publish readiness only after every exact readback',{timeout:15000},async t=>{
 const count=16,latency=15,f=fixture({count,latency});
 const receipt=await f.prepare();
 assert.equal(f.state.maxActive,4);
 assert.equal(f.events.filter(e=>e.part&&e.method==='POST').length,count);
 const manifest=JSON.parse(f.storage.get(receipt.key));
 validateSharedPreparedManifest(manifest,f.release,1);
 assert.equal(manifest.contract,'supplier-price-normalized-parts-v2');
 assert.equal(sha(f.storage.get(receipt.key)),receipt.sha256);
 for(const part of manifest.partitions){
  assert.equal(sha(f.storage.get(receipt.key.replace('manifest.json',part.path))),part.sha256);
 }
 assert.equal(f.events.filter(e=>e.method==='POST').at(-1).key,receipt.key);
 const duration=f.state.lastPartReadAt-f.state.firstPartAt;
 t.diagnostic(JSON.stringify({scope:'local simulated request latency, not real network throughput',
  parts:count,delayPerRequestMs:latency,requestsPerNewPart:3,serialDelayFloorMs:count*3*latency,
  boundedFourPartPhaseMs:Math.round(duration),simulatedSpeedup:Number((count*3*latency/duration).toFixed(2))}));
 const result=await f.source.scan({release:f.release,batchSize:1,receipt,claim:{cursor_start:16,cursor_end:16}});
 assert.equal(result.rows[0].normalized_code,'CODE16');
 assert.equal(result.acceptedRows,1);assert.equal(result.checksum,f.release.source_file_sha256);
 assert.equal(await ownedDirectory(f.release.id),null);
});

test('failure stops new work, settles inflight before cleanup, and restart reuses exact immutable parts',{timeout:15000},async()=>{
 const f=fixture(),hold=deferred();let held=0,failedRead=false,settled=false;
 f.state.hook=async({part,method,storage,key})=>{
  if(!part)return;
  if(method==='POST'){
   if(part===1)return Response.json({message:'denied'},{status:403});
   if(part<=4){held++;await hold.promise;}
  }
  if(part===1&&method==='GET'&&f.events.some(e=>e.part===1&&e.method==='POST'))failedRead=true;
 };
 const outcome=f.prepare().then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
 let directory;
 try{
  await waitFor(()=>held===3&&failedRead);
  await delay(20);
  assert.equal(settled,false,'inflight uploads must settle before prepare rejects');
  assert.ok(f.events.filter(e=>e.part).every(e=>e.part<=4),'nothing assigned after the failure');
  assert.equal(f.events.some(e=>!e.part&&e.method==='POST'),false);
  directory=await ownedDirectory(f.release.id);assert.ok(directory);
  assert.equal((await stat(directory)).isDirectory(),true,'owned files remain while uploads are inflight');
 }finally{hold.resolve();}
 const result=await outcome;
 assert.match(result.error?.message||'',/SHARED_PREPARED_UPLOAD_FAILED:403/);
 await assert.rejects(stat(directory),{code:'ENOENT'});
 assert.equal(f.storage.size,3);assert.equal(f.events.some(e=>!e.part&&e.method==='POST'),false);
 const firstObjects=new Map([...f.storage].map(([key,bytes])=>[key,Buffer.from(bytes)]));
 const split=f.events.length;f.state.hook=null;
 const receipt=await f.prepare();
 const retryPosts=f.events.slice(split).filter(e=>e.method==='POST');
 for(const [key,bytes] of firstObjects){
  assert.equal(retryPosts.some(e=>e.key===key),false,'restart must reuse the confirmed object');
  assert.deepEqual(f.storage.get(key),bytes);
 }
 assert.equal(retryPosts.filter(e=>e.part).length,9);
 assert.equal(retryPosts.at(-1).key,receipt.key);
 assert.equal(await ownedDirectory(f.release.id),null);
});

test('an existing unequal part fails closed without overwriting or a ready marker',{timeout:15000},async()=>{
 const f=fixture({count:8});let conflictKey;
 f.state.hook=({part,method,key,storage})=>{
  if(part===1&&method==='GET'&&!conflictKey){conflictKey=key;storage.set(key,Buffer.from('different existing bytes\n'));}
 };
 await assert.rejects(f.prepare(),/SHARED_PREPARED_IMMUTABLE_CONFLICT/);
 assert.equal(f.events.some(e=>e.key===conflictKey&&e.method==='POST'),false);
 assert.equal(f.events.some(e=>!e.part&&e.method==='POST'),false);
 assert.equal(f.storage.get(conflictKey).toString(),'different existing bytes\n');
 assert.equal(await ownedDirectory(f.release.id),null);
});

test('a same-length corrupt upload readback prevents readiness',{timeout:15000},async()=>{
 const f=fixture({count:8});let corruptKey;
 f.state.hook=({part,method,key,storage,options})=>{
  if(part===1&&method==='POST'){
   const corrupt=Buffer.from(options.body);corrupt[41]^=1;
   storage.set(key,corrupt);corruptKey=key;
   return Response.json({Key:key});
  }
 };
 await assert.rejects(f.prepare(),/SHARED_PREPARED_READBACK_MISMATCH/);
 assert.ok(corruptKey);
 assert.equal(f.events.filter(e=>e.key===corruptKey&&e.method==='POST').length,1);
 assert.equal(f.events.some(e=>!e.part&&e.method==='POST'),false);
 assert.equal(await ownedDirectory(f.release.id),null);
});

test('ambiguous accepted uploads recover by exact readback; cached readiness still rescans the original and replays its receipt',{timeout:15000},async()=>{
 const f=fixture({count:8});let ambiguous=false,retried=false;
 f.state.hook=({part,method,key,storage,options})=>{
  if(part===2&&method==='GET'&&!retried){retried=true;return Response.json({message:'retry'},{status:503});}
  if(part===1&&method==='POST'&&!ambiguous){
   ambiguous=true;storage.set(key,Buffer.from(options.body));
   throw Object.assign(Error('connection reset after acceptance'),{code:'ECONNRESET'});
  }
 };
 const receipt=await f.prepare();
 assert.equal(ambiguous,true);assert.equal(retried,true);
 assert.equal(f.events.filter(e=>e.part===1&&e.method==='POST').length,1);
 const split=f.events.length;
 const replay=await f.prepare();
 assert.deepEqual(replay,receipt);
 assert.equal(f.events.slice(split).some(e=>e.method==='POST'),false);
 assert.equal(f.events.slice(split).some(e=>e.part),false);
 assert.equal(f.state.sourceReads,2);
 assert.equal(f.state.compatibilityCalls.length,2);
 assert.deepEqual(f.state.compatibilityCalls[0],f.state.compatibilityCalls[1]);
 assert.equal(await ownedDirectory(f.release.id),null);
});

test('unsupported last-row commercial value cannot produce a compatibility receipt or prepared artifact',async()=>{
 const f=fixture({count:2,sourceBytes:Buffer.from('Product_Code,Buy_Price_EUR,Price_Date,Order Multiple\nA,10.50,2026-10-14,\nB,11.50,2026-10-14,0\n')});
 await assert.rejects(f.prepare(),error=>error.code==='SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD'
  &&error.sourceRowNumber===2&&error.fields.join(',')==='order_multiple');
 assert.equal(f.state.sourceReads,1);
 assert.equal(f.state.compatibilityCalls.length,0);
 assert.equal(f.storage.size,0);
});

test('original XLSX full scan records a bound receipt only when every commercial field is empty',async()=>{
 const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Prices');
 sheet.addRows([['Product_Code','Buy_Price_EUR','Price_Date','Stock Quantity'],
  ['A',10.5,'2026-10-14',''],['B',11.5,'2026-10-14','']]);
 const allowed=fixture({count:2,sourceExtension:'xlsx',sourceBytes:Buffer.from(await book.xlsx.writeBuffer())});
 await allowed.prepare();assert.equal(allowed.state.compatibilityCalls.length,1);
 sheet.getCell('D3').value=0;
 const blocked=fixture({count:2,sourceExtension:'xlsx',sourceBytes:Buffer.from(await book.xlsx.writeBuffer())});
 await assert.rejects(blocked.prepare(),error=>error.code==='SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD'&&error.sourceRowNumber===2);
 assert.equal(blocked.state.sourceReads,1);assert.equal(blocked.state.compatibilityCalls.length,0);assert.equal(blocked.storage.size,0);
});

test('source hash, total rows and business validation are checked before any compatibility receipt',async t=>{
 for(const kind of ['hash','count','validation'])await t.test(kind,async()=>{
  const f=kind==='validation'?fixture({count:1,sourceBytes:Buffer.from('Product_Code,Buy_Price_EUR,Price_Date\nA,0,2026-10-14\n')}):fixture({count:1});
  if(kind==='hash')f.release.source_file_sha256='a'.repeat(64);
  if(kind==='count')f.release.total_rows=2;
  await assert.rejects(f.prepare());
  assert.equal(f.state.compatibilityCalls.length,0);assert.equal(f.storage.size,0);
 });
});

test('unknown receipt outcome stops preparation; recovery rescans and reuses the exact immutable request',async()=>{
 const f=fixture({count:1});
 f.state.compatibilityHook=()=>{throw Error('synthetic lost response after receipt acceptance');};
 await assert.rejects(f.prepare(),/SHARED_PREPARED_SOURCE_COMPATIBILITY_UNCONFIRMED/);
 assert.equal(f.storage.size,0);assert.equal(f.state.compatibilityCalls.length,1);
 f.state.compatibilityHook=null;
 await f.prepare();
 assert.equal(f.state.sourceReads,2);
 assert.deepEqual(f.state.compatibilityCalls[1],f.state.compatibilityCalls[0]);
});

test('a successful HTTP response with a foreign or incomplete compatibility receipt fails closed',async t=>{
 for(const mutation of [{release_id:randomUUID()},{source_sha256:'b'.repeat(64)},
  {total_rows:2},{policy:'old-policy'},{status:'queued'}])await t.test(Object.keys(mutation)[0],async()=>{
   const f=fixture({count:1});
   f.state.compatibilityHook=payload=>Response.json({status:'recorded',release_id:payload.input_release_id,
    source_sha256:payload.input_source_sha256,total_rows:payload.input_total_rows,policy:payload.input_policy,...mutation});
   await assert.rejects(f.prepare(),/SHARED_PREPARED_SOURCE_COMPATIBILITY_UNCONFIRMED/);
   assert.equal(f.storage.size,0);
  });
});
