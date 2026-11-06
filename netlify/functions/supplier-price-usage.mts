import type { Config, Context } from '@netlify/functions';
import { json } from './_shared/http.mts';
import { resolveSupplierUpgradeAdmin, supplierUpgradeFetch, supplierUpgradeServiceHeaders, supplierUuid, SupplierUpgradeError } from './_shared/supplier-upgrade-auth.mts';

const reply = (body: unknown, status = 200) => json(body, status, { 'Cache-Control': 'no-store' });

export default async (req: Request, _context: Context) => {
  if (req.method !== 'GET' && req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const url = Netlify.env.get('SUPABASE_URL');
  const anon = Netlify.env.get('SUPABASE_ANON_KEY');
  const service = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anon || !service) return reply({ error: 'System configuration is incomplete.' }, 503);
  try {
    const caller = await resolveSupplierUpgradeAdmin(req, url, anon, service);
    if (req.method === 'GET') {
      const result = await supplierUpgradeFetch(`${url}/rest/v1/suppliers?select=id,name,price_usage_enabled&organization_id=eq.${encodeURIComponent(caller.organizationId)}&order=name`, {
        headers: supplierUpgradeServiceHeaders(service),
      });
      if (!result.response.ok || !Array.isArray(result.data)) return reply({ error: 'SUPPLIER_PRICE_USAGE_UNAVAILABLE' }, 503);
      return reply({ suppliers: result.data });
    }
    const raw = await req.text();
    if (raw.length > 4096) return reply({ error: 'INVALID_SUPPLIER_PRICE_USAGE_REQUEST' }, 400);
    let body: { supplierId?: unknown; enabled?: unknown; expectedEnabled?: unknown; reason?: unknown };
    try { body = JSON.parse(raw); } catch { return reply({ error: 'INVALID_SUPPLIER_PRICE_USAGE_REQUEST' }, 400); }
    if (!body || !supplierUuid(body.supplierId) || typeof body.enabled !== 'boolean' || typeof body.expectedEnabled !== 'boolean'
      || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 500)
      return reply({ error: 'INVALID_SUPPLIER_PRICE_USAGE_REQUEST' }, 400);
    // The RPC receives the verified user token so its role, organization and audit
    // actor checks remain authoritative. The service key is used for scoped reads only.
    const result = await supplierUpgradeFetch(`${url}/rest/v1/rpc/set_supplier_price_usage`, {
      method: 'POST', headers: { apikey: anon, Authorization: req.headers.get('authorization')!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_supplier_id: body.supplierId, input_enabled: body.enabled,
        input_expected_enabled: body.expectedEnabled, input_reason: body.reason.trim() }),
    }, 125_000);
    if (!result.response.ok) {
      const message = result.data && typeof result.data === 'object' && 'message' in result.data ? String(result.data.message) : '';
      if (/STALE|CONFLICT/.test(message)) return reply({ error: 'SUPPLIER_PRICE_USAGE_STALE' }, 409);
      if ([401, 403].includes(result.response.status)) return reply({ error: 'SUPPLIER_PRICE_USAGE_FORBIDDEN' }, 403);
      return reply({ error: 'SUPPLIER_PRICE_USAGE_FAILED' }, 503);
    }
    return reply(result.data);
  } catch (error) {
    if (error instanceof SupplierUpgradeError) return reply({ error: error.message }, error.status);
    return reply({ error: 'SUPPLIER_PRICE_USAGE_UNAVAILABLE' }, 503);
  }
};

export const config: Config = { path: '/api/supplier-price-usage' };
