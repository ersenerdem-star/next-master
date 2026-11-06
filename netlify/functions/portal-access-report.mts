import type { Config, Context } from '@netlify/functions';
import { json } from './_shared/http.mts';
import { resolveSupplierUpgradeAdmin, supplierUpgradeFetch, supplierUuid, SupplierUpgradeError } from './_shared/supplier-upgrade-auth.mts';

// Reuse the strict verified active administrator/session boundary. The report
// itself is authorized and tenant-scoped again by its read-only database RPC.
const reply = (body: unknown, status = 200) => json(body, status, { 'Cache-Control': 'no-store' });
function timestamp(value: string | null, required: boolean) {
  if (value === null || value === '') { if (required) throw Error('INVALID_FILTER'); return null; }
  if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw Error('INVALID_FILTER');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59
    || Number(value.slice(17, 19)) > 59) throw Error('INVALID_FILTER');
  return value;
}
export function parsePortalAccessReportQuery(url: URL) {
  const p = url.searchParams;
  const pageRaw = p.get('page') || '1', sizeRaw = p.get('pageSize') || '50';
  if (!/^\d{1,5}$/.test(pageRaw) || !/^\d{1,3}$/.test(sizeRaw)) throw Error('INVALID_FILTER');
  const page = Number(pageRaw), size = Number(sizeRaw), search = (p.get('search') || '').trim();
  const invite = p.get('inviteId') || null, event = p.get('event') || '', status = p.get('status') || '', country = p.get('country') || '';
  const from = timestamp(p.get('from'), true), to = timestamp(p.get('to'), true), asOf = timestamp(p.get('asOf'), false);
  if (page < 1 || page > 10000 || size < 1 || size > 250 || search.length > 200
    || (invite !== null && !supplierUuid(invite))
    || !['', 'portal_login', 'portal_logout', 'portal_session_resume', 'portal_session_rejected'].includes(event)
    || !['', 'ok', 'failed', 'rate_limited', 'degraded'].includes(status)
    || (country !== '' && country !== '__unknown__' && !/^[A-Z]{2}$/.test(country))
    || Date.parse(from!) >= Date.parse(to!) || Date.parse(to!) - Date.parse(from!) > 366 * 86400000
    || (asOf !== null && Date.parse(asOf) > Date.now())) throw Error('INVALID_FILTER');
  return { input_from: from, input_to: to, input_page: page, input_page_size: size, input_search: search,
    input_invite_id: invite, input_event: event, input_status: status, input_country: country, input_as_of: asOf };
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  const url = Netlify.env.get('SUPABASE_URL'), anon = Netlify.env.get('SUPABASE_ANON_KEY'), service = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anon || !service) return reply({ error: 'Portal access report is unavailable.' }, 503);
  try {
    await resolveSupplierUpgradeAdmin(req, url, anon, service);
    let input: ReturnType<typeof parsePortalAccessReportQuery>;
    try { input = parsePortalAccessReportQuery(new URL(req.url)); }
    catch { return reply({ error: 'PORTAL_ACCESS_REPORT_INVALID_FILTER' }, 400); }
    const result = await supplierUpgradeFetch(`${url}/rest/v1/rpc/admin_portal_access_report`, {
      method: 'POST', headers: { apikey: anon, Authorization: req.headers.get('authorization')!, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }, 15_000);
    if (!result.response.ok) {
      const message = result.data && typeof result.data === 'object' && 'message' in result.data ? String(result.data.message) : '';
      if (message.includes('ADMIN_REQUIRED') || [401, 403].includes(result.response.status)) return reply({ error: 'PORTAL_ACCESS_REPORT_FORBIDDEN' }, 403);
      if (message.includes('INVALID_FILTER')) return reply({ error: 'PORTAL_ACCESS_REPORT_INVALID_FILTER' }, 400);
      return reply({ error: 'Portal access report could not be loaded.' }, 503);
    }
    return reply(result.data);
  } catch (error) {
    if (error instanceof SupplierUpgradeError) return reply({ error: error.status === 403
      ? 'Only organization administrators can view portal access logs.' : 'Sign in again to view portal access logs.' }, error.status);
    return reply({ error: 'Portal access report could not be loaded.' }, 503);
  }
};
export const config: Config = { path: '/api/portal-access-report' };
