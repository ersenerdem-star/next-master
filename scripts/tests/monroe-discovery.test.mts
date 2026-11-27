import assert from 'node:assert/strict';
import test from 'node:test';
import { monroeDiscoveryReceipt, runClaimedMonroeDiscovery } from '../../netlify/functions/_shared/catalog/monroe-discovery-worker.mts';

const article = { articleNumber: 'CB0001', dataSupplierId: 37, mfrName: 'MONROE' };
const response = { status: 200, totalMatchingArticles: 1, maxAllowedPage: 1, articles: [{ ...article, articleNumber: 'C-0001' }] };

test('discovery preserves the source display code and binds a receipt to its page', () => {
  const receipt = monroeDiscoveryReceipt(response, 'C', 1);
  assert.deepEqual(receipt.codes, ['C-0001']);
  assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(monroeDiscoveryReceipt(response, 'C', 1), receipt);
  assert.equal(monroeDiscoveryReceipt({ status: 200, totalMatchingArticles: 0, maxAllowedPage: 0, articles: [] }, 'Q', 1).lastPage, 0);
});

test('discovery refuses truncation, source errors, and brand or prefix mismatches', () => {
  assert.throws(() => monroeDiscoveryReceipt({ ...response, totalMatchingArticles: 20001, maxAllowedPage: 100 }, 'C', 1), /PAGINATION/);
  assert.throws(() => monroeDiscoveryReceipt({ ...response, status: 403 }, 'C', 1), /PAGINATION/);
  assert.throws(() => monroeDiscoveryReceipt({ ...response, articles: [{ ...article, dataSupplierId: 9 }] }, 'C', 1), /IDENTITY/);
  assert.throws(() => monroeDiscoveryReceipt(response, 'B', 1), /IDENTITY/);
});

test('discovery sends one source request per claimed page and checkpoints transient failures', async () => {
  const source = { source_key: 'tecalliance_monroe', is_active: true, license_posture: 'internal_review_required',
    credential_boundary: 'none', rate_limit_posture: 'bounded', robots_posture: 'allowed',
    metadata: { brand_engine_read_allowed: true, allowed_brands: ['Monroe'] } };
  const calls: string[] = [];
  const db = {
    rpc: async (name: string) => {
      calls.push(name);
      return { data: { status: 'reviewed', discovered: 1 } };
    },
    from: () => ({
      select() { return this; }, eq() { return this; },
      single: async () => ({ data: source }),
    }),
  };
  const job = { id: 'job', lease_token: 'token', mode: 'stage', total_items: 1, next_index: 0,
    manifest: { adapter: 'monroe-official-discovery.v1', brand: 'Monroe', source_key: 'tecalliance_monroe', prefix: 'C', page: 1 } };
  let requests = 0;
  const result = await runClaimedMonroeDiscovery({ db, organizationId: 'org', job, fetchPage: async (prefix: string, page: number) => {
    requests++;
    assert.deepEqual([prefix, page], ['C', 1]);
    return response;
  } });
  assert.equal(requests, 1);
  assert.equal(result.status, 'reviewed');
  assert.deepEqual(calls, ['heartbeat_catalog_brand_job', 'complete_catalog_monroe_discovery']);
  calls.length = 0;
  const failure = await runClaimedMonroeDiscovery({ db, organizationId: 'org', job,
    fetchPage: async () => { throw Error('TecAlliance request failed 429'); } });
  assert.equal(failure.status, 'paused');
  assert.deepEqual(calls, ['heartbeat_catalog_brand_job', 'checkpoint_catalog_brand_job']);
});
