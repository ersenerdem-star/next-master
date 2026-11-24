import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePortalOrderLines, searchPortalCatalog, submitPortalSalesOrder } from '../../netlify/functions/_shared/portal-orders.mts';

const service = 'https://portal-test.example.invalid';
const target = { id: 'target', name: 'VDO/Continental' };
const continental = { id: 'continental', name: 'Continental' };
const invite = (org: string, allowed: string[] = []) => ({
  id: `invite-${org}`, organization_id: org, party_type: 'customer' as const,
  party_name: 'Customer', customer_id: `customer-${org}`, vendor_id: null,
  seller_company_profile_id: null, email: 'test@example.invalid', contact_name: 'Customer',
  status: 'active' as const, access_can_view_account: true, access_can_view_invoices: true,
  access_can_view_payments: true, access_can_view_orders: true, allowed_brand_ids: allowed,
});

async function withBackend(brands: {id:string;name:string}[], run: (calls: Array<Record<string, any>>, writes: Array<Record<string, any>>) => Promise<void>) {
  const previous = globalThis.fetch;
  const calls: Array<Record<string, any>> = [];
  const writes: Array<Record<string, any>> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, service);
    let data: any = [];
    if (url.pathname.endsWith('/customers')) data = [{id:'customer',display_name:'Customer',company_name:'Customer',currency:'EUR',payment_terms:'',contract_nr:'',custom_fields:'',price_list_type:'Other',price_list_margin_percent:10}];
    else if (url.pathname.endsWith('/brands')) data = brands;
    else if (/\/cloud_current_supplier_(?:commercial|quantity)_options_service$/.test(url.pathname)) {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const brand = brands.find((item) => item.name === body.input_brand);
      if (brand && body.input_code === '001234') data = [{supplier_id:'supplier',supplier_name:'GroupAuto',brand_id:brand.id,brand:brand.name,product_code:body.input_code,description:'Part',buy_price:brand.name === 'VDO' ? 50 : 10,price_date:'2026-11-01',moq:null,order_multiple:null,stock_qty:null,valid_to:null}];
    } else if (url.pathname.endsWith('/sales_orders') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      data = [{id:body.id}];
    }
    return Response.json(data);
  };
  try { await run(calls, writes); } finally { globalThis.fetch = previous; }
}

test('VDO shorthand uses the authorized canonical brand for search, merged uploads, pricing and submit', async () => {
  await withBackend([target,continental], async (calls,writes) => {
    const customer = invite('vdo-alias-1',['target']);
    const search = await searchPortalCatalog(service,'key',customer,'001234',' vDo ');
    assert.equal(search.items[0].brand,'VDO/Continental');
    assert.equal(search.items[0].code,'001234');
    assert.equal(search.items[0].sell_price,11);
    const rows = [{code:'001234',brand:' VdO ',qty:2},{code:'001234',brand:'VDO/Continental',qty:3}];
    const prepared = await preparePortalOrderLines(service,'key',customer,rows);
    assert.equal(prepared.lines.length,1);
    assert.deepEqual([prepared.lines[0].requestedCode,prepared.lines[0].brand,prepared.lines[0].qty,prepared.lines[0].sell_price],['001234','VDO/Continental',5,11]);
    assert.ok(calls.some(call => call.input_quantity === 5));
    const preserved = await preparePortalOrderLines(service,'key',customer,rows,{savedSuppliers:[{id:'supplier',name:'GroupAuto'},{id:'supplier',name:'GroupAuto'}]});
    assert.deepEqual(preserved.lines.map(line => [line.brand,line.qty,line.sell_price]),[['VDO/Continental',2,11],['VDO/Continental',3,11]]);
    await submitPortalSalesOrder(service,'key',customer,{mode:'confirm',rows});
    assert.equal(writes.length,1);
    assert.deepEqual([writes[0].lines[0].brand,writes[0].lines[0].requestedCode,writes[0].lines[0].qty,writes[0].lines[0].sell_price],['VDO/Continental','001234',5,11]);
    assert.ok(calls.length > 0 && calls.every(call => call.input_brand === 'VDO/Continental' && call.input_code === '001234'));
    await assert.rejects(searchPortalCatalog(service,'key',invite('vdo-alias-1',['continental']),'001234','VDO'),/outside this portal scope/);
    await assert.rejects(preparePortalOrderLines(service,'key',invite('vdo-alias-1',['continental']),[rows[0]]),/outside this portal scope/);
  });
});

test('a real VDO brand wins and cannot inherit VDO/Continental access', async () => {
  await withBackend([target,{id:'standalone',name:'VDO'},continental],async (calls) => {
    const customer = invite('vdo-alias-2',['standalone']);
    const line = (await preparePortalOrderLines(service,'key',customer,[{code:'001234',brand:'vdo',qty:1}])).lines[0];
    assert.equal(line.brand,'VDO');
    assert.equal(line.sell_price,55);
    assert.equal(calls[0].input_brand,'VDO');
    await assert.rejects(preparePortalOrderLines(service,'key',invite('vdo-alias-2',['target']),[{code:'001234',brand:'VDO',qty:1}]),/outside this portal scope/);
  });
});

test('missing or ambiguous VDO mapping fails closed even for unrestricted customers', async () => {
  for (const [org,brands] of [
    ['vdo-alias-missing',[continental]],
    ['vdo-alias-ambiguous',[target,{id:'target-2',name:'VDO / Continental'}]],
    ['vdo-alias-duplicate',[target,{id:'standalone-1',name:'VDO'},{id:'standalone-2',name:'vdo'}]],
  ] as Array<[string,{id:string;name:string}[]]>) {
    await withBackend(brands,async (calls) => {
      const customer = invite(org);
      await assert.rejects(searchPortalCatalog(service,'key',customer,'001234','VDO'),/Brand not found/);
      await assert.rejects(preparePortalOrderLines(service,'key',customer,[{code:'001234',brand:'VDO',qty:1}]),/not found or ambiguous/);
      assert.equal(calls.length,0);
    });
  }
});
