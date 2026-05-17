import { supabaseClient } from "./supabaseClient";
import type { QuoteSummary } from "../../types/quotes";

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
  revenue: RevenueSnapshot;
  issues: Partial<Record<"catalog" | "brands" | "suppliers" | "quotes" | "revenue", string>>;
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
      .from("quotes")
      .select("id,quote_date")
      .gte("quote_date", startDate)
      .order("quote_date", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(error.message || "Revenue analytics load failed");
    }

    const batch = (data || []) as Array<{ id: string; quote_date: string | null }>;
    for (const row of batch) {
      if (row.id && row.quote_date) quoteMap.set(row.id, row.quote_date);
    }
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  const quoteIds = [...quoteMap.keys()];
  if (!quoteIds.length) return snapshot;

  for (let index = 0; index < quoteIds.length; index += pageSize) {
    const chunk = quoteIds.slice(index, index + pageSize);
    const { data, error } = await supabaseClient
      .from("quote_totals")
      .select("quote_id,sales_total")
      .in("quote_id", chunk);

    if (error) {
      throw new Error(error.message || "Revenue totals load failed");
    }

    for (const row of (data || []) as Array<{ quote_id: string; sales_total: number | null }>) {
      const quoteDate = quoteMap.get(row.quote_id);
      if (!quoteDate) continue;
      const date = new Date(quoteDate);
      if (Number.isNaN(date.getTime())) continue;
      const total = Number(row.sales_total || 0);
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
  }

  return snapshot;
}

async function fetchTableCount(table: "catalog_products" | "brands" | "suppliers" | "quotes") {
  const { count, error } = await supabaseClient.from(table).select("id", { count: "exact", head: true });
  if (error) {
    throw new Error(error.message || `Failed to load ${table} count`);
  }
  return count ?? 0;
}

export async function fetchDashboardLatestQuotes(): Promise<QuoteSummary[]> {
  const { data, error } = await supabaseClient
    .from("quotes")
    .select("id,quote_no,revision_no,quote_date,customer_name,status")
    .order("quote_date", { ascending: false })
    .limit(5);

  if (error) {
    throw new Error(error.message || "Failed to load latest quotes");
  }

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    quote_id: String(row.id || ""),
    parent_quote_id: null,
    quote_no: String(row.quote_no || "-"),
    revision_no: Number(row.revision_no || 0),
    quote_date: (row.quote_date as string | null) || null,
    customer_name: (row.customer_name as string | null) || null,
    currency: (row.currency as string | null) || null,
    status: (row.status as string | null) || null,
    total_quantity: null,
    purchase_total: null,
    sales_total: null,
    profit_total: null,
    general_amount: null,
    created_by_name: null,
    created_by_email: null,
    updated_at: (row.updated_at as string | null) || null,
  }));
}

export async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [catalogResult, brandsResult, suppliersResult, quotesResult, revenueResult] = await Promise.allSettled([
    fetchTableCount("catalog_products"),
    fetchTableCount("brands"),
    fetchTableCount("suppliers"),
    fetchTableCount("quotes"),
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
    revenue: revenueResult.status === "fulfilled" ? revenueResult.value : buildEmptyRevenue("quotes", false),
    issues,
  };
}
