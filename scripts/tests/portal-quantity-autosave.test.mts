import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuantityOnlyUpdate, savePortalQuantities, sameOrderVersion } from '../../netlify/functions/_shared/portal-quantity-autosave.mts';
import { enforcePortalRateLimit } from '../../netlify/functions/_shared/portal-rate-limit.mts';

const original={id:'order',updated_at:'2026-11-14T10:00:00.000+00:00',shipping_cost:0,discount_amount:0,lines:[{resolvedCode:'P550428',qty:60,buy_price:1.25,sell_price:2,notes:'keep',supplier_name:'GNK'},{resolvedCode:'OTHER',qty:2,buy_price:3,sell_price:5,extra:{x:1}}]};
const edit={index:0,code:'P550428',previousQty:60,qty:14};
test('equivalent timestamp formats compare equal without losing microsecond conflicts',()=>{
  assert.equal(sameOrderVersion('2026-11-15T10:19:16.831Z','2026-11-15T10:19:16.831+00:00'),true);
  assert.equal(sameOrderVersion('2026-11-15T10:19:16.831001Z','2026-11-15T10:19:16.831002+00:00'),false);
  assert.equal(sameOrderVersion('invalid','invalid'),false);
});
test('quantity update preserves prices and untouched lines while recomputing totals',()=>{
  const next=buildQuantityOnlyUpdate(original,[edit]);
  assert.deepEqual(next.lines[0],{...original.lines[0],qty:14});
  assert.deepEqual(next.lines[1],original.lines[1]);
  assert.equal(next.sales_total,38); assert.equal(next.purchase_total,23.5);
  assert.equal(original.lines[0].qty,60);
  assert.throws(()=>buildQuantityOnlyUpdate(original,[{...edit,previousQty:12}]));
  assert.throws(()=>buildQuantityOnlyUpdate(original,[edit,edit]));
  assert.throws(()=>buildQuantityOnlyUpdate(original,[{...edit,qty:0}]));
});
test('two stale concurrent saves cannot overwrite one another',async()=>{
  const savedFetch=globalThis.fetch; let current=structuredClone(original); let reads=0; let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve});
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));
    if (init?.method !== 'PATCH') { const copy=structuredClone(current); reads++; if(reads===2) release(); await barrier; return Response.json([copy]); }
    assert.equal(url.searchParams.get('portal_invite_id'),'eq.invite');
    const expected=url.searchParams.get('updated_at')?.slice(3);
    if(expected!==current.updated_at) return Response.json([]);
    current={...current,...JSON.parse(String(init.body))};
    return Response.json([{updated_at:current.updated_at}]);
  };
  try {
    const invite={id:'invite',organization_id:'org',party_type:'customer',access_can_view_orders:true};
    const both=await Promise.allSettled([savePortalQuantities('https://example.test','secret',invite,'order',original.updated_at,[edit]),savePortalQuantities('https://example.test','secret',invite,'order',original.updated_at,[{...edit,qty:15}])]);
    assert.equal(both.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(both.filter(x=>x.status==='rejected').length,1);
    assert.ok([14,15].includes(current.lines[0].qty));
    assert.deepEqual(current.lines[1],original.lines[1]);
  } finally {globalThis.fetch=savedFetch;}
});
test('first edit accepts the equivalent UTC timestamp returned by draft creation',async()=>{
  const saved=globalThis.fetch;
  globalThis.fetch=async(_input,init)=>init?.method==='PATCH' ? Response.json([{updated_at:'2026-11-14T10:00:01+00:00'}]) : Response.json([original]);
  try {const result=await savePortalQuantities('https://example.test','secret',{id:'invite',organization_id:'org',party_type:'customer',access_can_view_orders:true},'order','2026-11-14T10:00:00.000Z',[edit]);assert.equal(result.salesTotal,38);}
  finally {globalThis.fetch=saved;}
});
test('inaccessible or wrong-tenant sessions cannot update orders',async()=>{
  await assert.rejects(()=>savePortalQuantities('https://example.test','secret',{id:'i',organization_id:'o',party_type:'vendor',access_can_view_orders:true},'order',original.updated_at,[edit]));
});
test('autosaves have an independent bounded rate limit',async()=>{
  const saved=globalThis.fetch; let observed:any;
  globalThis.fetch=async(_input,init)=>{observed=JSON.parse(String(init?.body));return Response.json([{allowed:true,remaining:239}]);};
  try {const result=await enforcePortalRateLimit(new Request('https://example.test'), 'https://example.test','key','quantity_autosave','client@example.test');assert.equal(result.allowed,true);assert.equal(observed.p_route,'quantity_autosave');assert.equal(observed.p_limit,240);assert.equal(observed.p_window_seconds,600);}
  finally {globalThis.fetch=saved;}
});

test('Wahler autosave persists the current whole-line tier without touching other lines or exposing supplier costs', async () => {
  const savedFetch = globalThis.fetch;
  const sku = '411471.103D';
  const invite = {id:'invite',organization_id:'org',party_type:'customer',access_can_view_orders:true};
  let order = {...structuredClone(original), lines:[
    {resolvedCode:sku,brand:'Wahler',qty:1,buy_price:30.58,sell_price:33.64,supplier_name:'GroupAuto',notes:'keep'},
    structuredClone(original.lines[1]),
  ]};
  const expected = [
    {qty:15,buy:30.58,sell:33.64,tier:null,amount:504.60},
    {qty:16,buy:29.68,sell:32.65,tier:16,amount:522.40},
    {qty:17,buy:29.68,sell:32.65,tier:16,amount:555.05},
    {qty:256,buy:28.82,sell:31.70,tier:256,amount:8115.20},
    {qty:15,buy:30.58,sell:33.64,tier:null,amount:504.60},
  ];
  globalThis.fetch = async (input, init) => {
    if (init?.method !== 'PATCH') return Response.json([order]);
    assert.equal(new URL(String(input)).searchParams.get('updated_at'), 'eq.' + order.updated_at);
    order = {...order,...JSON.parse(String(init.body))};
    return Response.json([{updated_at:order.updated_at}]);
  };
  try {
    for (const {qty,buy,sell,tier,amount} of expected) {
      const result = await savePortalQuantities('https://example.test','secret',invite,order.id,order.updated_at,
        [{index:0,code:sku,previousQty:order.lines[0].qty,qty}], async rows => {
          assert.deepEqual(rows.map(row => [row.code,row.qty]),[[sku,qty]]);
          return [{resolvedCode:sku,brand:'Wahler',qty,buy_price:buy,sell_price:sell,supplier_name:'GroupAuto',price_date:'2026-11-12',applied_min_quantity:tier}];
        });
      assert.equal(order.lines[0].buy_price,buy);
      assert.equal(order.lines[0].sell_price,sell);
      assert.equal(order.lines[0].notes,'keep');
      assert.deepEqual(order.lines[1],original.lines[1]);
      assert.equal(result.salesTotal,amount+10);
      assert.deepEqual(result.prices,[{index:0,sellPrice:sell}]);
    }
    const previous = structuredClone(order);
    await assert.rejects(savePortalQuantities('https://example.test','secret',invite,order.id,order.updated_at,
      [{index:0,code:sku,previousQty:15,qty:16}], async () => []), /quantity price could not be verified/);
    assert.deepEqual(order,previous);
  } finally { globalThis.fetch = savedFetch; }
});
