import type { LocalVendor } from "../types/vendors";
import type { LocalPurchaseOrder } from "../types/orders";
import { multiplyMoney, sumMoney } from "../../../../shared/order-money.mjs";

export interface PurchaseSupplierOffer {
  supplier_id: string;
  supplier_name: string;
  product_code: string;
  brand: string;
  buy_price: number;
  price_date: string | null;
  notes?: string | null;
  moq: number | null;
  order_multiple: number | null;
  stock_qty: number | null;
  valid_to: string | null;
}
export function exactPurchaseCode(code: string) { return code.trim().replace(/\s+/g, "").toUpperCase(); }
export function offerForLine(offers: PurchaseSupplierOffer[], supplierId: string, code: string) {
  const matches = offers.filter(o => o.supplier_id === supplierId && exactPurchaseCode(o.product_code) === exactPurchaseCode(code));
  return matches.length === 1 ? matches[0] : null;
}
export function offerBlockReason(offer: PurchaseSupplierOffer | null, qty: number, today = new Date().toISOString().slice(0, 10)) {
  if (!offer || !Number.isFinite(offer.buy_price) || offer.buy_price <= 0) return "price";
  if (!Number.isInteger(qty) || qty <= 0 || (offer.moq != null && qty < offer.moq) ||
    (offer.order_multiple != null && offer.order_multiple > 1 && qty % offer.order_multiple !== 0)) return "quantity";
  if (offer.stock_qty != null && qty > offer.stock_qty) return "stock";
  if (offer.valid_to && offer.valid_to < today) return "expired";
  return null;
}
export function sourcingTotals(order: LocalPurchaseOrder, indices: number[], offers: (PurchaseSupplierOffer | null)[]) {
  const oldTotal = sumMoney(indices.map(i => multiplyMoney(order.lines[i].buy_price, order.lines[i].qty)));
  const newTotal = indices.every(i => offers[i] && !offerBlockReason(offers[i], order.lines[i].qty))
    ? sumMoney(indices.map(i => multiplyMoney(offers[i]!.buy_price, order.lines[i].qty))) : null;
  return { oldTotal, newTotal };
}
export function compatiblePurchaseTargets(orders: LocalPurchaseOrder[], source: LocalPurchaseOrder, supplierName: string) {
  return orders.filter(o => o.id !== source.id && o.status === "draft" && o.sales_order_id === source.sales_order_id &&
    o.purchase_company === source.purchase_company && o.currency === source.currency &&
    o.supplier_name.trim().toLowerCase() === supplierName.trim().toLowerCase());
}

// Keep every alternative visible before a supplier is selected. Each price is
// that supplier's own current offer; never carry the source PO cost across.
export function comparePurchaseSuppliers(order: LocalPurchaseOrder, rows: PurchaseSupplierOffer[][], indices: number[]) {
  const suppliers = [...new Map(rows.flat()
    .filter(o => o.supplier_id && o.supplier_name.trim().toLowerCase() !== order.supplier_name.trim().toLowerCase())
    .map(o => [o.supplier_id, o])).values()]
    .sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));
  return suppliers.map(supplier => {
    const offers = order.lines.map((line, i) => offerForLine(rows[i] || [], supplier.supplier_id, line.product_code));
    const covered = indices.filter(i => !offerBlockReason(offers[i], order.lines[i].qty)).length;
    const totals = sourcingTotals(order, indices, offers);
    return { supplier, offers, covered, ...totals };
  });
}

export function purchaseVendorPaymentTerms(supplierName: string, vendors: LocalVendor[]) {
  const name = supplierName.trim().toLowerCase();
  if (!name) return null;
  const matches = vendors.filter(v => v.display_name.trim().toLowerCase() === name || v.company_name.trim().toLowerCase() === name);
  return matches.length === 1 ? matches[0].payment_terms.trim() || null : null;
}
