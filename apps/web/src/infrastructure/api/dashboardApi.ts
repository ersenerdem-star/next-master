import { supabaseClient } from "./supabaseClient";

export type RevenueSource = "quotes" | "bills";

export type RevenuePeriodSummary = {
  total: number;
  count: number;
};

export type RevenueSnapshot = {
  source: RevenueSource;
  currentMonth: RevenuePeriodSummary;
  currentYear: RevenuePeriodSummary;
  previousYear: RevenuePeriodSummary;
  available: boolean;
};

export type DashboardSnapshot = {
  catalogCount: number;
  brandCount: number;
  supplierCount: number;
  quoteCount: number;
  newPortalOrders: number;
  revenue: RevenueSnapshot;
  issues: Partial<Record<"catalog" | "brands" | "suppliers" | "quotes" | "revenue", string>>;
};

export type DashboardSalesOrderSummary = {
  id: string;
  sales_order_no: string;
  customer_name: string | null;
  status: string | null;
  quote_date: string | null;
  currency: string | null;
  sales_total: number | null;
  source_channel: "internal" | "portal";
  portal_submitted_at: string | null;
  portal_seen_at: string | null;
};

function buildEmptyRevenue(source: RevenueSource, available: boolean): RevenueSnapshot {
  return {
    source,
    available,
    currentMonth: { total: 0, count: 0 },
    currentYear: { total: 0, count: 0 },
    previousYear: { total: 0, count: 0 },
  };
}

async function fetchQuoteRevenueSnapshot(): Promise<RevenueSnapshot> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const previousYear = currentYear - 1;
  const startDate = `${previousYear}-01-01`;
  const snapshot = buildEmptyRevenue("quotes", true);
  const quoteMap = new Map<string, string>();
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabaseClient
      .from("sales_orders")
      .select("id,quote_date,sales_total")
      .gte("quote_date", startDate)
      .order("quote_date", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(error.message || "Revenue analytics load failed");
    }

    const batch = (data || []) as Array<{ id: string; quote_date: string | null; sales_total: number | null }>;
    for (const row of batch) {
      if (row.id && row.quote_date) quoteMap.set(row.id, JSON.stringify({ quote_date: row.quote_date, sales_total: Number(row.sales_total || 0) }));
    }
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  const quoteIds = [...quoteMap.keys()];
  if (!quoteIds.length) return snapshot;

  for (const quoteId of quoteIds) {
    const raw = quoteMap.get(quoteId);
    if (!raw) continue;
    const record = JSON.parse(raw) as { quote_date: string; sales_total: number };
    const date = new Date(record.quote_date);
    if (Number.isNaN(date.getTime())) continue;
    const total = Number(record.sales_total || 0);
    const year = date.getFullYear();
    const month = date.getMonth();

    if (year === currentYear) {
      snapshot.currentYear.total += total;
      snapshot.currentYear.count += 1;
      if (month === currentMonth) {
        snapshot.currentMonth.total += total;
        snapshot.currentMonth.count += 1;
      }
    } else if (year === previousYear) {
      snapshot.previousYear.total += total;
      snapshot.previousYear.count += 1;
    }
  }

  return snapshot;
}

async function fetchTableCount(table: "catalog_products" | "brands" | "suppliers" | "sales_orders") {
  const { count, error } = await supabaseClient.from(table).select("id", { count: "exact", head: true });
  if (error) {
    throw new Error(error.message || `Failed to load ${table} count`);
  }
  return count ?? 0;
}

export async function fetchDashboardLatestQuotes(): Promise<DashboardSalesOrderSummary[]> {
  const { data, error } = await supabaseClient
    .from("sales_orders")
    .select("id,sales_order_no,quote_date,customer_name,status,currency,sales_total,source_channel,portal_submitted_at,portal_seen_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(5);

  if (error) {
    throw new Error(error.message || "Failed to load latest quotes");
  }

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id || ""),
    sales_order_no: String(row.sales_order_no || "-"),
    quote_date: (row.quote_date as string | null) || null,
    customer_name: (row.customer_name as string | null) || null,
    currency: (row.currency as string | null) || null,
    status: (row.status as string | null) || null,
    sales_total: row.sales_total == null ? null : Number(row.sales_total),
    source_channel: String(row.source_channel || "internal") as DashboardSalesOrderSummary["source_channel"],
    portal_submitted_at: (row.portal_submitted_at as string | null) || null,
    portal_seen_at: (row.portal_seen_at as string | null) || null,
  }));
}

async function fetchNewPortalOrderCount() {
  const { count, error } = await supabaseClient
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("source_channel", "portal")
    .not("portal_submitted_at", "is", null)
    .is("portal_seen_at", null);

  if (error) {
    throw new Error(error.message || "Portal order count failed");
  }
  return count ?? 0;
}

export async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [catalogResult, brandsResult, suppliersResult, quotesResult, portalOrdersResult, revenueResult] = await Promise.allSettled([
    fetchTableCount("catalog_products"),
    fetchTableCount("brands"),
    fetchTableCount("suppliers"),
    fetchTableCount("sales_orders"),
    fetchNewPortalOrderCount(),
    fetchQuoteRevenueSnapshot(),
  ]);

  const issues: DashboardSnapshot["issues"] = {};

  if (catalogResult.status === "rejected") issues.catalog = catalogResult.reason instanceof Error ? catalogResult.reason.message : "Catalog count failed";
  if (brandsResult.status === "rejected") issues.brands = brandsResult.reason instanceof Error ? brandsResult.reason.message : "Brand count failed";
  if (suppliersResult.status === "rejected") issues.suppliers = suppliersResult.reason instanceof Error ? suppliersResult.reason.message : "Supplier count failed";
  if (quotesResult.status === "rejected") issues.quotes = quotesResult.reason instanceof Error ? quotesResult.reason.message : "Quote count failed";
  if (revenueResult.status === "rejected") issues.revenue = revenueResult.reason instanceof Error ? revenueResult.reason.message : "Revenue analysis failed";

  return {
    catalogCount: catalogResult.status === "fulfilled" ? catalogResult.value : 0,
    brandCount: brandsResult.status === "fulfilled" ? brandsResult.value : 0,
    supplierCount: suppliersResult.status === "fulfilled" ? suppliersResult.value : 0,
    quoteCount: quotesResult.status === "fulfilled" ? quotesResult.value : 0,
    newPortalOrders: portalOrdersResult.status === "fulfilled" ? portalOrdersResult.value : 0,
    revenue: revenueResult.status === "fulfilled" ? revenueResult.value : buildEmptyRevenue("quotes", false),
    issues,
  };
}
