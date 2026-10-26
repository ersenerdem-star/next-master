import type { Config } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { requireCallerProfile } from './_shared/auth.mts';
import { json, readJson, HttpRequestError } from './_shared/http.mts';

export default async (req: Request) => {
  if (!['GET', 'POST'].includes(req.method)) return json({ error: 'Method not allowed' }, 405);
  try {
    const caller = await requireCallerProfile(req, ['superadmin']);
    if ('error' in caller) return json({ error: caller.error }, caller.status);
    const db = createClient(caller.supabaseUrl, caller.serviceRoleKey, {
      auth: { persistSession: false },
      global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) }) },
    });
    const organizationId = caller.profile.organization_id;
    if (req.method === 'GET') {
      const params = new URL(req.url).searchParams;
      const brand = String(params.get('brand') || '').trim();
      const status = String(params.get('status') || 'pending').trim();
      const limit = Number(params.get('limit') || 50);
      const offset = Number(params.get('offset') || 0);
      if (!brand || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000 || !['pending', 'approved', 'rejected', 'all'].includes(status)) {
        return json({ error: 'Invalid review filter' }, 400);
      }
      const { data, error } = await db.rpc('get_catalog_engine_review_queue', {
        input_org: organizationId, input_brand: brand, input_status: status,
        input_limit: limit, input_offset: offset,
      });
      if (error) throw error;
      const items = (data?.items || []).map((item: Record<string, unknown>) => ({ ...item, engine: 'brand' }));
      let total = Number(data?.total || 0);
      if (['Elring', 'ZF', 'Sachs', 'Boge', 'TRW', 'Lemforder', 'Wabco'].includes(brand)) {
        const legacy = await db.rpc('get_catalog_legacy_engine_review_queue', {
          input_org: organizationId, input_brand: brand, input_status: status,
          input_limit: limit, input_offset: Math.max(0, offset - total),
        });
        if (legacy.error) throw legacy.error;
        if (items.length < limit) items.push(...(legacy.data?.items || []).slice(0, limit - items.length));
        total += Number(legacy.data?.total || 0);
      }
      return json({ total, items });
    }
    const body = await readJson<Record<string, unknown>>(req);
    const decision = String(body?.decision || '');
    const validItem = (item: Record<string, unknown>) =>
      /^[0-9a-f-]{36}$/i.test(String(item.jobId || ''))
      && Number.isInteger(item.itemIndex) && Number(item.itemIndex) >= 0
      && Number.isInteger(item.receiptIndex) && Number(item.receiptIndex) >= 0
      && Boolean(String(item.fingerprint || '')) && String(item.fingerprint).length <= 128
      && ['brand', 'zf', 'elring'].includes(String(item.engine || 'brand'));
    if (!body || !['approved', 'rejected'].includes(decision)) {
      return json({ error: 'Invalid review decision' }, 400);
    }
    const decide = async (item: Record<string, unknown>) => {
      const legacyEngine = String(item.engine || 'brand');
      const { data, error } = legacyEngine === 'brand'
        ? await db.rpc('decide_catalog_engine_review_item', {
          input_org: organizationId, input_actor: caller.profile.id,
          input_job: item.jobId, input_index: item.itemIndex,
          input_receipt_index: item.receiptIndex,
          input_fingerprint: item.fingerprint, input_decision: decision,
        })
        : await db.rpc('decide_catalog_legacy_engine_review_item', {
          input_org: organizationId, input_actor: caller.profile.id,
          input_engine: legacyEngine, input_job: item.jobId, input_index: item.itemIndex,
          input_fingerprint: item.fingerprint, input_decision: decision,
        });
      if (error) throw Error(/REVIEW_[A-Z_]+/.exec(error.message || '')?.[0] || 'REVIEW_DECISION_FAILED');
      return data;
    };
    if (Array.isArray(body.items)) {
      const items = body.items as Record<string, unknown>[];
      if (items.length < 1 || items.length > 20 || items.some((item) => !item || typeof item !== 'object' || !validItem(item))) {
        return json({ error: 'Invalid review batch' }, 400);
      }
      const identities = items.map((item) => `${item.engine || 'brand'}:${item.jobId}:${item.itemIndex}:${item.receiptIndex}`);
      if (new Set(identities).size !== items.length) return json({ error: 'Duplicate review item in batch' }, 400);
      const results: Array<{ key: string; ok: boolean; result?: unknown; error?: string }> = new Array(items.length);
      // Decision RPCs lock the same catalog job. Process a batch in order to
      // avoid lock-timeout failures when several selected rows share a job.
      for (let index = 0; index < items.length; index++) {
        try { results[index] = { key: identities[index], ok: true, result: await decide(items[index]) }; }
        catch (error) { results[index] = { key: identities[index], ok: false, error: error instanceof Error ? error.message : 'REVIEW_DECISION_FAILED' }; }
      }
      return json({ results });
    }
    if (!validItem(body)) return json({ error: 'Invalid review decision' }, 400);
    try { return json(await decide(body)); }
    catch (error) { return json({ error: error instanceof Error ? error.message : 'REVIEW_DECISION_FAILED' }, 409); }
  } catch (error) {
    if (error instanceof HttpRequestError && [401, 403].includes(error.status)) return json({ error: 'AUTH_REQUIRED' }, 401);
    console.error('catalog-engine-review failed', error instanceof Error ? error.name : 'error');
    return json({ error: 'REVIEW_REQUEST_FAILED' }, 500);
  }
};

export const config: Config = { path: '/api/catalog/engine-review' };
