import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogRow, completeMissingCatalogFieldsFromSpareto } from '../../netlify/functions/_shared/catalog/spareto-sync.mts';

const target = { brandId: 'synthetic-bosch', organizationId: 'synthetic-org', name: 'Bosch' };
const code = '0242140572';
const source = 'https://spareto.com/products/bosch-spark-plug/0-242-140-572';
const existing = {
  product_code: code, normalized_code: code, description: code,
  ean: '4047024112345', oem_no: 'OEM-EXISTING', vehicle: 'Mercedes-Benz', vehicle_model: 'W204',
  market_segment: 'Passenger cars', hs_code: '85111000', origin: 'DE', weight_kg: 0.038,
  image_url: 'https://synthetic.invalid/existing.jpg', lifecycle_status: 'active', lifecycle_note: '',
};
const card = { product_code: code, normalized_code: code, description: code, source_url: source };
const detail = { product_code: code, description: 'Spark Plug', source_url: source, lifecycle_status: 'active' };

test('a fetched detail description replaces a SKU placeholder without changing saved metadata or code zeros', () => {
  // This is fetchSparetoDetail's actual contract: description, not product_name.
  assert.equal('product_name' in detail, false);
  const row = buildCatalogRow(target, card, detail, existing, true);
  assert.equal(row.description, 'Spark Plug');
  assert.equal(row.product_code, code);
  assert.equal(row.normalized_code, code);
  for (const key of ['ean', 'oem_no', 'vehicle', 'vehicle_model', 'market_segment', 'hs_code', 'origin', 'weight_kg', 'image_url', 'lifecycle_status', 'lifecycle_note'] as const) {
    assert.equal(row[key], existing[key], `existing ${key} must survive a description fill`);
  }
});

test('a valid saved description and metadata take precedence over different listing and detail values', () => {
  const saved = { ...existing, description: 'Verified OEM spark plug' };
  const row = buildCatalogRow(target, { ...card, description: 'Listing product name' }, {
    ...detail, description: 'Source product name', ean: '9999999999999', oem_no: 'DIFFERENT-OEM',
    vehicle: 'Other vehicle', vehicle_model: 'Other model', market_segment: 'Engines', hs_code: '000000',
    origin: 'FR', weight_kg: 9, image_url: 'https://synthetic.invalid/new.jpg',
  }, saved, true);
  assert.equal(row.description, saved.description);
  for (const key of ['ean', 'oem_no', 'vehicle', 'vehicle_model', 'market_segment', 'hs_code', 'origin', 'weight_kg', 'image_url'] as const) {
    assert.equal(row[key], saved[key], `a saved ${key} is not replaced by this fill`);
  }
});

test('missing or SKU-only source text does not become an invented name from the product URL', () => {
  const row = buildCatalogRow(target, card, { ...detail, description: code }, existing, true);
  assert.equal(row.description, '');
  assert.equal(row.source_url, source, 'the descriptive URL may remain evidence without becoming a product name');
});

test('the actual helper carries a parsed Spareto page name through search, detail and update payload', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const captured: Array<Record<string, unknown>> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://synthetic.invalid/rest/v1/catalog_products?')) {
      const query = new URL(url).searchParams;
      if (init?.method === 'POST') {
        captured.push(...JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      if (query.get('select') === 'image_url' || query.get('select') === 'ean') return json([]);
      assert.equal(query.get('brand_id'), `eq.${target.brandId}`);
      return json([existing]);
    }
    if (url.startsWith('https://spareto.com/products?')) {
      assert.equal(new URL(url).searchParams.get('keywords'), code);
      const gtm = JSON.stringify({ item_id: code, item_brand: 'BOSCH', item_name: code });
      return new Response(`<div class='card bg-transparent card-product mt-4' data-variant-card-gtm-item-value='${gtm}'><a href="${source}"><img src=""></a></div>`);
    }
    if (url === source) {
      return new Response(`<html><head><meta property="og:title" content="0 242 140 572 - Spark Plug"></head><body></body></html>`);
    }
    throw Error(`Unexpected network request: ${url}`);
  };
  try {
    const result = await completeMissingCatalogFieldsFromSpareto({
      supabaseUrl: 'https://synthetic.invalid', serviceRoleKey: 'synthetic-test-key', brandName: 'Bosch',
      targetBrandId: target.brandId, organizationId: target.organizationId, concurrency: 1, limit: 1,
    });
    assert.equal(result.errorRows, 0);
    assert.equal(result.updatedRows, 1, 'a description-only improvement must be recognized as a real catalog delta');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].description, 'Spark Plug');
    assert.equal(captured[0].product_code, code);
    for (const key of ['ean', 'oem_no', 'vehicle', 'vehicle_model', 'market_segment', 'hs_code', 'origin', 'weight_kg', 'image_url'] as const) {
      assert.equal(captured[0][key], existing[key], `the actual helper must retain existing ${key}`);
    }
    assert.ok(requests.includes(source), 'the real detail reader must parse the supplied product HTML');
    assert.ok(requests.every(url => url.startsWith('https://synthetic.invalid/') || url.startsWith('https://spareto.com/products')), 'all I/O must stay within the mocked fixture routes');
  } finally { globalThis.fetch = originalFetch; }
});
