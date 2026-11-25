import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSalesBrandCustomers, fetchSalesBrandDetails, fetchSalesBrandSummary, type SalesBrandCustomer, type SalesBrandDetail, type SalesBrandFilters, type SalesBrandSummary } from "../../infrastructure/api/salesBrandReportApi";
import { useI18n } from "../../i18n/I18nProvider";
import { buildXlsxBlobAsync, downloadBlob } from "../../shared/xlsx";
import { assertPreparedDownloadGeneration, preparedDownloadGeneration } from "../../shared/preparedDownload";
import { collectSalesBrandExport, expectedSalesBrandRows } from "../../shared/salesBrandExport";
import type { BrandOption } from "../../types/brand";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";

const PAGE_SIZE = 100;

export function SalesBrandReport({ organizationId, brands, onBack }: { organizationId: string; brands: BrandOption[]; onBack: () => void }) {
  const { locale } = useI18n();
  const tr = locale === "tr";
  const s = (turkish: string, english: string) => tr ? turkish : english;
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [brand, setBrand] = useState(""); const [customer, setCustomer] = useState(""); const [status, setStatus] = useState("");
  const [customers, setCustomers] = useState<SalesBrandCustomer[]>([]);
  const [summary, setSummary] = useState<SalesBrandSummary[]>([]); const [details, setDetails] = useState<SalesBrandDetail[]>([]);
  const [applied, setApplied] = useState<SalesBrandFilters | null>(null); const [page, setPage] = useState(0);
  const [working, setWorking] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!organizationId) return; let live = true; void fetchSalesBrandCustomers(organizationId).then((items) => { if (live) setCustomers(items); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Müşteriler yüklenemedi."); }); return () => { live = false; }; }, [organizationId]);
  const selectedCustomer = customers.find((item) => JSON.stringify([item.customer_id, item.customer_name]) === customer);
  const filters = useMemo(() => ({ organizationId, from, to, brand, customer: selectedCustomer?.customer_id || "", customerName: selectedCustomer && !selectedCustomer.customer_id ? selectedCustomer.customer_name : "", status }), [organizationId, from, to, brand, selectedCustomer, status]);
  const isCurrent = applied !== null && JSON.stringify(applied) === JSON.stringify(filters);
  const expected = expectedSalesBrandRows(summary);
  const pages = Math.max(1, Math.ceil(expected / PAGE_SIZE));
  const formatter = new Intl.NumberFormat(tr ? "tr-TR" : "en-US", { maximumFractionDigits: 6 });
  function statusLabel(value: string) { return value === "draft" ? s("Taslak", "Draft") : value === "confirmed" ? s("Onaylandı", "Confirmed") : value; }
  function errorMessage(e: unknown) { return e instanceof Error ? e.message : s("İşlem tamamlanamadı.", "The action could not be completed."); }
  async function load() {
    if (!organizationId) { setError(s("Oturum bilgisi yüklenmedi. Sayfayı yenileyin.", "Session details are not available. Refresh the page.")); return; }
    if (from && to && from > to) { setError(s("Başlangıç tarihi bitiş tarihinden sonra olamaz.", "Start date must not be after end date.")); return; }
    setWorking(true); setError(""); setNotice(s("Rapor yükleniyor…", "Loading report…"));
    try {
      const [nextSummary, firstPage] = await Promise.all([fetchSalesBrandSummary(filters), fetchSalesBrandDetails(filters, 0, PAGE_SIZE)]);
      if (!mounted.current) return;
      const count = expectedSalesBrandRows(nextSummary);
      setSummary(nextSummary); setDetails(firstPage); setApplied(filters); setPage(0);
      setNotice(s(`${count.toLocaleString("tr-TR")} kayıt bulundu.`, `${count.toLocaleString("en-US")} records found.`));
    } catch (e) { if (mounted.current) { setError(errorMessage(e)); setNotice(""); } }
    finally { if (mounted.current) setWorking(false); }
  }
  async function changePage(next: number) {
    if (!applied || !isCurrent || next < 0 || next >= pages) return;
    setWorking(true); setError(""); setNotice(s(`${next + 1}. sayfa yükleniyor…`, `Loading page ${next + 1}…`));
    try { const result = await fetchSalesBrandDetails(applied, next * PAGE_SIZE, PAGE_SIZE); if (mounted.current) { setDetails(result); setPage(next); setNotice(s(`${next + 1}. sayfa yüklendi.`, `Page ${next + 1} loaded.`)); } }
    catch (e) { if (mounted.current) { setError(errorMessage(e)); setNotice(""); } }
    finally { if (mounted.current) setWorking(false); }
  }
  async function exportExcel() {
    if (!applied || !isCurrent) return;
    const generation = preparedDownloadGeneration();
    setWorking(true); setError(""); setNotice(s("Excel hazırlanıyor; tüm sayfalar alınıyor…", "Preparing Excel; retrieving all pages…"));
    try {
      const { summary: before, details: all, count } = await collectSalesBrandExport(
        () => fetchSalesBrandSummary(applied),
        (offset, limit) => fetchSalesBrandDetails(applied, offset, limit),
        (received, total) => { if (mounted.current) setNotice(s(`Excel hazırlanıyor: ${received} / ${total} kayıt alındı.`, `Preparing Excel: ${received} / ${total} records retrieved.`)); },
      );
      const summaryHeader = [s("Marka", "Brand"), s("Para birimi", "Currency"), s("Sipariş", "Orders"), s("Satır", "Lines"), s("Adet", "Quantity"), s("Satır toplamı", "Line total"), s("Fiyatı eksik satır", "Lines missing price"), s("Miktarı eksik satır", "Lines missing quantity")];
      const detailHeader = [s("Sipariş tarihi", "Order date"), s("Sipariş no", "Order number"), s("Müşteri", "Customer"), s("Durum", "Status"), s("Marka", "Brand"), s("İstenen parça no", "Requested part number"), s("Güncel parça no", "Current part number"), s("Açıklama", "Description"), s("Adet", "Quantity"), s("Birim fiyat", "Unit price"), s("Satır toplamı", "Line total"), s("Para birimi", "Currency")];
      const workbookRows: (string | number)[][] = [[s("Marka bazında satış siparişleri özeti", "Sales orders by brand summary")],
        [`${s("Sipariş tarihi", "Order date")}: ${applied.from || "—"} / ${applied.to || "—"}`, `${s("Marka", "Brand")}: ${applied.brand || s("Tümü", "All")}`, `${s("Müşteri", "Customer")}: ${selectedCustomer?.customer_name || s("Tümü", "All")}`, `${s("Durum", "Status")}: ${applied.status || s("Tümü", "All")}`],
        [s("Satır tutarlarıdır; kargo ve sipariş genelindeki indirimler dağıtılmaz. Eksik fiyat veya miktar toplam tutara dahil edilmez.", "Line amounts; shipping and order-level discounts are not allocated. Missing prices or quantities are excluded from the amount total.")], summaryHeader, ...before.map((r) => [r.brand, r.currency, Number(r.order_count), Number(r.line_count), r.quantity == null ? "" : Number(r.quantity), r.amount == null ? "" : Number(r.amount), Number(r.missing_price_count), Number(r.missing_quantity_count)]), [], [s("Satış siparişi detayları", "Sales order details")], detailHeader, ...all.map((r) => [r.order_date || "", r.order_no || "", r.customer_name || "", statusLabel(r.status || ""), r.brand || "", String(r.requested_code || ""), String(r.product_code || ""), r.description || "", r.quantity == null ? "" : Number(r.quantity), r.unit_price == null ? "" : Number(r.unit_price), r.amount == null ? "" : Number(r.amount), r.currency || ""])];
      const blob = await buildXlsxBlobAsync("Satis siparisleri", workbookRows, [], { headerRow: before.length + 6, expectedRows: count, dataRows: all.length });
      if (!mounted.current) return;
      assertPreparedDownloadGeneration(generation);
      downloadBlob(`marka-satis-siparisleri-${new Date().toISOString().slice(0, 10)}.xlsx`, blob);
      if (mounted.current) setNotice(s(`Excel hazır: ${count} kayıt. Dosyayı kaydetmek için sağ alttaki düğmeye basın.`, `Excel ready: ${count} records. Use the button at the bottom right to save the file.`));
    } catch (e) { if (mounted.current) { setError(errorMessage(e)); setNotice(""); } }
    finally { if (mounted.current) setWorking(false); }
  }
  const customerOptions = [{ value: "", label: s("Tüm müşteriler", "All customers") }, ...customers.map((c) => ({ value: JSON.stringify([c.customer_id, c.customer_name]), label: c.customer_name || c.customer_id || "" })).sort((a, b) => a.label.localeCompare(b.label))];
  const brandOptions = [{ value: "", label: s("Tüm markalar", "All brands") }, ...[...brands.map((b) => ({ value: b.name, label: b.name })), { value: "(Marka belirtilmemiş)", label: s("Marka belirtilmemiş", "Unspecified brand") }].sort((a, b) => a.label.localeCompare(b.label))];
  return <div className="page-stack"><section className="section-card"><div className="section-card__header">
    <div className="toolbar toolbar--wrap"><Button variant="secondary" onClick={onBack} disabled={working}>{s("Temel raporlara dön", "Back to core reports")}</Button><h2>{s("Marka Bazında Satış Siparişleri", "Sales Orders by Brand")}</h2></div>
    <p>{s("Tarih filtresi sipariş tarihine uygulanır. Özet, ürün satırlarının toplamıdır; kargo ve sipariş genelindeki indirimler dağıtılmaz. Para birimleri ayrı gösterilir. Fiyatı veya miktarı eksik satırlar tutar toplamına dahil edilmez.", "Dates filter the order date. Totals cover product lines; shipping and order-level discounts are not allocated. Currencies are shown separately. Lines missing price or quantity are excluded from amount totals.")}</p>
    <p>{s("Birden fazla marka içeren sipariş her ilgili marka için sayılır; satırsız siparişler marka belirtilmemiş olarak gösterilir.", "Orders containing multiple brands are counted for each brand; orders without lines are shown as unspecified brand.")}</p>
    <div className="toolbar toolbar--wrap"><Input label={s("Sipariş tarihi başlangıç", "Order date from")} type="date" value={from} onChange={setFrom} disabled={working}/><Input label={s("Sipariş tarihi bitiş", "Order date to")} type="date" value={to} onChange={setTo} disabled={working}/><Select label={s("Marka", "Brand")} value={brand} options={brandOptions} onChange={setBrand} disabled={working}/><Select label={s("Müşteri", "Customer")} value={customer} options={customerOptions} onChange={setCustomer} disabled={working}/><Select label={s("Durum", "Status")} value={status} options={[{value:"",label:s("Tüm durumlar", "All statuses")},{value:"draft",label:s("Taslak", "Draft")},{value:"confirmed",label:s("Onaylandı", "Confirmed")}]} onChange={setStatus} disabled={working}/><Button onClick={() => void load()} disabled={working}>{s("Raporu getir", "Load report")}</Button><Button variant="secondary" onClick={() => void exportExcel()} disabled={working || !isCurrent || !expected}>{s("Tüm sonuçları Excel indir", "Download all results to Excel")}</Button></div>
    <div aria-live="polite">{notice ? <p>{notice}</p> : null}{error ? <p className="error-text" role="alert">{error}</p> : null}{applied && !isCurrent ? <p>{s("Filtreler değişti; güncel sonuçlar için raporu yeniden getirin.", "Filters changed; load the report again.")}</p> : null}</div>
  </div>{applied && isCurrent ? <div className="section-card__body"><h3>{s("Marka özeti", "Brand summary")}</h3><div className="table-wrap"><table className="data-table"><thead><tr>{[s("Marka", "Brand"),s("Para birimi", "Currency"),s("Sipariş", "Orders"),s("Satır", "Lines"),s("Adet", "Quantity"),s("Satır toplamı", "Line total"),s("Fiyatı eksik", "Missing price"),s("Miktarı eksik", "Missing quantity")].map((x) => <th key={x}>{x}</th>)}</tr></thead><tbody>{summary.map((r) => <tr key={`${r.brand}:${r.currency}`}><td>{r.brand}</td><td>{r.currency}</td><td>{formatter.format(Number(r.order_count))}</td><td>{formatter.format(Number(r.line_count))}</td><td>{r.quantity == null ? "—" : formatter.format(Number(r.quantity))}</td><td>{r.amount == null ? "—" : formatter.format(Number(r.amount))}</td><td>{formatter.format(Number(r.missing_price_count))}</td><td>{formatter.format(Number(r.missing_quantity_count))}</td></tr>)}</tbody></table></div>{!summary.length ? <p>{s("Seçilen filtrelerde sipariş bulunamadı.", "No orders match these filters.")}</p> : null}<h3>{s("Sipariş detayları", "Order details")}</h3><p>{s(`${expected} kayıttan ${details.length} kayıt gösteriliyor. Excel filtreye uyan tüm kayıtları içerir.`, `Showing ${details.length} of ${expected} records. Excel contains all filtered records.`)}</p><div className="table-wrap"><table className="data-table"><thead><tr>{[s("Tarih", "Date"),s("Sipariş", "Order"),s("Müşteri", "Customer"),s("Durum", "Status"),s("Marka", "Brand"),s("İstenen kod", "Requested code"),s("Güncel kod", "Current code"),s("Açıklama", "Description"),s("Adet", "Quantity"),s("Birim fiyat", "Unit price"),s("Satır toplamı", "Line total"),s("Para birimi", "Currency")].map((x) => <th key={x}>{x}</th>)}</tr></thead><tbody>{details.map((r) => <tr key={`${r.order_id}:${r.line_index}`}><td>{r.order_date}</td><td>{r.order_no}</td><td>{r.customer_name}</td><td>{statusLabel(r.status)}</td><td>{r.brand}</td><td>{r.requested_code}</td><td>{r.product_code}</td><td>{r.description}</td><td>{r.quantity == null ? "—" : formatter.format(Number(r.quantity))}</td><td>{r.unit_price == null ? "—" : formatter.format(Number(r.unit_price))}</td><td>{r.amount == null ? "—" : formatter.format(Number(r.amount))}</td><td>{r.currency}</td></tr>)}</tbody></table></div><div className="toolbar"><Button variant="secondary" disabled={working || page === 0} onClick={() => void changePage(page - 1)}>{s("Önceki", "Previous")}</Button><span>{s(`Sayfa ${page + 1} / ${pages}`, `Page ${page + 1} / ${pages}`)}</span><Button variant="secondary" disabled={working || page + 1 >= pages} onClick={() => void changePage(page + 1)}>{s("Sonraki", "Next")}</Button></div></div> : null}</section></div>;
}
