import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCPriceMapForRows, getCPriceForRow } from "../../infrastructure/api/cPriceApi";
import { CLOUD_MASTER_EXPORT_MAX_ROWS, fetchAllCloudMaster, fetchCloudMasterFast } from "../../infrastructure/api/masterApi";
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
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";

const scopeOptions = [
  { value: "catalog", label: "Catalog only" },
  { value: "all", label: "Catalog + supplier only" },
];

export function MasterPage() {
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [brandId, setBrandId] = useState("");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [scope, setScope] = useState("catalog");
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
          setError(caught instanceof Error ? caught.message : "Master request failed");
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
      actionFeedback.succeed(`${nextTotal.toLocaleString("en-US")} master rows loaded.`);
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

  const brandOptions = [
    { value: "", label: "Select brand" },
    ...brands.map((item) => ({ value: item.id, label: item.name })),
  ];
  const scopeLabel = scopeOptions.find((item) => item.value === scope)?.label || scope;
  const activeFilterChips = [
    brandName ? `Brand: ${brandName}` : "",
    submittedSearch.trim() ? `Search: ${submittedSearch.trim()}` : "",
    scope ? `Scope: ${scopeLabel}` : "",
  ].filter(Boolean);

  const columns = useMemo(
    () => [
      {
        key: "product",
        header: "Product",
        render: (row: MasterRow) => <ProductIdentityCell row={row} />,
        sortValue: (row: MasterRow) => row.product_code,
      },
      {
        key: "decision",
        header: "Supplier Decision",
        render: (row: MasterRow) => <SupplierComparisonCell row={row} />,
        sortValue: (row: MasterRow) => row.cheapest_supplier || "",
      },
      {
        key: "bestPrice",
        header: "Best Price",
        render: (row: MasterRow) => <MoneyCell value={row.cheapest_price} />,
        sortValue: (row: MasterRow) => row.cheapest_price ?? 0,
      },
      {
        key: "second",
        header: "2nd Supplier / Price",
        render: (row: MasterRow) => (
          <div className="second-supplier-cell">
            <span className="second-supplier-cell__name">{row.second_supplier_name || "No second supplier"}</span>
            <MoneyCell value={row.second_price} muted={row.second_price == null} />
          </div>
        ),
        sortValue: (row: MasterRow) => row.second_price ?? 0,
      },
      {
        key: "gap",
        header: "Gap",
        render: (row: MasterRow) => {
          const isHighGap = Number(row.price_gap_percent ?? 0) >= HIGH_GAP_PERCENT;
          const hasGap = row.price_gap != null || row.price_gap_percent != null;
          return (
            <div className="gap-cell">
              <MoneyCell value={row.price_gap} muted={!hasGap} />
              <PercentCell value={row.price_gap_percent} muted={!hasGap} />
              {hasGap ? <RiskBadge label={isHighGap ? "High gap" : "Competitive"} tone={isHighGap ? "info" : "success"} /> : <RiskBadge label="No gap" tone="neutral" />}
            </div>
          );
        },
        sortValue: (row: MasterRow) => row.price_gap_percent ?? 0,
      },
      {
        key: "sales",
        header: "Sales Prices A/B/C",
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
        header: "Meta",
        render: (row: MasterRow) => (
          <div className="master-meta-cell">
            <span>{row.origin || "No origin"}</span>
            <span>{row.weight_kg == null ? "No weight" : `${formatMasterNumber(row.weight_kg, 3)} kg`}</span>
            <span>{row.hs_code ? `HS ${row.hs_code}` : "No HS"}</span>
          </div>
        ),
      },
    ],
    [],
  );

  async function loadMasterExportRows() {
    if (!brandName) {
      throw new Error("Select a brand first.");
    }
    const exportRows = await fetchAllCloudMaster({
      search: submittedSearch,
      brand: brandName,
      scope,
      marginA,
      marginB,
      maxRows: CLOUD_MASTER_EXPORT_MAX_ROWS,
    });
    const cPriceMap = await fetchCPriceMapForRows(exportRows);
    return applyCPrices(exportRows, cPriceMap);
  }

  async function handleMasterExport() {
    try {
      setError("");
      setExportNotice("");
      setExportingMaster(true);
      actionFeedback.begin("Preparing master export...");
      const exportRows = await loadMasterExportRows();
      if (!exportRows.length) {
        setError("No master rows found for the current filters.");
        actionFeedback.fail("No master rows found for the current filters.");
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
          row.product_code,
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
        buildXlsxBlob(`${brandName || "All"} Master`, rowsForSheet, [6, 8, 10, 11, 12, 14, 15, 16, 17]),
      );
      if (exportRows.length >= CLOUD_MASTER_EXPORT_MAX_ROWS) {
        const notice = `Export limited to first ${CLOUD_MASTER_EXPORT_MAX_ROWS.toLocaleString("en-US")} rows. Narrow the search or brand scope for a smaller file.`;
        setExportNotice(notice);
        actionFeedback.succeed(notice);
      } else {
        actionFeedback.succeed("Master export downloaded.");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Master export failed";
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
    actionFeedback.begin(`Searching supplier comparison for ${search.trim() || brandName || "all items"}...`);
    setSubmittedSearch(search);
  }

  return (
    <div className="page-stack procurement-master-page">
      <section className="procurement-page-header">
        <div>
          <span className="procurement-page-header__eyebrow">Procurement Intelligence</span>
          <h2>Supplier Comparison</h2>
          <p>Best supplier, second supplier, price gap and sales price intelligence</p>
        </div>
        <Button
          variant="secondary"
          className="button--compact procurement-export-button"
          onClick={() => void handleMasterExport()}
          busy={exportingMaster}
          busyLabel="Preparing..."
        >
          Export XLSX
        </Button>
      </section>

      <section className="smart-filter-bar" aria-label="Supplier comparison filters">
        <div className="smart-filter-bar__controls">
          <Input
            label="Search product/OEM/description"
            value={search}
            onChange={setSearch}
            placeholder="Code, OEM, name"
            onEnter={handleSearch}
          />
          <div className="smart-filter-bar__selects">
            <Select label="Brand" value={brandId} options={brandOptions} onChange={setBrandId} />
            <Select label="Scope" value={scope} options={scopeOptions} onChange={setScope} />
          </div>
          <Button onClick={handleSearch} busy={searching} busyLabel="Searching...">
            Search
          </Button>
        </div>
        <div className="active-filter-chip-row" aria-label="Active filters">
          {activeFilterChips.length ? activeFilterChips.map((chip) => <span key={chip} className="active-filter-chip">{chip}</span>) : <span className="active-filter-chip active-filter-chip--empty">No active filters</span>}
        </div>
      </section>

      <section className="metric-strip" aria-label="Supplier comparison summary">
        <MetricTile label="Rows Shown" value={summary.rowsShown.toLocaleString("en-US")} detail={loadingRows ? "Loading latest page" : "Current page"} tone="neutral" />
        <MetricTile label="Total Items" value={total ? total.toLocaleString("en-US") : "-"} detail="Filtered result set" tone="neutral" />
        <MetricTile label="With 2nd Supplier" value={summary.withSecondSupplier.toLocaleString("en-US")} detail="Comparison ready" tone="success" />
        <MetricTile label="High Gap Items" value={summary.highGap.toLocaleString("en-US")} detail={`Gap >= ${HIGH_GAP_PERCENT}%`} tone={summary.highGap ? "info" : "neutral"} />
        <MetricTile label="Single Supplier" value={summary.singleSupplier.toLocaleString("en-US")} detail="No second supplier" tone={summary.singleSupplier ? "warning" : "success"} />
        <MetricTile label="Average Gap" value={avgGapPercent == null ? "-" : `${formatMasterNumber(avgGapPercent, 2)}%`} detail="Rows with gap data" tone="neutral" />
      </section>

      <section className="section-card procurement-table-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>Decision Table</h2>
            <p>
              {loadingBrands
                ? "Loading brand context..."
                : loadingRows
                  ? "Refreshing supplier intelligence..."
                  : `${summary.rowsShown.toLocaleString("en-US")} rows shown${total ? ` from ${total.toLocaleString("en-US")} total` : ""}`}
            </p>
          </div>
          {error ? <div className="procurement-error-state">{error}</div> : null}
          {exportNotice ? <div className="procurement-warning-state">{exportNotice}</div> : null}
        </div>
        <div className="section-card__body">
          {loadingRows ? (
            <div className="procurement-loading-state" role="status">
              <span className="procurement-loading-state__label">Building supplier comparison</span>
              <span className="procurement-loading-state__bar" />
              <span className="procurement-loading-state__bar procurement-loading-state__bar--short" />
            </div>
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              className="decision-table"
              wrapClassName="decision-table-wrap"
              emptyText={!brandId ? "Select a brand or search to compare supplier prices." : "No supplier comparisons found for the current filters."}
            />
          )}
        </div>
      </section>
    </div>
  );
}
