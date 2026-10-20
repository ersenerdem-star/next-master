import { useMemo, useState, type ReactNode } from "react";
import { multiplyMoney, sumMoney } from "../../../../../../shared/order-money.mjs";
import type { LocalPurchaseOrder } from "../../../types/orders";
import type { LocalVendor } from "../../../types/vendors";
import {
  assignPurchaseDecisions, filterPurchaseDecisions, offerBlockReason, purchaseDecisionRows,
  purchasePlanSummary, purchaseVendorPaymentTerms,
  type PurchaseAssignments, type PurchaseDecisionFilter, type PurchaseSupplierOffer,
} from "../../../shared/purchaseSourcing";

export const PURCHASE_DECISION_PAGE_SIZE = 40;
export function PurchaseSourcingPlanner({ order, rows, assignments, vendors, locale, onChange }: {
  order: LocalPurchaseOrder; rows: PurchaseSupplierOffer[][]; assignments: PurchaseAssignments;
  vendors: LocalVendor[]; locale: string; onChange: (assignments: PurchaseAssignments) => void;
}) {
  const tr = locale === "tr";
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PurchaseDecisionFilter>("all");
  const [focusSupplier, setFocusSupplier] = useState("");
  const [sort, setSort] = useState("original");
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<number[]>([]);
  const [bulk, setBulk] = useState("");
  const [detail, setDetail] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const decisions = useMemo(() => purchaseDecisionRows(order, rows, assignments), [order, rows, assignments]);
  const summary = useMemo(() => purchasePlanSummary(order, decisions, assignments), [order, decisions, assignments]);
  const filtered = useMemo(() => filterPurchaseDecisions(order, decisions, assignments, search, filter, sort, focusSupplier), [order, decisions, assignments, search, filter, sort, focusSupplier]);
  const suppliers = [...new Map(decisions.flatMap(d => d.offers).map(o => [o.supplier_id, o])).values()].sort((a,b) => a.supplier_name.localeCompare(b.supplier_name));
  const pages = Math.max(1, Math.ceil(filtered.length / PURCHASE_DECISION_PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PURCHASE_DECISION_PAGE_SIZE, (currentPage + 1) * PURCHASE_DECISION_PAGE_SIZE);
  const money = (v: number) => new Intl.NumberFormat(locale, { style: "currency", currency: order.currency }).format(v);
  const diff = (v: number) => `${v > 0 ? "+" : ""}${money(v)}`;
  const issueText = { price: tr ? "Fiyat yok" : "No price", quantity: tr ? "MOQ / kat" : "MOQ / multiple", stock: tr ? "Stok yetersiz" : "Insufficient stock", expired: tr ? "Süresi dolmuş" : "Expired" };
  function applyBulk() {
    const result = assignPurchaseDecisions(decisions, assignments, picked, bulk);
    onChange(result.assignments);
    setPicked([]);
    setNotice(tr ? `${picked.length - result.skipped} satıra uygulandı.${result.skipped ? ` ${result.skipped} satırda uygun fiyat/koşul bulunmadı; önceki karar korundu.` : ""}` : `Applied to ${picked.length - result.skipped} lines.${result.skipped ? ` ${result.skipped} lines had no eligible offer; previous choices were kept.` : ""}`);
  }
  function selectFiltered(checked: boolean) {
    const indices = new Set(filtered.map(d => d.index));
    setPicked(current => checked ? [...new Set([...current, ...indices])] : current.filter(i => !indices.has(i)));
  }
  return <section className="purchase-planner" aria-label={tr ? "Satın alma karar listesi" : "Purchase decision list"}>
    <div className="purchase-planner-metrics">
      <span><strong>{order.lines.length}</strong> {tr ? "satır" : "lines"}</span>
      <span><strong>{decisions.filter(d => d.savings > 0).length}</strong> {tr ? "daha ucuz alternatif" : "cheaper alternatives"}</span>
      <span><strong>{summary.changed}</strong> {tr ? "değişiklik" : "changes"}</span>
      <span>{tr ? "Plan farkı" : "Plan difference"}: <strong className={summary.delta < 0 ? "purchase-saving" : ""}>{diff(summary.delta)}</strong></span>
    </div>
    <div className="purchase-planner-tools">
      <label><span>{tr ? "Ara" : "Search"}</span><input type="search" value={search} placeholder={tr ? "Parça no, marka, açıklama" : "Part, brand, description"} onChange={e => { setSearch(e.target.value); setPage(0); setPicked([]); }} /></label>
      <label><span>{tr ? "Karşılaştır" : "Compare"}</span><select value={focusSupplier} onChange={e => {setFocusSupplier(e.target.value);setBulk(e.target.value);setPage(0);setPicked([]);}}>
        <option value="">{tr ? "En düşük uygun alternatif" : "Lowest eligible alternative"}</option>
        {suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name} · {purchaseVendorPaymentTerms(s.supplier_name,vendors) || (tr ? "Ödeme şartı yok" : "No payment terms")}</option>)}
      </select></label>
      <label><span>{tr ? "Göster" : "Show"}</span><select value={filter} onChange={e => { setFilter(e.target.value as PurchaseDecisionFilter); setPage(0); setPicked([]); }}>
        <option value="all">{tr ? "Tüm satırlar" : "All lines"}</option><option value="cheaper">{tr ? "Daha ucuz alternatif var" : "Cheaper alternative available"}</option><option value="unavailable">{tr ? "Uygun alternatif yok" : "No eligible alternative"}</option><option value="assigned">{tr ? "Değiştirilenler" : "Changed lines"}</option><option value="keep">{tr ? "Mevcutta kalanlar" : "Kept with current supplier"}</option>
      </select></label>
      <label><span>{tr ? "Sırala" : "Sort"}</span><select value={sort} onChange={e => { setSort(e.target.value); setPage(0); }}><option value="original">{tr ? "Sipariş sırası" : "Order sequence"}</option><option value="impact">{tr ? "Tutar etkisi en yüksek" : "Largest cost impact"}</option></select></label>
    </div>
    <div className="purchase-planner-bulk">
      <strong>{picked.length} {tr ? "satır seçili" : "lines selected"}</strong>
      <button type="button" className="button button--secondary" disabled={!filtered.length} onClick={() => selectFiltered(true)}>{tr ? `Filtredeki ${filtered.length} satırı seç` : `Select all ${filtered.length} filtered lines`}</button>
      <button type="button" className="button button--secondary" disabled={!picked.length} onClick={() => setPicked([])}>{tr ? "Seçimi temizle" : "Clear selection"}</button>
      <select aria-label={tr ? "Toplu tedarikçi atama" : "Bulk supplier assignment"} value={bulk} onChange={e => setBulk(e.target.value)}>
        <option value="">{tr ? "Seçililere uygula…" : "Apply to selected…"}</option>
        <option value="keep">{tr ? `Mevcutta bırak (${order.supplier_name})` : `Keep current (${order.supplier_name})`}</option>
        <option value="best">{tr ? "En düşük uygun alternatif" : "Lowest eligible alternative"}</option>
        {suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name} · {purchaseVendorPaymentTerms(s.supplier_name,vendors) || (tr ? "Şart belirtilmemiş" : "Terms unspecified")}</option>)}
      </select>
      <button type="button" className="button button--primary" disabled={!picked.length || !bulk} onClick={applyBulk}>{tr ? "Toplu ata" : "Assign selected"}</button>
    </div>
    {notice && <p className="purchase-planner-notice" role="status">{notice}</p>}
    <div className="purchase-planner-table-scroll"><table className="purchase-planner-table">
      <thead><tr>
        <th><input type="checkbox" aria-label={tr ? "Filtredeki tüm satırları seç" : "Select all filtered lines"} checked={filtered.length > 0 && filtered.every(d => picked.includes(d.index))} onChange={e => selectFiltered(e.target.checked)} /></th>
        <th>{tr ? "Parça / adet" : "Part / quantity"}</th><th>{tr ? "Mevcut alış" : "Current buy"}</th><th>{focusSupplier ? (suppliers.find(s => s.supplier_id===focusSupplier)?.supplier_name || "—") : (tr ? "En düşük alternatif" : "Lowest alternative")}</th><th>{tr ? "Kararın / birim alış" : "Your choice / unit buy"}</th><th>{tr ? "Karar farkı" : "Decision difference"}</th><th>{tr ? "Koşullar" : "Terms"}</th>
      </tr></thead>
      <tbody>{visible.map(d => {
        const line = order.lines[d.index];
        const comparison = focusSupplier ? d.offers.find(o => o.supplier_id === focusSupplier) : d.best;
        const comparisonIssue = comparison ? offerBlockReason(comparison,line.qty) : null;
        const selectedDelta = d.assigned ? sumMoney([multiplyMoney(d.assigned.buy_price,line.qty),-multiplyMoney(line.buy_price,line.qty)]) : 0;
        return <PurchaseDecisionRow key={d.index} expanded={detail === d.index} columns={7}
          row={<>
            <td><input type="checkbox" aria-label={`${line.product_code} ${d.index+1}`} checked={picked.includes(d.index)} onChange={e => setPicked(current => e.target.checked ? [...current,d.index] : current.filter(i => i !== d.index))} /></td>
            <td><strong>{line.product_code}</strong><small title={line.description}>#{d.index+1} · {line.brand} · {line.qty} {tr ? "adet" : "pcs"}</small></td>
            <td>{money(line.buy_price)}<small>{order.supplier_name}</small></td>
            <td>{comparison ? <>{money(comparison.buy_price)}<small>{comparison.supplier_name}{comparisonIssue ? "" : ` · ${diff(-d.savings)}`}</small>{comparisonIssue && <small className="purchase-sourcing-error">{issueText[comparisonIssue]}</small>}</> : <small>{tr ? "Güncel alternatif yok" : "No current alternative"}</small>}</td>
            <td><select aria-label={`${line.product_code} ${d.index+1} ${tr ? "tedarikçi" : "supplier"}`} value={assignments[d.index] || "keep"} onChange={e => onChange(assignPurchaseDecisions(decisions,assignments,[d.index],e.target.value).assignments)}>
              <option value="keep">{order.supplier_name} · {money(line.buy_price)} {tr ? "(koru)" : "(keep)"}</option>
              {d.offers.map(o => { const issue=offerBlockReason(o,line.qty); return <option key={o.supplier_id} value={o.supplier_id} disabled={Boolean(issue)}>{o.supplier_name} · {Number.isFinite(o.buy_price) ? money(o.buy_price) : "—"}{issue ? ` · ${issueText[issue]}` : ""}</option>; })}
            </select></td>
            <td className={selectedDelta < 0 ? "purchase-saving" : ""}>{d.assigned ? diff(selectedDelta) : "—"}</td>
            <td><button type="button" className="purchase-planner-detail-button" aria-expanded={detail === d.index} onClick={() => setDetail(detail === d.index ? null : d.index)}>{detail === d.index ? (tr ? "Kapat" : "Close") : (tr ? "Fiyatlar / şartlar" : "Prices / terms")}</button></td>
          </>}
          details={<div className="purchase-planner-offers"><p>{line.product_code} · {line.description}</p>{d.offers.length ? d.offers.map(o => {
            const issue = offerBlockReason(o,line.qty);
            return <article key={o.supplier_id}><strong>{o.supplier_name} · {Number.isFinite(o.buy_price) ? money(o.buy_price) : "—"}</strong>
              <span>MOQ: {o.moq ?? "—"} · ×{o.order_multiple ?? 1} · {tr ? "Stok" : "Stock"}: {o.stock_qty ?? "—"}</span>
              <span>{tr ? "Ödeme" : "Payment"}: {purchaseVendorPaymentTerms(o.supplier_name,vendors) || (tr ? "Belirtilmemiş" : "Not specified")}</span>
              <span>{o.price_date || "—"} → {o.valid_to || "—"}</span><span>{o.notes || (tr ? "Kaynak şart notu yok" : "No source terms provided")}</span>
              {issue ? <span className="purchase-sourcing-error">{issueText[issue]}</span> : <button type="button" className="button button--secondary" onClick={() => onChange(assignPurchaseDecisions(decisions,assignments,[d.index],o.supplier_id).assignments)}>{tr ? "Bu satıra ata" : "Assign this line"}</button>}
            </article>;
          }) : <p>{tr ? "Güncel alternatif fiyat yok." : "No current alternative offer."}</p>}</div>} />;
      })}</tbody>
    </table></div>
    <div className="purchase-planner-pages"><span>{filtered.length ? currentPage*PURCHASE_DECISION_PAGE_SIZE+1 : 0}–{Math.min((currentPage+1)*PURCHASE_DECISION_PAGE_SIZE,filtered.length)} / {filtered.length} {tr ? "sonuç" : "results"} · {tr ? "Sayfalar arasında seçim, filtreler arasında kararlar korunur" : "Selection persists across pages; decisions across filters"}</span>
      <button type="button" className="button button--secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage-1)}>{tr ? "Önceki" : "Previous"}</button><span>{currentPage+1}/{pages}</span><button type="button" className="button button--secondary" disabled={currentPage+1 >= pages} onClick={() => setPage(currentPage+1)}>{tr ? "Sonraki" : "Next"}</button>
    </div>
  </section>;
}

function PurchaseDecisionRow({row,details,expanded,columns}: {row:ReactNode;details:ReactNode;expanded:boolean;columns:number}) {
  return <><tr>{row}</tr>{expanded && <tr className="purchase-planner-detail-row"><td colSpan={columns}>{details}</td></tr>}</>;
}
