export type PortalAccessRow = {
  id: string; created_at: string; party_name: string | null; email: string | null;
  event_type: string; status: string; ip_address: string | null; country_code: string | null; reason: string | null; is_legacy: boolean;
};
export type PortalAccessFilters = { fromDate: string; toDate: string; search: string; inviteId: string; event: string; status: string; country: string };
export type PortalAccessReport = { rows: PortalAccessRow[]; total: number; page: number; pageSize: number; asOf: string; parties: Array<{ id: string; name: string }>; countries: Array<{ code: string; count: number }> };

export function canViewPortalAccessReport(role: string) { return role === 'admin' || role === 'superadmin'; }

function istanbulDate(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function defaultPortalAccessFilters(now = new Date()): PortalAccessFilters {
  return { fromDate: istanbulDate(new Date(now.getTime() - 29 * 86400000)), toDate: istanbulDate(now), search: '', inviteId: '', event: '', status: '', country: '' };
}
export function portalAccessQuery(filters: PortalAccessFilters, page = 1, pageSize = 50) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(filters.toDate) || filters.fromDate > filters.toDate)
    throw new Error('PORTAL_ACCESS_DATES_INVALID');
  const start = new Date(`${filters.fromDate}T00:00:00+03:00`);
  const end = new Date(new Date(`${filters.toDate}T00:00:00+03:00`).getTime() + 86400000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() - start.getTime() > 366 * 86400000 || istanbulDate(start) !== filters.fromDate || istanbulDate(new Date(end.getTime() - 86400000)) !== filters.toDate) throw new Error('PORTAL_ACCESS_DATES_INVALID');
  return new URLSearchParams({ from: start.toISOString(), to: end.toISOString(), search: filters.search.trim(), inviteId: filters.inviteId,
    event: filters.event, status: filters.status, country: filters.country, page: String(page), pageSize: String(pageSize) });
}
export async function collectPortalAccessExport(filters: PortalAccessFilters, fetchPage: (filters: PortalAccessFilters, page: number, pageSize: number, asOf?: string) => Promise<PortalAccessReport>, asOf?: string): Promise<PortalAccessRow[]> {
  const first = await fetchPage(filters, 1, 250, asOf);
  if (first.total > 10000) throw new Error('PORTAL_ACCESS_EXPORT_LIMIT');
  const rows = [...first.rows];
  for (let page = 2; rows.length < first.total; page++) {
    const next = await fetchPage(filters, page, 250, first.asOf);
    if (next.total !== first.total || next.asOf !== first.asOf || !next.rows.length) throw new Error('PORTAL_ACCESS_EXPORT_CHANGED');
    rows.push(...next.rows);
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length || rows.length !== first.total) throw new Error('PORTAL_ACCESS_EXPORT_CHANGED');
  return rows;
}
export function portalAccessCountry(code: string | null, locale: string) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return locale === 'tr' ? 'Bilinmiyor' : 'Unknown';
  const name = new Intl.DisplayNames([locale === 'tr' ? 'tr' : 'en'], { type: 'region' }).of(code);
  return name && name !== code ? `${code} — ${name}` : code;
}
export function portalAccessEventLabel(row: Pick<PortalAccessRow, 'event_type' | 'is_legacy'>, locale: string) {
  if (row.event_type === 'portal_login' && row.is_legacy) return locale === 'tr' ? 'Giriş / oturum doğrulama (eski kayıt)' : 'Login / session validation (legacy record)';
  const labels: Record<string, [string, string]> = {
    portal_login: ['Giriş', 'Login'], portal_logout: ['Çıkış', 'Logout'], portal_session_resume: ['Oturum devamı', 'Session resumed'],
    portal_session_rejected: ['Oturum reddedildi (geçersiz veya süresi dolmuş)', 'Session rejected (invalid or expired)'],
  };
  return labels[row.event_type]?.[locale === 'tr' ? 0 : 1] || row.event_type;
}
export function portalAccessStatusLabel(status: string, locale: string) {
  const labels: Record<string, [string, string]> = { ok: ['Başarılı', 'Successful'], failed: ['Başarısız', 'Failed'], rate_limited: ['Deneme sınırı', 'Rate limited'], degraded: ['Kısmi / servis sorunu', 'Degraded'] };
  return labels[status]?.[locale === 'tr' ? 0 : 1] || status;
}
export function portalAccessReason(reason: string | null, locale: string) {
  const labels: Record<string, [string, string]> = {
    explicit_logout: ['Kullanıcı çıkış yaptı', 'User signed out'],
    invalid_or_expired: ['Oturum geçersiz veya süresi dolmuş', 'Session invalid or expired'],
    session_no_longer_active: ['Oturum artık etkin değil', 'Session no longer active'],
    session_domain_mismatch: ['Oturum bu portal adresine ait değil', 'Session belongs to another portal domain'],
  };
  return reason ? labels[reason]?.[locale === 'tr' ? 0 : 1] || reason : '—';
}
export function portalAccessTime(value: string, locale: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
