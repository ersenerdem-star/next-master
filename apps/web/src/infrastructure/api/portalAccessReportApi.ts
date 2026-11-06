import { supabaseClient } from './supabaseClient';
import { collectPortalAccessExport, portalAccessQuery, type PortalAccessFilters, type PortalAccessRow, type PortalAccessReport } from '../../shared/portalAccessReport';

export type { PortalAccessReport } from '../../shared/portalAccessReport';
export async function fetchPortalAccessReport(filters: PortalAccessFilters, page = 1, pageSize = 50, asOf?: string): Promise<PortalAccessReport> {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('PORTAL_ACCESS_SIGN_IN_REQUIRED');
  const query = portalAccessQuery(filters, page, pageSize);
  if (asOf) query.set('asOf', asOf);
  const response = await fetch(`/api/portal-access-report?${query}`, {
    headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25000),
  });
  const result = await response.json().catch(() => null);
  if (response.status === 403 || response.status === 401) throw new Error('PORTAL_ACCESS_FORBIDDEN');
  if (!response.ok || !result || !Array.isArray(result.rows) || !Array.isArray(result.parties) || !Array.isArray(result.countries) || !Number.isSafeInteger(result.total) || result.total < 0 || typeof result.asOf !== 'string' || !Number.isFinite(Date.parse(result.asOf)))
    throw new Error('PORTAL_ACCESS_LOAD_FAILED');
  return result;
}

export async function fetchPortalAccessExport(filters: PortalAccessFilters, asOf?: string): Promise<PortalAccessRow[]> {
  return collectPortalAccessExport(filters, fetchPortalAccessReport, asOf);
}
