import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewPortalAccessReport, collectPortalAccessExport, defaultPortalAccessFilters, portalAccessCountry, portalAccessEventLabel, portalAccessQuery, portalAccessTime, type PortalAccessReport, type PortalAccessRow } from '../../apps/web/src/shared/portalAccessReport.ts';

test('report uses Istanbul calendar boundaries and rejects impossible or reversed dates', () => {
  const filters = defaultPortalAccessFilters(new Date('2026-11-06T21:30:00Z'));
  assert.equal(filters.toDate, '2026-11-07');
  assert.equal(filters.fromDate, '2026-10-09');
  const query = portalAccessQuery({ ...filters, country: 'TR', search: '  member@example.invalid  ' });
  assert.equal(query.get('from'), '2026-10-08T21:00:00.000Z');
  assert.equal(query.get('to'), '2026-11-07T21:00:00.000Z');
  assert.equal(query.get('country'), 'TR');
  assert.equal(query.get('search'), 'member@example.invalid');
  assert.throws(() => portalAccessQuery({ ...filters, fromDate: '2026-02-30' }), /DATES_INVALID/);
  assert.throws(() => portalAccessQuery({ ...filters, fromDate: '2026-11-08' }), /DATES_INVALID/);
  assert.match(portalAccessTime('2026-11-06T21:30:00Z', 'tr'), /07\.11\.2026.*00:30:00/);
});

test('historical events and unknown IP country do not manufacture logout or location facts', () => {
  assert.match(portalAccessEventLabel({ event_type: 'portal_login', is_legacy: true }, 'tr'), /oturum doğrulama.*eski kayıt/);
  assert.equal(portalAccessEventLabel({ event_type: 'portal_login', is_legacy: false }, 'tr'), 'Giriş');
  assert.match(portalAccessEventLabel({ event_type: 'portal_session_rejected', is_legacy: false }, 'tr'), /geçersiz veya süresi dolmuş/);
  assert.equal(portalAccessCountry(null, 'tr'), 'Bilinmiyor');
  assert.match(portalAccessCountry('TR', 'tr'), /^TR — /);
  assert.equal(canViewPortalAccessReport('admin'), true);
  assert.equal(canViewPortalAccessReport('superadmin'), true);
  for (const role of ['sales', 'viewer', '', 'management']) assert.equal(canViewPortalAccessReport(role), false);
});

const row = (id: string): PortalAccessRow => ({ id, created_at: '2026-11-06T12:00:00Z', party_name: 'Synthetic customer', email: 'member@example.invalid', event_type: 'portal_login', status: 'ok', country_code: 'TR', ip_address: '192.0.2.1', reason: null, is_legacy: false });
const response = (rows: PortalAccessRow[], total: number, asOf = '2026-11-06T12:30:00.000Z'): PortalAccessReport => ({ rows, total, asOf, page: 1, pageSize: 250, countries: [], parties: [] });

test('Excel collection retains every filter and one server anchor across all pages', async () => {
  const filters = { ...defaultPortalAccessFilters(new Date('2026-11-06T12:00:00Z')), country: 'TR', event: 'portal_logout', search: 'member' };
  const calls: Array<{ page: number; pageSize: number; asOf?: string }> = [];
  const rows = await collectPortalAccessExport(filters, async (actual, page, pageSize, asOf) => {
    assert.equal(actual, filters); calls.push({ page, pageSize, asOf });
    return page === 1 ? response([row('first')], 2) : response([row('second')], 2);
  }, '2026-11-06T12:30:00.000Z');
  assert.deepEqual(rows.map(row => row.id), ['first', 'second']);
  assert.deepEqual(calls, [{ page: 1, pageSize: 250, asOf: '2026-11-06T12:30:00.000Z' }, { page: 2, pageSize: 250, asOf: '2026-11-06T12:30:00.000Z' }]);
});

test('Excel collection refuses oversized, inconsistent, duplicate or incomplete exports', async () => {
  const filters = defaultPortalAccessFilters();
  await assert.rejects(() => collectPortalAccessExport(filters, async () => response([], 10001)), /EXPORT_LIMIT/);
  await assert.rejects(() => collectPortalAccessExport(filters, async (_, page) => response([row(String(page))], page === 1 ? 2 : 3)), /EXPORT_CHANGED/);
  await assert.rejects(() => collectPortalAccessExport(filters, async () => response([row('duplicate')], 2)), /EXPORT_CHANGED/);
  await assert.rejects(() => collectPortalAccessExport(filters, async (_, page) => response(page === 1 ? [row('first')] : [], 2)), /EXPORT_CHANGED/);
  await assert.rejects(() => collectPortalAccessExport(filters, async (_, page) => response([row(String(page))], 2, page === 1 ? '2026-11-06T12:30:00Z' : '2026-11-06T12:31:00Z')), /EXPORT_CHANGED/);
});
