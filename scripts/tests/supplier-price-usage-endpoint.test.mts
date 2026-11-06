import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../netlify/functions/supplier-price-usage.mts';

const base='https://supplier-usage-fixture.invalid';
const org='10000000-0000-0000-0000-000000000001';
const actor='20000000-0000-0000-0000-000000000001';
const supplier='30000000-0000-0000-0000-000000000001';
const session='40000000-0000-0000-0000-000000000001';
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});

async function invoke(method='GET', options:{role?:string;rpcError?:string;noAuth?:boolean;body?:unknown;rawBody?:string}={}) {
  const priorFetch=globalThis.fetch, priorNetlify=(globalThis as any).Netlify;
  const now=Math.floor(Date.now()/1000);
  const claims={sub:actor,role:'authenticated',aud:'authenticated',iss:base+'/auth/v1',session_id:session,iat:now-10,exp:now+1000};
  const token=['head',Buffer.from(JSON.stringify(claims)).toString('base64url'),'synthetic-unsigned'].join('.');
  const calls:Array<{url:URL;init?:RequestInit;body?:Record<string,unknown>}>=[];
  (globalThis as any).Netlify={env:{get:(key:string)=>({SUPABASE_URL:base,SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic'} as Record<string,string>)[key]}};
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));
    assert.equal(url.origin,base,'Only synthetic transport is permitted');
    const body=init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({url,init,body});
    if(url.pathname==='/auth/v1/user')return response({id:actor});
    if(url.pathname==='/rest/v1/profiles')return response([{id:actor,organization_id:org,role:options.role||'admin',is_active:true,session_revoked_at:null}]);
    if(url.pathname==='/rest/v1/suppliers')return response([{id:supplier,name:'GNK',price_usage_enabled:true}]);
    if(url.pathname==='/rest/v1/rpc/set_supplier_price_usage')return options.rpcError
      ? response({message:options.rpcError},409)
      : response({supplier_id:supplier,price_usage_enabled:false,changed:true});
    throw Error('Unexpected endpoint '+url.pathname);
  };
  try {
    const req=new Request('https://portal.next-master.com/api/supplier-price-usage',{method,
      headers:options.noAuth?{}:{authorization:'Bearer '+token},
      ...(method==='POST'?{body:options.rawBody ?? JSON.stringify(options.body ?? {supplierId:supplier,enabled:false,expectedEnabled:true,reason:'New GNK list'})}:{})});
    const result=await handler(req,{} as any);
    const data=await result.json();
    assert.doesNotMatch(JSON.stringify(data),/sb_secret_synthetic|synthetic-anon|synthetic-unsigned/);
    return {status:result.status,data,calls,token};
  } finally {globalThis.fetch=priorFetch;(globalThis as any).Netlify=priorNetlify;}
}

test('usage GET scopes management read to verified profile organization',async()=>{
  const r=await invoke();
  assert.equal(r.status,200);assert.equal(r.data.suppliers[0].price_usage_enabled,true);
  const call=r.calls.find(c=>c.url.pathname==='/rest/v1/suppliers')!;
  assert.equal(call.url.searchParams.get('organization_id'),'eq.'+org);
  assert.equal(call.url.searchParams.get('select'),'id,name,price_usage_enabled');
  assert.equal((call.init?.headers as Record<string,string>).apikey,'sb_secret_synthetic');
  assert.equal((call.init?.headers as Record<string,string>).Authorization,undefined);
});

test('usage POST preserves authenticated user context and exact expected state for DB authorization',async()=>{
  const r=await invoke('POST');assert.equal(r.status,200);assert.equal(r.data.changed,true);
  const rpc=r.calls.find(c=>c.url.pathname.endsWith('/set_supplier_price_usage'))!;
  const headers=rpc.init?.headers as Record<string,string>;
  assert.equal(headers.apikey,'synthetic-anon');assert.equal(headers.Authorization,'Bearer '+r.token);
  assert.deepEqual(rpc.body,{input_supplier_id:supplier,input_enabled:false,input_expected_enabled:true,input_reason:'New GNK list'});
  assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,1);
  assert.ok(!r.calls.some(c=>/sales_orders|purchase_orders|quote_lines|supplier_prices/.test(c.url.pathname)));
});

test('usage POST rejects invalid body before any mutation',async()=>{
  for(const options of [{body:{supplierId:supplier,enabled:'false',expectedEnabled:true,reason:'test'}},{body:{supplierId:supplier,enabled:false,expectedEnabled:true,reason:'a'}},{rawBody:'{invalid'},{rawBody:' '.repeat(4097)}]){
    const r=await invoke('POST',options);assert.equal(r.status,400);
    assert.equal(r.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,0);
  }
});

test('usage endpoint returns stable conflict code without database diagnostics',async()=>{
  const r=await invoke('POST',{rpcError:'SUPPLIER_PRICE_USAGE_STALE private diagnosis'});
  assert.equal(r.status,409);assert.deepEqual(r.data,{error:'SUPPLIER_PRICE_USAGE_STALE'});
});

test('usage endpoint refuses staff and missing sessions before mutation',async()=>{
  const staff=await invoke('POST',{role:'staff'});assert.equal(staff.status,403);
  assert.equal(staff.calls.filter(c=>c.url.pathname.includes('/rpc/')).length,0);
  const anonymous=await invoke('POST',{noAuth:true});assert.equal(anonymous.status,401);assert.equal(anonymous.calls.length,0);
  const wrongMethod=await invoke('DELETE');assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.calls.length,0);
});
