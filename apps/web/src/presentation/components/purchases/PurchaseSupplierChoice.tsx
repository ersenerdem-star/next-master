import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalVendor } from "../../../types/vendors";
import type { LocalPurchaseOrder } from "../../../types/orders";
import { useI18n } from "../../../i18n/I18nProvider";
import { applyPurchaseSourcingPlan, fetchPurchaseSupplierOffers, type PurchaseSourcingPlanRequest } from "../../../infrastructure/api/ordersApi";
import { compatiblePurchaseTargets, purchaseDecisionRows, purchasePlanSummary, purchaseVendorPaymentTerms, type PurchaseAssignments, type PurchaseSupplierOffer } from "../../../shared/purchaseSourcing";
import { PurchaseSourcingPlanner } from "./PurchaseSourcingPlanner";

export function PurchaseSupplierChoice({ order, orders, vendors, onClose, onCommitted }: {
  order: LocalPurchaseOrder; orders: LocalPurchaseOrder[]; vendors: LocalVendor[]; onClose: () => void;
  onCommitted: (result: Awaited<ReturnType<typeof applyPurchaseSourcingPlan>>) => void;
}) {
  const { locale } = useI18n();
  const tr = locale === "tr";
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<PurchaseSourcingPlanRequest | null>(null);
  const inFlight = useRef(false);
  const [rows, setRows] = useState<PurchaseSupplierOffer[][]>([]);
  const [loaded, setLoaded] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [assignments, setAssignments] = useState<PurchaseAssignments>({});
  const [targetIds, setTargetIds] = useState<Record<string,string>>({});
  const [reason, setReason] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [canRefreshPrices, setCanRefreshPrices] = useState(false);
  const [notice, setNotice] = useState("");
  const decisions = useMemo(() => purchaseDecisionRows(order,rows,assignments), [order,rows,assignments]);
  const summary = useMemo(() => purchasePlanSummary(order,decisions,assignments), [order,decisions,assignments]);
  const money = (n:number) => new Intl.NumberFormat(locale,{style:"currency",currency:order.currency}).format(n);
  const diff = (n:number) => `${n>0?"+":""}${money(n)}`;
  function targetFor(supplierId:string,supplierName:string) {
    const candidates = compatiblePurchaseTargets(orders,order,supplierName);
    const chosen = targetIds[supplierId];
    return chosen === undefined ? (candidates.length === 1 ? candidates[0] : null) : candidates.find(t => t.id===chosen) || null;
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let active = true;
    fetchPurchaseSupplierOffers(order, count => { if (active) setLoaded(count); })
      .then(data => { if (active) setRows(data); })
      .catch(e => { if (active) {setCanRefreshPrices(true);setError(e instanceof Error ? e.message : (tr ? "Fiyatlar yüklenemedi." : "Prices could not be loaded."));} })
      .finally(() => { if (active) setLoading(false); });
    return () => { active=false; };
  }, [order]);
  const ready = summary.changed>0 && !summary.invalid && summary.groups.length<=50;
  async function refreshPrices() {
    if (inFlight.current || !canRefreshPrices) return;
    inFlight.current=true;setBusy(true);setLoading(true);
    try {
      const fresh=await fetchPurchaseSupplierOffers(order,count => setLoaded(count));
      setRows(fresh);setReview(false);setAttempted(false);request.current=null;
      setError("");setCanRefreshPrices(false);
      setNotice(tr?"Güncel fiyatlar yüklendi; atamaların korundu. Tutar farkını tekrar kontrol et.":"Prices refreshed; supplier choices were kept. Review the cost difference again.");
    } catch {setError(tr?"Fiyatlar yenilenemedi; tekrar dene.":"Could not refresh prices; try again.");}
    finally {inFlight.current=false;setBusy(false);setLoading(false);}
  }
  async function submit() {
    if (inFlight.current || (!request.current && (!ready || reason.trim().length<3))) return;
    if (!request.current) {
      request.current = {
        decision_id:crypto.randomUUID(), source_order_id:order.id, expected_source_updated_at:order.updated_at, reason:reason.trim(),
        groups:summary.groups.map(g => {
          const target=targetFor(g.supplierId,g.supplierName);
          return {supplier_id:g.supplierId,target_order_id:target?.id||null,expected_target_updated_at:target?.updated_at||null,
            line_indices:[...g.indices],expected_prices:g.indices.map(i => ({line_index:i,buy_price:decisions[i].assigned!.buy_price}))};
        }),
      };
    }
    inFlight.current=true; setBusy(true); setAttempted(true); setError("");setNotice("");setCanRefreshPrices(false);
    try { onCommitted(await applyPurchaseSourcingPlan(request.current)); }
    catch(e) {
      const message=e instanceof Error?e.message:String(e);
      const codes: Array<[string,string,string]> = [
        ["ORDER_CHANGED","Kaynak PO değişmiş. Plan kaydedilmedi; kapatıp güncel siparişle tekrar dene.","The source PO changed. Nothing was saved; close and reload."],
        ["TARGET_CHANGED","Hedef PO değişmiş veya uygun değil. Plan kaydedilmedi; kapatıp tekrar karşılaştır.","A target PO changed or is ineligible. Nothing was saved; close and compare again."],
        ["PRICE_CHANGED","Bir tedarikçi fiyatı değişmiş. Planın tamamı durduruldu; güncel fiyatlarla tekrar karşılaştır.","A supplier price changed. The whole plan was stopped; compare current prices again."],
        ["PRICE_UNAVAILABLE","Bir satırda güncel fiyat yok. Planın tamamı durduruldu.","A line no longer has a current offer. The whole plan was stopped."],
        ["QUANTITY_UNAVAILABLE","Stok / MOQ / sipariş katı uygun değil. Hedef PO’daki adetler de kontrol edilir. Plan kaydedilmedi.","Stock / MOQ / multiple is not met, including existing target quantities. Nothing was saved."],
        ["VENDOR_MAPPING_REQUIRED","Tedarikçi kaydı tek bir satın alma tedarikçisiyle eşleşmeli. Plan kaydedilmedi.","A supplier needs one matching purchase vendor. Nothing was saved."],
        ["ALREADY_ISSUED","Bir PO’da fatura, teslim alma veya gönderim kaydı var. Plan kaydedilmedi.","A PO has bill, receipt or sending records. Nothing was saved."],
        ["ACCESS_DENIED","Bu işlem için yetkin bulunmuyor.","You do not have permission for this operation."],
      ];
      const known=codes.find(([code]) => message.includes(code));
      // Only explicit transactional rejections authorize replacing the request.
      // An unknown/lost response must retry the original idempotent plan.
      setCanRefreshPrices(["PRICE_CHANGED","PRICE_UNAVAILABLE","QUANTITY_UNAVAILABLE"].some(code => message.includes(code)));
      setError(known ? known[tr?1:2] : (tr ? "İşlem sonucu alınamadı. Aynı planla sonucu kontrol et / yeniden dene; önceki kayıt varsa tekrar uygulanmaz." : "The outcome could not be retrieved. Retry the same plan to check its outcome; an already committed plan is not applied twice."));
    } finally { inFlight.current=false; setBusy(false); }
  }
  return <dialog ref={dialog} className="purchase-sourcing-dialog purchase-planning-dialog" aria-labelledby="purchase-sourcing-title" onCancel={e => {e.preventDefault(); if(!inFlight.current) onClose();}}>
    <div className="purchase-sourcing-header"><div><h2 id="purchase-sourcing-title">{tr ? "Satın alma karar listesi" : "Purchase decision list"}</h2><p>{order.id} · {order.supplier_name} · {order.sales_order_no}</p></div><button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>{tr?"Kapat":"Close"}</button></div>
    {error && <div className="purchase-plan-error"><p role="alert" className="purchase-sourcing-error">{error}</p>{canRefreshPrices && <button type="button" className="button button--secondary" disabled={busy} onClick={() => void refreshPrices()}>{tr?"Güncel fiyatları yükle · kararları koru":"Refresh prices · keep decisions"}</button>}</div>}
    {notice && <p role="status" className="purchase-planner-notice">{notice}</p>}
    {loading ? <p role="status">{tr?"Güncel fiyatlar yükleniyor":"Loading current prices"}… {loaded}/{order.lines.length}</p> : <>
      <fieldset disabled={busy||attempted} className="purchase-sourcing-fields">
        {!review ? <PurchaseSourcingPlanner order={order} rows={rows} assignments={assignments} vendors={vendors} locale={locale} onChange={setAssignments} /> : <section className="purchase-plan-review" aria-label={tr?"PO dağılımını gözden geçir":"Review PO allocation"}>
          <h3>{tr?"Dağılımı kontrol et, tek seferde kaydet":"Review the allocation, save once"}</h3>
          <p>{tr ? `${summary.changed} satır, ${summary.groups.length} tedarikçiye aktarılacak. ${order.lines.length-summary.changed} satır mevcut tedarikçide kalacak. Müşterinin satış fiyatı korunur.` : `${summary.changed} lines move to ${summary.groups.length} suppliers. ${order.lines.length-summary.changed} lines stay with the current supplier. Customer sale prices are preserved.`}</p>
          <div className="purchase-plan-review-groups">{summary.groups.map(g => {
            const candidates=compatiblePurchaseTargets(orders,order,g.supplierName);
            const target=targetFor(g.supplierId,g.supplierName);
            return <article key={g.supplierId}><h4>{g.supplierName} · {g.indices.length} {tr?"satır":"lines"}</h4>
              <small>{tr?"Kayıtlı ödeme şartı":"Vendor payment terms"}: {purchaseVendorPaymentTerms(g.supplierName,vendors) || (tr?"Belirtilmemiş":"Not specified")}</small>
              <p>{money(g.oldTotal)} → <strong>{money(g.newTotal)}</strong> · {diff(g.newTotal-g.oldTotal)}</p>
              <label className="field"><span className="field__label">{tr?"Hedef PO":"Target PO"}</span><select className="field__input" value={target?.id||""} onChange={e => setTargetIds(current => ({...current,[g.supplierId]:e.target.value}))}>
                <option value="">{tr?"Ayrı taslak / mevcut PO’yu değiştir":"Separate draft / retarget source PO"}</option>{candidates.map(t => <option key={t.id} value={t.id}>{t.id} · {money(t.total_amount)}</option>)}
              </select></label>
              {target && <small>{tr?"Birleşmiş hedef PO toplamı":"Combined target PO total"}: <strong>{money(target.total_amount+g.newTotal)}</strong></small>}
            </article>;
          })}</div>
          <p>{tr?"Bu işlem taslak PO’ları düzenler; tedarikçilere sipariş göndermez. Bir fiyat veya koşul değişirse planın tamamı durdurulur.":"This updates draft POs; no orders are sent. If a price or condition changes, the entire plan is stopped."}</p>
          <label className="field"><span className="field__label">{tr?"Değişiklik nedeni":"Reason for change"}</span><textarea className="field__input" value={reason} maxLength={1000} placeholder={tr?"Örn. lojistik, sevkiyat birleştirme, ödeme şartı":"E.g. logistics, consolidated shipment, payment terms"} onChange={e => setReason(e.target.value)} /></label>
        </section>}
      </fieldset>
      <footer className="purchase-plan-footer">
        <div><strong>{summary.changed} {tr?"satır değişecek":"lines change"} · {summary.groups.length} {tr?"tedarikçi":"suppliers"}</strong><small>{tr?`Bu ${order.lines.length} satırın toplamı`:`Total for these ${order.lines.length} lines`}: {money(summary.oldTotal)} → {money(summary.newTotal)} · {tr?"Fark":"Difference"}: {diff(summary.delta)}</small></div>
        {summary.invalid>0 && <span role="alert" className="purchase-sourcing-error">{summary.stockIssues.length ? summary.stockIssues.map(g => `${g.supplier} · ${g.code}: ${g.qty} > ${g.stock}`).join("; ") : (tr?"Uygun fiyatı olmayan kararlar var.":"Some choices have no eligible offer.")}</span>}
        {!review ? <button type="button" className="button button--primary" disabled={!ready} onClick={() => setReview(true)}>{tr?"Planı gözden geçir":"Review plan"}</button> : <>
          <button type="button" className="button button--secondary" disabled={busy||attempted} onClick={() => setReview(false)}>{tr?"Kararlara dön":"Back to decisions"}</button>
          <button type="button" className="button button--primary" disabled={busy||(!attempted&&(!ready||reason.trim().length<3))} onClick={() => void submit()}>{busy?(tr?"Kontrol ediliyor ve kaydediliyor…":"Checking and saving…"):attempted?(tr?"Sonucu kontrol et / yeniden dene":"Check outcome / retry"):(tr?"Planın tamamını kaydet":"Save entire plan")}</button>
        </>}
      </footer>
    </>}
  </dialog>;
}
