import { supabaseClient } from "./supabaseClient";

export type RevenuePeriodSummary = {
  total: number;
  count: number;
};

export type RevenueBreakdownRow = {
  name: string;
  total: number;
  count: number;
};

export type RevenuePeriodKey = "thisMonth" | "thisQuarter" | "thisYear" | "previousYear";

export type RevenuePeriodSnapshot = {
  sales: RevenuePeriodSummary;
  purchases: RevenuePeriodSummary;
  brandTotals: RevenueBreakdownRow[];
  sellerTotals: RevenueBreakdownRow[];
  purchaseCompanyTotals: RevenueBreakdownRow[];
};

export type RevenueSnapshot = {
  available: boolean;
  periods: Record<RevenuePeriodKey, RevenuePeriodSnapshot>;
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
  seller_company: string | null;
  status: string | null;
  quote_date: string | null;
  currency: string | null;
  sales_total: number | null;
  source_channel: "internal" | "portal";
  portal_submitted_at: string | null;
  portal_seen_at: string | null;
};

function buildEmptyPeriodSnapshot(): RevenuePeriodSnapshot {
  return {
    sales: { total: 0, count: 0 },
    purchases: { total: 0, count: 0 },
    brandTotals: [],
    sellerTotals: [],
    purchaseCompanyTotals: [],
  };
}

function buildEmptyRevenue(available: boolean): RevenueSnapshot {
  return {
    available,
    periods: {
      thisMonth: buildEmptyPeriodSnapshot(),
      thisQuarter: buildEmptyPeriodSnapshot(),
      thisYear: buildEmptyPeriodSnapshot(),
      previousYear: buildEmptyPeriodSnapshot(),
    },
  };
}

function ensureBreakdownRow(map: Map<string, RevenueBreakdownRow>, name: string) {
  const key = String(name || "Unassigned").trim() || "Unassigned";
  const existing = map.get(key);
  if (existing) return existing;
  const row = { name: key, total: 0, count: 0 };
  map.set(key, row);
  return row;
}

async function fetchQuoteRevenueSnapshot(): Promise<RevenueSnapshot> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentQuarter = Math.floor(currentMonth / 3);
  const previousYear = currentYear - 1;
  const startDate = `${previousYear}-01-01`;
  const snapshot = buildEmptyRevenue(true);
  const brandMaps = {
    thisMonth: new Map<string, RevenueBreakdownRow>(),
    thisQuarter: new Map<string, RevenueBreakdownRow>(),
    thisYear: new Map<string, RevenueBreakdownRow>(),
    previousYear: new Map<string, RevenueBreakdownRow>(),
  } satisfies Record<RevenuePeriodKey, Map<string, RevenueBreakdownRow>>;
  const sellerMaps = {
    thisMonth: new Map<string, RevenueBreakdownRow>(),
    thisQuarter: new Map<string, RevenueBreakdownRow>(),
    thisYear: new Map<string, RevenueBreakdownRow>(),
    previousYear: new Map<string, RevenueBreakdownRow>(),
  } satisfies Record<RevenuePeriodKey, Map<string, RevenueBreakdownRow>>;
  const purchaseCompanyMaps = {
    thisMonth: new Map<string, RevenueBreakdownRow>(),
    thisQuarter: new Map<string, RevenueBreakdownRow>(),
    thisYear: new Map<string, RevenueBreakdownRow>(),
    previousYear: new Map<string, RevenueBreakdownRow>(),
  } satisfies Record<RevenuePeriodKey, Map<string, RevenueBreakdownRow>>;

  async function accumulateSalesOrders() {
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabaseClient
        .from("sales_orders")
        .select("quote_date,sales_total,seller_company,lines")
        .gte("quote_date", startDate)
        .order("quote_date", { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) {
        throw new Error(error.message || "Revenue analytics load failed");
      }

      const batch = (data || []) as Array<{
        quote_date: string | null;
        sales_total: number | null;
        seller_company: string | null;
        lines?: Array<Record<string, unknown>> | null;
      }>;

      batch.forEach((row) => {
        if (!row.quote_date) return;
        const date = new Date(row.quote_date);
        if (Number.isNaN(date.getTime())) return;
        const total = Number(row.sales_total || 0);
        const sellerName = row.seller_company || "Unassigned";
        const year = date.getFullYear();
        const month = date.getMonth();
        const quarter = Math.floor(month / 3);
        const lineBrandTotals = new Map<string, { total: number; count: number }>();

        for (const line of row.lines || []) {
          const brandName = String(line.brand || "Unassigned").trim() || "Unassigned";
          const lineAmount = Number(
            line.sales_total ??
              line.line_total ??
              ((Number(line.sell_price || 0) || 0) * (Number(line.qty || 0) || 0)),
          );
          if (!lineAmount) continue;
          const current = lineBrandTotals.get(brandName) || { total: 0, count: 0 };
          lineBrandTotals.set(brandName, {
            total: Number((current.total + lineAmount).toFixed(2)),
            count: current.count + 1,
          });
        }

        function apply(period: RevenuePeriodKey) {
          snapshot.periods[period].sales.total += total;
          snapshot.periods[period].sales.count += 1;
          lineBrandTotals.forEach((brandMeta, brandName) => {
            const brandBucket = ensureBreakdownRow(brandMaps[period], brandName);
            brandBucket.total += brandMeta.total;
            brandBucket.count += brandMeta.count;
          });
          const bucket = ensureBreakdownRow(sellerMaps[period], sellerName);
          bucket.total += total;
          bucket.count += 1;
        }

        if (year === currentYear) {
          apply("thisYear");
          if (quarter === currentQuarter) apply("thisQuarter");
          if (month === currentMonth) apply("thisMonth");
        } else if (year === previousYear) {
          apply("previousYear");
        }
      });

      if (batch.length < pageSize) break;
      from += pageSize;
    }
  }

  async function accumulatePurchaseOrders() {
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabaseClient
        .from("purchase_orders")
        .select("created_at,total_amount,purchase_company")
        .gte("created_at", `${startDate}T00:00:00`)
        .order("created_at", { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) {
        throw new Error(error.message || "Purchase analytics load failed");
      }

      const batch = (data || []) as Array<{
        created_at: string | null;
        total_amount: number | null;
        purchase_company: string | null;
      }>;

      batch.forEach((row) => {
        if (!row.created_at) return;
        const date = new Date(row.created_at);
        if (Number.isNaN(date.getTime())) return;
        const total = Number(row.total_amount || 0);
        const purchaseCompany = row.purchase_company || "Unassigned";
        const year = date.getFullYear();
        const month = date.getMonth();
        const quarter = Math.floor(month / 3);

        function apply(period: RevenuePeriodKey) {
          snapshot.periods[period].purchases.total += total;
          snapshot.periods[period].purchases.count += 1;
          const bucket = ensureBreakdownRow(purchaseCompanyMaps[period], purchaseCompany);
          bucket.total += total;
          bucket.count += 1;
        }

        if (year === currentYear) {
          apply("thisYear");
          if (quarter === currentQuarter) apply("thisQuarter");
          if (month === currentMonth) apply("thisMonth");
        } else if (year === previousYear) {
          apply("previousYear");
        }
      });

      if (batch.length < pageSize) break;
      from += pageSize;
    }
  }

  await Promise.all([accumulateSalesOrders(), accumulatePurchaseOrders()]);

  (Object.keys(snapshot.periods) as RevenuePeriodKey[]).forEach((period) => {
    snapshot.periods[period].sales.total = Number(snapshot.periods[period].sales.total.toFixed(2));
    snapshot.periods[period].purchases.total = Number(snapshot.periods[period].purchases.total.toFixed(2));
    snapshot.periods[period].brandTotals = [...brandMaps[period].values()].sort((a, b) => b.total - a.total);
    snapshot.periods[period].sellerTotals = [...sellerMaps[period].values()].sort((a, b) => b.total - a.total);
    snapshot.periods[period].purchaseCompanyTotals = [...purchaseCompanyMaps[period].values()].sort((a, b) => b.total - a.total);
  });

  return snapshot;
}

async function fetchTableCount(table: "catalog_products" | "brands" | "suppliers" | "sales_orders") {
  const { count, error } = await supabaseClient.from(table).select("id", { count: "planned", head: true });
  if (error) {
    throw new Error(error.message || `Failed to load ${table} count`);
  }
  return count ?? 0;
}

export async function fetchDashboardLatestQuotes(): Promise<DashboardSalesOrderSummary[]> {
  const { data, error } = await supabaseClient
    .from("sales_orders")
    .select("id,sales_order_no,quote_date,customer_name,seller_company,status,currency,sales_total,source_channel,portal_submitted_at,portal_seen_at,updated_at")
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
    seller_company: (row.seller_company as string | null) || null,
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
    .select("id", { count: "planned", head: true })
    .eq("source_channel", "portal")
    .not("portal_submitted_at", "is", null)
    .eq("status", "draft")
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
    revenue: revenueResult.status === "fulfilled" ? revenueResult.value : buildEmptyRevenue(false),
    issues,
  };
}

export async function fetchCustomerOpsDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [quotesResult, portalOrdersResult, revenueResult] = await Promise.allSettled([
    fetchTableCount("sales_orders"),
    fetchNewPortalOrderCount(),
    fetchQuoteRevenueSnapshot(),
  ]);

  const issues: DashboardSnapshot["issues"] = {};
  if (quotesResult.status === "rejected") issues.quotes = quotesResult.reason instanceof Error ? quotesResult.reason.message : "Quote count failed";
  if (revenueResult.status === "rejected") issues.revenue = revenueResult.reason instanceof Error ? revenueResult.reason.message : "Revenue analysis failed";

  return {
    catalogCount: 0,
    brandCount: 0,
    supplierCount: 0,
    quoteCount: quotesResult.status === "fulfilled" ? quotesResult.value : 0,
    newPortalOrders: portalOrdersResult.status === "fulfilled" ? portalOrdersResult.value : 0,
    revenue: revenueResult.status === "fulfilled" ? revenueResult.value : buildEmptyRevenue(false),
    issues,
  };
}
