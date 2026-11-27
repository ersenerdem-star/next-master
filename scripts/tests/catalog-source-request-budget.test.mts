import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetedCatalogFetch, CatalogSourceDeferred, sourceRetryAfterSeconds } from '../../netlify/functions/_shared/catalog/source-request-budget.mts';
import { runClaimedMonroeDiscovery } from '../../netlify/functions/_shared/catalog/monroe-discovery-worker.mts';

const retryAt = '2026-11-27T10:00:00Z';

test('retry-after accepts seconds and HTTP dates with bounded defaults', () => {
  assert.equal(sourceRetryAfterSeconds('120'), 120);
  assert.equal(sourceRetryAfterSeconds(null), 60);
  assert.equal(sourceRetryAfterSeconds('0'), 30);
  assert.equal(sourceRetryAfterSeconds('Fri, 27 Nov 2026 10:00:00 GMT', Date.parse('2026-11-27T09:58:30Z')), 90);
});

test('permits are shared and a budget wait sends no outbound request', async () => {
  let requests = 0;
  const fakeFetch = async () => { requests++; return new Response('ok'); };
  let issuePermit = false;
  const db = { rpc: async () => ({ data: issuePermit ? { granted: true } : { granted: false, retryAt, retryAfterMs: 60000 }, error: null }) };
  const discovery = budgetedCatalogFetch(db, 'tecalliance', fakeFetch);
  const verification = budgetedCatalogFetch(db, 'tecalliance', fakeFetch);
  await assert.rejects(discovery('https://example.com'), CatalogSourceDeferred);
  assert.equal(requests, 0);
  issuePermit = true;
  await verification('https://example.com');
  issuePermit = false;
  await assert.rejects(discovery('https://example.com'), CatalogSourceDeferred);
  assert.equal(requests, 1);
});

test('HTTP 429 sets the upstream group cooldown and returns the shared retry time', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const db = { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push([name,args]);
    return { error: null, data: name === 'acquire_catalog_source_request' ? { granted: true } : { retryAt } };
  } };
  const read = budgetedCatalogFetch(db, 'spareto', async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '150' } }));
  await assert.rejects(read('https://example.com'), e => e instanceof CatalogSourceDeferred && e.retryAt === retryAt);
  assert.deepEqual(calls, [
    ['acquire_catalog_source_request', { input_group: 'spareto' }],
    ['cooldown_catalog_source_requests', { input_group: 'spareto', input_seconds: 150 }],
  ]);
});

test('Monroe retains its discovery cursor on a shared budget wait', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const source = { source_key: 'tecalliance_monroe', is_active: true, license_posture: 'allowed',
    credential_boundary: 'none', rate_limit_posture: 'bounded', robots_posture: 'allowed',
    metadata: { brand_engine_read_allowed: true, allowed_brands: ['Monroe'] } };
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([name,args]);
      return { error: null, data: { granted: false, retryAt, retryAfterMs: 60000 } };
    },
    from: () => ({ select() { return this; }, eq() { return this; }, async single() { return { data: source }; } }),
  };
  const job = { id: 'job', lease_token: 'token', mode: 'stage', total_items: 1, next_index: 0,
    manifest: { adapter: 'monroe-official-discovery.v1', brand: 'Monroe', source_key: 'tecalliance_monroe', prefix: 'C', page: 2 } };
  const result = await runClaimedMonroeDiscovery({ db, organizationId: 'org', job,
    fetchPage: async (_prefix: string, _page: number, request: typeof fetch) => request('https://example.invalid') });
  assert.equal(result.status, 'paused');
  assert.deepEqual(calls.map(([name]) => name), ['heartbeat_catalog_brand_job', 'acquire_catalog_source_request', 'defer_catalog_brand_source_request']);
  assert.deepEqual(calls[2][1], { input_org: 'org', input_job: 'job', input_token: 'token', input_retry_at: retryAt });
});

test('every registered TecAlliance brand declares the same upstream budget', async () => {
  const { listTecAllianceBrandEntries } = await import('../../netlify/functions/_shared/catalog/tecalliance-brand-registry.mts');
  const { supplierOfficialProvider } = await import('../../netlify/functions/_shared/catalog/supplier-official-completion.mts');
  const entries = listTecAllianceBrandEntries();
  assert.ok(entries.length > 15);
  for (const entry of entries) {
    const provider = supplierOfficialProvider(entry.managedBrandNames[0]);
    assert.equal(provider && 'budgetGroup' in provider ? provider.budgetGroup : null, 'tecalliance', entry.managedBrandNames[0]);
  }
});

test('approved Elring dispatcher signatures cannot authorize the generic route', async () => {
  const { brandDispatchSignature, requireBrandDispatch } = await import('../../netlify/functions/_shared/catalog/brand-dispatch.mts');
  const job = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
  const time=String(Date.now()), key='test-key', lane='catalog-elring-engine-v1';
  const req = new Request('https://example.invalid', { headers:{'x-catalog-time':time,'x-catalog-signature':brandDispatchSignature(key,job,org,time,lane)} });
  assert.doesNotThrow(() => requireBrandDispatch(req,key,job,org,lane));
  assert.throws(() => requireBrandDispatch(req,key,job,org), /BRAND_DISPATCH_DENIED/);
});

test('existing exact readers share their provider quota across entry points', async () => {
  const {brandOfficialProvider}=await import('../../netlify/functions/_shared/catalog/brand-official-provider.mts');
  const {supplierOfficialProvider}=await import('../../netlify/functions/_shared/catalog/supplier-official-completion.mts');
  const groups={Bosch:'bosch',Delphi:'delphi',Denso:'denso',Mann:'mann',SKF:'skf',Sachs:'zf',Lemforder:'zf',TRW:'zf'} as const;
  for(const [brand,group] of Object.entries(groups)){
    assert.equal(supplierOfficialProvider(brand)?.budgetGroup,group,brand);
    assert.equal(brandOfficialProvider(brand)?.budgetGroup,group,brand);
  }
  for(const brand of ['INA','LUK','FAG'])assert.equal(brandOfficialProvider(brand)?.budgetGroup,'schaeffler');
  assert.equal(brandOfficialProvider('Knorr-Bremse')?.budgetGroup,'knorr_bremse');
});

test('individual provider readers use the injected transport before making a request', async () => {
  const {brandOfficialProvider}=await import('../../netlify/functions/_shared/catalog/brand-official-provider.mts');
  const examples={Bosch:'1987302874',Delphi:'LP1708',Denso:'DCP02005',Mann:'HU 719/7 x',SKF:'VKBA 3643',
    Lemforder:'25975 01',INA:'530 0538 10','Knorr-Bremse':'K031740N00'};
  for(const [brand,code] of Object.entries(examples)){
    let requests=0;
    const provider=brandOfficialProvider(brand);
    assert.ok(provider,brand);
    await assert.rejects(provider.fetch(code,{fetchImpl:async()=>{
      requests++;
      throw new CatalogSourceDeferred(retryAt);
    }}),CatalogSourceDeferred,brand);
    assert.equal(requests,1,brand);
  }
});

test('a supplier Spareto budget wait preserves the isolated review lease and stops claiming rows', async () => {
  const {runSupplierSecondaryReviews}=await import('../../netlify/functions/_shared/catalog/supplier-secondary-worker.mts');
  const calls: Array<[string,Record<string,unknown>]>=[];
  const result=await runSupplierSecondaryReviews({
    firstClaim:{id:'row',token:'lease',brand:'Denso',code:'DCP02005'},
    async rpc(name:string,args:Record<string,unknown>){calls.push([name,args]);},
    async fetchSecondary(){throw new CatalogSourceDeferred(retryAt);},
  });
  assert.equal(result.processed,0);
  assert.deepEqual(calls,[['defer_supplier_catalog_secondary_source_request',{
    input_id:'row',input_token:'lease',input_retry_at:retryAt,
  }]]);
});
