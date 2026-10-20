import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalPurchaseOrder } from "../../../types/orders";
import { useI18n } from "../../../i18n/I18nProvider";
import { fetchPurchaseSupplierOffers, reassignPurchaseSupplier, type PurchaseSupplierChangeRequest } from "../../../infrastructure/api/ordersApi";
import { compatiblePurchaseTargets, offerBlockReason, offerForLine, sourcingTotals, type PurchaseSupplierOffer } from "../../../shared/purchaseSourcing";

const copy = {
  tr: { title: "Tedarikçi alternatifleri", intro: "Satırları seç, güncel maliyeti karşılaştır ve uygun taslak siparişe aktar. Müşterinin satış fiyatı korunur.", loading: "Güncel tedarikçi fiyatları yükleniyor…", supplier: "Yeni tedarikçi", choose: "Tedarikçi seç", target: "Hedef satın alma siparişi", own: "Aynı PO / seçili satırlar için yeni taslak", reason: "Değişiklik nedeni", placeholder: "Örn. lojistik, minimum sipariş tutarı, sevkiyat birleştirme", code: "Parça / marka", qty: "Adet", current: "Mevcut birim", next: "Yeni birim", rules: "Koşullar / fiyat tarihi", before: "Seçili satırların mevcut toplamı", after: "Yeni toplam", diff: "Maliyet farkı", apply: "Tedarikçiyi değiştir ve kaydet", retry: "İşlemin sonucunu kontrol et / yeniden dene", saving: "Kontrol ediliyor ve kaydediliyor…", cancel: "Kapat", empty: "Bu satırlar için farklı bir tedarikçinin güncel fiyatı bulunamadı.", price: "Güncel fiyat yok", quantity: "MOQ / sipariş katı uygun değil", stock: "Stok yetersiz", expired: "Fiyatın geçerliliği dolmuş", merge: "Satırlar seçilen taslak PO’ya eklenecek. Kaynak PO’da satır kalmazsa kaynak PO kapatılacak.", replace: "Tüm satırlar seçiliyse mevcut PO’nun tedarikçisi değişir. Kısmi seçimde yeni taslak PO açılır.", failed: "İşlem tamamlanamadı. Aynı kararla tekrar deneyebilirsin; sunucu fiyatı, siparişi ve işlem sonucunu yeniden kontrol eder.", selectAll: "Tüm satırları seç", unavailable: "Seçili satırların tamamı için uygun fiyat gerekli.", noChange: "Tedarikçi değişikliği yalnızca kaydedilmiş, EUR, taslak ve onaylı satış siparişine bağlı PO’larda yapılabilir.", date: "Tarih", noDate: "Tarih yok" },
  en: { title: "Supplier alternatives", intro: "Select lines, compare current costs and move them to a suitable draft order. Customer sale prices are preserved.", loading: "Loading current supplier prices…", supplier: "New supplier", choose: "Select supplier", target: "Target purchase order", own: "Same PO / new draft for selected lines", reason: "Reason for change", placeholder: "E.g. logistics, minimum order value, consolidate shipment", code: "Part / brand", qty: "Qty", current: "Current unit", next: "New unit", rules: "Terms / price date", before: "Current selected total", after: "New total", diff: "Cost difference", apply: "Change supplier and save", retry: "Check outcome / retry", saving: "Checking and saving…", cancel: "Close", empty: "No current alternative supplier prices found for these lines.", price: "No current price", quantity: "MOQ / order multiple not met", stock: "Insufficient stock", expired: "Price expired", merge: "Lines will be added to the selected draft PO. An empty source PO will be closed.", replace: "Selecting all lines changes the supplier on this PO. A partial selection creates a new draft PO.", failed: "The operation could not complete. Retry the same decision; the server checks the price, order and committed outcome again.", selectAll: "Select all lines", unavailable: "Every selected line needs an eligible price.", noChange: "Supplier changes require a saved EUR draft PO linked to a confirmed sales order.", date: "Date", noDate: "No date" },
};
export function PurchaseSupplierChoice({ order, orders, onClose, onCommitted }: {
  order: LocalPurchaseOrder; orders: LocalPurchaseOrder[]; onClose: () => void;
  onCommitted: (result: Awaited<ReturnType<typeof reassignPurchaseSupplier>>) => void;
}) {
  const { locale } = useI18n();
  const c = copy[locale === "tr" ? "tr" : "en"];
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<PurchaseSupplierChangeRequest | null>(null);
  const inFlight = useRef(false);
  const [rows, setRows] = useState<PurchaseSupplierOffer[][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [indices, setIndices] = useState(order.lines.map((_, i) => i));
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    let active = true;
    fetchPurchaseSupplierOffers(order).then(data => { if (active) setRows(data); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : c.failed); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [order]);
  const suppliers = useMemo(() => [...new Map(rows.flat().filter(o => o.supplier_id && o.supplier_name.trim().toLowerCase() !== order.supplier_name.trim().toLowerCase()).map(o => [o.supplier_id, o])).values()], [rows, order.supplier_name]);
  const supplier = suppliers.find(s => s.supplier_id === supplierId);
  const targets = compatiblePurchaseTargets(orders, order, supplier?.supplier_name || "");
  const offers = order.lines.map((l, i) => offerForLine(rows[i] || [], supplierId, l.product_code));
  const totals = sourcingTotals(order, indices, offers);
  const money = (v: number) => new Intl.NumberFormat(locale, { style: "currency", currency: order.currency }).format(v);
  const target = targets.find(t => t.id === targetId);
  const errorMessage = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const messages: Array<[string, string, string]> = [
      ["ORDER_CHANGED", "Sipariş değişmiş. Kapatıp güncel siparişle tekrar karşılaştır.", "The order changed. Close and compare the refreshed order."],
      ["TARGET_CHANGED", "Hedef PO değişmiş veya artık uygun değil. Kapatıp tekrar karşılaştır.", "The target PO changed or is no longer eligible. Close and compare again."],
      ["PRICE_CHANGED", "Tedarikçi fiyatı değişmiş. Kapatıp güncel fiyatları tekrar karşılaştır.", "Supplier prices changed. Close and compare the current prices again."],
      ["PRICE_UNAVAILABLE", "Seçili satırlardan birinde güncel fiyat bulunmuyor.", "A selected line no longer has a current price."],
      ["QUANTITY_UNAVAILABLE", "Stok, MOQ veya sipariş katı uygun değil. Hedef PO’daki mevcut adetler de kontrol edilir.", "Stock, MOQ or order multiple is not met. Existing quantities in the target PO are also checked."],
      ["VENDOR_MAPPING_REQUIRED", "Bu fiyat tedarikçisi için tek bir satın alma tedarikçisi kaydı bulunmalı. Tedarikçi kayıtlarını kontrol et.", "This price supplier needs one matching purchase vendor. Check vendor records."],
      ["ALREADY_ISSUED", "PO için fatura, teslim alma veya gönderim kaydı var; tedarikçi değiştirilemez.", "This PO has a bill, receipt or sending record; its supplier cannot be changed."],
      ["CONFIRMED_SALE_REQUIRED", "Bağlı satış siparişi onaylı olmalı.", "The linked sales order must be confirmed."],
      ["EUR_DRAFT_REQUIRED", "Bu işlem yalnızca EUR taslak PO’larda yapılabilir.", "This operation requires a draft EUR PO."],
      ["ACCESS_DENIED", "Bu işlem için yetkin bulunmuyor.", "You do not have permission for this operation."],
    ];
    const match = messages.find(([code]) => message.includes(code));
    return match ? match[locale === "tr" ? 1 : 2] : c.failed;
  };
  const ready = supplier && indices.length > 0 && totals.newTotal != null && reason.trim().length >= 3 && reason.trim().length <= 1000;
  async function submit() {
    if (inFlight.current || (!request.current && !ready)) return;
    if (!request.current) {
      const target = targets.find(t => t.id === targetId);
      request.current = { decision_id: crypto.randomUUID(), source_order_id: order.id, expected_source_updated_at: order.updated_at,
        target_order_id: target?.id || null, expected_target_updated_at: target?.updated_at || null, supplier_id: supplierId,
        line_indices: [...indices], expected_prices: indices.map(i => ({ line_index: i, buy_price: offers[i]!.buy_price })), reason: reason.trim() };
    }
    inFlight.current = true; setBusy(true); setAttempted(true); setError("");
    try { const result = await reassignPurchaseSupplier(request.current); onCommitted(result); }
    catch (e) { setError(errorMessage(e)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="purchase-sourcing-dialog" aria-labelledby="purchase-sourcing-title" onCancel={e => { e.preventDefault(); if (!inFlight.current) onClose(); }}>
    <div className="purchase-sourcing-header"><div><h2 id="purchase-sourcing-title">{c.title}</h2><p>{order.id} · {order.supplier_name} · {order.sales_order_no}</p></div><button className="button button--secondary" disabled={busy} onClick={onClose}>{c.cancel}</button></div>
    <p>{c.intro}</p>
    {error && <p role="alert" className="purchase-sourcing-error">{error}</p>}
    {loading ? <p role="status">{c.loading}</p> : <>
      {!suppliers.length && <p>{c.empty}</p>}
      <fieldset disabled={busy || attempted} className="purchase-sourcing-fields">
        <div className="purchase-sourcing-selects">
          <label className="field"><span className="field__label">{c.supplier}</span><select className="field__input" value={supplierId} onChange={e => { const id = e.target.value; setSupplierId(id); const name = suppliers.find(s => s.supplier_id === id)?.supplier_name || ""; const matches = compatiblePurchaseTargets(orders, order, name); setTargetId(matches.length === 1 ? matches[0].id : ""); }}><option value="">{c.choose}</option>{suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name} · {rows.filter((options, i) => !offerBlockReason(offerForLine(options, s.supplier_id, order.lines[i].product_code), order.lines[i].qty)).length}/{order.lines.length}</option>)}</select></label>
          <label className="field"><span className="field__label">{c.target}</span><select className="field__input" value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">{c.own}</option>{targets.map(t => <option key={t.id} value={t.id}>{t.id} · {money(t.total_amount)}</option>)}</select></label>
        </div>
        <div className="purchase-lines-scroll"><table className="purchase-sourcing-table"><thead><tr><th><input type="checkbox" aria-label={c.selectAll} checked={indices.length === order.lines.length} onChange={e => setIndices(e.target.checked ? order.lines.map((_, i) => i) : [])} /></th><th>{c.code}</th><th>{c.qty}</th><th>{c.current}</th><th>{c.next}</th><th>{c.rules}</th></tr></thead>
          <tbody>{order.lines.map((line, i) => { const o = offers[i]; const block = offerBlockReason(o, line.qty); return <tr key={i}><td><input type="checkbox" aria-label={`${line.product_code} ${line.brand}`} checked={indices.includes(i)} onChange={e => setIndices(current => e.target.checked ? [...current, i].sort((a,b) => a-b) : current.filter(n => n !== i))} /></td><td><strong>{line.product_code}</strong><small>{line.brand} · {line.description}</small></td><td>{line.qty}</td><td>{money(line.buy_price)}</td><td>{o ? money(o.buy_price) : "—"}{supplierId && block && <small className="purchase-sourcing-error">{c[block]}</small>}</td><td>{o ? <><small>MOQ: {o.moq ?? "—"} · ×{o.order_multiple ?? 1} · {locale === "tr" ? "Stok" : "Stock"}: {o.stock_qty ?? "—"}</small><small>{c.date}: {o.price_date || c.noDate}{o.valid_to ? ` → ${o.valid_to}` : ""}</small></> : "—"}</td></tr>; })}</tbody></table></div>
        <label className="field"><span className="field__label">{c.reason}</span><textarea className="field__input" value={reason} maxLength={1000} placeholder={c.placeholder} onChange={e => setReason(e.target.value)} /></label>
      </fieldset>
      <div className="purchase-sourcing-totals"><div>{c.before}<strong>{money(totals.oldTotal)}</strong></div><div>{c.after}<strong>{totals.newTotal == null ? "—" : money(totals.newTotal)}</strong></div><div>{c.diff}<strong>{totals.newTotal == null ? "—" : `${totals.newTotal - totals.oldTotal > 0 ? "+" : ""}${money(totals.newTotal - totals.oldTotal)}`}</strong></div>{target && <div>{locale === "tr" ? "Hedef PO yeni toplamı" : "New target PO total"}<strong>{totals.newTotal == null ? "—" : money(target.total_amount + totals.newTotal)}</strong></div>}</div>
      <p>{targetId ? c.merge : c.replace}</p>
      {supplierId && totals.newTotal == null && <p>{c.unavailable}</p>}
      <div className="purchase-sourcing-footer"><button className="button button--secondary" disabled={busy} onClick={onClose}>{c.cancel}</button><button className="button button--primary" disabled={busy || (!attempted && !ready)} onClick={() => void submit()}>{busy ? c.saving : attempted ? c.retry : c.apply}</button></div>
    </>}
  </dialog>;
}
