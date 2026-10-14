import test from 'node:test';
import assert from 'node:assert/strict';
import admission from '../../netlify/functions/supplier-price-upload-session.mts';
import finish from '../../netlify/functions/supplier-price-upload-finish.mts';
import status from '../../netlify/functions/supplier-price-upload-status.mts';
import options from '../../netlify/functions/supplier-price-upload-options.mts';
import { supplierVerifiedUploadTargetEnabled } from '../../netlify/functions/_shared/supplier-upload-target.mts';
import { supplierVerifiedUploadTargetEnabled as clientTarget } from '../../apps/web/src/infrastructure/api/supplierVerifiedUploadTargetGate.ts';
import {parseUploadStatus,supplierUploadStatusView,SUPPLIER_SOURCE_UNSUPPORTED_FIELDS,SUPPLIER_SOURCE_INVALID_FIELDS} from '../../apps/web/src/shared/supplierUploadProtocol.ts';

const prod='zjgueqijumzlfioihnkt', v3='kaxsqafdevabkxofwdod';
const base=`https://${prod}.supabase.co`, portal='https://portal.next-master.com';
const org='10000000-0000-0000-0000-000000000001', actor='40000000-0000-0000-0000-000000000001';
const session='50000000-0000-0000-0000-000000000001', release='60000000-0000-0000-0000-000000000001';
const authSession='80000000-0000-0000-0000-000000000001';
const payload={supplierId:'20000000-0000-0000-0000-000000000001',brandId:'30000000-0000-0000-0000-000000000001',
  fileName:'prices.csv',contentType:'text/csv',totalBytes:100,checksumSha256:'a'.repeat(64),mode:'replace',sourceDate:'2026-10-14'};
const env:Record<string,string>={SUPABASE_URL:base,SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_only',
  SUPPLIER_PRICE_UPLOAD_VERIFIED_ADMISSION_ENABLED:'true',SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED:'1',
  SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED:'true',NM_PRODUCTION_TARGET:prod};
const json=(data:unknown,code=200)=>new Response(JSON.stringify(data),{status:code,headers:{'content-type':'application/json'}});

async function invoke(kind:'admission'|'finish'|'status'|'options', overrides:Record<string,any>={}) {
  const priorFetch=globalThis.fetch, priorNetlify=(globalThis as any).Netlify;
  const calls:Array<{url:URL,body:any}>=[];
  const now=Math.floor(Date.now()/1000);
  const claims={sub:actor,role:'authenticated',aud:'authenticated',iss:base+'/auth/v1',session_id:authSession,iat:now-10,exp:now+3600,...overrides.claims};
  const token=[{alg:'HS256',typ:'JWT'},claims,'SYNTHETIC_NOT_SIGNED'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
  (globalThis as any).Netlify={env:{get:(key:string)=>({...env,...overrides.env})[key]}};
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.hostname,`${prod}.supabase.co`,'Synthetic fixture must not reach external transport');
    const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,body});
    if(url.pathname==='/auth/v1/user') return json({id:actor},overrides.authStatus||200);
    if(url.pathname==='/rest/v1/profiles') return json([{id:actor,organization_id:org,role:'admin',is_active:true,
      ...(overrides.missingRevocation?{}:{session_revoked_at:null}),...overrides.profile}]);
    if(url.pathname==='/rest/v1/suppliers') return json([{id:payload.supplierId,name:'Synthetic',is_active:true}]);
    if(url.pathname==='/rest/v1/brands') return json([{id:payload.brandId,name:'Fixture'}]);
    assert.equal((init?.headers as any).apikey,env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal((init?.headers as any).Authorization,undefined,'Secret API keys must not be used as bearer JWTs');
    if(overrides.rpcError) return json({message:overrides.rpcError},403);
    if(url.pathname==='/rest/v1/rpc/start_supplier_price_verified_upload_session') return json([{session_id:session,release_id:release,
      status:'created',storage_bucket:'supplier-price-imports',storage_object_path:`${org}/supplier-price/${session}/prices.csv`,
      total_bytes:body.input_total_bytes,uploaded_bytes:0,expires_at:'2099-01-01T00:00:00Z',...overrides.receipt}]);
    if(url.pathname==='/rest/v1/rpc/request_supplier_price_upload_verification') return json({session_id:session,release_id:release,
      request_id:'90000000-0000-0000-0000-000000000001',status:'queued',published:false,...overrides.receipt});
    if(url.pathname==='/rest/v1/rpc/get_supplier_price_upload_status') return json({session_id:session,release_id:release,
      upload_status:'uploaded',verification_status:'verified',transfer_ready:true,total_bytes:100,total_rows:2,processed_rows:0,
      release_status:'uploaded',error_code:null,release_updated_at:new Date().toISOString(),expires_at:'2099-01-01T00:00:00Z',updated_at:new Date().toISOString(),published:false,...overrides.receipt});
    throw Error(`Unexpected endpoint ${url.pathname}`);
  };
  try {
    const path=kind==='admission'?'session':kind;
    const method=kind==='admission'||kind==='finish'?'POST':'GET';
    const req=new Request(`${overrides.origin||portal}/api/supplier-price-upload-${path}${kind==='status'?`?sessionId=${session}`:''}`,{
      method,headers:overrides.noAuth?{}:{authorization:`Bearer ${token}`},
      ...(method==='POST'?{body:overrides.raw||JSON.stringify(kind==='finish'?{sessionId:session}:{...payload,...overrides.body})}:{})});
    const handler={admission,finish,status,options}[kind];
    const response=await handler(req,{} as any);
    const data=await response.json();
    assert.ok(!JSON.stringify(data).includes(env.SUPABASE_SERVICE_ROLE_KEY));
    return {code:response.status,data,calls};
  } finally { globalThis.fetch=priorFetch;(globalThis as any).Netlify=priorNetlify; }
}

test('production and frontend gates require exact target, canonical portal and explicit enablement',()=>{
  assert.equal(supplierVerifiedUploadTargetEnabled(portal+'/api/test',name=>env[name]),true);
  assert.equal(clientTarget({enabled:'true',productionEnabled:'1',productionTarget:prod,supabaseUrl:base,portalOrigin:portal}),true);
  for(const changed of [{SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED:'0'},{NM_PRODUCTION_TARGET:v3},{NM_FULL_STAGING_TARGET:v3},
    {SUPABASE_URL:base+'/other'},{SUPABASE_URL:base+'?'}]) {
    assert.equal(supplierVerifiedUploadTargetEnabled(portal+'/api/test',name=>({...env,...changed})[name]),false);
  }
  assert.equal(supplierVerifiedUploadTargetEnabled('https://attacker.invalid/api/test',name=>env[name]),false);
  assert.equal(clientTarget({enabled:'true',productionTarget:prod,supabaseUrl:base,portalOrigin:portal}),false);
  assert.equal(clientTarget({enabled:'true',supabaseUrl:`https://${v3}.supabase.co`,portalOrigin:'https://next-master-v3-staging-20261006.netlify.app'}),true);
  assert.equal(clientTarget({enabled:'true',supabaseUrl:'https://other.supabase.co',portalOrigin:portal}),false);
});

test('status exposes operational code and release freshness while preserving source status and row counters',async()=>{
  const releaseUpdatedAt='2026-10-14T14:00:00.123456+00:00';
  const r=await invoke('status',{receipt:{release_status:'parsing',total_rows:1000000,processed_rows:25000,
    error_code:'SUPPLIER_PROCESSING_INTERRUPTED',release_updated_at:releaseUpdatedAt,error_message:'private provider diagnostic'}});
  assert.equal(r.code,200);assert.equal(r.data.errorCode,'SUPPLIER_PROCESSING_INTERRUPTED');
  assert.equal(r.data.releaseUpdatedAt,releaseUpdatedAt);assert.equal(r.data.releaseStatus,'parsing');
  assert.equal(r.data.processedRows,25000);assert.equal(r.data.verificationStatus,'verified');
  assert.equal(r.data.published,false);assert.equal('errorMessage' in r.data,false);
  assert.doesNotMatch(JSON.stringify(r.data),/private provider diagnostic/);
  for(const receipt of [{error_code:'private provider diagnostic'},{release_updated_at:'invalid'}])
    assert.equal((await invoke('status',{receipt})).code,503);
});

test('terminal commercial-field failures survive actual status API and typed parser with exact localized rejection',async()=>{
 for(const [code,field] of Object.entries(SUPPLIER_SOURCE_UNSUPPORTED_FIELDS)){
  const r=await invoke('status',{receipt:{verification_status:'failed',release_status:'received',
   total_rows:0,processed_rows:0,error_code:code,last_error:'private provider URL/token must never reach the client'}});
  assert.equal(r.code,200);assert.equal(r.data.errorCode,code);assert.equal(r.data.published,false);
  assert.doesNotMatch(JSON.stringify(r.data),/private provider|last_error/);
  const parsed=parseUploadStatus(r.data,session,100);
  for(const tr of [false,true]){
   const view=supplierUploadStatusView(parsed,tr);
   assert.equal(view.phase,'failed');assert.ok(view.message.includes(field.column));assert.ok(view.message.includes(tr?field.tr:field.en));
   assert.match(view.message,tr?/Dosya reddedildi/:/File rejected/);
   assert.match(view.message,tr?/Fiyatlar yayımlanmadı/:/Prices were not published/);
   assert.match(view.message,tr?/gerekli bilgiyi silmeyin/:/Do not delete meaningful commercial data/);
   assert.doesNotMatch(view.message,/kuyruğunda|queued|running|Check this same upload later|re-upload|yeniden yükle/i);
  }
  assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,1,'Status observation only; no retry or handoff mutation');
 }
 const unknown=await invoke('status',{receipt:{verification_status:'failed',error_code:'SOURCE_UNSUPPORTED_UNKNOWN'}});
 assert.equal(supplierUploadStatusView(parseUploadStatus(unknown.data,session)).phase,'attention','Unknown codes do not masquerade as a known commercial-field rejection');
});

test('invalid commercial fields preserve typed API errors with actionable bounds and no source value disclosure',async()=>{
 for(const [code,field] of Object.entries(SUPPLIER_SOURCE_INVALID_FIELDS)){
  const r=await invoke('status',{receipt:{verification_status:'failed',release_status:'received',total_rows:0,processed_rows:0,error_code:code,last_error:'PRIVATE malformed source value'}});
  assert.equal(r.code,200);const parsed=parseUploadStatus(r.data,session,100);
  for(const tr of [false,true]){
   const view=supplierUploadStatusView(parsed,tr);assert.equal(view.phase,'failed');assert.ok(view.message.includes(field.column));
   assert.ok(view.message.includes(tr?field.tr:field.en));assert.doesNotMatch(view.message,/PRIVATE|queued|kuyruğunda/);
   assert.match(view.message,tr?/Fiyatlar yayımlanmadı/:/Prices were not published/);
  }
  assert.doesNotMatch(JSON.stringify(r.data),/PRIVATE|last_error/);
 }
});

test('all new routes stay closed before authentication or any remote call when production flag is absent',async()=>{
  for(const kind of ['admission','finish','status','options'] as const) {
    const r=await invoke(kind,{env:{SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED:undefined}});
    assert.equal(r.code,503);assert.equal(r.calls.length,0);
  }
});

test('admission binds the authenticated actor and organization, never body aliases',async()=>{
  const r=await invoke('admission',{body:{actorId:'foreign',organizationId:'foreign'}});
  assert.equal(r.code,200);
  const call=r.calls.find(c=>c.url.pathname.endsWith('/start_supplier_price_verified_upload_session'))!;
  assert.equal(call.body.input_actor_id,actor);assert.equal(call.body.input_organization_id,org);
  assert.equal(r.data.data.verification_required,true);
  assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,1);
});

test('same admission derives the same key and a changed source changes it',async()=>{
  const a=await invoke('admission'),b=await invoke('admission'),c=await invoke('admission',{body:{totalBytes:101}});
  const key=(r:any)=>r.calls.find((c:any)=>c.body?.input_idempotency_key)?.body.input_idempotency_key;
  assert.equal(key(a),key(b));assert.notEqual(key(a),key(c));
});

test('authenticated verified merge is rejected before a session RPC can create state',async()=>{
  const r=await invoke('admission',{body:{mode:'merge'}});
  assert.equal(r.code,400);assert.match(r.data.error,/complete replacement price list/);
  assert.ok(r.calls.some(c=>c.url.pathname==='/rest/v1/profiles'));
  assert.ok(!r.calls.some(c=>c.url.pathname.includes('/rpc/')));
});

for(const [name,overrides,expected] of [
  ['missing bearer',{noAuth:true},401],['unverified Auth token',{authStatus:401},401],
  ['wrong issuer',{claims:{iss:'https://foreign.invalid/auth/v1'}},401],
  ['expired token',{claims:{exp:1}},401],['disabled profile',{profile:{is_active:false}},401],
  ['non-admin profile',{profile:{role:'customer'}},403],
  ['revoked session',{profile:{session_revoked_at:new Date().toISOString()}},401],
  ['unknown revocation state',{missingRevocation:true},503],
] as const) test(`${name} cannot reach upload admission`,async()=>{
  const r=await invoke('admission',overrides);assert.equal(r.code,expected);
  assert.ok(!r.calls.some(c=>c.url.pathname.includes('/rpc/')));
});

test('foreign object receipt is rejected without offering a different session',async()=>{
  const r=await invoke('admission',{receipt:{storage_object_path:`${actor}/supplier-price/${session}/prices.csv`}});
  assert.equal(r.code,502);assert.equal(r.data.outcome,'unknown');assert.ok(r.data.idempotencyKey);
});

test('supplier tenant denial remains a permission failure',async()=>{
  const r=await invoke('admission',{rpcError:'Supplier is not in this organization'});assert.equal(r.code,403);
});

test('finish queues verification only and binds the current Auth session proof',async()=>{
  const r=await invoke('finish');assert.equal(r.code,202);assert.equal(r.data.published,false);
  const call=r.calls.find(c=>c.url.pathname.includes('/rpc/'))!;
  assert.equal(call.url.pathname,'/rest/v1/rpc/request_supplier_price_upload_verification');
  assert.equal(call.body.input_actor_id,actor);assert.equal(call.body.input_auth_session_id,authSession);
});

test('finish body cannot contain file bytes or a publication command',async()=>{
  const r=await invoke('finish',{raw:JSON.stringify({sessionId:session,bytes:'x'.repeat(2048)})});
  assert.equal(r.code,413);assert.equal(r.calls.length,0);
});

test('status reads counters, rejects a foreign session and does not imply publication',async()=>{
  const r=await invoke('status');assert.equal(r.code,200);assert.equal(r.data.published,false);
  assert.deepEqual(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).map(c=>c.url.pathname),['/rest/v1/rpc/get_supplier_price_upload_status']);
  const bad=await invoke('status',{receipt:{session_id:release}});assert.equal(bad.code,503);
});

test('options read only organization-scoped supplier and brand identifiers',async()=>{
  const r=await invoke('options');assert.equal(r.code,200);
  for(const call of r.calls.filter(c=>['/rest/v1/suppliers','/rest/v1/brands'].includes(c.url.pathname)))
    assert.equal(call.url.searchParams.get('organization_id'),`eq.${org}`);
  assert.ok(!r.calls.some(c=>c.url.pathname.includes('/rpc/')));
});
