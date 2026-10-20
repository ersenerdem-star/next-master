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

export type PurchaseAssignments = Record<number, string>;
export type PurchaseSourcingDecision = {
  index: number;
  offers: PurchaseSupplierOffer[];
  eligible: PurchaseSupplierOffer[];
  best: PurchaseSupplierOffer | null;
  assigned: PurchaseSupplierOffer | null;
  savings: number;
};
export function purchaseDecisionRows(order: LocalPurchaseOrder, rows: PurchaseSupplierOffer[][], assignments: PurchaseAssignments): PurchaseSourcingDecision[] {
  return order.lines.map((line, index) => {
    const offers = [...new Map((rows[index] || []).map(o => [o.supplier_id, o])).values()]
      .map(o => offerForLine(rows[index] || [], o.supplier_id, line.product_code))
      .filter((o): o is PurchaseSupplierOffer => o != null && o.supplier_name.trim().toLowerCase() !== order.supplier_name.trim().toLowerCase())
      .sort((a,b) => a.buy_price-b.buy_price || a.supplier_name.localeCompare(b.supplier_name));
    const eligible = offers.filter(o => !offerBlockReason(o, line.qty));
    const best = eligible[0] || null;
    return { index, offers, eligible, best, assigned: eligible.find(o => o.supplier_id === assignments[index]) || null,
      savings: best ? multiplyMoney(line.buy_price,line.qty)-multiplyMoney(best.buy_price,line.qty) : 0 };
  });
}
export function assignPurchaseDecisions(decisions: PurchaseSourcingDecision[], assignments: PurchaseAssignments, indices: number[], supplier: string) {
  const next = {...assignments};
  let skipped = 0;
  indices.forEach(i => {
    if (supplier === "keep") { delete next[i]; return; }
    const offer = supplier === "best" ? decisions[i]?.best : decisions[i]?.eligible.find(o => o.supplier_id === supplier);
    if (!offer) { skipped++; return; }
    next[i] = offer.supplier_id;
  });
  return { assignments: next, skipped };
}
export function purchasePlanSummary(order: LocalPurchaseOrder, decisions: PurchaseSourcingDecision[], assignments: PurchaseAssignments) {
  const groups = new Map<string, {supplierId:string; supplierName:string; indices:number[]; oldTotal:number; newTotal:number}>();
  let invalid = 0;
  decisions.forEach(d => {
    if (!assignments[d.index]) return;
    if (!d.assigned) { invalid++; return; }
    const group = groups.get(d.assigned.supplier_id) || {supplierId:d.assigned.supplier_id,supplierName:d.assigned.supplier_name,indices:[],oldTotal:0,newTotal:0};
    group.indices.push(d.index);
    groups.set(group.supplierId,group);
  });
  const result = [...groups.values()].map(g => ({...g,
    oldTotal:sumMoney(g.indices.map(i => multiplyMoney(order.lines[i].buy_price,order.lines[i].qty))),
    newTotal:sumMoney(g.indices.map(i => multiplyMoney(decisions[i].assigned!.buy_price,order.lines[i].qty)))}));
  const stockGroups = new Map<string, {indices:number[];qty:number;stock:number;supplier:string;code:string}>();
  decisions.forEach(d => {
    if (!assignments[d.index] || !d.assigned || d.assigned.stock_qty == null) return;
    const line=order.lines[d.index];
    const key=JSON.stringify([d.assigned.supplier_id,line.brand.trim().toLowerCase(),exactPurchaseCode(line.product_code)]);
    const group=stockGroups.get(key) || {indices:[],qty:0,stock:d.assigned.stock_qty,supplier:d.assigned.supplier_name,code:line.product_code};
    group.indices.push(d.index);group.qty+=line.qty;group.stock=Math.min(group.stock,d.assigned.stock_qty);stockGroups.set(key,group);
  });
  const stockIssues=[...stockGroups.values()].filter(g => g.qty>g.stock);
  invalid+=stockIssues.reduce((n,g) => n+g.indices.length,0);
  const oldTotal = sumMoney(order.lines.map(l => multiplyMoney(l.buy_price,l.qty)));
  const delta = sumMoney(result.map(g => g.newTotal-g.oldTotal));
  return {groups:result, invalid, stockIssues, changed:result.reduce((n,g) => n+g.indices.length,0), oldTotal, delta, newTotal:sumMoney([oldTotal,delta])};
}

export type PurchaseDecisionFilter = "all" | "cheaper" | "unavailable" | "assigned" | "keep";
export function filterPurchaseDecisions(order: LocalPurchaseOrder, decisions: PurchaseSourcingDecision[], assignments: PurchaseAssignments, search: string, filter: PurchaseDecisionFilter, sort: string, focusSupplier = "") {
  const text = search.trim().toLocaleLowerCase();
  const compared = focusSupplier ? decisions.map(d => {
    const best = d.eligible.find(o => o.supplier_id === focusSupplier) || null;
    const line = order.lines[d.index];
    return {...d,best,savings:best ? multiplyMoney(line.buy_price,line.qty)-multiplyMoney(best.buy_price,line.qty) : 0};
  }) : decisions;
  const filtered = compared.filter(d => {
    const l = order.lines[d.index];
    if (text && !`${l.product_code} ${l.brand} ${l.description}`.toLocaleLowerCase().includes(text)) return false;
    return filter === "all" || (filter === "cheaper" && d.savings > 0) || (filter === "unavailable" && (focusSupplier ? !d.best : !d.eligible.length)) ||
      (filter === "assigned" && Boolean(assignments[d.index])) || (filter === "keep" && !assignments[d.index]);
  });
  return sort === "impact" ? filtered.sort((a,b) => Math.abs(b.savings)-Math.abs(a.savings) || a.index-b.index) : filtered;
}
