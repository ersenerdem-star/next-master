import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCloudMaster } from "../../infrastructure/api/masterApi";
import type { BrandOption } from "../../types/brand";
import type { MasterRow } from "../../types/master";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
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

const DASHBOARD_PAGE_SIZE = 50;
const DASHBOARD_HEAVY_BRAND_MESSAGE = "This brand has many items. Please narrow the search or open Supplier Comparison.";

const scopeOptions = [
  { value: "catalog", label: "Catalog only" },
  { value: "all", label: "Catalog + supplier only" },
];

type ProcurementDashboardPageProps = {
  onOpenSupplierComparison?: () => void;
};

function hasBestPrice(row: MasterRow) {
  return row.cheapest_price != null && Boolean(String(row.cheapest_supplier || "").trim());
}

function hasSecondSupplier(row: MasterRow) {
  return Number(row.supplier_count ?? 0) >= 2 || row.second_price != null || Boolean(String(row.second_supplier_name || "").trim());
}

function numericValue(value: number | null | undefined) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function sortByGapPercent(left: MasterRow, right: MasterRow) {
  return numericValue(right.price_gap_percent) - numericValue(left.price_gap_percent);
}

function sortByGapAmount(left: MasterRow, right: MasterRow) {
  return numericValue(right.price_gap) - numericValue(left.price_gap);
}

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
  rows: MasterRow[];
  emptyText: string;
  mode?: "gap" | "risk" | "missing";
}) {
  return (
    <section className="procurement-insight-card">
      <div className="procurement-insight-card__header">
        <h3>{title}</h3>
        <RiskBadge label={badge} tone={badgeTone} />
      </div>
      <div className="procurement-insight-card__body">
        {rows.length ? rows.map((row) => <InsightRow key={`${row.brand}:${row.product_code}:${mode}`} row={row} mode={mode} />) : <div className="procurement-insight-empty">{emptyText}</div>}
      </div>
    </section>
  );
}

function InsightRow({ row, mode }: { row: MasterRow; mode: "gap" | "risk" | "missing" }) {
  const hasGap = row.price_gap != null || row.price_gap_percent != null;

  return (
    <article className="procurement-insight-row">
      <div className="procurement-insight-row__product">
        <ProductIdentityCell row={row} />
      </div>
      <div className="procurement-insight-row__decision">
        <SupplierComparisonCell row={row} />
      </div>
      <div className="procurement-insight-row__metrics">
        {mode === "missing" ? (
          <RiskBadge label="Missing supplier data" tone="danger" />
        ) : mode === "risk" ? (
          <>
            <RiskBadge label="Single supplier" tone="warning" />
            <MoneyCell value={row.cheapest_price} />
          </>
        ) : (
          <>
            <MoneyCell value={row.price_gap} muted={!hasGap} />
            <PercentCell value={row.price_gap_percent} muted={!hasGap} />
            <MoneyCell value={row.second_price} muted={row.second_price == null} />
          </>
        )}
      </div>
    </article>
  );
}

export function ProcurementDashboardPage({ onOpenSupplierComparison }: ProcurementDashboardPageProps) {
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [brand, setBrand] = useState("");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [scope, setScope] = useState("catalog");
  const [rows, setRows] = useState<MasterRow[]>([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoadingBrands(true);
      setError("");
      try {
        const result = await fetchCloudBrands();
        if (cancelled) return;
        setBrands(result);
        setBrand((current) => current || result[0]?.name || "");
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
      if (!brand) {
        setRows([]);
        return;
      }

      setLoadingRows(true);
      setError("");
      try {
        const result = await fetchCloudMaster({
          search: submittedSearch,
          brand,
          scope,
          page: 1,
          pageSize: DASHBOARD_PAGE_SIZE,
        });
        if (!cancelled) setRows(result);
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          setError(getDashboardErrorMessage(caught));
        }
      } finally {
        if (!cancelled) setLoadingRows(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [brand, scope, submittedSearch]);

  const brandOptions = [
    { value: "", label: "Select brand" },
    ...brands.map((item) => ({ value: item.name, label: item.name })),
  ];

  const summary = useMemo(() => {
    const pricedRows = rows.filter(hasBestPrice);
    const rowsWithSecondSupplier = rows.filter((row) => hasBestPrice(row) && hasSecondSupplier(row));
    const singleSupplierRisk = rows.filter((row) => hasBestPrice(row) && !hasSecondSupplier(row));
    const highGapRows = rows.filter((row) => hasBestPrice(row) && Number(row.price_gap_percent ?? 0) >= HIGH_GAP_PERCENT);
    const missingSupplierRows = rows.filter((row) => !hasBestPrice(row));
    const gapPercentValues = rows
      .map((row) => Number(row.price_gap_percent))
      .filter((value) => Number.isFinite(value));
    const averageGapPercent = gapPercentValues.length
      ? gapPercentValues.reduce((sum, value) => sum + value, 0) / gapPercentValues.length
      : null;

    return {
      pricedRows,
      rowsWithSecondSupplier,
      singleSupplierRisk,
      highGapRows,
      missingSupplierRows,
      averageGapPercent,
    };
  }, [rows]);

  const insights = useMemo(() => {
    const bestOpportunities = [...summary.highGapRows]
      .filter((row) => row.price_gap != null && hasSecondSupplier(row))
      .sort(sortByGapAmount)
      .slice(0, 5);
    const singleSupplierRisks = [...summary.singleSupplierRisk]
      .sort((left, right) => numericValue(right.cheapest_price) - numericValue(left.cheapest_price))
      .slice(0, 5);
    const highGapItems = [...summary.highGapRows].sort(sortByGapPercent).slice(0, 5);
    const missingSupplierData = [...summary.missingSupplierRows].slice(0, 5);

    return {
      bestOpportunities,
      singleSupplierRisks,
      highGapItems,
      missingSupplierData,
    };
  }, [summary.highGapRows, summary.missingSupplierRows, summary.singleSupplierRisk]);

  const total = rows[0]?.total_count ?? 0;
  const loadedLabel = total
    ? `${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows`
    : `${rows.length.toLocaleString("en-US")} rows`;

  function submitSearch() {
    setSubmittedSearch(search);
  }

  return (
    <div className="page-stack procurement-dashboard-page">
      <section className="procurement-dashboard-header">
        <div>
          <span className="procurement-page-header__eyebrow">Procurement Intelligence</span>
          <h2>Procurement Intelligence</h2>
          <p>Pricing coverage, supplier risk, and price gap opportunities for the selected brand.</p>
        </div>
        <Button variant="secondary" className="button--compact" onClick={onOpenSupplierComparison}>
          Supplier Comparison
        </Button>
      </section>

      <section className="smart-filter-bar" aria-label="Procurement dashboard filters">
        <div className="smart-filter-bar__controls procurement-dashboard-filters">
          <Input
            label="Search product/OEM/description"
            value={search}
            onChange={setSearch}
            placeholder="Code, OEM, name"
            onEnter={submitSearch}
          />
          <div className="smart-filter-bar__selects">
            <Select label="Brand" value={brand} options={brandOptions} onChange={setBrand} />
            <Select label="Scope" value={scope} options={scopeOptions} onChange={setScope} />
          </div>
          <Button onClick={submitSearch} busy={loadingRows} busyLabel="Loading...">
            Refresh
          </Button>
        </div>
        <div className="procurement-dashboard-meta">
          <span>{loadingBrands ? "Loading brands..." : brand || "No brand selected"}</span>
          <span>{loadingRows ? "Refreshing intelligence..." : loadedLabel}</span>
          {submittedSearch.trim() ? <span>Search: {submittedSearch.trim()}</span> : null}
        </div>
      </section>

      {error ? <div className="procurement-dashboard-error">{error}</div> : null}

      <section className="metric-strip" aria-label="Procurement KPI summary">
        <MetricTile label="Total Priced Items" value={summary.pricedRows.length.toLocaleString("en-US")} detail={loadedLabel} tone="neutral" />
        <MetricTile label="Items with 2+ Suppliers" value={summary.rowsWithSecondSupplier.length.toLocaleString("en-US")} detail="Comparison ready" tone="success" />
        <MetricTile label="Single Supplier Risk" value={summary.singleSupplierRisk.length.toLocaleString("en-US")} detail="No backup supplier" tone={summary.singleSupplierRisk.length ? "warning" : "success"} />
        <MetricTile label="Average Price Gap %" value={summary.averageGapPercent == null ? "-" : `${formatMasterNumber(summary.averageGapPercent, 2)}%`} detail="Rows with gap data" tone="neutral" />
        <MetricTile label="High Gap Opportunities" value={summary.highGapRows.length.toLocaleString("en-US")} detail={`Gap >= ${HIGH_GAP_PERCENT}%`} tone={summary.highGapRows.length ? "info" : "neutral"} />
        <MetricTile label="Missing Supplier Data" value={summary.missingSupplierRows.length.toLocaleString("en-US")} detail="No active price" tone={summary.missingSupplierRows.length ? "danger" : "success"} />
      </section>

      {loadingRows ? (
        <div className="procurement-dashboard-loading" role="status">
          <span className="procurement-loading-state__label">Loading procurement intelligence</span>
          <span className="procurement-loading-state__bar" />
          <span className="procurement-loading-state__bar procurement-loading-state__bar--short" />
        </div>
      ) : !brand ? (
        <div className="procurement-insight-empty procurement-insight-empty--page">Select a brand to load procurement intelligence.</div>
      ) : (
        <div className="procurement-insight-grid">
          <InsightSection
            title="Best Opportunities"
            badge={`${insights.bestOpportunities.length} items`}
            badgeTone={insights.bestOpportunities.length ? "info" : "neutral"}
            rows={insights.bestOpportunities}
            emptyText="No high-gap supplier opportunities in the current selection."
          />
          <InsightSection
            title="Single Supplier Risks"
            badge={`${insights.singleSupplierRisks.length} items`}
            badgeTone={insights.singleSupplierRisks.length ? "warning" : "success"}
            rows={insights.singleSupplierRisks}
            emptyText="No single-supplier risk in the current selection."
            mode="risk"
          />
          <InsightSection
            title="High Gap Items"
            badge={`${insights.highGapItems.length} items`}
            badgeTone={insights.highGapItems.length ? "info" : "neutral"}
            rows={insights.highGapItems}
            emptyText="No high-gap items in the current selection."
          />
          {insights.missingSupplierData.length ? (
            <InsightSection
              title="No Price / Missing Supplier Data"
              badge={`${insights.missingSupplierData.length} items`}
              badgeTone="danger"
              rows={insights.missingSupplierData}
              emptyText="All loaded items have supplier price coverage."
              mode="missing"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
