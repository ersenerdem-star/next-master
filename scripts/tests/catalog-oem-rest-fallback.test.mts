import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../netlify/functions/app-rpc.mts';

const org = 'b0000000-0000-4000-8000-000000000001';
const brand = 'b0000000-0000-4000-8000-000000000002';
const otherBrand = 'b0000000-0000-4000-8000-000000000003';
const ids = [
  'b0000000-0000-4000-8000-000000000011',
  'b0000000-0000-4000-8000-000000000012',
  'b0000000-0000-4000-8000-000000000013',
];
const products = [
  { id: ids[0], organization_id: org, brand_id: brand, product_code: 'CD119002', normalized_code: 'CD119002', oem_no: null },
  { id: ids[1], organization_id: org, brand_id: brand, product_code: 'CX119002', normalized_code: 'CX119002', oem_no: null },
  { id: ids[2], organization_id: org, brand_id: otherBrand, product_code: 'OTHER', normalized_code: 'OTHER', oem_no: null },
];
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ iat: 2000000000 })).toString('base64url')}.synthetic`;

test('actual gateway REST recovery returns both OE matches with organization, brand and leading-zero safeguards', async () => {
  const previousFetch = globalThis.fetch;
  const previousNetlify = (globalThis as any).Netlify;
  const calls: URL[] = [];
  let exactSku = false;
  (globalThis as any).Netlify = { env: { get: (key: string) => ({
    SUPABASE_URL: 'https://oem-fixture.invalid', SUPABASE_ANON_KEY: 'public-fixture', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture',
  } as Record<string, string>)[key] } };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'actor' });
    if (url.pathname === '/rest/v1/profiles') return Response.json([{ id: 'actor', organization_id: org, role: 'superadmin', is_active: true }]);
    if (url.pathname === '/rest/v1/rpc/search_catalog_products') return Response.json({ message: 'temporary RPC failure' }, { status: 503 });
    if (url.pathname === '/rest/v1/brands') {
      assert.equal(url.searchParams.get('organization_id'), `eq.${org}`);
      return Response.json([{ id: brand, name: 'TITANX' }, { id: otherBrand, name: 'OTHER' }]);
    }
    if (url.pathname === '/rest/v1/catalog_product_identifiers') {
      assert.equal(url.searchParams.get('organization_id'), `eq.${org}`);
      assert.equal(url.searchParams.get('identifier_type'), 'eq.oem');
      const search = url.searchParams.get('normalized_value');
      const rows = search === 'eq.000123' ? ids.map((id) => ({ catalog_product_id: id, value: '000123' })) : [];
      return Response.json(rows);
    }
    if (url.pathname === '/rest/v1/catalog_products') {
      assert.equal(url.searchParams.get('organization_id'), `eq.${org}`);
      const selected = url.searchParams.get('id');
      if (!selected) return Response.json(exactSku && url.searchParams.has('or') ? [{
        id: 'b0000000-0000-4000-8000-000000000014', organization_id: org, brand_id: brand,
        product_code: '000123', normalized_code: '000123', oem_no: null,
      }] : []);
      assert.equal(url.searchParams.get('brand_id'), `eq.${brand}`);
      const matched = products.filter((row) => selected.includes(row.id) && row.brand_id === brand);
      return Response.json(matched);
    }
    if (url.pathname === '/rest/v1/item_code_references') return Response.json([]);
    throw new Error(`unexpected fixture request: ${url}`);
  };
  const request = (search: string, page = 1, pageSize = 50) => new Request('https://portal.fixture.invalid/api/app-rpc', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cloud_catalog_page', args: {
      input_search: search, input_brand: 'TITANX', input_page: page, input_page_size: pageSize,
    } }),
  });
  try {
    const response = await handler(request('000-123'), {} as any);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.map((row: any) => row.product_code), ['CD119002', 'CX119002']);
    assert.ok(body.data.every((row: any) => row.oem_no === '000123'));
    assert.ok(body.data.every((row: any) => row.total_count === 2));
    const second = await handler(request('000-123', 2, 1), {} as any);
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).data.map((row: any) => row.product_code), ['CX119002']);
    const noZeros = await handler(request('123'), {} as any);
    assert.equal(noZeros.status, 200);
    assert.deepEqual((await noZeros.json()).data, []);
    assert.ok(calls.some((url) => url.pathname === '/rest/v1/rpc/search_catalog_products'));
    exactSku = true;
    const mixed = await handler(request('000-123'), {} as any);
    assert.equal(mixed.status, 200);
    assert.deepEqual((await mixed.json()).data.map((row: any) => row.product_code), ['000123', 'CD119002', 'CX119002']);
  } finally {
    globalThis.fetch = previousFetch;
    (globalThis as any).Netlify = previousNetlify;
  }
});
