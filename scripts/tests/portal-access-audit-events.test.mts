import test from 'node:test';
import assert from 'node:assert/strict';
import login from '../../netlify/functions/portal-login.mts';
import logout from '../../netlify/functions/portal-logout.mts';
import { createPortalSessionToken, hashPortalToken } from '../../netlify/functions/_shared/portal-security.mts';

const base='https://portal-auth-audit-fixture.invalid';
const secret='synthetic-session-signing-key';
const password='synthetic-customer-password';
const org='10000000-0000-4000-8000-000000000001';
const inviteId='20000000-0000-4000-8000-000000000001';
const customerId='30000000-0000-4000-8000-000000000001';
const updated='2026-01-01T00:00:00.000Z';
const email='customer@example.invalid';
const host='seller.example.invalid';
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});

async function invoke(kind:'login'|'logout',options:{body?:unknown;token?:string;method?:string;allowed?:boolean;auditFailure?:boolean;abortAudit?:boolean;context?:unknown;headers?:Record<string,string>;noConfig?:boolean;networkFailure?:boolean;disabledInvite?:boolean}={}){
 const priorFetch=globalThis.fetch,priorNetlify=(globalThis as any).Netlify;
 const priorTimeout=AbortSignal.timeout;const deadlines:number[]=[];
 if(options.abortAudit)AbortSignal.timeout=(ms:number)=>{deadlines.push(ms);return ms===2500?AbortSignal.abort():priorTimeout(ms);};
 const audits:Array<Record<string,any>>=[];
 const calls:Array<{url:URL;init?:RequestInit;body?:any}>=[];
 const invite={id:inviteId,organization_id:org,party_type:'customer',party_name:'Fixture customer',customer_id:customerId,vendor_id:null,
  seller_company_profile_id:null,email,contact_name:'Fixture user',status:'active',invite_token_hash:await hashPortalToken(password),
  updated_at:updated,last_used_at:null,expires_at:null,access_can_view_account:false,access_can_view_invoices:false,
  access_can_view_payments:false,access_can_view_orders:false,allowed_brand_ids:[]};
 (globalThis as any).Netlify={env:{get:(key:string)=>options.noConfig?undefined:({SUPABASE_URL:base,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',PORTAL_SESSION_SECRET:secret} as Record<string,string>)[key]}};
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,base,'No external transport is permitted');
  const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,init,body});
  if(url.pathname==='/rest/v1/portal_seller_domains')return response([{id:'domain',organization_id:org,seller_company_profile_id:null,hostname:host}]);
  if(url.pathname==='/rest/v1/rpc/check_portal_rate_limit')return response([{allowed:options.allowed!==false,retry_after_seconds:60}]);
  if(url.pathname==='/rest/v1/portal_invites'){
   if(options.networkFailure)throw Error('Database request timed out');
   return response(init?.method==='PATCH'?[]:[{...invite,status:options.disabledInvite?'disabled':invite.status}]);
  }
  if(url.pathname==='/rest/v1/customers')return response([{id:customerId,organization_id:org,display_name:'Fixture customer',currency:'EUR'}]);
  if(url.pathname==='/rest/v1/portal_audit_logs'){
   if(init?.method==='POST'){
    if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');
    audits.push(body[0]);return response([],options.auditFailure?503:201);
   }
   return response([]);
  }
  if(url.pathname.startsWith('/rest/v1/'))return response([]);
  throw Error('Unexpected transport '+url.pathname);
 };
 try{
  const method=options.method||'POST';
  const req=new Request(`https://${host}/api/portal-${kind}`,{method,headers:{host,'user-agent':'Fixture agent',
   ...(options.token?{cookie:'__Host-next-master-portal='+encodeURIComponent(options.token)}:{}),...options.headers},
   ...(kind==='login'&&method==='POST'?{body:JSON.stringify(options.body??{email,password})}:{})});
  const res=await (kind==='login'?login:logout)(req,(options.context||{ip:'203.0.113.7',geo:{country:{code:'TR'}}}) as any);
  const data=await res.json();
  assert.ok(audits.every(a=>!JSON.stringify(a).includes(password)&&!JSON.stringify(a).includes(secret)&&!JSON.stringify(a).includes('synthetic-service-key')));
  if(options.token)assert.ok(audits.every(a=>!JSON.stringify(a).includes(options.token!)));
  return {status:res.status,cookie:res.headers.get('set-cookie'),data,audits,calls,deadlines};
 }finally{globalThis.fetch=priorFetch;(globalThis as any).Netlify=priorNetlify;AbortSignal.timeout=priorTimeout;}
}
const token=()=>createPortalSessionToken(secret,inviteId,email,org,host,updated);

test('explicit password login records a scoped verified login with trusted country/IP only',async()=>{
 const r=await invoke('login',{headers:{'x-country':'US','x-forwarded-for':'198.51.100.88'}});
 assert.equal(r.status,200);assert.equal(r.audits.length,1);
 assert.equal(r.audits[0].event_type,'portal_login');assert.equal(r.audits[0].status,'ok');
 assert.equal(r.audits[0].invite_id,inviteId);assert.equal(r.audits[0].organization_id,org);
 assert.equal(r.audits[0].details.auth_method,'password');assert.equal(r.audits[0].country_code,'TR');
 assert.equal(r.audits[0].country_source,'netlify_geo');assert.equal(r.audits[0].ip_address,'203.0.113.7');
 assert.match(r.cookie!,/HttpOnly; Secure; SameSite=Lax/);
});
test('cookie restore is a session-resume event rather than another password login',async()=>{
 const r=await invoke('login',{token:await token(),body:{}});
 assert.equal(r.status,200);assert.equal(r.audits[0].event_type,'portal_session_resume');
 assert.equal(r.audits[0].details.auth_method,'session');assert.equal(r.audits[0].invite_id,inviteId);
});
test('failed login is scoped by seller domain, never the submitted organization or spoofed geo',async()=>{
 const r=await invoke('login',{body:{email,password:'wrong password',organization_id:'forged'},
  context:{ip:'not-an-ip',geo:{country:{code:'ZZ'}}},headers:{'x-forwarded-for':'198.51.100.88','x-country':'US'}});
 assert.equal(r.status,401);assert.equal(r.audits[0].status,'failed');assert.equal(r.audits[0].organization_id,org);
 assert.equal(r.audits[0].invite_id,null);assert.equal(r.audits[0].country_code,null);assert.equal(r.audits[0].country_source,null);
 assert.equal(r.audits[0].ip_address,null);
});
test('session rejection is observed invalid-or-expired access, not an invented logout time',async()=>{
 const clock=Date.now;let expired:string;
 try{Date.now=()=>clock()-13*60*60*1000;expired=await token();}finally{Date.now=clock;}
 for(const session of ['tampered.invalid',expired!]){
  const r=await invoke('login',{token:session,body:{}});
  assert.equal(r.status,401);assert.equal(r.audits.length,1);assert.equal(r.audits[0].event_type,'portal_session_rejected');
  assert.equal(r.audits[0].details.reason,'invalid_or_expired');assert.equal(r.audits[0].invite_id,null);
 }
});
test('rate-limited attempt is recorded with attempted authentication method',async()=>{
 const r=await invoke('login',{allowed:false});assert.equal(r.status,429);assert.equal(r.audits[0].status,'rate_limited');
 assert.equal(r.audits[0].organization_id,org);assert.equal(r.audits[0].details.auth_method,'password');
});
test('backend restoration failure is not recorded as expired or rejected authentication',async()=>{
 const r=await invoke('login',{token:await token(),body:{},networkFailure:true});
 assert.equal(r.status,401);assert.equal(r.audits.length,1);
 assert.equal(r.audits[0].event_type,'portal_session_resume');assert.equal(r.audits[0].status,'failed');
 assert.equal(r.audits[0].details.reason,'The request took too long. Please try again.');
 assert.equal(r.audits[0].organization_id,org);assert.equal(r.audits[0].invite_id,null);
});
test('revoked and wrong-domain sessions have separate verified rejection reasons',async()=>{
 const revoked=await invoke('login',{token:await token(),body:{},disabledInvite:true});
 assert.equal(revoked.audits[0].event_type,'portal_session_rejected');
 assert.equal(revoked.audits[0].details.reason,'session_no_longer_active');
 const wrongTenant=await createPortalSessionToken(secret,inviteId,email,'90000000-0000-4000-8000-000000000001',host,updated);
 const domain=await invoke('login',{token:wrongTenant,body:{}});
 assert.equal(domain.audits[0].event_type,'portal_session_rejected');
 assert.equal(domain.audits[0].details.reason,'session_domain_mismatch');
});
test('verified logout records exact observed exit and clears cookie without warming session',async()=>{
 const r=await invoke('logout',{token:await token()});assert.equal(r.status,200);assert.equal(r.data.ok,true);
 assert.match(r.cookie!,/Max-Age=0/);assert.equal(r.audits.length,1);assert.equal(r.audits[0].event_type,'portal_logout');
 assert.equal(r.audits[0].invite_id,inviteId);assert.equal(r.audits[0].details.reason,'explicit_logout');
 assert.equal(r.audits[0].country_code,'TR');assert.ok(!r.calls.some(c=>c.init?.method==='PATCH'));
});
test('missing, malformed and wrong-tenant sessions cannot manufacture successful logout actors',async()=>{
 const wrongTenant=await createPortalSessionToken(secret,inviteId,email,'90000000-0000-4000-8000-000000000001',host,updated);
 for(const value of [undefined,'tampered.invalid',wrongTenant]){
  const r=await invoke('logout',{token:value});assert.equal(r.status,200);assert.match(r.cookie!,/Max-Age=0/);assert.deepEqual(r.audits,[]);
 }
});
test('audit failures and unavailable configuration never prevent local logout or disclose secrets',async()=>{
 const auditError=await invoke('logout',{token:await token(),auditFailure:true});assert.equal(auditError.status,200);assert.match(auditError.cookie!,/Max-Age=0/);
 const noConfig=await invoke('logout',{token:await token(),noConfig:true});assert.equal(noConfig.status,200);assert.match(noConfig.cookie!,/Max-Age=0/);
 assert.deepEqual(noConfig.audits,[]);assert.equal((await invoke('logout',{method:'GET'})).status,405);
});
test('bounded audit timeout cannot prevent successful login or cookie-clearing logout',async()=>{
 const signed=await token();
 for(const kind of ['login','logout'] as const){
  const r=await invoke(kind,{token:kind==='logout'?signed:undefined,abortAudit:true});
  assert.equal(r.status,200);assert.ok(r.deadlines.includes(2500));
  if(kind==='logout')assert.match(r.cookie!,/Max-Age=0/);
 }
});
test('trusted unknown context location remains unknown despite arbitrary country headers',async()=>{
 const r=await invoke('login',{context:{},headers:{'x-country':'DE','x-nf-geo':'{"country":{"code":"DE"}}','x-forwarded-for':'203.0.113.88'}});
 assert.equal(r.status,200);assert.equal(r.audits[0].country_code,null);assert.equal(r.audits[0].ip_address,null);
});
