import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCPriceMapForRows, getCPriceForRow } from "../../infrastructure/api/cPriceApi";
import { CLOUD_MASTER_EXPORT_MAX_ROWS, CLOUD_MASTER_PRICED_EXPORT_MAX_ROWS, fetchAllCloudMaster, fetchCloudMasterFast } from "../../infrastructure/api/masterApi";
import { fetchPriceListSettings } from "../../infrastructure/api/priceListsApi";
import type { BrandOption } from "../../types/brand";
import type { MasterRow } from "../../types/master";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
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
import { formatBrandAwareProductCode } from "../../shared/productCodeDisplay";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { CompactFilterBar, PageHeader, PageShell } from "../components/common/VisualPrimitives";
import { useI18n } from "../../i18n/I18nProvider";

export function MasterPage() {
  const { t } = useI18n();
  const r = (key: string, params?: Record<string, string | number>) => t(`reports.${key}`, params);
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [brandId, setBrandId] = useState("");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [scope, setScope] = useState("priced");
  const [marginA, setMarginA] = useState(0.1);
  const [marginB, setMarginB] = useState(0.15);
  const [rows, setRows] = useState<MasterRow[]>([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState("");
  const [exportNotice, setExportNotice] = useState("");
  const [searching, setSearching] = useState(false);
  const [exportingMaster, setExportingMaster] = useState(false);

  function applyCPrices(baseRows: MasterRow[], priceMap: Map<string, number>) {
    return baseRows.map((row) => ({
      ...row,
      sales_c: getCPriceForRow(priceMap, row),
    }));
  }

  const selectedBrand = brands.find((item) => item.id === brandId) || null;
  const brandName = selectedBrand?.name || "";

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
          setError(caught instanceof Error ? caught.message : r("master.errors.brandRequestFailed"));
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
      try {
        const settings = await fetchPriceListSettings();
        if (cancelled) return;
        const a = settings.find((item) => item.listType === "A");
        const b = settings.find((item) => item.listType === "B");
        if (typeof a?.marginPercent === "number") setMarginA(a.marginPercent / 100);
        if (typeof b?.marginPercent === "number") setMarginB(b.marginPercent / 100);
      } catch {
        if (!cancelled) {
          setMarginA(0.1);
          setMarginB(0.15);
        }
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
      if (!brandId || !brandName) {
        setRows([]);
        setExportNotice("");
        return;
      }

      setLoadingRows(true);
      setError("");
      setExportNotice("");
      try {
        const result = await fetchCloudMasterFast({
          search: submittedSearch,
          brand: brandName,
          brandId,
          scope,
          page: 1,
          pageSize: 50,
          marginA,
          marginB,
        });
        const cPriceMap = await fetchCPriceMapForRows(result);
        if (!cancelled) setRows(applyCPrices(result, cPriceMap));
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          setError(caught instanceof Error ? caught.message : r("master.errors.requestFailed"));
        }
      } finally {
        if (!cancelled) setLoadingRows(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [brandId, brandName, scope, submittedSearch, marginA, marginB]);

  useEffect(() => {
    if (!searching || loadingRows) return;
    const nextTotal = rows[0]?.total_count ?? rows.length;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(r("master.feedback.rowsLoaded", { count: nextTotal.toLocaleString("en-US") }));
    }
    setSearching(false);
  }, [searching, loadingRows, error, rows, actionFeedback]);

  const total = rows[0]?.total_count ?? rows.length;
  const avgGapPercent = useMemo(() => {
    const values = rows
      .map((row) => Number(row.price_gap_percent))
      .filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [rows]);
  const summary = useMemo(() => {
    const withSecondSupplier = rows.filter((row) => row.second_price != null || Boolean(String(row.second_supplier_name || "").trim())).length;
    const highGap = rows.filter((row) => Number(row.price_gap_percent ?? 0) >= HIGH_GAP_PERCENT).length;
    const singleSupplier = rows.filter((row) => {
      const hasSecondSupplier = row.second_price != null || Boolean(String(row.second_supplier_name || "").trim());
      return !hasSecondSupplier || Number(row.supplier_count ?? 0) <= 1;
    }).length;
    return {
      rowsShown: rows.length,
      withSecondSupplier,
      highGap,
      singleSupplier,
    };
  }, [rows]);

  const scopeOptions = useMemo(
    () => [
      { value: "priced", label: r("master.scope.priced") },
      { value: "catalog", label: r("master.scope.catalog") },
    ],
    [t],
  );
  const brandOptions = [
    { value: "", label: r("master.filters.selectBrand") },
    ...brands.map((item) => ({ value: item.id, label: item.name })),
  ];
  const scopeLabel = scopeOptions.find((item) => item.value === scope)?.label || scope;
  const activeFilterChips = [
    brandName ? r("master.filters.brandChip", { brand: brandName }) : "",
    submittedSearch.trim() ? r("master.filters.searchChip", { search: submittedSearch.trim() }) : "",
    scope ? r("master.filters.scopeChip", { scope: scopeLabel }) : "",
  ].filter(Boolean);

  const columns = useMemo(
    () => [
      {
        key: "product",
        header: r("master.columns.product"),
        render: (row: MasterRow) => <ProductIdentityCell row={row} />,
        sortValue: (row: MasterRow) => row.product_code,
      },
      {
        key: "decision",
        header: r("master.columns.supplierDecision"),
        render: (row: MasterRow) => <SupplierComparisonCell row={row} />,
        sortValue: (row: MasterRow) => row.cheapest_supplier || "",
      },
      {
        key: "bestPrice",
        header: r("master.columns.bestPrice"),
        render: (row: MasterRow) => <MoneyCell value={row.cheapest_price} />,
        sortValue: (row: MasterRow) => row.cheapest_price ?? 0,
      },
      {
        key: "second",
        header: r("master.columns.secondSupplierPrice"),
        render: (row: MasterRow) => (
          <div className="second-supplier-cell">
            <span className="second-supplier-cell__name">{row.second_supplier_name || r("master.values.noSecondSupplier")}</span>
            <MoneyCell value={row.second_price} muted={row.second_price == null} />
          </div>
        ),
        sortValue: (row: MasterRow) => row.second_price ?? 0,
      },
      {
        key: "gap",
        header: r("master.columns.gap"),
        render: (row: MasterRow) => {
          const isHighGap = Number(row.price_gap_percent ?? 0) >= HIGH_GAP_PERCENT;
          const hasGap = row.price_gap != null || row.price_gap_percent != null;
          return (
            <div className="gap-cell">
              <MoneyCell value={row.price_gap} muted={!hasGap} />
              <PercentCell value={row.price_gap_percent} muted={!hasGap} />
              {hasGap ? <RiskBadge label={isHighGap ? r("master.badges.highGap") : r("master.badges.competitive")} tone={isHighGap ? "info" : "success"} /> : <RiskBadge label={r("master.badges.noGap")} tone="neutral" />}
            </div>
          );
        },
        sortValue: (row: MasterRow) => row.price_gap_percent ?? 0,
      },
      {
        key: "sales",
        header: r("master.columns.salesPrices"),
        render: (row: MasterRow) => (
          <div className="sales-price-stack">
            <span><strong>A</strong><MoneyCell value={row.sales_a} /></span>
            <span><strong>B</strong><MoneyCell value={row.sales_b} /></span>
            <span><strong>C</strong><MoneyCell value={row.sales_c} /></span>
          </div>
        ),
      },
      {
        key: "meta",
        header: r("master.columns.meta"),
        render: (row: MasterRow) => (
          <div className="master-meta-cell">
            <span>{row.origin || r("master.values.noOrigin")}</span>
            <span>{row.weight_kg == null ? r("master.values.noWeight") : `${formatMasterNumber(row.weight_kg, 3)} kg`}</span>
            <span>{row.hs_code ? `HS ${row.hs_code}` : r("master.values.noHs")}</span>
          </div>
        ),
      },
    ],
    [t],
  );

  async function loadMasterExportRows() {
    if (!brandName) {
      throw new Error(r("master.errors.selectBrandFirst"));
    }
    const maxRows = scope === "priced" ? CLOUD_MASTER_PRICED_EXPORT_MAX_ROWS : CLOUD_MASTER_EXPORT_MAX_ROWS;
    const exportRows = await fetchAllCloudMaster({
      search: submittedSearch,
      brand: brandName,
      brandId,
      scope,
      marginA,
      marginB,
      maxRows,
    });
    const cPriceMap = await fetchCPriceMapForRows(exportRows);
    return applyCPrices(exportRows, cPriceMap);
  }

  async function handleMasterExport() {
    try {
      setError("");
      setExportNotice("");
      setExportingMaster(true);
      actionFeedback.begin(r("master.feedback.preparingExport"));
      const exportRows = await loadMasterExportRows();
      if (!exportRows.length) {
        setError(r("master.errors.noRowsForExport"));
        actionFeedback.fail(r("master.errors.noRowsForExport"));
        return;
      }

      const headers = [
        "Product_Code",
        "Brand",
        "Product_Name",
        "OEM_No",
        "HS_Code",
        "Origin",
        "Weight_kg",
        "Cheapest_Supplier",
        "Cheapest_EUR",
        "Second_Supplier",
        "Second_EUR",
        "Price_Gap_EUR",
        "Price_Gap_Percent",
        "Price_Date",
        "A_Sales_EUR",
        "B_Sales_EUR",
        "C_Sales_EUR",
        "Supplier_Count",
        "Catalog_Status",
        "Notes",
      ];
      const rowsForSheet = [
        headers,
        ...exportRows.map((row) => [
          formatBrandAwareProductCode(row.product_code, row.brand),
          row.brand || "",
          row.description || "",
          row.oem_no || "",
          row.hs_code || "",
          row.origin || "",
          row.weight_kg ?? "",
          row.cheapest_supplier || "",
          row.cheapest_price ?? "",
          row.second_supplier_name || "",
          row.second_price ?? "",
          row.price_gap ?? "",
          row.price_gap_percent ?? "",
          row.price_date || "",
          row.sales_a ?? "",
          row.sales_b ?? "",
          row.sales_c ?? "",
          row.supplier_count ?? "",
          row.catalog_status || "",
          row.notes || "",
        ]),
      ];
      const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const fileBrand = (brandName || "all-brands").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      downloadBlob(
        `${fileBrand}-${stamp}-master.xlsx`,
        buildXlsxBlob(`${brandName || r("values.all")} ${r("master.export.sheetSuffix")}`, rowsForSheet, [6, 8, 10, 11, 12, 14, 15, 16, 17]),
      );
      const maxRows = scope === "priced" ? CLOUD_MASTER_PRICED_EXPORT_MAX_ROWS : CLOUD_MASTER_EXPORT_MAX_ROWS;
      if (exportRows.length >= maxRows) {
        const notice = r("master.feedback.exportLimited", { count: maxRows.toLocaleString("en-US") });
        setExportNotice(notice);
        actionFeedback.succeed(notice);
      } else {
        actionFeedback.succeed(r("master.feedback.exportDownloaded"));
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : r("master.errors.exportFailed");
      setError(message);
      setExportNotice("");
      actionFeedback.fail(message);
    } finally {
      setExportingMaster(false);
    }
  }

  function handleSearch() {
    setExportNotice("");
    setSearching(true);
    actionFeedback.begin(r("master.feedback.searching", { target: search.trim() || brandName || r("values.allItems") }));
    setSubmittedSearch(search);
  }

  return (
    <PageShell className="procurement-master-page">
      <PageHeader
        eyebrow={r("procurement.eyebrow")}
        title={r("master.title")}
        subtitle={r("master.subtitle")}
        actions={
          <Button
            variant="secondary"
            className="button--compact procurement-export-button"
            onClick={() => void handleMasterExport()}
            busy={exportingMaster}
            busyLabel={r("busy.preparing")}
          >
            {r("actions.exportXlsx")}
          </Button>
        }
      />

      <CompactFilterBar className="smart-filter-bar">
        <div className="smart-filter-bar__controls">
          <Input
            label={r("master.fields.search")}
            value={search}
            onChange={setSearch}
            placeholder={r("master.placeholders.search")}
            onEnter={handleSearch}
          />
          <div className="smart-filter-bar__selects">
            <Select label={r("fields.brand")} value={brandId} options={brandOptions} onChange={setBrandId} />
            <Select label={r("master.fields.scope")} value={scope} options={scopeOptions} onChange={setScope} />
          </div>
          <Button onClick={handleSearch} busy={searching} busyLabel={r("busy.searching")}>
            {r("actions.search")}
          </Button>
        </div>
        <div className="active-filter-chip-row" aria-label={r("master.filters.activeFilters")}>
          {activeFilterChips.length ? activeFilterChips.map((chip) => <span key={chip} className="active-filter-chip">{chip}</span>) : <span className="active-filter-chip active-filter-chip--empty">{r("master.filters.noActiveFilters")}</span>}
        </div>
      </CompactFilterBar>

      <section className="metric-strip" aria-label={r("master.summary.aria")}>
        <MetricTile label={r("master.summary.rowsShown")} value={summary.rowsShown.toLocaleString("en-US")} detail={loadingRows ? r("master.summary.loadingLatestPage") : r("master.summary.currentPage")} tone="neutral" />
        <MetricTile label={r("master.summary.totalItems")} value={total ? total.toLocaleString("en-US") : "-"} detail={r("master.summary.filteredResultSet")} tone="neutral" />
        <MetricTile label={r("master.summary.withSecondSupplier")} value={summary.withSecondSupplier.toLocaleString("en-US")} detail={r("master.summary.comparisonReady")} tone="success" />
        <MetricTile label={r("master.summary.highGapItems")} value={summary.highGap.toLocaleString("en-US")} detail={r("master.summary.gapThreshold", { percent: HIGH_GAP_PERCENT })} tone={summary.highGap ? "info" : "neutral"} />
        <MetricTile label={r("master.summary.singleSupplier")} value={summary.singleSupplier.toLocaleString("en-US")} detail={r("master.values.noSecondSupplier")} tone={summary.singleSupplier ? "warning" : "success"} />
        <MetricTile label={r("master.summary.averageGap")} value={avgGapPercent == null ? "-" : `${formatMasterNumber(avgGapPercent, 2)}%`} detail={r("master.summary.rowsWithGapData")} tone="neutral" />
      </section>

      <section className="section-card procurement-table-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>{r("master.decisionTable.title")}</h2>
            <p>
              {loadingBrands
                ? r("master.loading.brandContext")
                : loadingRows
                  ? r("master.loading.refreshingSupplierIntelligence")
                  : total
                    ? r("master.meta.rowsShownFromTotal", { shown: summary.rowsShown.toLocaleString("en-US"), total: total.toLocaleString("en-US") })
                    : r("master.meta.rowsShown", { shown: summary.rowsShown.toLocaleString("en-US") })}
            </p>
          </div>
          {error ? <div className="procurement-error-state">{error}</div> : null}
          {exportNotice ? <div className="procurement-warning-state">{exportNotice}</div> : null}
        </div>
        <div className="section-card__body">
          {loadingRows ? (
            <div className="procurement-loading-state" role="status">
              <span className="procurement-loading-state__label">{r("master.loading.buildingSupplierComparison")}</span>
              <span className="procurement-loading-state__bar" />
              <span className="procurement-loading-state__bar procurement-loading-state__bar--short" />
            </div>
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              className="decision-table"
              wrapClassName="decision-table-wrap"
              emptyText={!brandId ? r("master.empty.selectBrandOrSearch") : r("master.empty.noComparisons")}
            />
          )}
        </div>
      </section>
    </PageShell>
  );
}
