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
import { useI18n } from "../../i18n/I18nProvider";

const DASHBOARD_ITEM_LIMIT = 10;

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

function getDashboardErrorMessage(caught: unknown, heavyBrandMessage: string, fallbackMessage: string) {
  const message = caught instanceof Error ? caught.message : String(caught || "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("request too long") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("took too long")
  ) {
    return heavyBrandMessage;
  }
  return message || fallbackMessage;
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
  const { t } = useI18n();
  const r = (key: string, params?: Record<string, string | number>) => t(`reports.${key}`, params);
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
            <RiskBadge label={r("procurement.badges.singleSupplier")} tone="warning" />
            <MoneyCell value={item.cheapest_price} />
            {item.stock_qty == null ? null : <span className="procurement-dashboard-mini-metric">{r("procurement.values.stockQty", { qty: formatMasterNumber(item.stock_qty, 0) })}</span>}
            {item.lead_time_days == null ? null : <span className="procurement-dashboard-mini-metric">{r("procurement.values.daysLead", { days: formatMasterNumber(item.lead_time_days, 0) })}</span>}
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
  const { t } = useI18n();
  const r = (key: string, params?: Record<string, string | number>) => t(`reports.${key}`, params);
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
          setError(caught instanceof Error ? caught.message : r("procurement.errors.brandRequestFailed"));
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
          setError(getDashboardErrorMessage(caught, r("procurement.errors.heavyBrand"), r("procurement.errors.requestFailed")));
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
    { value: "", label: r("procurement.filters.selectBrand") },
    ...brands.map((item) => ({ value: item.id, label: item.name })),
  ];
  const loadedLabel = r("procurement.meta.rollupRows", { count: currentSummary.total_rollups.toLocaleString("en-US") });
  const refreshedLabel = formatDateTime(currentSummary.max_refreshed_at);

  return (
    <div className="page-stack procurement-dashboard-page">
      <section className="procurement-dashboard-header">
        <div>
          <span className="procurement-page-header__eyebrow">{r("procurement.eyebrow")}</span>
          <h2>{r("procurement.title")}</h2>
          <p>{r("procurement.subtitle")}</p>
        </div>
        <Button variant="secondary" className="button--compact" onClick={onOpenSupplierComparison}>
          {r("master.title")}
        </Button>
      </section>

      <section className="smart-filter-bar" aria-label={r("procurement.filters.aria")}>
        <div className="smart-filter-bar__controls procurement-dashboard-filters">
          <Select label={r("fields.brand")} value={brandId} options={brandOptions} onChange={setBrandId} />
          <Button onClick={() => setRefreshTick((current) => current + 1)} busy={loadingSummary} busyLabel={r("busy.loading")}>
            {r("actions.refresh")}
          </Button>
        </div>
        <div className="procurement-dashboard-meta">
          <span>{loadingBrands ? r("procurement.loading.brands") : selectedBrand?.name || r("procurement.values.noBrandSelected")}</span>
          <span>{loadingSummary ? r("procurement.loading.refreshingIntelligence") : loadedLabel}</span>
          <span>{r("procurement.meta.rollupRefresh", { value: refreshedLabel })}</span>
        </div>
      </section>

      {error ? <div className="procurement-dashboard-error">{error}</div> : null}

      <section className="metric-strip" aria-label={r("procurement.summary.aria")}>
        <MetricTile label={r("procurement.summary.totalPricedItems")} value={currentSummary.total_rollups.toLocaleString("en-US")} detail={r("procurement.summary.supplierRollups")} tone="neutral" />
        <MetricTile label={r("procurement.summary.itemsWithTwoSuppliers")} value={currentSummary.with_second_supplier.toLocaleString("en-US")} detail={r("master.summary.comparisonReady")} tone="success" />
        <MetricTile label={r("procurement.summary.singleSupplierRisk")} value={currentSummary.single_supplier_count.toLocaleString("en-US")} detail={r("procurement.summary.noBackupSupplier")} tone={currentSummary.single_supplier_count ? "warning" : "success"} />
        <MetricTile label={r("procurement.summary.averagePriceGap")} value={currentSummary.avg_gap_percent == null ? "-" : `${formatMasterNumber(currentSummary.avg_gap_percent, 2)}%`} detail={r("master.summary.rowsWithGapData")} tone="neutral" />
        <MetricTile label={r("procurement.summary.highGapOpportunities")} value={currentSummary.high_gap_count.toLocaleString("en-US")} detail={r("master.summary.gapThreshold", { percent: HIGH_GAP_PERCENT })} tone={currentSummary.high_gap_count ? "info" : "neutral"} />
        <MetricTile label={r("procurement.summary.rollupFreshness")} value={currentSummary.max_refreshed_at ? r("values.ready") : "-"} detail={refreshedLabel} tone={currentSummary.max_refreshed_at ? "success" : "warning"} />
      </section>

      {loadingSummary ? (
        <div className="procurement-dashboard-loading" role="status">
          <span className="procurement-loading-state__label">{r("procurement.loading.procurementIntelligence")}</span>
          <span className="procurement-loading-state__bar" />
          <span className="procurement-loading-state__bar procurement-loading-state__bar--short" />
        </div>
      ) : !brandId ? (
        <div className="procurement-insight-empty procurement-insight-empty--page">{r("procurement.empty.selectBrand")}</div>
      ) : (
        <div className="procurement-insight-grid">
          <InsightSection
            title={r("procurement.sections.bestOpportunities")}
            badge={r("procurement.badges.items", { count: currentSummary.top_high_gap_items.length })}
            badgeTone={currentSummary.top_high_gap_items.length ? "info" : "neutral"}
            rows={currentSummary.top_high_gap_items}
            emptyText={r("procurement.empty.noHighGapOpportunities")}
          />
          <InsightSection
            title={r("procurement.sections.singleSupplierRisks")}
            badge={r("procurement.badges.items", { count: currentSummary.single_supplier_items.length })}
            badgeTone={currentSummary.single_supplier_items.length ? "warning" : "success"}
            rows={currentSummary.single_supplier_items}
            emptyText={r("procurement.empty.noSingleSupplierRisk")}
            mode="risk"
          />
        </div>
      )}
    </div>
  );
}
