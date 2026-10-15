import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../netlify/functions/app-admin-records.mts';
const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),brand=id(2),vendor=id(3),invite=id(4);
async function run(options:{role?:string;foreign?:boolean;writeFail?:boolean;lookupFail?:boolean}={},excluded:unknown=[]){
 const prevFetch=globalThis.fetch,prevNetlify=(globalThis as any).Netlify;
 (globalThis as any).Netlify={env:{get:(name:string)=>({SUPABASE_URL:'https://fixture.test',SUPABASE_ANON_KEY:'anon-fixture',SUPABASE_SERVICE_ROLE_KEY:'service-fixture'}[name])}};
 const writes:any[]=[];
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));
  if(u.pathname==='/auth/v1/user')return Response.json({id:id(5),email:'admin@fixture.test'});
  if(u.pathname==='/rest/v1/profiles')return Response.json([{organization_id:org,role:options.role||'admin',is_active:true,permissions:{}}]);
  if(u.pathname==='/rest/v1/vendors')return Response.json([{id:vendor}]);
  if(u.pathname==='/rest/v1/brands'){
   assert.equal(u.searchParams.get('organization_id'),'eq.'+org);
   if(options.lookupFail)return Response.json({message:'lookup unavailable'},{status:503});
   return Response.json(options.foreign?[]:[{id:brand}]);
  }
  if(u.pathname==='/rest/v1/portal_invites'){
   if(init?.method==='PATCH'||init?.method==='POST'){
    writes.push(JSON.parse(String(init.body)));
    if(options.writeFail)return Response.json({message:'scope save failed'},{status:500});
    return Response.json([{id:invite,...writes.at(-1)}]);
   }
   return Response.json([]);
  }
  throw Error('Unexpected '+u.pathname);
 };
 try{
  const response=await handler(new Request('https://fixture.test/api/app-admin-records',{method:'POST',headers:{Authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({resource:'portalInvites',action:'upsert',id:invite,payload:{organization_id:id(9),party_type:'vendor',party_name:'Fixture',email:'fixture@fixture.test',vendor_id:vendor,allowed_brand_ids:[id(9)],excluded_brand_ids:excluded}})}),{} as any);
  return {response,writes,body:await response.json()};
 }finally{globalThis.fetch=prevFetch;(globalThis as any).Netlify=prevNetlify;}
}
test('admin saves validated exclusions, pins organization and never accepts a client allow-list',async()=>{
 const result=await run({},[brand]);assert.equal(result.response.status,200);assert.equal(result.writes.length,1);
 assert.deepEqual(result.writes[0].excluded_brand_ids,[brand]);assert.equal(result.writes[0].allowed_brand_ids,undefined);assert.equal(result.writes[0].organization_id,org);
});
test('foreign/malformed exclusions and failed validation never write or silently broaden access',async()=>{
 for(const [options,excluded] of [[{foreign:true},[brand]],[{},['bad']],[{lookupFail:true},[brand]]] as const){const r=await run(options as any,excluded);assert.notEqual(r.response.status,200);assert.equal(r.writes.length,0);}
});
test('failed scope write never retries through the legacy payload fallback',async()=>{
 const r=await run({writeFail:true},[brand]);assert.notEqual(r.response.status,200);assert.equal(r.writes.length,1);
});
test('viewer cannot change portal scope',async()=>{
 const r=await run({role:'viewer'},[]);assert.equal(r.response.status,403);assert.equal(r.writes.length,0);
});
