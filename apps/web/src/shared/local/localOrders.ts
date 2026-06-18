import type { QuoteBuilderLine } from "../../types/quoteBuilder";
import type { LocalBill, LocalBillLine, LocalInvoice, LocalInvoiceLine, LocalPurchaseOrder, LocalPurchaseOrderLine, LocalSalesOrder } from "../../types/orders";
import { normalizeBrandKey, normalizePartCode } from "../../domain/shared/normalize";

const SALES_ORDERS_KEY = "master-next-sales-orders";
const PURCHASE_ORDERS_KEY = "master-next-purchase-orders";
const INVOICES_KEY = "master-next-invoices";
const BILLS_KEY = "master-next-bills";

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function supplierKey(name: string) {
  return String(name || "Unassigned Supplier")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

const COMPACT_DOCUMENT_CODE_BRANDS = new Set(["bosch", "sachs"]);

function shouldCompactDocumentCode(brand: string) {
  return COMPACT_DOCUMENT_CODE_BRANDS.has(normalizeBrandKey(brand || ""));
}

function normalizeCompactLineCode(value: string) {
  return normalizePartCode(String(value || ""));
}

function normalizeCompactBrandQuoteLine(line: QuoteBuilderLine): QuoteBuilderLine {
  if (!shouldCompactDocumentCode(line.brand || "")) return line;
  return {
    ...line,
    requestedCode: normalizeCompactLineCode(line.requestedCode),
    resolvedCode: normalizeCompactLineCode(line.resolvedCode),
  };
}

function normalizeCompactBrandDocumentLine<T extends { brand?: string; product_code?: string; old_code?: string }>(line: T): T {
  if (!shouldCompactDocumentCode(line.brand || "")) return line;
  return {
    ...line,
    product_code: normalizeCompactLineCode(line.product_code || ""),
    old_code: normalizeCompactLineCode(line.old_code || ""),
  };
}

export function loadLocalSalesOrders() {
  return readJson<LocalSalesOrder[]>(SALES_ORDERS_KEY, []).map((row) => ({
    ...row,
    lines: (row.lines || []).map(normalizeCompactBrandQuoteLine),
  }));
}

export function saveLocalSalesOrders(rows: LocalSalesOrder[]) {
  writeJson(SALES_ORDERS_KEY, rows);
}

export function loadLocalPurchaseOrders() {
  return readJson<LocalPurchaseOrder[]>(PURCHASE_ORDERS_KEY, []).map((row) => ({
    ...row,
    lines: (row.lines || []).map(normalizeCompactBrandDocumentLine),
  }));
}

export function saveLocalPurchaseOrders(rows: LocalPurchaseOrder[]) {
  writeJson(PURCHASE_ORDERS_KEY, rows);
}

export function loadLocalInvoices() {
  const rows = readJson<LocalInvoice[]>(INVOICES_KEY, []);
  return rows.map((row) => ({
    ...row,
    purchase_company: row.purchase_company || (row as LocalInvoice & { buyer_company?: string }).buyer_company || "",
    warehouse_id: row.warehouse_id || "",
    warehouse_code: row.warehouse_code || "",
    warehouse_name: row.warehouse_name || "",
    due_date: row.due_date || row.quote_date || "",
    contract_nr: row.contract_nr || "",
    packing_details: row.packing_details || "",
    notes: row.notes || "",
    lines: (row.lines || []).map(normalizeCompactBrandDocumentLine),
  }));
}

export function loadLocalBills() {
  return readJson<LocalBill[]>(BILLS_KEY, []).map((row) => ({
    ...row,
    lines: (row.lines || []).map(normalizeCompactBrandDocumentLine),
  }));
}

export function saveLocalInvoices(rows: LocalInvoice[]) {
  writeJson(INVOICES_KEY, rows);
}

export function saveLocalBills(rows: LocalBill[]) {
  writeJson(BILLS_KEY, rows);
}

export function upsertLocalSalesOrder(order: LocalSalesOrder) {
  const current = loadLocalSalesOrders();
  const next = [order, ...current.filter((item) => item.id !== order.id)].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  saveLocalSalesOrders(next);
  return order;
}

export function buildLocalSalesOrder(input: {
  id?: string;
  sales_order_no: string;
  customer_name: string;
  seller_company: string;
  purchase_company: string;
  quote_date: string;
  currency: string;
  customer_type: "A" | "B" | "C" | "Other";
  shipping_cost: number;
  discount_amount: number;
  supplier_mode: string;
  preferred_supplier: string;
  seller_info: string;
  buyer_info: string;
  delivery_term: string;
  payment_terms: string;
  packing_details: string;
  notes: string;
  status: "draft" | "confirmed";
  source_channel?: "internal" | "portal";
  portal_invite_id?: string | null;
  portal_submitted_at?: string | null;
  portal_seen_at?: string | null;
  lines: QuoteBuilderLine[];
}) {
  const previous = input.id ? loadLocalSalesOrders().find((item) => item.id === input.id) : null;
  const purchaseTotal = roundMoney(input.lines.reduce((sum, line) => sum + (Number(line.buy_price ?? 0) || 0) * line.qty, 0));
  const subtotalAmount = roundMoney(input.lines.reduce((sum, line) => sum + (Number(line.sell_price ?? 0) || 0) * line.qty, 0));
  const salesTotal = roundMoney(subtotalAmount - input.discount_amount + input.shipping_cost);
  const profitTotal = roundMoney(salesTotal - purchaseTotal);
  const marginPercent = salesTotal > 0 ? roundMoney((profitTotal / salesTotal) * 100) : 0;
  return {
    id: input.id || makeId("so"),
    sales_order_no: input.sales_order_no,
    customer_name: input.customer_name,
    seller_company: input.seller_company,
    purchase_company: input.purchase_company,
    quote_date: input.quote_date,
    currency: input.currency,
    customer_type: input.customer_type,
    shipping_cost: input.shipping_cost,
    discount_amount: input.discount_amount,
    supplier_mode: input.supplier_mode,
    preferred_supplier: input.preferred_supplier,
    seller_info: input.seller_info,
    buyer_info: input.buyer_info,
    delivery_term: input.delivery_term,
    payment_terms: input.payment_terms,
    packing_details: input.packing_details,
    notes: input.notes,
    status: input.status,
    purchase_total: purchaseTotal,
    sales_total: salesTotal,
    profit_total: profitTotal,
    margin_percent: marginPercent,
    source_channel: input.source_channel || previous?.source_channel || "internal",
    portal_invite_id: input.portal_invite_id ?? previous?.portal_invite_id ?? null,
    portal_submitted_at: input.portal_submitted_at ?? previous?.portal_submitted_at ?? null,
    portal_seen_at: input.portal_seen_at ?? previous?.portal_seen_at ?? null,
    created_at: previous?.created_at || nowIso(),
    updated_at: nowIso(),
    confirmed_at: input.status === "confirmed" ? nowIso() : previous?.confirmed_at || null,
    lines: input.lines,
  } satisfies LocalSalesOrder;
}

export function createPurchaseOrdersFromSalesOrder(order: LocalSalesOrder) {
  const orders = buildPurchaseOrdersFromSalesOrder(order);
  const current = loadLocalPurchaseOrders().filter((po) => po.sales_order_id !== order.id);
  saveLocalPurchaseOrders([...orders, ...current].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))));
  return orders;
}

export function buildPurchaseOrdersFromSalesOrder(order: LocalSalesOrder) {
  const grouped = new Map<string, LocalPurchaseOrderLine[]>();
  order.lines.forEach((line) => {
    const name = line.supplier_name || "Unassigned Supplier";
    const key = supplierKey(name);
    const list = grouped.get(key) || [];
    list.push({
      sales_order_id: order.id,
      sales_order_no: order.sales_order_no,
      product_code: line.resolvedCode,
      old_code: line.codeChanged ? line.requestedCode : "",
      brand: line.brand,
      description: line.description,
      qty: line.qty,
      oem_no: line.oem_no,
      hs_code: line.hs_code || "",
      weight_kg: line.weight_kg ?? null,
      supplier_name: name,
      buy_price: roundMoney(Number(line.buy_price ?? 0) || 0),
      line_total: roundMoney((Number(line.buy_price ?? 0) || 0) * line.qty),
      origin: line.origin,
      notes: line.notes,
    });
    grouped.set(key, list);
  });

  const orders = Array.from(grouped.entries()).map(([key, lines]) => {
    const supplier_name = lines[0]?.supplier_name || "Unassigned Supplier";
    return {
      id: makeId("po"),
      supplier_name,
      supplier_key: key,
      purchase_company: order.purchase_company,
      sales_order_id: order.id,
      sales_order_no: order.sales_order_no,
      customer_name: order.customer_name,
      status: "draft",
      currency: order.currency,
      created_at: nowIso(),
      updated_at: nowIso(),
      total_amount: roundMoney(lines.reduce((sum, line) => sum + line.line_total, 0)),
      line_count: lines.length,
      lines,
    } satisfies LocalPurchaseOrder;
  });
  return orders;
}

export function createInvoiceFromSalesOrder(order: LocalSalesOrder) {
  const invoice = buildInvoiceFromSalesOrder(order);
  const current = loadLocalInvoices();
  const next = [invoice, ...current.filter((item) => item.sales_order_id !== order.id)].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  saveLocalInvoices(next);
  return invoice;
}

export function buildInvoiceFromSalesOrder(order: LocalSalesOrder) {
  const lines: LocalInvoiceLine[] = order.lines.map((line) => {
    const purchaseTotal = roundMoney((Number(line.buy_price ?? 0) || 0) * line.qty);
    const salesTotal = roundMoney((Number(line.sell_price ?? 0) || 0) * line.qty);
    const profitTotal = roundMoney(salesTotal - purchaseTotal);
    const marginPercent = salesTotal > 0 ? roundMoney((profitTotal / salesTotal) * 100) : 0;
    return {
      sales_order_id: order.id,
      sales_order_no: order.sales_order_no,
      product_code: line.resolvedCode,
      old_code: line.codeChanged ? line.requestedCode : "",
      brand: line.brand,
      description: line.description,
      qty: line.qty,
      oem_no: line.oem_no,
      hs_code: line.hs_code,
      weight_kg: line.weight_kg ?? null,
      supplier_name: line.supplier_name,
      buy_price: roundMoney(Number(line.buy_price ?? 0) || 0),
      sell_price: roundMoney(Number(line.sell_price ?? 0) || 0),
      purchase_total: purchaseTotal,
      sales_total: salesTotal,
      profit_total: profitTotal,
      margin_percent: marginPercent,
      origin: line.origin,
      notes: line.notes,
      lifecycle_status: line.lifecycle_status ?? "active",
      lifecycle_note: line.lifecycle_note ?? null,
      lifecycle_warning: line.lifecycle_warning ?? null,
    };
  });

  const current = loadLocalInvoices();
  const previous = current.find((item) => item.sales_order_id === order.id);
  const invoice: LocalInvoice = {
    id: previous?.id || makeId("inv"),
    sales_order_id: order.id,
    sales_order_ids: [order.id],
    sales_order_no: order.sales_order_no,
    customer_name: order.customer_name,
    seller_company: order.seller_company,
    purchase_company: order.purchase_company,
    currency: order.currency,
    status: "draft",
    warehouse_id: previous?.warehouse_id || "",
    warehouse_code: previous?.warehouse_code || "",
    warehouse_name: previous?.warehouse_name || "",
    quote_date: order.quote_date,
    delivery_term: order.delivery_term,
    payment_terms: order.payment_terms,
    due_date: order.quote_date,
    contract_nr: order.seller_info,
    packing_details: order.packing_details,
    notes: order.notes,
    subtotal: roundMoney(order.sales_total - order.shipping_cost + order.discount_amount),
    discount_amount: roundMoney(order.discount_amount),
    shipping_cost: roundMoney(order.shipping_cost),
    total_amount: roundMoney(order.sales_total),
    purchase_total: roundMoney(order.purchase_total),
    profit_total: roundMoney(order.profit_total),
    margin_percent: roundMoney(order.margin_percent),
    created_at: previous?.created_at || nowIso(),
    updated_at: nowIso(),
    lines,
  };
  return invoice;
}

export function buildMergedInvoiceFromSalesOrders(orders: LocalSalesOrder[]) {
  if (!orders.length) {
    throw new Error("At least one sales order is required");
  }

  const first = orders[0];
  const lines: LocalInvoiceLine[] = orders.flatMap((order) =>
    order.lines.map((line) => {
      const purchaseTotal = roundMoney((Number(line.buy_price ?? 0) || 0) * line.qty);
      const salesTotal = roundMoney((Number(line.sell_price ?? 0) || 0) * line.qty);
      const profitTotal = roundMoney(salesTotal - purchaseTotal);
      const marginPercent = salesTotal > 0 ? roundMoney((profitTotal / salesTotal) * 100) : 0;
      return {
        sales_order_id: order.id,
        sales_order_no: order.sales_order_no,
        product_code: line.resolvedCode,
        old_code: line.codeChanged ? line.requestedCode : "",
        brand: line.brand,
        description: line.description,
        qty: line.qty,
        oem_no: line.oem_no,
        hs_code: line.hs_code,
        weight_kg: line.weight_kg ?? null,
        supplier_name: line.supplier_name,
        buy_price: roundMoney(Number(line.buy_price ?? 0) || 0),
        sell_price: roundMoney(Number(line.sell_price ?? 0) || 0),
        purchase_total: purchaseTotal,
        sales_total: salesTotal,
        profit_total: profitTotal,
        margin_percent: marginPercent,
        origin: line.origin,
        notes: line.notes,
        lifecycle_status: line.lifecycle_status ?? "active",
        lifecycle_note: line.lifecycle_note ?? null,
        lifecycle_warning: line.lifecycle_warning ?? null,
      };
    }),
  );

  const discountAmount = roundMoney(orders.reduce((sum, order) => sum + Number(order.discount_amount || 0), 0));
  const shippingCost = roundMoney(orders.reduce((sum, order) => sum + Number(order.shipping_cost || 0), 0));
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.sales_total || 0), 0));
  const purchaseTotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.purchase_total || 0), 0));
  const totalAmount = roundMoney(subtotal - discountAmount + shippingCost);
  const profitTotal = roundMoney(totalAmount - purchaseTotal);
  const marginPercent = totalAmount > 0 ? roundMoney((profitTotal / totalAmount) * 100) : 0;

  return {
    id: makeId("inv"),
    sales_order_id: first.id,
    sales_order_ids: orders.map((order) => order.id),
    sales_order_no: orders.map((order) => order.sales_order_no).join(", "),
    customer_name: first.customer_name,
    seller_company: first.seller_company,
    purchase_company: first.purchase_company,
    currency: first.currency,
    status: "draft",
    warehouse_id: "",
    warehouse_code: "",
    warehouse_name: "",
    quote_date: nowIso().slice(0, 10),
    delivery_term: first.delivery_term,
    payment_terms: first.payment_terms,
    due_date: nowIso().slice(0, 10),
    contract_nr: first.seller_info,
    packing_details: first.packing_details,
    notes: orders.map((order) => `${order.sales_order_no}: ${order.notes}`.trim()).filter(Boolean).join("\n"),
    subtotal,
    discount_amount: discountAmount,
    shipping_cost: shippingCost,
    total_amount: totalAmount,
    purchase_total: purchaseTotal,
    profit_total: profitTotal,
    margin_percent: marginPercent,
    created_at: nowIso(),
    updated_at: nowIso(),
    lines,
  } satisfies LocalInvoice;
}

export function buildBillFromPurchaseOrder(order: LocalPurchaseOrder) {
  const lines: LocalBillLine[] = order.lines.map((line) => ({
    purchase_order_id: order.id,
    purchase_order_no: order.id,
    product_code: line.product_code,
    old_code: line.old_code,
    brand: line.brand,
    description: line.description,
    qty: line.qty,
    oem_no: line.oem_no,
    hs_code: line.hs_code || "",
    weight_kg: line.weight_kg ?? null,
    supplier_name: line.supplier_name,
    buy_price: roundMoney(line.buy_price),
    line_total: roundMoney(line.line_total),
    origin: line.origin,
    notes: line.notes,
  }));

  const current = loadLocalBills();
  const previous = current.find((item) => item.purchase_order_id === order.id);
  const bill: LocalBill = {
    id: previous?.id || makeId("bill"),
    purchase_order_id: order.id,
    purchase_order_no: order.id,
    supplier_name: order.supplier_name,
    purchase_company: order.purchase_company,
    currency: order.currency,
    status: "draft",
    bill_date: nowIso().slice(0, 10),
    due_date: nowIso().slice(0, 10),
    payment_terms: "Cash in Advance",
    notes: "",
    subtotal: roundMoney(order.total_amount),
    shipping_cost: 0,
    discount_amount: 0,
    total_amount: roundMoney(order.total_amount),
    created_at: previous?.created_at || nowIso(),
    updated_at: nowIso(),
    lines,
  };
  return bill;
}

export function buildMergedBillFromPurchaseOrders(orders: LocalPurchaseOrder[]) {
  if (!orders.length) {
    throw new Error("At least one purchase order is required");
  }

  const first = orders[0];
  const lines: LocalBillLine[] = orders.flatMap((order) =>
    order.lines.map((line) => ({
      purchase_order_id: order.id,
      purchase_order_no: order.id,
      product_code: line.product_code,
      old_code: line.old_code,
      brand: line.brand,
      description: line.description,
      qty: line.qty,
      oem_no: line.oem_no,
      hs_code: line.hs_code || "",
      weight_kg: line.weight_kg ?? null,
      supplier_name: line.supplier_name,
      buy_price: roundMoney(line.buy_price),
      line_total: roundMoney(line.line_total),
      origin: line.origin,
      notes: line.notes,
    })),
  );

  const subtotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.line_total || 0), 0));

  return {
    id: makeId("bill"),
    purchase_order_id: first.id,
    purchase_order_no: orders.map((order) => order.id).join(", "),
    supplier_name: first.supplier_name,
    purchase_company: first.purchase_company,
    currency: first.currency,
    status: "draft",
    bill_date: nowIso().slice(0, 10),
    due_date: nowIso().slice(0, 10),
    payment_terms: "Cash in Advance",
    notes: orders
      .map((order) => `${order.id}: ${order.sales_order_no || order.customer_name || ""}`.trim())
      .filter(Boolean)
      .join("\n"),
    subtotal,
    shipping_cost: 0,
    discount_amount: 0,
    total_amount: subtotal,
    created_at: nowIso(),
    updated_at: nowIso(),
    lines,
  } satisfies LocalBill;
}
