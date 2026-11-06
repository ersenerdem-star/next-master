import { useEffect, useRef, useState } from 'react';
import { fetchPortalAccessExport, fetchPortalAccessReport, type PortalAccessReport } from '../../infrastructure/api/portalAccessReportApi';
import { defaultPortalAccessFilters, portalAccessCountry, portalAccessEventLabel, portalAccessStatusLabel, portalAccessTime, portalAccessReason, type PortalAccessFilters, type PortalAccessRow } from '../../shared/portalAccessReport';
import { useI18n } from '../../i18n/I18nProvider';
import { buildXlsxBlobAsync, downloadBlob } from '../../shared/xlsx';
import { Button } from '../components/common/Button';
import { DataTable } from '../components/common/DataTable';
import { Input } from '../components/common/Input';
import { Select } from '../components/common/Select';
import { useActionFeedback } from '../components/common/ActionFeedback';

export function PortalAccessReportPage() {
  const { locale } = useI18n();
  const tr = locale === 'tr';
  const feedback = useActionFeedback();
  const [draft, setDraft] = useState<PortalAccessFilters>(() => defaultPortalAccessFilters());
  const [filters, setFilters] = useState(draft);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<PortalAccessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const pendingFeedback = useRef(false);
  const anchor = useRef<{ scope: string; asOf?: string }>({ scope: '' });
  const dirty = JSON.stringify(draft) !== JSON.stringify(filters);
  const text = (turkish: string, english: string) => tr ? turkish : english;
  const errorMessage = (caught: unknown) => {
    const code = caught instanceof Error ? caught.message : '';
    if (code === 'PORTAL_ACCESS_DATES_INVALID') return text('Başlangıç ve bitiş tarihini kontrol edin.', 'Check the start and end dates.');
    if (code === 'PORTAL_ACCESS_FORBIDDEN' || code === 'PORTAL_ACCESS_SIGN_IN_REQUIRED') return text('Bu rapor yalnızca yönetici ve süper yönetici hesaplarına açıktır. Oturumunuzu kontrol edin.', 'This report is restricted to admin and superadmin accounts. Check your session.');
    if (code === 'PORTAL_ACCESS_EXPORT_LIMIT') return text('Excel için en fazla 10.000 kayıt alınabilir. Tarih veya kullanıcı filtresini daraltın.', 'Excel supports up to 10,000 records. Narrow the date or user filter.');
    if (code === 'PORTAL_ACCESS_EXPORT_CHANGED') return text('Dışa aktarma sırasında kayıtlar değişti. Raporu yenileyip tekrar deneyin.', 'Records changed during export. Refresh the report and retry.');
    return text('Portal giriş/çıkış kayıtları alınamadı. Yeniden deneyin.', 'Portal access records could not be loaded. Retry.');
  };

  useEffect(() => () => {
    if (pendingFeedback.current) {
      pendingFeedback.current = false;
      feedback.clear();
    }
  }, [feedback]);

  useEffect(() => {
    const request = ++version.current;
    const scope = JSON.stringify(filters) + ':' + refresh;
    if (anchor.current.scope !== scope) anchor.current = { scope };
    setLoading(true); setError('');
    void fetchPortalAccessReport(filters, page, 50, anchor.current.asOf).then(result => {
      if (version.current !== request) return;
      anchor.current.asOf = result.asOf;
      setReport(result);
      // Page navigation is a user action even before the first filter refresh.
      // Every begin must settle; the initial automatic load needs no success toast.
      if (pendingFeedback.current) {
        pendingFeedback.current = false;
        feedback.succeed(text(`${page}. sayfa yüklendi · ${result.total.toLocaleString('tr-TR')} kayıt.`, `Page ${page} loaded · ${result.total.toLocaleString('en-GB')} records.`));
      }
    }).catch(caught => {
      if (version.current !== request) return;
      pendingFeedback.current = false;
      setReport(null); const message = errorMessage(caught); setError(message); feedback.fail(message);
    }).finally(() => { if (version.current === request) setLoading(false); });
    return () => { if (version.current === request) version.current++; };
  }, [filters, page, refresh]);

  function applyFilters() {
    pendingFeedback.current = true;
    feedback.begin(text('Portal oturum kayıtları aranıyor…', 'Searching portal access records…'));
    setPage(1); setFilters({ ...draft }); setRefresh(value => value + 1);
  }
  function changePage(next: number) {
    if (loading || next === page || next < 1 || next > totalPages) return;
    pendingFeedback.current = true;
    feedback.begin(text(`${next}. sayfa yükleniyor…`, `Loading page ${next}…`));
    setPage(next);
  }
  const headers = [text('Tarih / saat (İstanbul)', 'Date / time (Istanbul)'), text('Müşteri / hesap', 'Customer / account'), text('Portal kullanıcısı', 'Portal user'), text('Olay', 'Event'), text('Sonuç', 'Outcome'), text('Ülke (IP)', 'Country (IP)'), text('IP adresi', 'IP address'), text('Açıklama', 'Reason')];
  const rowValues = (row: PortalAccessRow) => [portalAccessTime(row.created_at, locale), row.party_name || '—', row.email || '—', portalAccessEventLabel(row, locale), portalAccessStatusLabel(row.status, locale), portalAccessCountry(row.country_code, locale), row.ip_address || '—', portalAccessReason(row.reason, locale)];
  async function exportExcel() {
    setExporting(true); feedback.begin(text('Filtrelenmiş kayıtlar Excel için hazırlanıyor…', 'Preparing filtered records for Excel…'));
    try {
      const rows = await fetchPortalAccessExport(filters, report?.asOf);
      const blob = await buildXlsxBlobAsync(text('Portal Oturum Kayıtları', 'Portal Access Records'), [headers, ...rows.map(rowValues)], []);
      downloadBlob(`portal-access-${filters.fromDate}-${filters.toDate}.xlsx`, blob);
      feedback.succeed(text(`${rows.length.toLocaleString('tr-TR')} kayıt Excel olarak hazırlandı.`, `${rows.length.toLocaleString('en-GB')} records prepared as Excel.`));
    } catch (caught) { feedback.fail(errorMessage(caught)); }
    finally { setExporting(false); }
  }
  const totalPages = Math.max(1, Math.ceil((report?.total || 0) / 50));
  return <div className="page-stack">
    <section className="section-card">
      <div className="section-card__header section-card__header--row">
        <div><h2>{text('Portal Giriş / Çıkış', 'Portal Access')}</h2><p>{text('Portal kullanıcılarının giriş denemeleri, oturum devamı ve açıkça yaptığı çıkışlar.', 'Portal user login attempts, session resumptions and explicit sign-outs.')}</p></div>
        <Button variant="secondary" onClick={() => void exportExcel()} busy={exporting} disabled={loading || dirty || !report?.total}>{text('Excel indir', 'Download Excel')}</Button>
      </div>
      <div className="section-card__body">
        <div className="modal-form-grid">
          <Input label={text('Başlangıç tarihi', 'Start date')} type="date" value={draft.fromDate} onChange={fromDate => setDraft(value => ({ ...value, fromDate }))} />
          <Input label={text('Bitiş tarihi', 'End date')} type="date" value={draft.toDate} onChange={toDate => setDraft(value => ({ ...value, toDate }))} />
          <Input label={text('Kullanıcı / e-posta / IP ara', 'Search user / email / IP')} value={draft.search} onChange={search => setDraft(value => ({ ...value, search }))} onEnter={applyFilters} />
          <Select label={text('Müşteri / hesap', 'Customer / account')} value={draft.inviteId} onChange={inviteId => setDraft(value => ({ ...value, inviteId }))}
            options={[{ value: '', label: text('Tüm hesaplar', 'All accounts') }, ...(report?.parties || []).map(party => ({ value: party.id, label: party.name }))]} />
          <Select label={text('Olay', 'Event')} value={draft.event} onChange={event => setDraft(value => ({ ...value, event }))}
            options={[{ value: '', label: text('Tüm olaylar', 'All events') }, ...['portal_login', 'portal_logout', 'portal_session_resume', 'portal_session_rejected'].map(event_type => ({ value: event_type, label: portalAccessEventLabel({ event_type, is_legacy: false }, locale) }))]} />
          <Select label={text('Sonuç', 'Outcome')} value={draft.status} onChange={status => setDraft(value => ({ ...value, status }))}
            options={[{ value: '', label: text('Tüm sonuçlar', 'All outcomes') }, ...['ok', 'failed', 'rate_limited', 'degraded'].map(status => ({ value: status, label: portalAccessStatusLabel(status, locale) }))]} />
          <Select label={text('Ülke (IP)', 'Country (IP)')} value={draft.country} onChange={country => setDraft(value => ({ ...value, country }))}
            options={[{ value: '', label: text('Tüm ülkeler', 'All countries') }, ...(report?.countries || []).map(country => ({ value: country.code, label: `${portalAccessCountry(country.code === '__unknown__' ? null : country.code, locale)} (${country.count.toLocaleString(tr ? 'tr-TR' : 'en-GB')})` }))]} />
        </div>
        <div className="modal-actions"><Button onClick={applyFilters} busy={loading} busyLabel={text('Yükleniyor…', 'Loading…')}>{text(dirty ? 'Filtreleri uygula' : 'Yenile', dirty ? 'Apply filters' : 'Refresh')}</Button></div>
        {dirty ? <p role="status">{text('Filtreler değişti. Tabloyu ve Excel kapsamını güncellemek için filtreleri uygulayın.', 'Filters changed. Apply them to update the table and Excel scope.')}</p> : null}
        <p className="muted">{text('Saatler İstanbul saatidir. Ülke IP konumuna göredir; VPN nedeniyle kullanıcının fiziksel konumundan farklı olabilir.', 'Times are shown in Istanbul time. Country is based on IP location and can differ from physical location when using a VPN.')}</p>
        <details><summary>{text('Kayıt kapsamı ve eski kayıtlar', 'Coverage and legacy records')}</summary><p>{text('Eski kayıtlarda giriş ile oturum doğrulama ayrımı tutulmuyordu; geçmiş çıkış kaydı yoktur. Eski kayıtların ülkesi bilinmiyor olarak gösterilir. Tarayıcıyı kapatmak açık bir çıkış işlemi sayılmaz. Kurumla ilişkilendirilemeyen başarısız denemeler bu rapora dahil değildir.', 'Legacy records did not distinguish logins from session validations, and historical logout records do not exist. Legacy records have unknown country. Closing a browser is not an explicit sign-out. Failed attempts that cannot be associated with this organization are excluded.')}</p></details>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        <div className="meta-row" role="status">{loading ? text('Kayıtlar yükleniyor…', 'Loading records…') : error ? text('Kayıtlar yüklenemedi. Yeniden deneyin.', 'Records could not be loaded. Retry.') : text(`${(report?.total || 0).toLocaleString('tr-TR')} kayıt · Sayfa ${page} / ${totalPages}`, `${(report?.total || 0).toLocaleString('en-GB')} records · Page ${page} / ${totalPages}`)}</div>
        <DataTable rows={loading ? [] : report?.rows || []} rowKey={row => row.id} columns={headers.map((header, index) => ({ key: String(index), header, render: (row: PortalAccessRow) => rowValues(row)[index] }))}
          emptyText={loading ? text('Yükleniyor…', 'Loading…') : error ? text('Kayıtlar yüklenemedi.', 'Records could not be loaded.') : text('Bu filtrelere uygun kayıt yok.', 'No records match these filters.')} />
        <div className="modal-actions">
          <Button variant="secondary" disabled={loading || page <= 1} onClick={() => changePage(page - 1)}>{text('Önceki', 'Previous')}</Button>
          <Button variant="secondary" disabled={loading || page >= totalPages} onClick={() => changePage(page + 1)}>{text('Sonraki', 'Next')}</Button>
        </div>
      </div>
    </section>
  </div>;
}
