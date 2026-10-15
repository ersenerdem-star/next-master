import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../netlify/functions/app-admin-records.mts';

// Exercise the actual gateway with explicit synthetic Auth/transport stubs.
const token = `${Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')}.${Buffer.from(JSON.stringify({iat:2000000000})).toString('base64url')}.synthetic`;
async function run(authorization:string, authResponse:unknown, authStatus:number, profile:unknown[]) {
 const previousFetch=globalThis.fetch, previousNetlify=globalThis.Netlify;
 const calls:string[]=[];
 globalThis.Netlify={env:{get:(k:string)=>({SUPABASE_URL:'https://synthetic.invalid',SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-secret'}[k])}} as any;
 globalThis.fetch=(async(input:unknown)=>{
  const url=String(input);calls.push(url);
  if(url.endsWith('/auth/v1/user'))return Response.json(authResponse,{status:authStatus});
  if(url.includes('/rest/v1/profiles?'))return Response.json(profile);
  throw Error('Unexpected protected record transport');
 }) as typeof fetch;
 try {
  const response=await handler(new Request('https://synthetic.invalid/api/app-admin-records',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({resource:'customers',action:'list'})}),{} as any);
  return {status:response.status,body:await response.json(),calls};
 } finally {globalThis.fetch=previousFetch;globalThis.Netlify=previousNetlify;}
}

test('missing credentials return 401 before any transport or record read',async()=>{
 const r=await run('',{},200,[]);assert.equal(r.status,401);assert.deepEqual(r.calls,[]);assert.equal(r.body.data,undefined);
});
test('expired credentials return 401 without protected record transport',async()=>{
 const r=await run(`Bearer ${token}`,{message:'invalid JWT'},401,[]);assert.equal(r.status,401);assert.equal(r.calls.length,1);assert.equal(r.body.data,undefined);
});
test('inactive profile is rejected without protected record transport',async()=>{
 const r=await run(`Bearer ${token}`,{id:'local-user'},200,[{organization_id:'local-org',role:'admin',department:'management',permissions:{},is_active:false}]);assert.equal(r.status,401);assert.equal(r.calls.length,2);assert.equal(r.body.data,undefined);
});
