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
    if (!body || !['approved', 'rejected'].includes(String(body.decision))
      || !/^[0-9a-f-]{36}$/i.test(String(body.jobId || ''))
      || !Number.isInteger(body.itemIndex) || !Number.isInteger(body.receiptIndex)
      || String(body.fingerprint || '').length > 128 || !String(body.fingerprint || '')) {
      return json({ error: 'Invalid review decision' }, 400);
    }
    const legacyEngine = String(body.engine || 'brand');
    if (!['brand', 'zf', 'elring'].includes(legacyEngine)) return json({ error: 'Invalid review engine' }, 400);
    const { data, error } = legacyEngine === 'brand'
      ? await db.rpc('decide_catalog_engine_review_item', {
        input_org: organizationId, input_actor: caller.profile.id,
        input_job: body.jobId, input_index: body.itemIndex,
        input_receipt_index: body.receiptIndex,
        input_fingerprint: body.fingerprint, input_decision: body.decision,
      })
      : await db.rpc('decide_catalog_legacy_engine_review_item', {
        input_org: organizationId, input_actor: caller.profile.id,
        input_engine: legacyEngine, input_job: body.jobId, input_index: body.itemIndex,
        input_fingerprint: body.fingerprint, input_decision: body.decision,
      });
    if (error) {
      const known = /REVIEW_[A-Z_]+/.exec(error.message || '')?.[0];
      return json({ error: known || 'REVIEW_DECISION_FAILED' }, 409);
    }
    return json(data);
  } catch (error) {
    if (error instanceof HttpRequestError && [401, 403].includes(error.status)) return json({ error: 'AUTH_REQUIRED' }, 401);
    console.error('catalog-engine-review failed', error instanceof Error ? error.name : 'error');
    return json({ error: 'REVIEW_REQUEST_FAILED' }, 500);
  }
};

export const config: Config = { path: '/api/catalog/engine-review' };
