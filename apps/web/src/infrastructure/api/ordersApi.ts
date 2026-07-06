import { buildBillFromPurchaseOrder, buildMergedBillFromPurchaseOrders, loadLocalBills, loadLocalInvoices, loadLocalPurchaseOrders, loadLocalSalesOrders } from "../../shared/localOrders";
import { resyncBillLinesFromCatalog, resyncPurchaseOrderLinesFromCatalog } from "../../shared/salesOrderCatalogSync";
import type {
  LocalBill,
  LocalInvoice,
  LocalPaymentMade,
  LocalPaymentReceived,
  LocalPurchaseOrder,
  LocalSalesOrder,
} from "../../types/orders";
import { supabaseClient } from "./supabaseClient";
import { getCurrentOrgId } from "./organizationApi";
import { fetchWarehouses } from "./warehousesApi";
import { callAppRpc } from "./appRpcApi";

const SALES_ORDER_COLUMNS = [
  "id",
  "sales_order_no",
  "customer_name",
  "seller_company",
  "purchase_company",
  "quote_date",
  "currency",
  "customer_type",
  "shipping_cost",
  "discount_amount",
  "supplier_mode",
  "preferred_supplier",
  "seller_info",
  "buyer_info",
  "delivery_term",
  "payment_terms",
  "packing_details",
  "notes",
  "status",
  "purchase_total",
  "sales_total",
  "profit_total",
  "margin_percent",
  "source_channel",
  "portal_invite_id",
  "portal_submitted_at",
  "portal_seen_at",
  "created_at",
  "updated_at",
  "confirmed_at",
  "lines",
].join(",");

const SALES_ORDER_SUMMARY_COLUMNS = [
  "id",
  "sales_order_no",
  "customer_name",
  "seller_company",
  "quote_date",
  "currency",
  "customer_type",
  "status",
  "sales_total",
  "source_channel",
  "portal_submitted_at",
  "portal_seen_at",
  "updated_at",
  "confirmed_at",
].join(",");

const PURCHASE_ORDER_COLUMNS = [
  "id",
  "supplier_name",
  "supplier_key",
  "purchase_company",
  "sales_order_id",
  "sales_order_no",
  "customer_name",
  "status",
  "currency",
  "created_at",
  "updated_at",
  "total_amount",
  "line_count",
  "lines",
].join(",");

const PURCHASE_ORDER_SUMMARY_COLUMNS = [
  "id",
  "supplier_name",
  "supplier_key",
  "purchase_company",
  "sales_order_id",
  "sales_order_no",
  "customer_name",
  "status",
  "currency",
  "created_at",
  "updated_at",
  "total_amount",
  "line_count",
  "lines",
].join(",");

const INVOICE_COLUMNS = [
  "id",
  "sales_order_id",
  "sales_order_ids",
  "warehouse_id",
  "warehouse_code",
  "warehouse_name",
  "sales_order_no",
  "customer_name",
  "seller_company",
  "purchase_company",
  "currency",
  "status",
  "quote_date",
  "delivery_term",
  "payment_terms",
  "due_date",
  "contract_nr",
  "packing_details",
  "notes",
  "subtotal",
  "discount_amount",
  "shipping_cost",
  "total_amount",
  "purchase_total",
  "profit_total",
  "margin_percent",
  "created_at",
  "updated_at",
  "lines",
].join(",");

const INVOICE_SUMMARY_COLUMNS = [
  "id",
  "sales_order_id",
  "sales_order_ids",
  "warehouse_id",
  "warehouse_code",
  "warehouse_name",
  "sales_order_no",
  "customer_name",
  "seller_company",
  "purchase_company",
  "currency",
  "status",
  "quote_date",
  "delivery_term",
  "payment_terms",
  "due_date",
  "contract_nr",
  "packing_details",
  "notes",
  "subtotal",
  "discount_amount",
  "shipping_cost",
  "total_amount",
  "purchase_total",
  "profit_total",
  "margin_percent",
  "created_at",
  "updated_at",
  "lines",
].join(",");

const BILL_COLUMNS = [
  "id",
  "purchase_order_id",
  "purchase_order_no",
  "supplier_name",
  "purchase_company",
  "currency",
  "status",
  "bill_date",
  "due_date",
  "payment_terms",
  "notes",
  "subtotal",
  "shipping_cost",
  "discount_amount",
  "total_amount",
  "created_at",
  "updated_at",
  "lines",
].join(",");

const BILL_SUMMARY_COLUMNS = [
  "id",
  "purchase_order_id",
  "purchase_order_no",
  "supplier_name",
  "purchase_company",
  "currency",
  "status",
  "bill_date",
  "due_date",
  "payment_terms",
  "notes",
  "subtotal",
  "shipping_cost",
  "discount_amount",
  "total_amount",
  "created_at",
  "updated_at",
  "lines",
].join(",");

const PAYMENT_RECEIVED_COLUMNS = [
  "id",
  "invoice_id",
  "invoice_no",
  "customer_name",
  "currency",
  "received_date",
  "amount",
  "method",
  "reference_no",
  "notes",
  "status",
  "created_at",
  "updated_at",
].join(",");

const PAYMENT_MADE_COLUMNS = [
  "id",
  "bill_id",
  "bill_no",
  "supplier_name",
  "purchase_company",
  "currency",
  "payment_date",
  "amount",
  "method",
  "reference_no",
  "notes",
  "status",
  "created_at",
  "updated_at",
].join(",");

let bootstrapPromise: Promise<void> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value: unknown) {
  return Number(value ?? 0) || 0;
}

function mapSalesOrderRow(row: Record<string, unknown>): LocalSalesOrder {
  return {
    id: String(row.id || ""),
    sales_order_no: String(row.sales_order_no || ""),
    customer_name: String(row.customer_name || ""),
    seller_company: String(row.seller_company || ""),
    purchase_company: String(row.purchase_company || ""),
    quote_date: String(row.quote_date || ""),
    currency: String(row.currency || "EUR"),
    customer_type: String(row.customer_type || "A") as LocalSalesOrder["customer_type"],
    shipping_cost: toNumber(row.shipping_cost),
    discount_amount: toNumber(row.discount_amount),
    supplier_mode: String(row.supplier_mode || ""),
    preferred_supplier: String(row.preferred_supplier || ""),
    seller_info: String(row.seller_info || ""),
    buyer_info: String(row.buyer_info || ""),
    delivery_term: String(row.delivery_term || ""),
    payment_terms: String(row.payment_terms || ""),
    packing_details: String(row.packing_details || ""),
    notes: String(row.notes || ""),
    status: String(row.status || "draft") as LocalSalesOrder["status"],
    purchase_total: toNumber(row.purchase_total),
    sales_total: toNumber(row.sales_total),
    profit_total: toNumber(row.profit_total),
    margin_percent: toNumber(row.margin_percent),
    source_channel: String(row.source_channel || "internal") as LocalSalesOrder["source_channel"],
    portal_invite_id: row.portal_invite_id ? String(row.portal_invite_id) : null,
    portal_submitted_at: row.portal_submitted_at ? String(row.portal_submitted_at) : null,
    portal_seen_at: row.portal_seen_at ? String(row.portal_seen_at) : null,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    confirmed_at: row.confirmed_at ? String(row.confirmed_at) : null,
    lines: Array.isArray(row.lines) ? (row.lines as LocalSalesOrder["lines"]) : [],
  };
}

function mapPurchaseOrderRow(row: Record<string, unknown>): LocalPurchaseOrder {
  return {
    id: String(row.id || ""),
    supplier_name: String(row.supplier_name || ""),
    supplier_key: String(row.supplier_key || ""),
    purchase_company: String(row.purchase_company || ""),
    sales_order_id: String(row.sales_order_id || ""),
    sales_order_no: String(row.sales_order_no || ""),
    customer_name: String(row.customer_name || ""),
    status: String(row.status || "open") as LocalPurchaseOrder["status"],
    currency: String(row.currency || "EUR"),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    total_amount: toNumber(row.total_amount),
    line_count: Number(row.line_count ?? 0) || 0,
    lines: Array.isArray(row.lines) ? (row.lines as LocalPurchaseOrder["lines"]) : [],
  };
}

function mapInvoiceRow(row: Record<string, unknown>): LocalInvoice {
  return {
    id: String(row.id || ""),
    sales_order_id: String(row.sales_order_id || ""),
    sales_order_ids: Array.isArray(row.sales_order_ids) ? (row.sales_order_ids as string[]) : [],
    warehouse_id: row.warehouse_id ? String(row.warehouse_id) : null,
    warehouse_code: String(row.warehouse_code || ""),
    warehouse_name: String(row.warehouse_name || ""),
    sales_order_no: String(row.sales_order_no || ""),
    customer_name: String(row.customer_name || ""),
    seller_company: String(row.seller_company || ""),
    purchase_company: String(row.purchase_company || ""),
    currency: String(row.currency || "EUR"),
    status: String(row.status || "open") as LocalInvoice["status"],
    quote_date: String(row.quote_date || ""),
    delivery_term: String(row.delivery_term || ""),
    payment_terms: String(row.payment_terms || ""),
    due_date: String(row.due_date || ""),
    contract_nr: String(row.contract_nr || ""),
    packing_details: String(row.packing_details || ""),
    notes: String(row.notes || ""),
    subtotal: toNumber(row.subtotal),
    discount_amount: toNumber(row.discount_amount),
    shipping_cost: toNumber(row.shipping_cost),
    total_amount: toNumber(row.total_amount),
    purchase_total: toNumber(row.purchase_total),
    profit_total: toNumber(row.profit_total),
    margin_percent: toNumber(row.margin_percent),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    lines: Array.isArray(row.lines) ? (row.lines as LocalInvoice["lines"]) : [],
  };
}

function mapBillRow(row: Record<string, unknown>): LocalBill {
  return {
    id: String(row.id || ""),
    purchase_order_id: String(row.purchase_order_id || ""),
    purchase_order_no: String(row.purchase_order_no || ""),
    supplier_name: String(row.supplier_name || ""),
    purchase_company: String(row.purchase_company || ""),
    currency: String(row.currency || "EUR"),
    status: String(row.status || "draft") as LocalBill["status"],
    bill_date: String(row.bill_date || ""),
    due_date: String(row.due_date || ""),
    payment_terms: String(row.payment_terms || ""),
    notes: String(row.notes || ""),
    subtotal: toNumber(row.subtotal),
    shipping_cost: toNumber(row.shipping_cost),
    discount_amount: toNumber(row.discount_amount),
    total_amount: toNumber(row.total_amount),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    lines: Array.isArray(row.lines) ? (row.lines as LocalBill["lines"]) : [],
  };
}

function mapPaymentReceivedRow(row: Record<string, unknown>): LocalPaymentReceived {
  return {
    id: String(row.id || ""),
    invoice_id: String(row.invoice_id || ""),
    invoice_no: String(row.invoice_no || ""),
    customer_name: String(row.customer_name || ""),
    currency: String(row.currency || "EUR"),
    received_date: String(row.received_date || ""),
    amount: toNumber(row.amount),
    method: String(row.method || "Bank Transfer"),
    reference_no: String(row.reference_no || ""),
    notes: String(row.notes || ""),
    status: String(row.status || "draft") as LocalPaymentReceived["status"],
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function mapPaymentMadeRow(row: Record<string, unknown>): LocalPaymentMade {
  return {
    id: String(row.id || ""),
    bill_id: String(row.bill_id || ""),
    bill_no: String(row.bill_no || ""),
    supplier_name: String(row.supplier_name || ""),
    purchase_company: String(row.purchase_company || ""),
    currency: String(row.currency || "EUR"),
    payment_date: String(row.payment_date || ""),
    amount: toNumber(row.amount),
    method: String(row.method || "Bank Transfer"),
    reference_no: String(row.reference_no || ""),
    notes: String(row.notes || ""),
    status: String(row.status || "draft") as LocalPaymentMade["status"],
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function mapSalesOrderPayload(order: LocalSalesOrder, organizationId: string) {
  return {
    id: order.id,
    organization_id: organizationId,
    sales_order_no: order.sales_order_no,
    customer_name: order.customer_name,
    seller_company: order.seller_company,
    purchase_company: order.purchase_company,
    quote_date: order.quote_date,
    currency: order.currency,
    customer_type: order.customer_type,
    shipping_cost: order.shipping_cost,
    discount_amount: order.discount_amount,
    supplier_mode: order.supplier_mode,
    preferred_supplier: order.preferred_supplier,
    seller_info: order.seller_info,
    buyer_info: order.buyer_info,
    delivery_term: order.delivery_term,
    payment_terms: order.payment_terms,
    packing_details: order.packing_details,
    notes: order.notes,
    status: order.status,
    purchase_total: order.purchase_total,
    sales_total: order.sales_total,
    profit_total: order.profit_total,
    margin_percent: order.margin_percent,
    source_channel: order.source_channel || "internal",
    portal_invite_id: order.portal_invite_id || null,
    portal_submitted_at: order.portal_submitted_at || null,
    portal_seen_at: order.portal_seen_at || null,
    confirmed_at: order.confirmed_at || null,
    lines: order.lines,
    created_at: order.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

function mapPurchaseOrderPayload(order: LocalPurchaseOrder, organizationId: string) {
  return {
    id: order.id,
    organization_id: organizationId,
    supplier_name: order.supplier_name,
    supplier_key: order.supplier_key,
    purchase_company: order.purchase_company,
    sales_order_id: order.sales_order_id,
    sales_order_no: order.sales_order_no,
    customer_name: order.customer_name,
    status: order.status,
    currency: order.currency,
    total_amount: order.total_amount,
    line_count: order.line_count,
    lines: order.lines,
    created_at: order.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

function mapInvoicePayload(invoice: LocalInvoice, organizationId: string) {
  return {
    id: invoice.id,
    organization_id: organizationId,
    sales_order_id: invoice.sales_order_id,
    sales_order_ids: invoice.sales_order_ids ?? [],
    warehouse_id: invoice.warehouse_id || null,
    warehouse_code: invoice.warehouse_code || "",
    warehouse_name: invoice.warehouse_name || "",
    sales_order_no: invoice.sales_order_no,
    customer_name: invoice.customer_name,
    seller_company: invoice.seller_company,
    purchase_company: invoice.purchase_company,
    currency: invoice.currency,
    status: invoice.status,
    quote_date: invoice.quote_date,
    delivery_term: invoice.delivery_term,
    payment_terms: invoice.payment_terms,
    due_date: invoice.due_date,
    contract_nr: invoice.contract_nr,
    packing_details: invoice.packing_details,
    notes: invoice.notes,
    subtotal: invoice.subtotal,
    discount_amount: invoice.discount_amount,
    shipping_cost: invoice.shipping_cost,
    total_amount: invoice.total_amount,
    purchase_total: invoice.purchase_total,
    profit_total: invoice.profit_total,
    margin_percent: invoice.margin_percent,
    lines: invoice.lines,
    created_at: invoice.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

async function resolveInvoiceWarehouseDefaults(invoice: LocalInvoice) {
  if (invoice.warehouse_id && String(invoice.warehouse_id).trim()) {
    return {
      ...invoice,
      warehouse_id: String(invoice.warehouse_id).trim(),
      warehouse_code: String(invoice.warehouse_code || "").trim(),
      warehouse_name: String(invoice.warehouse_name || "").trim(),
    };
  }

  const warehouses = await fetchWarehouses();
  const preferredWarehouse =
    warehouses.find((row) => row.is_active !== false && String(row.fulfillment_model || "").toLowerCase() === "stocked") ||
    warehouses.find((row) => row.is_active !== false) ||
    null;

  if (!preferredWarehouse) {
    return {
      ...invoice,
      warehouse_id: null,
      warehouse_code: "",
      warehouse_name: "",
    };
  }

  return {
    ...invoice,
    warehouse_id: preferredWarehouse.id,
    warehouse_code: preferredWarehouse.warehouse_code || "",
    warehouse_name: preferredWarehouse.warehouse_name || "",
  };
}

function mapBillPayload(bill: LocalBill, organizationId: string) {
  return {
    id: bill.id,
    organization_id: organizationId,
    purchase_order_id: bill.purchase_order_id,
    purchase_order_no: bill.purchase_order_no,
    supplier_name: bill.supplier_name,
    purchase_company: bill.purchase_company,
    currency: bill.currency,
    status: bill.status,
    bill_date: bill.bill_date,
    due_date: bill.due_date,
    payment_terms: bill.payment_terms,
    notes: bill.notes,
    subtotal: bill.subtotal,
    shipping_cost: bill.shipping_cost,
    discount_amount: bill.discount_amount,
    total_amount: bill.total_amount,
    lines: bill.lines,
    created_at: bill.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

function mapPaymentReceivedPayload(payment: LocalPaymentReceived, organizationId: string) {
  return {
    id: payment.id,
    organization_id: organizationId,
    invoice_id: payment.invoice_id,
    invoice_no: payment.invoice_no,
    customer_name: payment.customer_name,
    currency: payment.currency,
    received_date: payment.received_date,
    amount: payment.amount,
    method: payment.method,
    reference_no: payment.reference_no,
    notes: payment.notes,
    status: payment.status,
    created_at: payment.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

function mapPaymentMadePayload(payment: LocalPaymentMade, organizationId: string) {
  return {
    id: payment.id,
    organization_id: organizationId,
    bill_id: payment.bill_id,
    bill_no: payment.bill_no,
    supplier_name: payment.supplier_name,
    purchase_company: payment.purchase_company,
    currency: payment.currency,
    payment_date: payment.payment_date,
    amount: payment.amount,
    method: payment.method,
    reference_no: payment.reference_no,
    notes: payment.notes,
    status: payment.status,
    created_at: payment.created_at || nowIso(),
    updated_at: nowIso(),
  };
}

async function syncInvoicePaidStatus(organizationId: string, invoiceId: string) {
  if (!invoiceId) return;
  const { data: invoiceRows, error: invoiceError } = await supabaseClient
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", invoiceId)
    .limit(1);
  if (invoiceError) throw new Error(invoiceError.message || "Invoice payment sync failed");
  const invoice = invoiceRows?.[0] as unknown as Record<string, unknown> | undefined;
  if (!invoice) return;

  const { data: paymentRows, error: paymentError } = await supabaseClient
    .from("payments_received")
    .select("amount,status")
    .eq("organization_id", organizationId)
    .eq("invoice_id", invoiceId);
  if (paymentError) throw new Error(paymentError.message || "Invoice payment sync failed");

  const confirmedAmount = (paymentRows || []).reduce((sum, row) => {
    const status = String((row as Record<string, unknown>).status || "").toLowerCase();
    return status === "confirmed" ? sum + toNumber((row as Record<string, unknown>).amount) : sum;
  }, 0);
  const invoiceTotal = toNumber(invoice.total_amount);
  const nextStatus =
    confirmedAmount >= invoiceTotal && invoiceTotal > 0 ? "paid" : String(invoice.status || "draft").toLowerCase() === "paid" ? "confirmed" : String(invoice.status || "draft");

  const { error: updateError } = await supabaseClient
    .from("invoices")
    .update({ status: nextStatus, updated_at: nowIso() })
    .eq("organization_id", organizationId)
    .eq("id", invoiceId);
  if (updateError) throw new Error(updateError.message || "Invoice payment sync failed");
}

async function syncBillPaidStatus(organizationId: string, billId: string) {
  if (!billId) return;
  const { data: billRows, error: billError } = await supabaseClient
    .from("bills")
    .select(BILL_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", billId)
    .limit(1);
  if (billError) throw new Error(billError.message || "Bill payment sync failed");
  const bill = billRows?.[0] as unknown as Record<string, unknown> | undefined;
  if (!bill) return;

  const { data: paymentRows, error: paymentError } = await supabaseClient
    .from("payments_made")
    .select("amount,status")
    .eq("organization_id", organizationId)
    .eq("bill_id", billId);
  if (paymentError) throw new Error(paymentError.message || "Bill payment sync failed");

  const confirmedAmount = (paymentRows || []).reduce((sum, row) => {
    const status = String((row as Record<string, unknown>).status || "").toLowerCase();
    return status === "confirmed" ? sum + toNumber((row as Record<string, unknown>).amount) : sum;
  }, 0);
  const billTotal = toNumber(bill.total_amount);
  const nextStatus =
    confirmedAmount >= billTotal && billTotal > 0 ? "paid" : String(bill.status || "draft").toLowerCase() === "paid" ? "confirmed" : String(bill.status || "draft");

  const { error: updateError } = await supabaseClient
    .from("bills")
    .update({ status: nextStatus, updated_at: nowIso() })
    .eq("organization_id", organizationId)
    .eq("id", billId);
  if (updateError) throw new Error(updateError.message || "Bill payment sync failed");
}

async function bootstrapOrdersFromLocalIfNeeded() {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const organizationId = await getCurrentOrgId();
    const [localSalesOrders, localPurchaseOrders, localInvoices, localBills] = [
      loadLocalSalesOrders(),
      loadLocalPurchaseOrders(),
      loadLocalInvoices(),
      loadLocalBills(),
    ];

    const [
      { count: salesCount, error: salesCountError },
      { count: purchaseCount, error: purchaseCountError },
      { count: invoiceCount, error: invoiceCountError },
      { count: billCount, error: billCountError },
    ] =
      await Promise.all([
        supabaseClient.from("sales_orders").select("id", { count: "planned", head: true }).eq("organization_id", organizationId),
        supabaseClient.from("purchase_orders").select("id", { count: "planned", head: true }).eq("organization_id", organizationId),
        supabaseClient.from("invoices").select("id", { count: "planned", head: true }).eq("organization_id", organizationId),
        supabaseClient.from("bills").select("id", { count: "planned", head: true }).eq("organization_id", organizationId),
      ]);

    if (salesCountError) throw new Error(salesCountError.message || "Sales order bootstrap check failed");
    if (purchaseCountError) throw new Error(purchaseCountError.message || "Purchase order bootstrap check failed");
    if (invoiceCountError) throw new Error(invoiceCountError.message || "Invoice bootstrap check failed");
    if (billCountError) throw new Error(billCountError.message || "Bill bootstrap check failed");

    if ((salesCount || 0) === 0 && localSalesOrders.length) {
      const { error } = await supabaseClient.from("sales_orders").insert(localSalesOrders.map((row) => mapSalesOrderPayload(row, organizationId)));
      if (error) throw new Error(error.message || "Sales order bootstrap failed");
    }

    if ((purchaseCount || 0) === 0 && localPurchaseOrders.length) {
      const { error } = await supabaseClient
        .from("purchase_orders")
        .insert(localPurchaseOrders.map((row) => mapPurchaseOrderPayload(row, organizationId)));
      if (error) throw new Error(error.message || "Purchase order bootstrap failed");
    }

    if ((invoiceCount || 0) === 0 && localInvoices.length) {
      const { error } = await supabaseClient.from("invoices").insert(localInvoices.map((row) => mapInvoicePayload(row, organizationId)));
      if (error) throw new Error(error.message || "Invoice bootstrap failed");
    }

    if ((billCount || 0) === 0 && localBills.length) {
      const { error } = await supabaseClient.from("bills").insert(localBills.map((row) => mapBillPayload(row, organizationId)));
      if (error) throw new Error(error.message || "Bill bootstrap failed");
    }
  })().finally(() => {
    bootstrapPromise = null;
  });

  return bootstrapPromise;
}

async function fetchOrderCollection<T>(
  table: "sales_orders" | "purchase_orders" | "invoices" | "bills",
  columns: string,
  mapper: (row: Record<string, unknown>) => T,
) {
  await bootstrapOrdersFromLocalIfNeeded();
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from(table)
    .select(columns)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || `${table} load failed`);
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapper);
}

async function fetchOrderRecord<T>(
  table: "sales_orders" | "purchase_orders" | "invoices" | "bills",
  columns: string,
  mapper: (row: Record<string, unknown>) => T,
  id: string,
) {
  await bootstrapOrdersFromLocalIfNeeded();
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from(table)
    .select(columns)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .single();

  if (error) throw new Error(error.message || `${table} detail load failed`);
  return mapper(data as unknown as Record<string, unknown>);
}

export async function fetchSalesOrders(): Promise<LocalSalesOrder[]> {
  return fetchOrderCollection("sales_orders", SALES_ORDER_COLUMNS, mapSalesOrderRow);
}

export async function fetchSalesOrderSummaries(): Promise<LocalSalesOrder[]> {
  return fetchOrderCollection("sales_orders", SALES_ORDER_SUMMARY_COLUMNS, mapSalesOrderRow);
}

export type SalesOrderBrandSummary = {
  id: string;
  brands: string[];
};

export async function fetchSalesOrderBrandSummaries(): Promise<SalesOrderBrandSummary[]> {
  await bootstrapOrdersFromLocalIfNeeded();
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("sales_orders")
    .select("id,lines")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "sales_orders brand summaries load failed");
  return ((data || []) as Array<Record<string, unknown>>).map((row) => {
    const seen = new Set<string>();
    const brands: string[] = [];
    const lines = Array.isArray(row.lines) ? (row.lines as Array<Record<string, unknown>>) : [];
    lines.forEach((line) => {
      const brand = String(line.brand || "").trim();
      if (!brand) return;
      const key = brand.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      brands.push(brand);
    });
    return {
      id: String(row.id || ""),
      brands,
    };
  });
}

export type PurchaseOrderSalesLinkSummary = {
  id: string;
  sales_order_id: string;
};

export type InvoiceSalesLinkSummary = {
  id: string;
  sales_order_id: string;
  sales_order_ids: string[];
};

export async function fetchPurchaseOrderSalesLinkSummaries(): Promise<PurchaseOrderSalesLinkSummary[]> {
  await bootstrapOrdersFromLocalIfNeeded();
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("purchase_orders")
    .select("id,sales_order_id")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "purchase_orders load failed");
  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id || ""),
    sales_order_id: String(row.sales_order_id || ""),
  }));
}

export async function fetchInvoiceSalesLinkSummaries(): Promise<InvoiceSalesLinkSummary[]> {
  await bootstrapOrdersFromLocalIfNeeded();
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("invoices")
    .select("id,sales_order_id,sales_order_ids")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "invoices load failed");
  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id || ""),
    sales_order_id: String(row.sales_order_id || ""),
    sales_order_ids: Array.isArray(row.sales_order_ids) ? (row.sales_order_ids as string[]) : [],
  }));
}

export async function fetchSalesOrderById(salesOrderId: string): Promise<LocalSalesOrder> {
  return fetchOrderRecord("sales_orders", SALES_ORDER_COLUMNS, mapSalesOrderRow, salesOrderId);
}

export async function upsertSalesOrder(order: LocalSalesOrder): Promise<LocalSalesOrder> {
  const organizationId = await getCurrentOrgId();
  const payload = mapSalesOrderPayload(order, organizationId);
  const { data, error } = await supabaseClient
    .from("sales_orders")
    .upsert(payload, { onConflict: "id" })
    .select(SALES_ORDER_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Sales order save failed");
  return mapSalesOrderRow(data as unknown as Record<string, unknown>);
}

export async function deleteSalesOrder(salesOrderId: string): Promise<void> {
  const organizationId = await getCurrentOrgId();
  const { error } = await supabaseClient
    .from("sales_orders")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", salesOrderId);

  if (error) throw new Error(error.message || "Sales order delete failed");
}

export async function markSalesOrderPortalSeen(orderId: string): Promise<LocalSalesOrder | null> {
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("sales_orders")
    .update({
      portal_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", orderId)
    .is("portal_seen_at", null)
    .select(SALES_ORDER_COLUMNS)
    .maybeSingle();

  if (error) throw new Error(error.message || "Sales order seen update failed");
  if (!data) return null;
  return mapSalesOrderRow(data as unknown as Record<string, unknown>);
}

export async function fetchPurchaseOrders(): Promise<LocalPurchaseOrder[]> {
  return fetchOrderCollection("purchase_orders", PURCHASE_ORDER_COLUMNS, mapPurchaseOrderRow);
}

export async function fetchPurchaseOrderSummaries(): Promise<LocalPurchaseOrder[]> {
  return fetchOrderCollection("purchase_orders", PURCHASE_ORDER_SUMMARY_COLUMNS, mapPurchaseOrderRow);
}

export async function fetchPurchaseOrderById(purchaseOrderId: string): Promise<LocalPurchaseOrder> {
  return fetchOrderRecord("purchase_orders", PURCHASE_ORDER_COLUMNS, mapPurchaseOrderRow, purchaseOrderId);
}

export async function replacePurchaseOrdersForSalesOrder(salesOrderId: string, purchaseOrders: LocalPurchaseOrder[]) {
  const organizationId = await getCurrentOrgId();
  const { error: deleteError } = await supabaseClient
    .from("purchase_orders")
    .delete()
    .eq("organization_id", organizationId)
    .eq("sales_order_id", salesOrderId);

  if (deleteError) throw new Error(deleteError.message || "Purchase order replace failed");
  if (!purchaseOrders.length) return [];

  const { data, error } = await supabaseClient
    .from("purchase_orders")
    .insert(purchaseOrders.map((row) => mapPurchaseOrderPayload(row, organizationId)))
    .select(PURCHASE_ORDER_COLUMNS);

  if (error) throw new Error(error.message || "Purchase order save failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapPurchaseOrderRow);
}

export async function fetchInvoices(): Promise<LocalInvoice[]> {
  return fetchOrderCollection("invoices", INVOICE_COLUMNS, mapInvoiceRow);
}

export async function fetchInvoiceSummaries(): Promise<LocalInvoice[]> {
  return fetchOrderCollection("invoices", INVOICE_SUMMARY_COLUMNS, mapInvoiceRow);
}

export async function fetchInvoiceById(invoiceId: string): Promise<LocalInvoice> {
  return fetchOrderRecord("invoices", INVOICE_COLUMNS, mapInvoiceRow, invoiceId);
}

export async function fetchInvoicesByCustomerNames(names: string[]): Promise<LocalInvoice[]> {
  await bootstrapOrdersFromLocalIfNeeded();
  const normalizedNames = [...new Set(names.map((item) => item.trim()).filter(Boolean))];
  if (!normalizedNames.length) return [];

  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("invoices")
    .select(INVOICE_SUMMARY_COLUMNS)
    .eq("organization_id", organizationId)
    .in("customer_name", normalizedNames)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "Invoices load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapInvoiceRow);
}

export async function upsertInvoice(invoice: LocalInvoice, previousId?: string): Promise<LocalInvoice> {
  const organizationId = await getCurrentOrgId();
  if (previousId && previousId !== invoice.id) {
    const { error: deleteError } = await supabaseClient
      .from("invoices")
      .delete()
      .eq("organization_id", organizationId)
      .eq("id", previousId);

    if (deleteError) throw new Error(deleteError.message || "Previous invoice cleanup failed");
  }

  const resolvedInvoice = await resolveInvoiceWarehouseDefaults(invoice);
  const payload = mapInvoicePayload(resolvedInvoice, organizationId);
  const { data, error } = await supabaseClient
    .from("invoices")
    .upsert(payload, { onConflict: "id" })
    .select(INVOICE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Invoice save failed");
  return mapInvoiceRow(data as unknown as Record<string, unknown>);
}

export async function deleteInvoice(invoiceId: string): Promise<void> {
  const organizationId = await getCurrentOrgId();
  const { data: paymentRows, error: paymentError } = await supabaseClient
    .from("payments_received")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("invoice_id", invoiceId)
    .limit(1);
  if (paymentError) throw new Error(paymentError.message || "Invoice delete check failed");
  if ((paymentRows || []).length) {
    throw new Error("Delete linked payments first, then delete the invoice.");
  }

  const { error } = await supabaseClient
    .from("invoices")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", invoiceId);

  if (error) throw new Error(error.message || "Invoice delete failed");
}

export async function upsertPurchaseOrder(order: LocalPurchaseOrder): Promise<LocalPurchaseOrder> {
  const organizationId = await getCurrentOrgId();
  const payload = mapPurchaseOrderPayload(order, organizationId);
  const { data, error } = await supabaseClient
    .from("purchase_orders")
    .upsert(payload, { onConflict: "id" })
    .select(PURCHASE_ORDER_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Purchase order save failed");
  return mapPurchaseOrderRow(data as unknown as Record<string, unknown>);
}

export async function deletePurchaseOrder(purchaseOrderId: string): Promise<void> {
  const organizationId = await getCurrentOrgId();
  const { error } = await supabaseClient
    .from("purchase_orders")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", purchaseOrderId);

  if (error) throw new Error(error.message || "Purchase order delete failed");
}

export async function fetchBills(): Promise<LocalBill[]> {
  return fetchOrderCollection("bills", BILL_COLUMNS, mapBillRow);
}

export async function fetchBillSummaries(): Promise<LocalBill[]> {
  return fetchOrderCollection("bills", BILL_SUMMARY_COLUMNS, mapBillRow);
}

export async function fetchBillById(billId: string): Promise<LocalBill> {
  const bill = await fetchOrderRecord("bills", BILL_COLUMNS, mapBillRow, billId);
  if (!bill.lines.some((line) => !String(line.hs_code || "").trim() || line.weight_kg == null)) {
    return bill;
  }
  return {
    ...bill,
    lines: await resyncBillLinesFromCatalog(bill.lines, { onlyFillBlanks: true }),
  };
}

export async function fetchBillsBySupplierNames(names: string[]): Promise<LocalBill[]> {
  await bootstrapOrdersFromLocalIfNeeded();
  const normalizedNames = [...new Set(names.map((item) => item.trim()).filter(Boolean))];
  if (!normalizedNames.length) return [];

  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("bills")
    .select(BILL_COLUMNS)
    .eq("organization_id", organizationId)
    .in("supplier_name", normalizedNames)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "Bills load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapBillRow);
}

export async function upsertBill(bill: LocalBill, previousId?: string): Promise<LocalBill> {
  const organizationId = await getCurrentOrgId();
  if (previousId && previousId !== bill.id) {
    const { error: deleteError } = await supabaseClient.from("bills").delete().eq("organization_id", organizationId).eq("id", previousId);
    if (deleteError) throw new Error(deleteError.message || "Previous bill cleanup failed");
  }

  const payload = mapBillPayload(bill, organizationId);
  const { data, error } = await supabaseClient
    .from("bills")
    .upsert(payload, { onConflict: "id" })
    .select(BILL_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Bill save failed");
  return mapBillRow(data as unknown as Record<string, unknown>);
}

export async function buildAndUpsertBillFromPurchaseOrder(order: LocalPurchaseOrder): Promise<LocalBill> {
  const enrichedOrder = {
    ...order,
    lines: await resyncPurchaseOrderLinesFromCatalog(order.lines, {
      onlyFillBlanks: true,
      keepPrices: true,
    }),
  };
  return await upsertBill(buildBillFromPurchaseOrder(enrichedOrder));
}

export async function buildAndUpsertMergedBillFromPurchaseOrders(orders: LocalPurchaseOrder[]): Promise<LocalBill> {
  const enrichedOrders = await Promise.all(
    orders.map(async (order) => ({
      ...order,
      lines: await resyncPurchaseOrderLinesFromCatalog(order.lines, {
        onlyFillBlanks: true,
        keepPrices: true,
      }),
    })),
  );
  return await upsertBill(buildMergedBillFromPurchaseOrders(enrichedOrders));
}

export async function deleteBill(billId: string): Promise<void> {
  const organizationId = await getCurrentOrgId();
  const { data: paymentRows, error: paymentError } = await supabaseClient
    .from("payments_made")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("bill_id", billId)
    .limit(1);
  if (paymentError) throw new Error(paymentError.message || "Bill delete check failed");
  if ((paymentRows || []).length) {
    throw new Error("Delete linked payments first, then delete the bill.");
  }

  const { error } = await supabaseClient
    .from("bills")
    .delete()
    .eq("organization_id", organizationId)
    .eq("id", billId);

  if (error) throw new Error(error.message || "Bill delete failed");
}

export async function fetchPaymentsReceived(): Promise<LocalPaymentReceived[]> {
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("payments_received")
    .select(PAYMENT_RECEIVED_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message || "Payments received load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapPaymentReceivedRow);
}

export async function deletePaymentReceived(paymentId: string): Promise<void> {
  await callAppRpc("delete_payment_received_guarded", { id: paymentId });
}

export async function fetchPaymentsReceivedByCustomerNames(names: string[]): Promise<LocalPaymentReceived[]> {
  const normalizedNames = [...new Set(names.map((item) => item.trim()).filter(Boolean))];
  if (!normalizedNames.length) return [];

  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("payments_received")
    .select(PAYMENT_RECEIVED_COLUMNS)
    .eq("organization_id", organizationId)
    .in("customer_name", normalizedNames)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message || "Payments received load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapPaymentReceivedRow);
}

export async function upsertPaymentReceived(payment: LocalPaymentReceived, previousId?: string): Promise<LocalPaymentReceived> {
  const result = await callAppRpc<{ payment?: Record<string, unknown> }>("save_payment_received_atomic", {
    payload: mapPaymentReceivedPayload(payment, ""),
    previous_id: previousId || null,
  });
  if (!result?.payment) throw new Error("Payment received save failed");
  return mapPaymentReceivedRow(result.payment);
}

export async function fetchPaymentsMade(): Promise<LocalPaymentMade[]> {
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("payments_made")
    .select(PAYMENT_MADE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message || "Payments made load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapPaymentMadeRow);
}

export async function deletePaymentMade(paymentId: string): Promise<void> {
  await callAppRpc("delete_payment_made_guarded", { id: paymentId });
}

export async function fetchPaymentsMadeBySupplierNames(names: string[]): Promise<LocalPaymentMade[]> {
  const normalizedNames = [...new Set(names.map((item) => item.trim()).filter(Boolean))];
  if (!normalizedNames.length) return [];

  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("payments_made")
    .select(PAYMENT_MADE_COLUMNS)
    .eq("organization_id", organizationId)
    .in("supplier_name", normalizedNames)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message || "Payments made load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapPaymentMadeRow);
}

export async function upsertPaymentMade(payment: LocalPaymentMade, previousId?: string): Promise<LocalPaymentMade> {
  const result = await callAppRpc<{ payment?: Record<string, unknown> }>("save_payment_made_atomic", {
    payload: mapPaymentMadePayload(payment, ""),
    previous_id: previousId || null,
  });
  if (!result?.payment) throw new Error("Payment made save failed");
  return mapPaymentMadeRow(result.payment);
}
