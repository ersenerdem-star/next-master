import { supabaseClient } from "./supabaseClient";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { getCurrentOrgId } from "./organizationApi";
import type {
  AccountTransactionRow,
  BillLineRow,
  CustomerBalanceByBrandProductRow,
  CommercialLineFactRow,
  InventoryByBrandProductWarehouseRow,
  InvoiceLineRow,
  OpenPurchaseOrdersByBrandProductRow,
  OpenSalesOrdersByBrandProductRow,
  PurchasePriceVarianceReportRow,
  ProcurementDashboardSummary,
  ProcurementDashboardSummaryItem,
  PriceVarianceCheckRow,
  RefreshReportingCoreLoggedResult,
  RefreshReportingCoreResult,
  SalesMarginReportRow,
  ReportingCoreRefreshRunRow,
  SupplierBalanceByBrandProductRow,
} from "../../types/reporting";

type FetchViewOptions = {
  organizationId?: string;
  limit?: number;
  orderBy?: string;
  ascending?: boolean;
};

export type ReportingReportFilters = {
  organizationId: string;
  startDate?: string;
  endDate?: string;
  brandId?: string;
  productQuery?: string;
  partyQuery?: string;
  limit?: number;
};

export type ProcurementDashboardSummaryFilters = {
  organizationId?: string;
  brandId?: string | null;
  highGapThreshold?: number;
  limit?: number;
};

function normalizeReportFilters(options: ReportingReportFilters) {
  return {
    p_organization_id: options.organizationId,
    p_start_date: options.startDate || null,
    p_end_date: options.endDate || null,
    p_brand_id: options.brandId || null,
    p_product_query: options.productQuery?.trim() || null,
    p_party_query: options.partyQuery?.trim() || null,
    p_limit: options.limit && options.limit > 0 ? options.limit : 500,
  };
}

async function fetchReportRows<T>(functionName: string, options: ReportingReportFilters) {
  const { data, error } = await supabaseClient.rpc(functionName, normalizeReportFilters(options));
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "The request could not be completed right now."));
  return (data ?? []) as T[];
}

async function fetchViewRows<T extends Record<string, unknown>>(viewName: string, options: FetchViewOptions = {}) {
  let query = supabaseClient.from(viewName).select("*");
  if (options.organizationId) {
    query = query.eq("organization_id", options.organizationId);
  }
  if (options.orderBy) {
    query = query.order(options.orderBy, { ascending: options.ascending ?? true });
  }
  if (typeof options.limit === "number" && options.limit > 0) {
    query = query.limit(options.limit);
  }
  const { data, error } = await query;
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "The request could not be completed right now."));
  return (data ?? []) as T[];
}

function toNullableNumber(value: unknown) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeDashboardItem(value: unknown): ProcurementDashboardSummaryItem {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    brand: String(row.brand || ""),
    product_code: String(row.product_code || ""),
    normalized_code: String(row.normalized_code || ""),
    cheapest_supplier: String(row.cheapest_supplier || ""),
    cheapest_price: toNullableNumber(row.cheapest_price),
    second_supplier_name: row.second_supplier_name == null ? null : String(row.second_supplier_name || ""),
    second_price: toNullableNumber(row.second_price),
    price_gap: toNullableNumber(row.price_gap),
    price_gap_percent: toNullableNumber(row.price_gap_percent),
    stock_qty: toNullableNumber(row.stock_qty),
    lead_time_days: toNullableNumber(row.lead_time_days),
  };
}

function normalizeDashboardItems(value: unknown) {
  return Array.isArray(value) ? value.map(normalizeDashboardItem) : [];
}

function normalizeDashboardSummary(value: unknown): ProcurementDashboardSummary {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    total_rollups: Number(row.total_rollups || 0),
    with_second_supplier: Number(row.with_second_supplier || 0),
    single_supplier_count: Number(row.single_supplier_count || 0),
    avg_gap_percent: toNullableNumber(row.avg_gap_percent),
    high_gap_count: Number(row.high_gap_count || 0),
    max_refreshed_at: row.max_refreshed_at == null ? null : String(row.max_refreshed_at || ""),
    top_high_gap_items: normalizeDashboardItems(row.top_high_gap_items),
    single_supplier_items: normalizeDashboardItems(row.single_supplier_items),
  };
}

export async function fetchProcurementDashboardSummary(options: ProcurementDashboardSummaryFilters = {}) {
  const organizationId = options.organizationId || await getCurrentOrgId();
  const { data, error } = await supabaseClient.rpc("procurement_dashboard_summary", {
    p_organization_id: organizationId,
    p_brand_id: options.brandId || null,
    p_high_gap_threshold: options.highGapThreshold ?? 10,
    p_limit: options.limit && options.limit > 0 ? options.limit : 10,
  });
  if (error) {
    throw new Error(sanitizeUserFacingMessage(error.message, "The request could not be completed right now."));
  }
  const firstRow = Array.isArray(data) ? data[0] : data;
  return normalizeDashboardSummary(firstRow);
}

export async function refreshReportingCore(organizationId?: string | null): Promise<RefreshReportingCoreResult> {
  const { data, error } = await supabaseClient.rpc("refresh_reporting_core", {
    input_organization_id: organizationId ?? null,
  });
  if (error) {
    throw new Error(sanitizeUserFacingMessage(error.message, "The request could not be completed right now."));
  }
  return (data ?? {
    status: "ok",
    organization_id: organizationId ?? "all",
    bill_lines: 0,
    invoice_lines: 0,
    account_transactions: 0,
    commercial_line_facts: 0,
    price_variance_checks: 0,
  }) as RefreshReportingCoreResult;
}

export async function refreshReportingCoreLogged(organizationId: string): Promise<RefreshReportingCoreLoggedResult> {
  const { data, error } = await supabaseClient.rpc("refresh_reporting_core_logged", {
    p_organization_id: organizationId,
  });
  if (error) {
    throw new Error(sanitizeUserFacingMessage(error.message, "The request could not be completed right now."));
  }
  return data as RefreshReportingCoreLoggedResult;
}

export async function fetchReportingCoreRefreshRuns(options: FetchViewOptions = {}) {
  let query = supabaseClient
    .from("reporting_core_refresh_runs")
    .select("*")
    .order("started_at", { ascending: false });

  if (options.organizationId) {
    query = query.eq("organization_id", options.organizationId);
  }
  if (typeof options.limit === "number" && options.limit > 0) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "The request could not be completed right now."));
  return (data ?? []) as ReportingCoreRefreshRunRow[];
}

export async function fetchSupplierBalanceByBrandProduct(options: ReportingReportFilters) {
  return fetchReportRows<SupplierBalanceByBrandProductRow>("reporting_supplier_balance_by_brand_product", options);
}

export async function fetchCustomerBalanceByBrandProduct(options: ReportingReportFilters) {
  return fetchReportRows<CustomerBalanceByBrandProductRow>("reporting_customer_balance_by_brand_product", options);
}

export async function fetchOpenPurchaseOrdersByBrandProduct(options: ReportingReportFilters) {
  return fetchReportRows<OpenPurchaseOrdersByBrandProductRow>("reporting_open_purchase_orders_by_brand_product", options);
}

export async function fetchOpenSalesOrdersByBrandProduct(options: ReportingReportFilters) {
  return fetchReportRows<OpenSalesOrdersByBrandProductRow>("reporting_open_sales_orders_by_brand_product", options);
}

export async function fetchPurchasePriceVarianceReport(options: ReportingReportFilters) {
  return fetchReportRows<PurchasePriceVarianceReportRow>("reporting_purchase_price_variance_report", options);
}

export async function fetchSalesMarginReport(options: ReportingReportFilters) {
  return fetchReportRows<SalesMarginReportRow>("reporting_sales_margin_report", options);
}

export async function fetchInventoryByBrandProductWarehouse(options: ReportingReportFilters) {
  return fetchReportRows<InventoryByBrandProductWarehouseRow>("reporting_inventory_by_brand_product_warehouse", options);
}

export async function fetchBillLines(options: FetchViewOptions = {}) {
  return fetchViewRows<BillLineRow>("bill_lines", {
    ...options,
    orderBy: options.orderBy || "created_at",
    ascending: options.ascending ?? false,
  });
}

export async function fetchInvoiceLines(options: FetchViewOptions = {}) {
  return fetchViewRows<InvoiceLineRow>("invoice_lines", {
    ...options,
    orderBy: options.orderBy || "created_at",
    ascending: options.ascending ?? false,
  });
}

export async function fetchAccountTransactions(options: FetchViewOptions = {}) {
  return fetchViewRows<AccountTransactionRow>("account_transactions", {
    ...options,
    orderBy: options.orderBy || "transaction_date",
    ascending: options.ascending ?? false,
  });
}

export async function fetchCommercialLineFacts(options: FetchViewOptions = {}) {
  return fetchViewRows<CommercialLineFactRow>("commercial_line_facts", {
    ...options,
    orderBy: options.orderBy || "transaction_date",
    ascending: options.ascending ?? false,
  });
}

export async function fetchPriceVarianceChecks(options: FetchViewOptions = {}) {
  return fetchViewRows<PriceVarianceCheckRow>("price_variance_checks", {
    ...options,
    orderBy: options.orderBy || "transaction_date",
    ascending: options.ascending ?? false,
  });
}
