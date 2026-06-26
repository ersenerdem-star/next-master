import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchProcurementDashboardSummary } from "../../infrastructure/api/reportingApi";
import type { BrandOption } from "../../types/brand";
import type { MasterRow } from "../../types/master";
import type { ProcurementDashboardSummary, ProcurementDashboardSummaryItem } from "../../types/reporting";
import { Button } from "../components/common/Button";
import { Select } from "../components/common/Select";
import {
  HIGH_GAP_PERCENT,
  MetricTile,
  MoneyCell,
  PercentCell,
  ProductIdentityCell,
  RiskBadge,
  SupplierComparisonCell,
  formatMasterNumber,
} from "../components/master/MasterIntelligenceComponents";

const DASHBOARD_ITEM_LIMIT = 10;
const DASHBOARD_HEAVY_BRAND_MESSAGE = "This brand has many items. Please narrow the search or open Supplier Comparison.";

type ProcurementDashboardPageProps = {
  onOpenSupplierComparison?: () => void;
};

const emptySummary: ProcurementDashboardSummary = {
  total_rollups: 0,
  with_second_supplier: 0,
  single_supplier_count: 0,
  avg_gap_percent: null,
  high_gap_count: 0,
  max_refreshed_at: null,
  top_high_gap_items: [],
  single_supplier_items: [],
};

function getDashboardErrorMessage(caught: unknown) {
  const message = caught instanceof Error ? caught.message : String(caught || "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("request too long") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("took too long")
  ) {
    return DASHBOARD_HEAVY_BRAND_MESSAGE;
  }
  return message || "Procurement dashboard request failed";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function itemToMasterRow(item: ProcurementDashboardSummaryItem, supplierCount: number): MasterRow {
  return {
    total_count: 0,
    product_id: null,
    product_code: item.product_code,
    brand: item.brand,
    description: null,
    oem_no: null,
    hs_code: null,
    origin: null,
    weight_kg: null,
    cheapest_supplier: item.cheapest_supplier,
    cheapest_price: item.cheapest_price,
    second_supplier_name: item.second_supplier_name || null,
    second_price: item.second_price ?? null,
    price_gap: item.price_gap ?? null,
    price_gap_percent: item.price_gap_percent ?? null,
    price_date: null,
    sales_a: null,
    sales_b: null,
    sales_c: null,
    supplier_count: supplierCount,
    catalog_status: null,
    notes: null,
    has_notes: null,
  };
}

function InsightSection({
  title,
  badge,
  badgeTone,
  rows,
  emptyText,
  mode = "gap",
}: {
  title: string;
  badge: string;
  badgeTone: "neutral" | "success" | "warning" | "danger" | "info";
  rows: ProcurementDashboardSummaryItem[];
  emptyText: string;
  mode?: "gap" | "risk";
}) {
  return (
    <section className="procurement-insight-card">
      <div className="procurement-insight-card__header">
        <h3>{title}</h3>
        <RiskBadge label={badge} tone={badgeTone} />
      </div>
      <div className="procurement-insight-card__body">
        {rows.length ? rows.map((row) => <InsightRow key={`${row.brand}:${row.product_code}:${mode}`} item={row} mode={mode} />) : <div className="procurement-insight-empty">{emptyText}</div>}
      </div>
    </section>
  );
}

function InsightRow({ item, mode }: { item: ProcurementDashboardSummaryItem; mode: "gap" | "risk" }) {
  const masterRow = itemToMasterRow(item, mode === "risk" ? 1 : 2);
  const hasGap = item.price_gap != null || item.price_gap_percent != null;

  return (
    <article className="procurement-insight-row">
      <div className="procurement-insight-row__product">
        <ProductIdentityCell row={masterRow} />
      </div>
      <div className="procurement-insight-row__decision">
        <SupplierComparisonCell row={masterRow} />
      </div>
      <div className="procurement-insight-row__metrics">
        {mode === "risk" ? (
          <>
            <RiskBadge label="Single supplier" tone="warning" />
            <MoneyCell value={item.cheapest_price} />
            {item.stock_qty == null ? null : <span className="procurement-dashboard-mini-metric">Stock {formatMasterNumber(item.stock_qty, 0)}</span>}
            {item.lead_time_days == null ? null : <span className="procurement-dashboard-mini-metric">{formatMasterNumber(item.lead_time_days, 0)} days lead</span>}
          </>
        ) : (
          <>
            <MoneyCell value={item.price_gap} muted={!hasGap} />
            <PercentCell value={item.price_gap_percent} muted={!hasGap} />
            <MoneyCell value={item.second_price} muted={item.second_price == null} />
          </>
        )}
      </div>
    </article>
  );
}

export function ProcurementDashboardPage({ onOpenSupplierComparison }: ProcurementDashboardPageProps) {
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [brandId, setBrandId] = useState("");
  const [summary, setSummary] = useState<ProcurementDashboardSummary | null>(null);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoadingBrands(true);
      setError("");
      try {
        const result = await fetchCloudBrands();
        if (cancelled) return;
        setBrands(result);
        setBrandId((current) => current || result[0]?.id || "");
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Brand request failed");
        }
      } finally {
        if (!cancelled) setLoadingBrands(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!brandId) {
        setSummary(null);
        return;
      }

      setLoadingSummary(true);
      setError("");
      try {
        const result = await fetchProcurementDashboardSummary({
          brandId,
          highGapThreshold: HIGH_GAP_PERCENT,
          limit: DASHBOARD_ITEM_LIMIT,
        });
        if (!cancelled) setSummary(result);
      } catch (caught) {
        if (!cancelled) {
          setSummary(null);
          setError(getDashboardErrorMessage(caught));
        }
      } finally {
        if (!cancelled) setLoadingSummary(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [brandId, refreshTick]);

  const currentSummary = summary || emptySummary;
  const selectedBrand = useMemo(() => brands.find((item) => item.id === brandId) || null, [brandId, brands]);
  const brandOptions = [
    { value: "", label: "Select brand" },
    ...brands.map((item) => ({ value: item.id, label: item.name })),
  ];
  const loadedLabel = `${currentSummary.total_rollups.toLocaleString("en-US")} rollup rows`;
  const refreshedLabel = formatDateTime(currentSummary.max_refreshed_at);

  return (
    <div className="page-stack procurement-dashboard-page">
      <section className="procurement-dashboard-header">
        <div>
          <span className="procurement-page-header__eyebrow">Procurement Intelligence</span>
          <h2>Procurement Intelligence</h2>
          <p>Pricing coverage, supplier risk, and price gap opportunities from supplier price rollups.</p>
        </div>
        <Button variant="secondary" className="button--compact" onClick={onOpenSupplierComparison}>
          Supplier Comparison
        </Button>
      </section>

      <section className="smart-filter-bar" aria-label="Procurement dashboard filters">
        <div className="smart-filter-bar__controls procurement-dashboard-filters">
          <Select label="Brand" value={brandId} options={brandOptions} onChange={setBrandId} />
          <Button onClick={() => setRefreshTick((current) => current + 1)} busy={loadingSummary} busyLabel="Loading...">
            Refresh
          </Button>
        </div>
        <div className="procurement-dashboard-meta">
          <span>{loadingBrands ? "Loading brands..." : selectedBrand?.name || "No brand selected"}</span>
          <span>{loadingSummary ? "Refreshing intelligence..." : loadedLabel}</span>
          <span>Rollup refresh: {refreshedLabel}</span>
        </div>
      </section>

      {error ? <div className="procurement-dashboard-error">{error}</div> : null}

      <section className="metric-strip" aria-label="Procurement KPI summary">
        <MetricTile label="Total Priced Items" value={currentSummary.total_rollups.toLocaleString("en-US")} detail="Supplier rollups" tone="neutral" />
        <MetricTile label="Items with 2+ Suppliers" value={currentSummary.with_second_supplier.toLocaleString("en-US")} detail="Comparison ready" tone="success" />
        <MetricTile label="Single Supplier Risk" value={currentSummary.single_supplier_count.toLocaleString("en-US")} detail="No backup supplier" tone={currentSummary.single_supplier_count ? "warning" : "success"} />
        <MetricTile label="Average Price Gap %" value={currentSummary.avg_gap_percent == null ? "-" : `${formatMasterNumber(currentSummary.avg_gap_percent, 2)}%`} detail="Rows with gap data" tone="neutral" />
        <MetricTile label="High Gap Opportunities" value={currentSummary.high_gap_count.toLocaleString("en-US")} detail={`Gap >= ${HIGH_GAP_PERCENT}%`} tone={currentSummary.high_gap_count ? "info" : "neutral"} />
        <MetricTile label="Rollup Freshness" value={currentSummary.max_refreshed_at ? "Ready" : "-"} detail={refreshedLabel} tone={currentSummary.max_refreshed_at ? "success" : "warning"} />
      </section>

      {loadingSummary ? (
        <div className="procurement-dashboard-loading" role="status">
          <span className="procurement-loading-state__label">Loading procurement intelligence</span>
          <span className="procurement-loading-state__bar" />
          <span className="procurement-loading-state__bar procurement-loading-state__bar--short" />
        </div>
      ) : !brandId ? (
        <div className="procurement-insight-empty procurement-insight-empty--page">Select a brand to load procurement intelligence.</div>
      ) : (
        <div className="procurement-insight-grid">
          <InsightSection
            title="Best Opportunities"
            badge={`${currentSummary.top_high_gap_items.length} items`}
            badgeTone={currentSummary.top_high_gap_items.length ? "info" : "neutral"}
            rows={currentSummary.top_high_gap_items}
            emptyText="No high-gap supplier opportunities in the current rollup."
          />
          <InsightSection
            title="Single Supplier Risks"
            badge={`${currentSummary.single_supplier_items.length} items`}
            badgeTone={currentSummary.single_supplier_items.length ? "warning" : "success"}
            rows={currentSummary.single_supplier_items}
            emptyText="No single-supplier risk in the current rollup."
            mode="risk"
          />
        </div>
      )}
    </div>
  );
}
