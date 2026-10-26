import { useEffect, useMemo, useState } from 'react';
import { decideEngineReviewBatch, decideEngineReviewItem, engineReviewItemKey, getEngineReviewQueue, type EngineReviewItem, type EngineReviewQueue } from '../../infrastructure/api/catalogEngineReviewApi';
import { listBrandEngines } from '../../infrastructure/api/zfCatalogApi';
import { useI18n } from '../../i18n/I18nProvider';
import { Button } from '../components/common/Button';
import { useActionFeedback } from '../components/common/ActionFeedback';
import { EmptyState, InlineAlert, LoadingState, PageHeader, PageShell, StatusBadge } from '../components/common/VisualPrimitives';

const PAGE_SIZE = 50;

function reasonLabel(reason: string, tr: boolean) {
  const labels: Record<string, [string, string]> = {
    EAN_IDENTITY_CONFLICT: ['EAN çelişkisi', 'EAN conflict'],
    WILMINK_DUPLICATE_ARTICLE: ['Aynı parça koduna birden fazla kaynak kaydı', 'Duplicate source article'],
    WILMINK_EXACT_IDENTITY_INVALID: ['Ürün kimliği doğrulanamadı', 'Product identity could not be verified'],
    CATALOG_PRODUCT_NOT_REGISTERED: ['Katalogda ürün yok', 'Product is not in the catalog'],
    CATALOG_IDENTITY_AMBIGUOUS: ['Katalog eşleşmesi belirsiz', 'Ambiguous catalog match'],
    WILMINK_HTTP_404: ['Kaynak sayfası bulunamadı', 'Source page not found'],
  };
  return labels[reason]?.[tr ? 0 : 1] || reason.replaceAll('_', ' ');
}

function sourceLabel(sourceKey: string) {
  return sourceKey.replace(/_v\d+$/, '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initialBrand() {
  const requested = new URLSearchParams(window.location.search).get('brand');
  return requested?.trim() || 'Elring';
}

export function CatalogEngineReviewQueue({ onOpenLegacy }: { onOpenLegacy: () => void }) {
  const { locale } = useI18n();
  const tr = locale === 'tr';
  const feedback = useActionFeedback();
  const [brand, setBrand] = useState(initialBrand);
  const [brandSearch, setBrandSearch] = useState(initialBrand);
  const [brands, setBrands] = useState<string[]>([]);
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [offset, setOffset] = useState(0);
  const [queue, setQueue] = useState<EngineReviewQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [confirmItem, setConfirmItem] = useState<EngineReviewItem | null>(null);
  const [selected, setSelected] = useState<EngineReviewItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState<'approved' | 'rejected' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState('');
  const [bulkFailures, setBulkFailures] = useState<string[]>([]);
  const visibleBrands = useMemo(() => brands.filter((name) => name.toLocaleLowerCase().includes(brandSearch.toLocaleLowerCase())).slice(0, 16), [brands, brandSearch]);
  const selectedItems = useMemo(() => (queue?.items || []).filter((item) => selectedKeys.has(engineReviewItemKey(item))), [queue, selectedKeys]);
  const allVisibleSelected = Boolean(queue?.items.length) && queue!.items.every((item) => selectedKeys.has(engineReviewItemKey(item)));
  const selectedCodes = selectedItems.map((item) => item.productCode.trim().toLocaleUpperCase());
  const canBulkApply = selectedItems.length > 0 && selectedItems.every((item) => item.canApprove) && new Set(selectedCodes).size === selectedCodes.length;

  useEffect(() => {
    let live = true;
    listBrandEngines().then((entries) => {
      if (live) setBrands(entries.map((entry) => entry.brand).sort((a, b) => a.localeCompare(b)));
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    getEngineReviewQueue(brand, status, offset, PAGE_SIZE).then((result) => {
      if (live) { setQueue(result); setBulkFailures([]); }
    }).catch((caught) => {
      if (live) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [brand, status, offset, tick]);

  function chooseBrand(value: string) {
    setBrand(value);
    setQueue(null);
    setBrandSearch(value);
    setOffset(0);
    setSelected(null);
    setSelectedKeys(new Set());
    setBulkFailures([]);
    setConfirmItem(null);
    const url = new URL(window.location.href);
    url.searchParams.set('brand', value);
    window.history.replaceState(null, '', url);
  }

  async function decide(item: EngineReviewItem, decision: 'approved' | 'rejected') {
    const key = `${item.jobId}:${item.itemIndex}:${item.receiptIndex}`;
    setBusyKey(key);
    setError('');
    try {
      const result = await decideEngineReviewItem(item, decision);
      setConfirmItem(null);
      setSelected(null);
      feedback.succeed(decision === 'approved'
        ? (result.application.status === 'applied' ? (tr ? `${item.productCode}: kaynak EAN'ı kataloğa kaydedildi.` : `${item.productCode}: source EAN saved to catalog.`) : (tr ? 'Onay kaydedildi.' : 'Approval recorded.'))
        : (tr ? `${item.productCode}: kaynak önerisi reddedildi; katalog kaydı korundu.` : `${item.productCode}: source suggestion rejected; catalog data preserved.`));
      if (queue?.items.length === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE_SIZE));
      else setTick((value) => value + 1);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      feedback.fail(message);
    } finally {
      setBusyKey('');
    }
  }

  function toggleRow(item: EngineReviewItem) {
    const key = engineReviewItemKey(item);
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function decideBulk(decision: 'approved' | 'rejected') {
    const items = selectedItems;
    if (!items.length || (decision === 'approved' && !canBulkApply)) return;
    setBulkConfirm(null);
    setBulkBusy(true);
    setBulkFailures([]);
    setError('');
    const failed: string[] = [];
    const failedKeys = new Set<string>();
    let succeeded = 0;
    for (let start = 0; start < items.length; start += 8) {
      const batch = items.slice(start, start + 8);
      setBulkProgress(`${start} / ${items.length}`);
      try {
        const response = await decideEngineReviewBatch(batch, decision);
        response.results.forEach((result, index) => {
          if (result.ok) succeeded += 1;
          else {
            failedKeys.add(result.key);
            failed.push(`${batch[index].productCode}: ${result.error || 'REVIEW_DECISION_FAILED'}`);
          }
        });
        setBulkProgress(`${start + batch.length} / ${items.length}`);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        batch.forEach((item) => { failedKeys.add(engineReviewItemKey(item)); failed.push(`${item.productCode}: ${message}`); });
      }
    }
    setSelectedKeys(failedKeys);
    setBulkFailures(failed);
    setBulkBusy(false);
    setBulkProgress('');
    setTick((value) => value + 1);
    const summary = tr
      ? `${succeeded} karar kaydedildi${failed.length ? `, ${failed.length} kayıt işlenemedi.` : '.'}`
      : `${succeeded} decisions saved${failed.length ? `, ${failed.length} items failed.` : '.'}`;
    if (failed.length) feedback.fail(summary); else feedback.succeed(summary);
  }

  const words = tr ? {
    title: 'Gözlem İncelemesi', sub: 'Motorların beklettiği ürünleri markaya göre inceleyin. Yinelenen kaynak bağlantıları ve sonradan çözülen kayıtlar tekilleştirilir. Tarama ve güvenli zenginleştirme arka planda devam eder.',
    search: 'Marka ara', pending: 'Bekleyen', approved: 'Onaylanan', rejected: 'Reddedilen', refresh: 'Yenile',
    item: 'Ürün', source: 'Kaynak', reason: 'Neden', current: 'Mevcut EAN', proposed: 'Kaynak EAN', action: 'Karar',
    apply: 'Kaynak EAN’ını uygula', reject: 'Reddet', detail: 'İncele', empty: 'Bu markada bu durumda kayıt yok.',
    cannot: 'Bu kayıt için doğrulanmış kaynak EAN’ı yok; katalog değişikliği uygulanamaz.',
    confirm: 'Bu EAN değişikliği katalog kaydına hemen yazılır. Mevcut ve kaynak değerlerini kontrol edin.',
    save: 'Değişikliği kaydet', cancel: 'Vazgeç', legacy: 'Diğer gözlem kayıtları', next: 'Sonraki', previous: 'Önceki',
    select: 'Seç', selectPage: 'Sayfadaki tümünü seç', clearSelection: 'Seçimi temizle', sameReason: 'Aynı nedenleri seç',
    selectedCount: 'seçili', bulkApply: 'Seçilenleri uygula', bulkReject: 'Seçilenleri reddet',
    duplicateHelp: 'Aynı parça kodu birkaç kaynak bağlantısında görüldü. Bağlantıların sonunda aynı WG kodu varsa bu aynı ürünün farklı sayfa adresleri olabilir. Karar vermeden bağlantıları kontrol edin; motor katalog verisini değiştirmedi.',
    bulkApplyBlocked: 'Toplu uygulama için tüm satırlarda doğrulanmış EAN bulunmalı ve her parça kodu bir kez seçilmeli. Mükerrer kaynak kayıtları yalnızca reddedilebilir.',
    bulkConfirmApply: 'Seçilen ürünlerin kaynak EAN değerleri kataloğa tek tek yazılacak. Her satır yeniden doğrulanır; uyuşmayanlar hata olarak kalır.',
    bulkConfirmReject: 'Seçilen kaynak önerileri reddedilecek. Mevcut katalog değerleri korunur.',
    failures: 'İşlenemeyen satırlar', confirmBulk: 'Kararları uygula',
  } : {
    title: 'Observation Review', sub: 'Review held catalog products by brand. Duplicate source links and subsequently resolved records are excluded. Scanning and safe enrichment continue in the background.',
    search: 'Search brand', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', refresh: 'Refresh',
    item: 'Product', source: 'Source', reason: 'Reason', current: 'Current EAN', proposed: 'Source EAN', action: 'Decision',
    apply: 'Apply source EAN', reject: 'Reject', detail: 'Review', empty: 'No records in this state for this brand.',
    cannot: 'This item has no verified source EAN, so a catalog change cannot be applied.',
    confirm: 'This EAN change will be written to the catalog immediately. Check both values first.',
    save: 'Save change', cancel: 'Cancel', legacy: 'Other observations', next: 'Next', previous: 'Previous',
    select: 'Select', selectPage: 'Select visible rows', clearSelection: 'Clear selection', sameReason: 'Select same reason',
    selectedCount: 'selected', bulkApply: 'Apply selected', bulkReject: 'Reject selected',
    duplicateHelp: 'The scan found the same part code at several links. If the links end in the same WG code, they may be different URLs for one product. Check the links before deciding; the engine did not change catalog data.',
    bulkApplyBlocked: 'Every selected row needs a verified EAN and each part code may appear only once. Duplicate source records can only be rejected.',
    bulkConfirmApply: 'Source EAN values will be written to the catalog one item at a time. Each item is rechecked; conflicts remain unresolved.',
    bulkConfirmReject: 'The selected source suggestions will be rejected. Existing catalog values stay unchanged.',
    failures: 'Items not processed', confirmBulk: 'Confirm decisions',
  };

  return <PageShell className="catalog-engine-review-page">
    <PageHeader eyebrow={words.title} title={words.title} subtitle={words.sub} actions={<>
      <Button variant="secondary" onClick={onOpenLegacy}>{words.legacy}</Button>
      <Button onClick={() => setTick((value) => value + 1)} busy={loading}>{words.refresh}</Button>
    </>} />
    <div className="catalog-engine-review-toolbar">
      <label className="field"><span className="field__label">{words.search}</span>
        <input className="field__input" value={brandSearch} onChange={(event) => setBrandSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { const exact = brands.find((name) => name.toLocaleLowerCase() === brandSearch.toLocaleLowerCase()); if (exact) chooseBrand(exact); } }} />
      </label>
      <div className="catalog-engine-review-brands" aria-label={words.search}>
        {visibleBrands.map((name) => <Button key={name} variant={name === brand ? 'primary' : 'secondary'} className="button--compact" onClick={() => chooseBrand(name)}>{name}</Button>)}
      </div>
      <div className="catalog-engine-review-tabs" role="tablist">
        {(['pending', 'approved', 'rejected'] as const).map((value) => <Button key={value} variant={status === value ? 'primary' : 'secondary'} className="button--compact" onClick={() => { setStatus(value); setOffset(0); setSelected(null); setSelectedKeys(new Set()); }}>{words[value]}</Button>)}
      </div>
    </div>
    {error ? <InlineAlert tone="danger" title={tr ? 'İşlem tamamlanamadı' : 'Action failed'}>{error}</InlineAlert> : null}
    <div className="catalog-engine-review-count"><strong>{brand}</strong> · {words[status]}: {queue ? queue.total.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US') : '—'}
      <span>{tr ? 'Karar beklerken motor çalışmaya devam eder.' : 'The engine continues while decisions are pending.'}</span></div>
    {status === 'pending' && queue?.items.length ? <div className="catalog-engine-review-bulkbar">
      <strong>{selectedItems.length} {words.selectedCount}</strong>
      <Button variant="secondary" className="button--compact" disabled={bulkBusy} onClick={() => setSelectedKeys(allVisibleSelected ? new Set() : new Set(queue.items.map(engineReviewItemKey)))}>{allVisibleSelected ? words.clearSelection : words.selectPage}</Button>
      <Button variant="secondary" className="button--compact" disabled={!selectedItems.length || bulkBusy} onClick={() => { const reason = selectedItems[0]?.reason; setSelectedKeys(new Set(queue.items.filter((item) => item.reason === reason).map(engineReviewItemKey))); }}>{words.sameReason}</Button>
      <Button variant="secondary" className="button--compact" disabled={!selectedItems.length || bulkBusy} onClick={() => setSelectedKeys(new Set())}>{words.clearSelection}</Button>
      <div className="catalog-engine-review-bulkbar__actions">
        <Button className="button--compact" disabled={!canBulkApply || bulkBusy} title={!canBulkApply && selectedItems.length ? words.bulkApplyBlocked : undefined} onClick={() => setBulkConfirm('approved')}>{words.bulkApply}</Button>
        <Button variant="secondary" className="button--compact" disabled={!selectedItems.length || bulkBusy} onClick={() => setBulkConfirm('rejected')}>{words.bulkReject}</Button>
      </div>
      {selectedItems.length && !canBulkApply ? <small>{words.bulkApplyBlocked}</small> : null}
      {bulkBusy ? <small role="status">{bulkProgress}</small> : null}
    </div> : null}
    {bulkFailures.length ? <InlineAlert tone="danger" title={words.failures}><ul>{bulkFailures.map((failure, index) => <li key={`${failure}-${index}`}>{failure}</li>)}</ul></InlineAlert> : null}
    {queue?.items.some((item) => item.reason === 'WILMINK_DUPLICATE_ARTICLE') ? <div className="catalog-engine-review-duplicate-note">{words.duplicateHelp}</div> : null}
    {loading ? <LoadingState title={tr ? 'İnceleme kayıtları yükleniyor' : 'Loading review items'} /> : queue?.items.length ? <>
      <div className="table-wrap catalog-engine-review-table-wrap"><table className="data-table catalog-engine-review-table"><thead><tr>
        {status === 'pending' ? <th><input type="checkbox" aria-label={words.selectPage} checked={allVisibleSelected} onChange={() => setSelectedKeys(allVisibleSelected ? new Set() : new Set(queue.items.map(engineReviewItemKey)))} disabled={bulkBusy} /></th> : null}
        <th>{words.item}</th><th>{words.source}</th><th>{words.reason}</th><th>{words.current}</th><th>{words.proposed}</th><th>{words.action}</th>
      </tr></thead><tbody>{queue.items.map((item) => {
        const key = `${item.jobId}:${item.itemIndex}:${item.receiptIndex}`;
        return <tr key={key} className={selected?.reviewKey === item.reviewKey ? 'data-table__row--active' : ''}>
          {status === 'pending' ? <td><input type="checkbox" aria-label={`${words.select} ${item.productCode}`} checked={selectedKeys.has(engineReviewItemKey(item))} onChange={() => toggleRow(item)} disabled={bulkBusy} /></td> : null}
          <td><strong>{item.productCode.startsWith('https://') ? (tr ? 'Kod doğrulanamadı' : 'Code unverified') : item.productCode}</strong><small>{item.currentDescription || '—'}</small></td>
          <td>{sourceLabel(item.sourceKey)}{item.sourceUrl?.startsWith('https://') ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{tr ? 'Kaynağı aç' : 'Open source'} · {item.sourceUrl.match(/\/(wg\d+)(?:[/?#]|$)/i)?.[1]?.toUpperCase() || item.sourceUrl.split('/')[2]}</a> : null}</td>
          <td><StatusBadge tone="warning">{reasonLabel(item.reason, tr)}</StatusBadge></td>
          <td>{item.currentEan || '—'}</td><td><strong>{item.sourceEan || '—'}</strong></td>
          <td><div className="catalog-engine-review-row-actions">
            <Button variant="secondary" className="button--compact" onClick={() => setSelected(selected?.reviewKey === item.reviewKey ? null : item)}>{words.detail}</Button>
            {status === 'pending' ? <><Button className="button--compact" disabled={!item.canApprove || Boolean(busyKey) || bulkBusy} onClick={() => setConfirmItem(item)}>{words.apply}</Button>
              <Button variant="secondary" className="button--compact" disabled={Boolean(busyKey) || bulkBusy} onClick={() => void decide(item, 'rejected')}>{words.reject}</Button></> : <StatusBadge tone={status === 'approved' ? 'success' : 'neutral'}>{words[status]}</StatusBadge>}
          </div></td>
        </tr>;
      })}</tbody></table></div>
      <div className="catalog-engine-review-pagination"><Button variant="secondary" disabled={offset === 0 || bulkBusy} onClick={() => { setSelectedKeys(new Set()); setOffset(Math.max(0, offset - PAGE_SIZE)); }}>{words.previous}</Button>
        <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, queue.total)} / {queue.total}</span>
        <Button variant="secondary" disabled={offset + PAGE_SIZE >= queue.total || bulkBusy} onClick={() => { setSelectedKeys(new Set()); setOffset(offset + PAGE_SIZE); }}>{words.next}</Button></div>
    </> : error && !queue ? null : <EmptyState title={words.empty} />}
    {selected ? <div className="catalog-engine-review-detail"><strong>{selected.productCode.startsWith('https://') ? (tr ? 'Kod doğrulanamadı' : 'Code unverified') : selected.productCode}</strong><p>{reasonLabel(selected.reason, tr)}</p>
      <div>{words.current}: <strong>{selected.currentEan || '—'}</strong> → {words.proposed}: <strong>{selected.sourceEan || '—'}</strong></div>
      <div>{selected.currentDescription || '—'} → {selected.sourceDescription || '—'}</div>
      {!selected.canApprove && status === 'pending' ? <p>{words.cannot}</p> : null}
    </div> : null}
    {confirmItem ? <div className="catalog-engine-review-confirm" role="dialog" aria-modal="true" aria-label={words.apply}>
      <div className="catalog-engine-review-confirm__card"><strong>{confirmItem.productCode} · {words.apply}</strong><p>{words.confirm}</p>
        <p>{words.current}: <strong>{confirmItem.currentEan || '—'}</strong> → {words.proposed}: <strong>{confirmItem.sourceEan}</strong></p>
        <div className="toolbar toolbar--wrap"><Button variant="secondary" onClick={() => setConfirmItem(null)} disabled={Boolean(busyKey)}>{words.cancel}</Button>
          <Button onClick={() => void decide(confirmItem, 'approved')} busy={Boolean(busyKey)}>{words.save}</Button></div>
      </div></div> : null}
    {bulkConfirm ? <div className="catalog-engine-review-confirm" role="dialog" aria-modal="true" aria-label={bulkConfirm === 'approved' ? words.bulkApply : words.bulkReject}>
      <div className="catalog-engine-review-confirm__card"><strong>{selectedItems.length} {words.selectedCount} · {bulkConfirm === 'approved' ? words.bulkApply : words.bulkReject}</strong>
        <p>{bulkConfirm === 'approved' ? words.bulkConfirmApply : words.bulkConfirmReject}</p>
        <div className="catalog-engine-review-confirm__codes">{selectedItems.map((item) => item.productCode).join(', ')}</div>
        <div className="toolbar toolbar--wrap"><Button variant="secondary" onClick={() => setBulkConfirm(null)}>{words.cancel}</Button>
          <Button onClick={() => void decideBulk(bulkConfirm)}>{words.confirmBulk}</Button></div>
      </div></div> : null}
  </PageShell>;
}
