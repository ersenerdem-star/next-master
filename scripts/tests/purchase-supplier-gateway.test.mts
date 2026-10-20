import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../netlify/functions/app-rpc.mts';

test('supplier reassignment gateway enforces operations access and forwards the caller JWT to the atomic RPC', async () => {
  const previousFetch=globalThis.fetch;
  const previousNetlify=(globalThis as any).Netlify;
  let permitted=false; let dispatched=0;
  (globalThis as any).Netlify={env:{get:(key:string)=>({SUPABASE_URL:'https://po-gateway.invalid',SUPABASE_ANON_KEY:'anon-fixture',SUPABASE_SERVICE_ROLE_KEY:'service-fixture'} as Record<string,string>)[key]}};
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://po-gateway.invalid');
    if(url.pathname==='/auth/v1/user')return Response.json({id:'actor',email:'test@example.invalid'});
    if(url.pathname==='/rest/v1/profiles')return Response.json([{organization_id:'org',role:'sales',department:permitted?'purchasing':'viewer',permissions:{'purchasing.orders':permitted},is_active:true}]);
    assert.equal(url.pathname,'/rest/v1/rpc/reassign_purchase_order_supplier_atomic');
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer caller-fixture');
    assert.equal(new Headers(init?.headers).get('apikey'),'anon-fixture');
    assert.deepEqual(JSON.parse(String(init?.body)),{payload:{decision_id:'fixture-decision'}});
    dispatched++;
    return Response.json({source_order:{id:'PO-R'},target_order:{id:'PO-T'},replayed:false});
  };
  const request=()=>new Request('https://portal.example.invalid/api/app-rpc',{method:'POST',headers:{Authorization:'Bearer caller-fixture','Content-Type':'application/json'},body:JSON.stringify({name:'reassign_purchase_order_supplier_atomic',args:{payload:{decision_id:'fixture-decision'}}})});
  try {
    assert.equal((await handler(request(),{} as any)).status,403);assert.equal(dispatched,0);
    permitted=true;const result=await handler(request(),{} as any);assert.equal(result.status,200);assert.equal(dispatched,1);assert.equal((await result.json()).data.target_order.id,'PO-T');
  } finally { globalThis.fetch=previousFetch;(globalThis as any).Netlify=previousNetlify; }
});
