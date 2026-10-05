import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {serviceConfig,servicePreflight,serviceLogger,serviceStartupFailure,createWorkerService,startServiceHealth,SERVICE_QUEUE_LIMITS,SERVICE_RPC_NAMES}
  from '../../apps/engine/supplier-price-shadow/src/worker-service.mjs';

const env={SUPABASE_URL:'https://ztzxxogozgaojgabnvpg.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_only',
  SUPPLIER_PRICE_EXECUTOR_ID:'supplier-price-staging-01',DBOS_SYSTEM_DATABASE_URL:'postgresql://worker:synthetic@private.invalid/history',
  ...Object.fromEntries(['SUPPLIER_PRICE_SERVICE_ENABLED','SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED',
    'SUPPLIER_PRICE_VERIFIED_HANDOFF_ENABLED','SUPPLIER_PRICE_SHARED_PREPARED_ENABLED','SUPPLIER_PRICE_SHADOW_PERSIST',
    'SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED'].map(k=>[k,'1']))};
test('Operational config retains exact staging, stable identity, bounded execution and no publication RPC',()=>{
 const c=serviceConfig(env);assert.equal(c.batchSize,1000);assert.equal(c.port,3000);
 assert.equal(c.executorId,env.SUPPLIER_PRICE_EXECUTOR_ID);assert.equal(c.shutdownMs,20000);
 assert.deepEqual(SERVICE_QUEUE_LIMITS,{globalConcurrency:1,workerConcurrency:1});
 assert.equal([...SERVICE_RPC_NAMES].some(x=>/publish|activate|delete|bootstrap|close/.test(x)),false);
});
for(const [name,patch] of Object.entries({production:{SUPABASE_URL:'https://zjgueqijumzlfioihnkt.supabase.co'},
  extraPath:{SUPABASE_URL:env.SUPABASE_URL+'/rest/v1'},query:{SUPABASE_URL:env.SUPABASE_URL+'?other=1'},
  credentials:{SUPABASE_URL:'https://user:secret@ztzxxogozgaojgabnvpg.supabase.co'},noKey:{SUPABASE_SERVICE_ROLE_KEY:''},
  publicKey:{SUPABASE_SERVICE_ROLE_KEY:'sb_publishable_fake'},historyUnconfirmed:{SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED:'0'},
  noExecutor:{SUPPLIER_PRICE_EXECUTOR_ID:''},pidExecutor:{SUPPLIER_PRICE_EXECUTOR_ID:'dbos-shadow:123'},
  missingHistory:{DBOS_SYSTEM_DATABASE_URL:''},prodHistory:{DBOS_SYSTEM_DATABASE_URL:'postgresql://x:y@db.zjgueqijumzlfioihnkt.supabase.co/postgres'},
  noHistoryPassword:{DBOS_SYSTEM_DATABASE_URL:'postgresql://worker@private.invalid/history'},
  excessiveBatch:{SUPPLIER_PRICE_SHADOW_BATCH_SIZE:'10000'},nanBatch:{SUPPLIER_PRICE_SHADOW_BATCH_SIZE:'bad'},
  expectedFixture:{SUPPLIER_PRICE_EXPECTED_RELEASE_ID:'fixture'},localManifest:{SUPPLIER_PRICE_SHADOW_PARTITION_MANIFEST:'/tmp/manifest'},
  recoveryHook:{SUPPLIER_PRICE_RECOVERY_TEST_PAUSE_AFTER_STAGE:'1'},expiryHook:{SUPPLIER_PRICE_EXPIRY_TEST_ROLE:'a'},
  badPort:{PORT:'-1'}}))test('Refuse '+name+' before intake',()=>assert.throws(()=>serviceConfig({...env,...patch})));
for(const name of Object.keys(env).filter(x=>env[x]==='1'))test('Default off without '+name,()=>assert.throws(()=>serviceConfig({...env,[name]:undefined})));
test('Exact privilege preflight is non-mutating; generic HTTP errors/200 cannot pass',async()=>{
 let called=0;
 await servicePreflight({origin:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl:async(url,opts)=>{
  called++;assert.ok(url.endsWith('/inspect_supplier_price_staging_fixture'));assert.equal(opts.redirect,'error');
  assert.deepEqual(JSON.parse(opts.body),{input_run_id:'00000000-0000-0000-0000-000000000000'});
  return {status:400,json:async()=>({message:'STAGING_FIXTURE_NOT_FOUND'})};
 }});assert.equal(called,1);
 for(const status of [200,401,403,429,500])await assert.rejects(servicePreflight({origin:env.SUPABASE_URL,key:'synthetic',
  fetchImpl:async()=>({status,json:async()=>({message:'STAGING_FIXTURE_NOT_FOUND'})})}),/CAPABILITY/);
 await assert.rejects(servicePreflight({origin:env.SUPABASE_URL,key:'synthetic',
  fetchImpl:async()=>({status:400,json:async()=>({message:'Invalid API key'})})}),/CAPABILITY/);
});
const empty={status:'empty',published:false};
test('Startup diagnosis identifies only known guard codes and nonsecret opt-in names',()=>{
 try{serviceConfig({...env,SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED:'0'});}catch(error){
  assert.deepEqual(serviceStartupFailure(error),{stage:'worker-service',status:'startup-failed',
   errorCode:'SERVICE_OPT_IN_REQUIRED',configKey:'SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED',published:false});
 }
 assert.equal(serviceStartupFailure(Error('SERVICE_CAPABILITY_NOT_CONFIRMED')).errorCode,'SERVICE_CAPABILITY_NOT_CONFIRMED');
});
test('Unknown startup diagnostics cannot leak secret-bearing messages, stacks or config values',()=>{
 for(const message of ['sb_secret_private','postgresql://worker:password@host/history','SERVICE_sb_secret_private']){
  const diagnostic=serviceStartupFailure(Object.assign(Error(message),{configKey:'sb_secret_private',stack:'private stack'}));
  assert.equal(diagnostic.errorCode,'SERVICE_STARTUP_UNCONFIRMED');
  assert.doesNotMatch(JSON.stringify(diagnostic),/private|password|postgresql/);
 }
 assert.equal(serviceStartupFailure({message:'SERVICE_OPT_IN_REQUIRED',configKey:'SUPABASE_SERVICE_ROLE_KEY'}).configKey,undefined);
});
const setup=(overrides={})=>createWorkerService({verify:async()=>empty,dispatch:async()=>empty,
 probe:async()=>({busy:false,failed:false}),...overrides});
test('Same verifier then same outbox; ACK remains enqueued, not staged/published',async()=>{
 const calls=[];const s=setup({verify:async()=>{calls.push('verify');return {status:'verified',published:false};},
 dispatch:async()=>{calls.push('dispatch');return {status:'enqueued',published:false};}});
 await s.cycle();assert.deepEqual(calls,['verify','dispatch']);assert.equal(s.snapshot().phase,'enqueued');
 assert.equal(s.snapshot().ready,true);assert.equal(s.snapshot().published,false);
});
test('Recovered work applies backpressure before any new source parse/admission',async()=>{
 let calls=0;const s=setup({probe:async()=>({busy:true,failed:false}),verify:async()=>{calls++;},dispatch:async()=>{calls++;}});
 await s.cycle();assert.equal(calls,0);assert.equal(s.snapshot().phase,'processing');
});
test('Failed durable execution requires review, not automatic replay/reset',async()=>{
 let calls=0;const s=setup({probe:async()=>({busy:false,failed:true}),verify:async()=>{calls++;}});
 await assert.rejects(s.cycle(),/REQUIRES_REVIEW/);assert.equal(calls,0);assert.equal(s.snapshot().ready,false);
});
test('Malformed or falsely published response fails closed',async()=>{
 for(const status of ['empty','verified','published']) {
  let dispatched=false;const s=setup({verify:async()=>({status,published:true}),dispatch:async()=>{dispatched=true;return empty;}});
  await assert.rejects(s.cycle(),/VERIFICATION_RESPONSE/);assert.equal(dispatched,false);
 }
});
test('Shutdown during verify prohibits subsequent dispatch; no profile/object cleanup',async()=>{
 let s,dispatched=false;s=setup({verify:async()=>{s.stop();return empty;},dispatch:async()=>{dispatched=true;return empty;}});
 await s.cycle();assert.equal(dispatched,false);assert.equal(s.snapshot().ready,false);assert.equal(s.snapshot().stopping,true);
});
test('Continuous loop contains outage, backs off, recovers, stops; raw data not logged',async()=>{
 let probes=0,waits=0;const logs=[];let s;
 s=setup({probe:async()=>{if(++probes===1)throw Error('sb_secret_private customer price=99');return {busy:false,failed:false};},
  log:x=>logs.push(x),wait:async()=>{if(++waits===2)s.stop();}});
 await s.run();assert.equal(probes,2);assert.equal(waits,2);assert.equal(s.snapshot().completedCycles,1);
 assert.equal(s.snapshot().phase,'stopped');assert.ok(logs[0].includes('WORKER_CYCLE_UNCONFIRMED'));
 assert.doesNotMatch(logs.join(''),/private|price=99/);
});
test('Stop interrupts idle wait immediately; no second claim',async()=>{
 let s,waits=0;s=setup({wait:async(_ms,_value,{signal})=>{
  waits++;s.stop();signal.throwIfAborted();
 }});await s.run();assert.equal(waits,1);assert.equal(s.snapshot().completedCycles,1);
});
test('SDK logging never passes connection URLs, SQL bodies, price data or metadata stacks',()=>{
 const logs=[];const logger=serviceLogger(x=>logs.push(x));
 for(const level of ['debug','info','warn','error'])logger[level]('postgres://worker:secret@host sb_secret_hidden price=99',{stack:'private stack'});
 assert.equal(logs.length,2);assert.doesNotMatch(logs.join(''),/secret|postgres|price=99|private stack/);
});
test('Actual HTTP probes are private-data-free and distinguish readiness from process liveness',async()=>{
 const s=setup();
 // Port zero is allowed only on this test helper; operational config rejects it.
 const close=await startServiceHealth({service:s,port:0,host:'127.0.0.1'}),port=close.port;
 try{
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status,503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
  await s.cycle();const ready=await fetch(`http://127.0.0.1:${port}/readyz`);assert.equal(ready.status,200);
  assert.deepEqual(await ready.json(),{status:'ok',phase:'idle',published:false});
  assert.equal((await fetch(`http://127.0.0.1:${port}/control`,{method:'POST'})).status,405);
  assert.equal((await fetch(`http://127.0.0.1:${port}/unknown`)).status,404);
  s.stop();assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,503);
 }finally{await close();}
});
test('Actual worker service invocation without opt-ins exits before DBOS/network and conceals secret',()=>{
 assert.throws(()=>execFileSync(process.execPath,['apps/engine/supplier-price-shadow/src/worker.mjs','--service'],{
  encoding:'utf8',env:{PATH:process.env.PATH,SUPABASE_URL:env.SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY:'sb_secret_not_to_log'},
  stdio:'pipe',timeout:5000}),error=>{
   assert.equal(error.status,1);assert.match(String(error.stderr),/No publication enabled/);
   assert.doesNotMatch(String(error.stderr)+String(error.stdout),/sb_secret_not_to_log|Initializing DBOS/);return true;
 });
});
