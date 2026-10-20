import { multiplyMoney } from "../../../../../../shared/order-money.mjs";
import type { LocalVendor } from "../../../types/vendors";
import type { LocalPurchaseOrder } from "../../../types/orders";
import { comparePurchaseSuppliers, purchaseVendorPaymentTerms, offerBlockReason, type PurchaseSupplierOffer } from "../../../shared/purchaseSourcing";

export function PurchaseSupplierComparison({ order, rows, indices, supplierId, locale, vendors, onSelectSupplier, onSelectLines }: {
  order: LocalPurchaseOrder;
  rows: PurchaseSupplierOffer[][];
  indices: number[];
  supplierId: string;
  locale: string;
  vendors: LocalVendor[];
  onSelectSupplier: (id: string) => void;
  onSelectLines: (indices: number[]) => void;
}) {
  const tr = locale === "tr";
  const money = (v: number) => new Intl.NumberFormat(locale, { style: "currency", currency: order.currency }).format(v);
  const comparisons = comparePurchaseSuppliers(order, rows, indices);
  const blocked = { price: tr ? "Güncel fiyat yok" : "No current price", quantity: tr ? "MOQ / sipariş katı uygun değil" : "MOQ / multiple not met", stock: tr ? "Stok yetersiz" : "Insufficient stock", expired: tr ? "Fiyat geçerliliği dolmuş" : "Price expired" };
  const paymentTerms = (name: string) => <small>{tr ? "Kayıtlı ödeme şartı" : "Vendor payment terms"}: {purchaseVendorPaymentTerms(name, vendors) || (tr ? "Belirtilmemiş / eşleşme yok" : "Not specified / no unique match")}</small>;
  return <section className="purchase-supplier-comparison" aria-label={tr ? "Tedarikçi alış fiyatları ve koşulları" : "Supplier buy prices and terms"}>
    <h3>{tr ? "Alış fiyatlarını ve tedarikçi koşullarını karşılaştır" : "Compare buy prices and supplier terms"}</h3>
    <p>{tr ? "Her sütun ilgili tedarikçinin kendi güncel alış fiyatıdır. Toplam ve fark yalnızca seçili satırlar içindir. Ödeme / teslim şartları kaynakta varsa notlarda gösterilir; belirtilmemiş şartlar varsayılmaz." : "Each column uses that supplier’s own current buy price. Totals and differences cover selected lines only. Payment / delivery terms appear in source notes when provided; unspecified terms are not assumed."}</p>
    <div className="purchase-lines-scroll"><table className="purchase-sourcing-table purchase-comparison-table">
      <thead><tr>
        <th><input type="checkbox" aria-label={tr ? "Tüm satırları seç" : "Select all lines"} checked={indices.length === order.lines.length} onChange={e => onSelectLines(e.target.checked ? order.lines.map((_, i) => i) : [])} /></th>
        <th>{tr ? "Parça / adet" : "Part / quantity"}</th>
        <th>{order.supplier_name}<small>{tr ? "PO’daki mevcut alış" : "Current PO buy price"}</small>{paymentTerms(order.supplier_name)}</th>
        {comparisons.map(({supplier, newTotal, oldTotal, covered}) => <th key={supplier.supplier_id} className={supplierId === supplier.supplier_id ? "purchase-comparison-selected" : ""}>
          <button type="button" className={`button button--${supplierId === supplier.supplier_id ? "primary" : "secondary"}`} aria-pressed={supplierId === supplier.supplier_id} onClick={() => onSelectSupplier(supplier.supplier_id)}>{supplier.supplier_name}{supplierId === supplier.supplier_id ? " ✓" : ""}</button>
          <small>{tr ? "Seçili toplam" : "Selected total"}: <strong>{indices.length && newTotal != null ? money(newTotal) : "—"}</strong></small>
          <small>{tr ? "Fark" : "Difference"}: {indices.length && newTotal != null ? `${newTotal > oldTotal ? "+" : ""}${money(newTotal - oldTotal)}` : "—"}</small>
          <small>{covered}/{indices.length} {tr ? "satır uygun" : "eligible lines"}</small>
          {paymentTerms(supplier.supplier_name)}
        </th>)}
      </tr></thead>
      <tbody>{order.lines.map((line, i) => <tr key={i} className={indices.includes(i) ? "" : "purchase-comparison-excluded"}>
        <td><input type="checkbox" aria-label={`${line.product_code} ${line.brand}`} checked={indices.includes(i)} onChange={e => onSelectLines(e.target.checked ? [...indices, i].sort((a,b) => a-b) : indices.filter(n => n !== i))} /></td>
        <td><strong>{line.product_code}</strong><small>{line.brand} · {line.qty} {tr ? "adet" : "pcs"}</small><small>{line.description}</small></td>
        <td><strong>{money(line.buy_price)}</strong><small>{tr ? "Birim alış" : "Unit buy price"}</small><small>{tr ? "Satır" : "Line"}: {money(multiplyMoney(line.buy_price, line.qty))}</small></td>
        {comparisons.map(({supplier, offers}) => {
          const offer = offers[i]; const issue = offerBlockReason(offer, line.qty);
          return <td key={supplier.supplier_id} className={supplierId === supplier.supplier_id ? "purchase-comparison-selected" : ""}>
            <strong>{offer ? money(offer.buy_price) : "—"}</strong>
            {offer && <>
              <small>{tr ? "Satır toplamı" : "Line total"}: {money(multiplyMoney(offer.buy_price, line.qty))}</small>
              <small>MOQ: {offer.moq ?? "—"} · ×{offer.order_multiple ?? 1} · {tr ? "Stok" : "Stock"}: {offer.stock_qty ?? "—"}</small>
              <small>{tr ? "Fiyat tarihi" : "Price date"}: {offer.price_date || "—"}</small>
              <small>{tr ? "Son geçerlilik" : "Valid until"}: {offer.valid_to || "—"}</small>
              <small className="purchase-comparison-notes">{tr ? "Kaynak notu / şartlar" : "Source notes / terms"}: {offer.notes?.trim() || (tr ? "Belirtilmemiş" : "Not specified")}</small>
            </>}
            {issue && <small className="purchase-sourcing-error">{blocked[issue]}</small>}
          </td>;
        })}
      </tr>)}</tbody>
    </table></div>
  </section>;
}
