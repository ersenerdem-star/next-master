import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {build} from 'esbuild';
import appRpc from '../../netlify/functions/app-rpc.mts';
import {SUPPLIER_LEGACY_IMPORT_COLUMNS,legacySupplierImportTelemetry,loadLegacySupplierOperations,legacyCustomerPriceReadiness} from '../../apps/web/src/shared/supplierLegacyImportStatus.ts';

const baseline=JSON.parse(await readFile(new URL('./fixtures/price-engine-full-replay-production-source.json',import.meta.url),'utf8'));
const run={status:'running',error_message:null,finalize_error_message:null,finalized_at:null,finished_at:null,superseded_by:null};

// Exercise the real gateway client and its real user-message sanitizer; only
// Auth and HTTP are fixtures. Hand-built Errors missed this boundary before.
const bundled=await build({entryPoints:[new URL('../../apps/web/src/infrastructure/api/appRpcApi.ts',import.meta.url).pathname],
 bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'fixture-auth',setup(b){
  b.onResolve({filter:/^\.\/supabaseClient$/},()=>({path:'auth',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const supabaseClient={auth:{getSession:async()=>({data:{session:{access_token:"fixture-token"}},error:null})}};',loader:'js'}));
 }}]});
const actualRpc=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
async function withRpcResponse<T>(status:number,body:unknown,fn:(load:()=>Promise<unknown>)=>Promise<T>){
 const previousFetch=globalThis.fetch,previousWindow=(globalThis as any).window;
 const pending:Promise<unknown>[]=[];
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'/api/app-rpc');
  assert.deepEqual(JSON.parse(String(options?.body)),{name:'get_latest_supplier_price_rollup_refresh_run',args:{}});
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 };
 (globalThis as any).window={setTimeout,clearTimeout};
 try{return await fn(()=>{const request=actualRpc.callAppRpc('get_latest_supplier_price_rollup_refresh_run');pending.push(request);return request;});}
 finally{await Promise.allSettled(pending);globalThis.fetch=previousFetch;(globalThis as any).window=previousWindow;}
}

async function withActualGateway<T>(options:{role?:string;status?:number;code?:string;denyProfile?:boolean;rpcName?:string},fn:(load:()=>Promise<unknown>,envelopes:any[],reads:string[])=>Promise<T>){
 const previousFetch=globalThis.fetch,previousWindow=(globalThis as any).window,previousNetlify=(globalThis as any).Netlify;
 const pending:Promise<unknown>[]=[],envelopes:any[]=[],reads:string[]=[];
 const rpcName=options.rpcName||'get_latest_supplier_price_rollup_refresh_run';
 const env={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-service'};
 (globalThis as any).Netlify={env:{get:(key:keyof typeof env)=>env[key]}};
 (globalThis as any).window={setTimeout,clearTimeout};
 globalThis.fetch=async(input,init)=>{
  if(input==='/api/app-rpc'){
   const response=await appRpc(new Request('https://fixture.invalid/api/app-rpc',init),{} as any);
   envelopes.push({status:response.status,body:await response.clone().json()});return response;
  }
  const url=new URL(String(input));reads.push(url.pathname);
  assert.equal(url.origin,'https://fixture.supabase.co');
  if(url.pathname==='/auth/v1/user')return Response.json({id:'admin-1'});
  if(url.pathname==='/rest/v1/profiles'){
   if(options.denyProfile)return Response.json({code:'42501',message:'permission denied for table profiles'},{status:403});
   return Response.json([{organization_id:'org-1',role:options.role||'superadmin',is_active:true,permissions:{},session_revoked_at:null}]);
  }
  const status=options.status??403;
  if(rpcName==='get_latest_supplier_price_rollup_refresh_run'){
   assert.equal(url.pathname,'/rest/v1/supplier_price_rollup_refresh_runs');
   assert.equal(url.searchParams.get('organization_id'),'eq.org-1');assert.equal(url.searchParams.get('limit'),'1');
   assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fixture-service');
  }
  return Response.json(status===200?[{id:'rollup-1',status:'completed'}]:{
   code:options.code||'42501',message:'permission denied for table supplier_price_rollup_refresh_runs',
  },{status});
 };
 try{return await fn(()=>{const request=actualRpc.callAppRpc(rpcName,{code:'ROLLUP_STATUS_ACCESS_DENIED'});pending.push(request);return request;},envelopes,reads);}
 finally{await Promise.allSettled(pending);globalThis.fetch=previousFetch;(globalThis as any).window=previousWindow;(globalThis as any).Netlify=previousNetlify;}
}

test('legacy history projection executes against independently captured production/staging schema',async()=>{
 const columns=baseline.tables.find((t:{schema:string;name:string})=>t.schema==='public'&&t.name==='supplier_price_import_runs').columns;
 assert.ok(columns.length>20,'captured schema must exist');
 const db=new PGlite();
 try{
  await db.exec(`create table public.supplier_price_import_runs(${columns.map((c:{name:string;type:string})=>`"${c.name}" ${c.type}`).join(',')})`);
  await db.query(`insert into public.supplier_price_import_runs(id,organization_id,status,finalize_error_message) values($1,$2,'failed','preserved finalizer error')`,['10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002']);
  const {rows}=await db.query(`select ${SUPPLIER_LEGACY_IMPORT_COLUMNS} from public.supplier_price_import_runs where organization_id=$1 order by started_at desc`,['20000000-0000-0000-0000-000000000002']);
  assert.equal(rows.length,1);
  assert.equal(rows[0].finalize_error_message,'preserved finalizer error');
  await assert.rejects(db.query('select finalize_worker_state from public.supplier_price_import_runs'),{code:'42703'});
 }finally{await db.close();}
});

test('stored active state never fabricates live worker telemetry or zero batch history',()=>{
 for(const status of ['running','finalizing','pending','unexpected']){
  const result=legacySupplierImportTelemetry({...run,status});
  assert.equal(result.supplier_import_worker_state,'unknown');
  assert.equal(result.supplier_import_last_heartbeat_at,null);
  assert.equal(result.supplier_import_last_progress_at,null);
  assert.equal(result.supplier_import_batches,null);
  assert.equal(result.supplier_import_last_batch_processed,null);
 }
 assert.equal(legacySupplierImportTelemetry(null).supplier_import_worker_state,'unknown');
});

test('failed and superseded history retain stored errors without showing queued success',()=>{
 const failed=legacySupplierImportTelemetry({...run,status:'failed',finalize_error_message:'finalizer timeout'});
 assert.equal(failed.supplier_import_worker_state,'failed');
 assert.equal(failed.supplier_import_error_message,'finalizer timeout');
 assert.equal(legacySupplierImportTelemetry({...run,finalize_error_message:'unresolved failure'}).supplier_import_error_message,'unresolved failure');
 const superseded=legacySupplierImportTelemetry({...run,status:'failed',error_message:'original error',finalize_error_message:'secondary error',superseded_by:'another-run'});
 assert.equal(superseded.supplier_import_worker_state,'superseded');
 assert.equal(superseded.supplier_import_error_message,'original error');
});

test('terminal success uses only committed completion timestamp and never invents a heartbeat',()=>{
 for(const status of ['finalized','succeeded']){
  const result=legacySupplierImportTelemetry({...run,status,finalized_at:'2026-10-14T10:00:00Z',finished_at:'2026-10-14T10:01:00Z'});
  assert.equal(result.supplier_import_worker_state,'completed');
  assert.equal(result.supplier_import_last_progress_at,'2026-10-14T10:00:00Z');
  assert.equal(result.supplier_import_last_heartbeat_at,null);
  assert.equal(result.supplier_import_error_message,null);
 }
});

test('optional superadmin rollup denial preserves actual import history and errors',async()=>{
 const imports=[{...run,id:'failed-import',status:'failed',error_message:'real import error'}];
 const result=await withRpcResponse(403,{error:'Superadmin access required',code:'SUPERADMIN_ACCESS_REQUIRED'},async load=>{
  await assert.rejects(load(),(error:any)=>{
   assert.equal(error.status,403);assert.equal(error.code,'SUPERADMIN_ACCESS_REQUIRED');
   assert.notEqual(error.message,'Superadmin access required');
   assert.match(error.message,/superadmin|permission/i);return true;
  });
  return loadLegacySupplierOperations(async()=>imports,load);
 });
 assert.equal(result.importRuns,imports);
 assert.equal(result.importRuns[0].error_message,'real import error');
 assert.equal(result.rollupRun,null);
 assert.equal(result.rollupUnavailable,true);
 assert.equal(legacyCustomerPriceReadiness(true,true,'unavailable'),'unavailable');
 assert.equal(legacyCustomerPriceReadiness(false,true,'unavailable'),'waiting');
});

test('required import failure still rejects when optional rollup read is forbidden',async()=>{
 const failure=new Error('Import history could not be read');
 await withRpcResponse(403,{error:'Superadmin access required',code:'SUPERADMIN_ACCESS_REQUIRED'},load=>
  assert.rejects(loadLegacySupplierOperations(async()=>{throw failure;},load),error=>error===failure));
});

test('actual RPC sanitizer cannot turn other denials into the optional rollup code',async()=>{
 for(const [status,body] of [
  [401,{error:'Superadmin access required'}],
  [500,{error:'Superadmin access required'}],
  [403,{error:'Permission denied',code:'UNRECOGNIZED_PERMISSION_CODE'}],
  [400,{error:'Permission denied',code:'ROLLUP_STATUS_ACCESS_DENIED'}],
  [403,{error:'Superadmin access required'}],
  [403,{error:'Superadmin access required for a different scope'}],
 ] as const){
  await withRpcResponse(status,body,load=>assert.rejects(loadLegacySupplierOperations(async()=>[],load),(error:any)=>{
   assert.equal(error.status,status);assert.equal(error.code,undefined);return true;
  }));
 }
});

test('real authenticated gateway HTTP sanitizer and browser preserve only the optional table denial',async()=>{
 await withActualGateway({},async(load,envelopes,reads)=>{
  const imports=[{id:'original-import',status:'failed',error_message:'original business error'}];
  const result=await loadLegacySupplierOperations(async()=>imports,load);
  assert.equal(result.importRuns,imports);assert.equal(result.rollupUnavailable,true);assert.equal(result.rollupRun,null);
  assert.deepEqual(envelopes,[{status:403,body:{error:'You do not have permission for this action.',code:'ROLLUP_STATUS_ACCESS_DENIED'}}]);
  assert.deepEqual(reads,['/auth/v1/user','/rest/v1/profiles','/rest/v1/supplier_price_rollup_refresh_runs']);
  assert.doesNotMatch(JSON.stringify(envelopes),/supplier_price_rollup_refresh_runs|fixture-service|42501/);
 });
});

test('real gateway superadmin check emits its own code without a privileged table read',async()=>{
 await withActualGateway({role:'admin'},async(load,envelopes,reads)=>{
  const result=await loadLegacySupplierOperations(async()=>[],load);
  assert.equal(result.rollupUnavailable,true);
  assert.equal(envelopes[0].status,403);assert.equal(envelopes[0].body.code,'SUPERADMIN_ACCESS_REQUIRED');
  assert.deepEqual(reads,['/auth/v1/user','/rest/v1/profiles']);
 });
});

test('real gateway does not downgrade Auth/profile, other RPC, SQLSTATE, or server failures',async()=>{
 for(const options of [
  {denyProfile:true}, {status:401}, {status:500}, {status:403,code:'OTHER_DENIAL'},
  {rpcName:'get_catalog_integrity_summary'},
 ])await withActualGateway(options,async(load,envelopes)=>{
  await assert.rejects(loadLegacySupplierOperations(async()=>[],load));
  assert.equal(envelopes[0].status,400);assert.equal(envelopes[0].body.code,undefined);
 });
});

test('real gateway authorized telemetry keeps its actual completed result',async()=>{
 await withActualGateway({status:200},async(load,envelopes)=>{
  const result=await loadLegacySupplierOperations(async()=>[],load);
  assert.deepEqual(result.rollupRun,{id:'rollup-1',status:'completed'});assert.equal(result.rollupUnavailable,false);
  assert.equal(envelopes[0].status,200);
 });
});

test('unrelated rollup auth, server and transport failures are not swallowed',async()=>{
 for(const error of [
  Object.assign(new Error('Session expired'),{status:401}),
  Object.assign(new Error('Different denied scope'),{status:403}),
  Object.assign(new Error('Superadmin access required'),{status:500}),
  Object.assign(new Error('Superadmin access required'),{status:403}),
  Object.assign(new Error('Changed display text'),{status:401,code:'SUPERADMIN_ACCESS_REQUIRED'}),
  new Error('Superadmin access required'),
  new TypeError('Failed to fetch'),
 ])await assert.rejects(loadLegacySupplierOperations(async()=>[],async()=>{throw error;}),caught=>caught===error);
});

test('authorized rollup reads retain explicit status without manufacturing readiness',async()=>{
 const completed={id:'rollup',status:'completed'};
 const result=await loadLegacySupplierOperations(async()=>[],async()=>completed);
 assert.equal(result.rollupRun,completed);assert.equal(result.rollupUnavailable,false);
 assert.equal(legacyCustomerPriceReadiness(true,true,'completed'),'ready');
 assert.equal(legacyCustomerPriceReadiness(true,true,'pending'),'waiting');
 assert.equal(legacyCustomerPriceReadiness(true,false,'completed'),'waiting');
 const empty=await loadLegacySupplierOperations(async()=>[],async()=>null);
 assert.equal(empty.rollupRun,null);assert.equal(empty.rollupUnavailable,false);
});
