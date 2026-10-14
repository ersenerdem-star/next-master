import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {serviceConfig,servicePreflight,serviceStartupFailure,SERVICE_RPC_NAMES,SERVICE_QUEUE_LIMITS}
  from '../../apps/engine/supplier-price-shadow/src/worker-service.mjs';
import {PRODUCTION_SUPABASE_HOST,requireProductionServiceInvocation}
  from '../../apps/engine/supplier-price-shadow/src/worker-target.mjs';
import {requireShadowStagingHost} from '../../apps/engine/supplier-price-shadow/src/shadow-batch-contract.mjs';
import {requireRecoveryTestHook} from '../../apps/engine/supplier-price-shadow/src/shadow-recovery-test-hook.mjs';
import {requireExpiryTestHook} from '../../apps/engine/supplier-price-shadow/src/shadow-expiry-test-hook.mjs';

const origin='https://'+PRODUCTION_SUPABASE_HOST;
const env={SUPABASE_URL:origin,SUPPLIER_PRICE_EXPECTED_HOST:PRODUCTION_SUPABASE_HOST,
 SUPPLIER_PRICE_TARGET_ENVIRONMENT:'production',SUPPLIER_PRICE_PRODUCTION_ENABLED:'1',
 SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_only',SUPPLIER_PRICE_EXECUTOR_ID:'supplier-price-production-01', // synthetic placeholder
 DBOS_SYSTEM_DATABASE_URL:'postgresql://nm_supplier_production_worker:example@dpg-private-production/nm_supplier_production_history',
 ...Object.fromEntries(['SUPPLIER_PRICE_SERVICE_ENABLED','SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED',
  'SUPPLIER_PRICE_VERIFIED_HANDOFF_ENABLED','SUPPLIER_PRICE_SHARED_PREPARED_ENABLED',
  'SUPPLIER_PRICE_SHADOW_PERSIST','SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED'].map(key=>[key,'1']))};
const jwt=(patch={},header={alg:'HS256',typ:'JWT'})=>[
 Buffer.from(JSON.stringify(header)).toString('base64url'),
 Buffer.from(JSON.stringify({role:'service_role',ref:'zjgueqijumzlfioihnkt',exp:4102444800,...patch})).toString('base64url'),
 'syntheticSignatureNeverAuthenticateThis',
].join('.');

test('Production service requires exact target and independent private history; execution never publishes',()=>{
 const config=serviceConfig(env);
 assert.equal(config.environment,'production');assert.equal(config.origin,origin);
 assert.equal(config.autoValidate,false);assert.equal(config.batchSize,1000);
 assert.deepEqual(SERVICE_QUEUE_LIMITS,{globalConcurrency:1,workerConcurrency:1});
 assert.equal([...SERVICE_RPC_NAMES].some(name=>/publish|activate|bootstrap|delete/.test(name)),false);
 assert.equal(serviceConfig({...env,SUPABASE_SERVICE_ROLE_KEY:jwt()}).environment,'production');
});

for(const [name,patch] of Object.entries({
 missingEnvironment:{SUPPLIER_PRICE_TARGET_ENVIRONMENT:undefined},
 missingProductionOptIn:{SUPPLIER_PRICE_PRODUCTION_ENABLED:undefined},
 disabledProductionOptIn:{SUPPLIER_PRICE_PRODUCTION_ENABLED:'0'},
 missingExpectedHost:{SUPPLIER_PRICE_EXPECTED_HOST:undefined},
 stagingExpectedHost:{SUPPLIER_PRICE_EXPECTED_HOST:'kaxsqafdevabkxofwdod.supabase.co'},
 arbitraryExpectedHost:{SUPPLIER_PRICE_EXPECTED_HOST:'arbitrary.supabase.co'},
 stagingURL:{SUPABASE_URL:'https://kaxsqafdevabkxofwdod.supabase.co'},
 arbitraryURL:{SUPABASE_URL:'https://arbitrary.supabase.co'},
 http:{SUPABASE_URL:origin.replace('https:','http:')},
 userinfo:{SUPABASE_URL:origin.replace('https://','https://user:secret@')},
 port:{SUPABASE_URL:origin+':8443'},
 path:{SUPABASE_URL:origin+'/rest/v1'},
 normalizedPath:{SUPABASE_URL:origin+'/rest/..'},
 query:{SUPABASE_URL:origin+'?other=1'},
 emptyQuery:{SUPABASE_URL:origin+'?'},
 fragment:{SUPABASE_URL:origin+'#other'},
 suffixAttack:{SUPABASE_URL:origin+'.invalid'},
 invalidEnvironment:{SUPPLIER_PRICE_TARGET_ENVIRONMENT:'live'},
 mixedStagingMode:{SUPPLIER_PRICE_TARGET_ENVIRONMENT:'staging'},
 stagingExecutor:{SUPPLIER_PRICE_EXECUTOR_ID:'supplier-price-staging-01'},
 stagingHistory:{DBOS_SYSTEM_DATABASE_URL:env.DBOS_SYSTEM_DATABASE_URL.replace('production','staging')},
 businessDatabase:{DBOS_SYSTEM_DATABASE_URL:'postgresql://nm_supplier_production_worker:example@db.zjgueqijumzlfioihnkt.supabase.co/nm_supplier_production_history'},
 SupabasePooler:{DBOS_SYSTEM_DATABASE_URL:'postgresql://nm_supplier_production_worker:example@aws-0-eu.pooler.supabase.com/nm_supplier_production_history'},
 queryHistory:{DBOS_SYSTEM_DATABASE_URL:env.DBOS_SYSTEM_DATABASE_URL+'?options=-csearch_path%3Dpublic'},
 recoveryRelease:{SUPPLIER_PRICE_OPERATOR_RECOVERY_RELEASE_ID:'00000000-0000-0000-0000-000000000000'},
 recoveryHandoff:{SUPPLIER_PRICE_OPERATOR_RECOVERY_HANDOFF_ID:'00000000-0000-0000-0000-000000000000'},
 recoveryHook:{SUPPLIER_PRICE_RECOVERY_TEST_PAUSE_AFTER_STAGE:'1'},
 expiryHook:{SUPPLIER_PRICE_EXPIRY_TEST_ROLE:'a'},
 expiryPause:{SUPPLIER_PRICE_EXPIRY_TEST_PAUSE:'0'},
 localPartition:{SUPPLIER_PRICE_SHADOW_PARTITION_MANIFEST:'/tmp/synthetic'},
 drain:{SUPPLIER_PRICE_SHADOW_DRAIN:'1'},
}))test('Production refuses '+name+' before intake',()=>assert.throws(()=>serviceConfig({...env,...patch})));

for(const [name,key] of Object.entries({publicKey:'sb_publishable_synthetic',missingKey:'',
 stagingLegacyKey:jwt({ref:'kaxsqafdevabkxofwdod'}),anonLegacyKey:jwt({role:'anon'}),
 noProjectClaim:jwt({ref:undefined}),expiredLegacyKey:jwt({exp:1}),
 unsignedLegacyKey:jwt({}, {alg:'none'}),malformedLegacyKey:'eyJ.synthetic.signature'}))
 test('Production refuses '+name,()=>assert.throws(()=>serviceConfig({...env,SUPABASE_SERVICE_ROLE_KEY:key})));

test('Both staging targets still use isolated config; supplied env controls expected host',()=>{
 for(const host of ['ztzxxogozgaojgabnvpg.supabase.co','kaxsqafdevabkxofwdod.supabase.co']) {
  const staging={...env,SUPABASE_URL:'https://'+host,SUPPLIER_PRICE_EXPECTED_HOST:host,
   SUPPLIER_PRICE_TARGET_ENVIRONMENT:undefined,SUPPLIER_PRICE_PRODUCTION_ENABLED:undefined,
   SUPPLIER_PRICE_EXECUTOR_ID:'supplier-price-staging-01',
   DBOS_SYSTEM_DATABASE_URL:'postgresql://worker:example@private.invalid/history'};
  assert.equal(serviceConfig(staging).environment,'staging');
  assert.throws(()=>serviceConfig({...staging,SUPPLIER_PRICE_EXPECTED_HOST:PRODUCTION_SUPABASE_HOST}));
 }
});

test('Production activation never expands staging fixtures or their recovery/expiry hooks',()=>{
 assert.throws(()=>requireShadowStagingHost(origin,PRODUCTION_SUPABASE_HOST),/STAGING_HOST_REQUIRED/);
 assert.throws(()=>requireRecoveryTestHook({enabled:true,releaseId:'synthetic',supabaseUrl:origin,canSend:true}),/STAGING_HOST_REQUIRED/);
 assert.throws(()=>requireExpiryTestHook({role:'a',releaseId:'synthetic',supabaseUrl:origin,canSend:true}),/STAGING_HOST_REQUIRED/);
 for(const argument of [undefined,'--operator-recover','--verified-handoff','--check-only','00000000-0000-0000-0000-000000000000'])
  assert.throws(()=>requireProductionServiceInvocation(env,argument),/PRODUCTION_SERVICE_REQUIRED/);
 assert.doesNotThrow(()=>requireProductionServiceInvocation(env,'--service'));
});

test('Production read-only privilege probe requires the real manifest exception; headers respect key format',async()=>{
 for(const key of [env.SUPABASE_SERVICE_ROLE_KEY,jwt()]) {
  let called=0;
  await servicePreflight({origin,key,environment:'production',fetchImpl:async(url,options)=>{
   called++;assert.equal(url,origin+'/rest/v1/rpc/get_supplier_price_verified_manifest');
   assert.equal(options.redirect,'error');assert.equal(options.headers.apikey,key);
   assert.equal(options.headers.Authorization,key.startsWith('sb_secret_')?undefined:'Bearer '+key);
   assert.deepEqual(JSON.parse(options.body),{input_release_id:'00000000-0000-0000-0000-000000000000',
    input_handoff_id:'00000000-0000-0000-0000-000000000000'});
   return {status:400,json:async()=>({code:'P0001',message:'UPLOAD_HANDOFF_NOT_READY'})};
  }});assert.equal(called,1);
 }
});

test('Missing migration, public-role denial, wrong key and generic HTTP400 cannot satisfy production capability',async()=>{
 for(const [status,data] of [[404,{code:'PGRST202'}],[400,{code:'P0001',message:'UPLOAD_VERIFY_ROLE'}],
  [400,{code:'P0001',message:'unrelated validation'}],[400,{code:'PGRST116',message:'not found'}],
  [200,{}],[401,{message:'Invalid API key'}],[403,{}],[500,{code:'P0001',message:'UPLOAD_HANDOFF_NOT_READY'}]])
  await assert.rejects(servicePreflight({origin,key:'synthetic',environment:'production',
   fetchImpl:async()=>({status,json:async()=>data})}),/CAPABILITY/);
});

test('Privilege probe sends no credential to malformed or mixed target',async()=>{
 for(const badOrigin of [origin+'/rest/v1',origin+'/rest/..',origin+'?x=1',origin+'#x',
  origin.replace('https:','http:'),origin.replace('https://','https://user:secret@'),
  'https://kaxsqafdevabkxofwdod.supabase.co','https://arbitrary.supabase.co']) {
  let fetched=false;
  await assert.rejects(servicePreflight({origin:badOrigin,key:'synthetic',environment:'production',
   fetchImpl:async()=>{fetched=true;throw Error('Never fetch');}}));
  assert.equal(fetched,false);
 }
});

test('Actual production operator and missing-opt-in service invocations exit before DBOS/network',()=>{
 for(const [argument,patch,expected] of [['--operator-recover',{},'SERVICE_PRODUCTION_SERVICE_REQUIRED'],
  ['--service',{SUPPLIER_PRICE_PRODUCTION_ENABLED:undefined},'SERVICE_OPT_IN_REQUIRED']]) {
  assert.throws(()=>execFileSync(process.execPath,['apps/engine/supplier-price-shadow/src/worker.mjs',argument],{
   encoding:'utf8',env:{PATH:process.env.PATH,...env,...patch},stdio:'pipe',timeout:5000}),error=>{
    assert.equal(error.status,1);assert.match(String(error.stderr),new RegExp(expected));
    assert.doesNotMatch(String(error.stderr)+String(error.stdout),/sb_secret_synthetic_only|Initializing DBOS|dpg-private-production/);
    return true;
   });
 }
 const diagnostic=serviceStartupFailure(Object.assign(Error('SERVICE_OPT_IN_REQUIRED'),{configKey:'SUPPLIER_PRICE_PRODUCTION_ENABLED'}));
 assert.equal(diagnostic.configKey,'SUPPLIER_PRICE_PRODUCTION_ENABLED');assert.equal(diagnostic.published,false);
});

test('Unapplied production Blueprint has dedicated private history and gates; staging auto-deploy remains unchanged',()=>{
 const production=parse(readFileSync('apps/engine/supplier-price-shadow/render.production.yaml','utf8'));
 const staging=parse(readFileSync('apps/engine/supplier-price-shadow/render.staging.yaml','utf8'));
 const worker=production.services[0],db=production.databases[0];
 const vars=Object.fromEntries(worker.envVars.map(entry=>[entry.key,entry]));
 assert.equal(production.previews.generation,'off');assert.equal(worker.type,'worker');
 assert.equal(worker.numInstances,1);assert.equal(worker.autoDeployTrigger,'off');
 assert.equal(vars.SUPABASE_URL.value,origin);assert.equal(vars.SUPPLIER_PRICE_TARGET_ENVIRONMENT.value,'production');
 for(const name of ['SUPABASE_SERVICE_ROLE_KEY','SUPPLIER_PRICE_PRODUCTION_ENABLED','SUPPLIER_PRICE_SERVICE_ENABLED','SUPPLIER_PRICE_SERVICE_HISTORY_CONFIRMED']) {
  assert.equal(vars[name].sync,false);assert.equal(vars[name].value,undefined);
 }
 assert.equal(vars.DBOS_SYSTEM_DATABASE_URL.fromDatabase.name,db.name);
 assert.equal(vars.DBOS_SYSTEM_DATABASE_URL.fromDatabase.property,'connectionString');
 assert.equal(db.databaseName,'nm_supplier_production_history');assert.equal(db.user,'nm_supplier_production_worker');
 assert.deepEqual(db.ipAllowList,[]);assert.equal(db.storageAutoscalingEnabled,false);
 assert.notEqual(db.name,staging.databases[0].name);assert.notEqual(worker.name,staging.services[0].name);
 assert.equal(staging.services[0].autoDeployTrigger,'commit');
 assert.equal(staging.services[0].branch,'codex/supplier-price-render-staging');
 assert.equal(staging.services[0].envVars.some(entry=>entry.key==='SUPPLIER_PRICE_PRODUCTION_ENABLED'),false);
});
