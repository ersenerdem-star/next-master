import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../netlify/functions/portal-access-report.mts';

const base='https://portal-audit-fixture.invalid';
const org='10000000-0000-4000-8000-000000000001',actor='20000000-0000-4000-8000-000000000001';
const session='30000000-0000-4000-8000-000000000001',invite='40000000-0000-4000-8000-000000000001';
const fixtureResponse=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});

async function invoke(query='',options:{method?:string;role?:string;noAuth?:boolean;inactive?:boolean;revoked?:boolean;rpcError?:string}={}){
 const priorFetch=globalThis.fetch,priorNetlify=(globalThis as any).Netlify;
 const now=Math.floor(Date.now()/1000);
 const claims={sub:actor,role:'authenticated',aud:'authenticated',iss:base+'/auth/v1',session_id:session,iat:now-10,exp:now+1000};
 const token=['synthetic-head',Buffer.from(JSON.stringify(claims)).toString('base64url'),'synthetic-not-real-signature'].join('.');
 const calls:Array<{url:URL;init?:RequestInit;body?:Record<string,unknown>}>=[];
 (globalThis as any).Netlify={env:{get:(key:string)=>({SUPABASE_URL:base,SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic'} as Record<string,string>)[key]}};
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,base,'Real external transport is forbidden in this fixture');
  const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,init,body});
  if(url.pathname==='/auth/v1/user')return fixtureResponse({id:actor});
  if(url.pathname==='/rest/v1/profiles')return fixtureResponse([{id:actor,organization_id:org,role:options.role??'admin',is_active:!options.inactive,session_revoked_at:options.revoked?new Date(now*1000).toISOString():null}]);
  if(url.pathname==='/rest/v1/rpc/admin_portal_access_report')return options.rpcError?fixtureResponse({message:options.rpcError},400):fixtureResponse({rows:[],total:0,page:1,pageSize:50,asOf:'2026-11-06T12:00:00Z',parties:[],countries:[]});
  throw Error('Unexpected fixture endpoint '+url.pathname);
 };
 try{
  const req=new Request('https://portal.next-master.com/api/portal-access-report'+query,{method:options.method||'GET',headers:options.noAuth?{}:{authorization:'Bearer '+token}});
  const result=await handler(req,{} as any);const data=await result.json();
  assert.doesNotMatch(JSON.stringify(data),/sb_secret_synthetic|synthetic-anon|synthetic-not-real-signature|private database detail/);
  return {status:result.status,data,calls,token,headers:result.headers};
 }finally{globalThis.fetch=priorFetch;(globalThis as any).Netlify=priorNetlify;}
}
const valid='?from=2026-11-01T00%3A00%3A00Z&to=2026-11-07T00%3A00%3A00Z';

test('portal report endpoint calls only scoped admin RPC with verified user bearer and bounded filters',async()=>{
 const r=await invoke(valid+'&page=2&pageSize=250&search=alice&inviteId='+invite+'&event=portal_logout&status=ok&country=TR&asOf=2026-11-06T12%3A00%3A00Z');
 assert.equal(r.status,200);assert.match(r.headers.get('cache-control')||'',/no-store/);
 const rpc=r.calls.find(c=>c.url.pathname==='/rest/v1/rpc/admin_portal_access_report')!;assert.ok(rpc);
 const headers=rpc.init?.headers as Record<string,string>;
 assert.equal(headers.apikey,'synthetic-anon');assert.equal(headers.Authorization,'Bearer '+r.token);
 assert.equal(rpc.body?.input_page,2);assert.equal(rpc.body?.input_page_size,250);assert.equal(rpc.body?.input_search,'alice');
 assert.equal(rpc.body?.input_invite_id,invite);assert.equal(rpc.body?.input_event,'portal_logout');assert.equal(rpc.body?.input_status,'ok');assert.equal(rpc.body?.input_country,'TR');
 assert.ok(!Object.hasOwn(rpc.body!,'input_organization_id'),'Caller cannot select an organization');
 assert.ok(!r.calls.some(c=>c.url.pathname==='/rest/v1/portal_audit_logs'),'Endpoint must not service-read unbounded audit records');
 assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,1);
});

test('malformed filters fail before requesting the report data',async()=>{
 for(const query of ['?from=wrong&to=2026-11-07T00:00:00Z','?from=2026-02-30T00:00:00Z&to=2026-03-07T00:00:00Z','?from=2026-11-01T24:00:00Z&to=2026-11-07T00:00:00Z',valid+'&country=TURKEY',valid+'&pageSize=251',valid+'&page=0',valid+'&inviteId=not-uuid',valid+'&event=portal_search',valid+'&status=invalid',valid+'&asOf=wrong']){
  const r=await invoke(query);assert.equal(r.status,400,query);assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,0);
 }
});

test('staff, anonymous, inactive and revoked sessions cannot read portal access logs',async()=>{
 for(const opts of [{role:'sales'},{role:'viewer'},{noAuth:true},{inactive:true},{revoked:true}]){
  const r=await invoke(valid,opts);assert.ok([401,403].includes(r.status));assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,0);
 }
 const r=await invoke(valid,{method:'POST'});assert.equal(r.status,405);assert.equal(r.calls.length,0);
});

test('unavailable report returns a sanitized failure without database internals',async()=>{
 const r=await invoke(valid,{rpcError:'private database detail with secrets'});assert.ok(r.status>=400);assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,1);
});
