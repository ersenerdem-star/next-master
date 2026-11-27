import { useEffect, useMemo, useRef, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCloudMasterFast, fetchCloudMasterGloballySorted, fetchCloudMasterCursor, type MasterPreviewRow } from "../../infrastructure/api/masterApi";
import { enrichSupplierReportCatalog } from "../../infrastructure/api/supplierReportCatalogApi";
import { fetchSupplierComparisonNoteIndicators } from "../../infrastructure/api/supplierComparisonNoteIndicatorsApi";
import { downloadExportJob, startMasterExport, waitForExportJob } from "../../infrastructure/api/exportJobsApi";
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
import { CompactFilterBar, PageHeader, PageShell } from "../components/common/VisualPrimitives";
import { SupplierOffersPanel, SupplierOffersToggle } from "../components/master/AdditionalSupplierOffers";
import { useI18n } from "../../i18n/I18nProvider";

export function MasterPage() {
  const { t, locale } = useI18n();
  const r = (key: string, params?: Record<string, string | number>) => t(`reports.${key}`, params);
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [brandId, setBrandId] = useState("");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [scope, setScope] = useState("priced");
  const [page, setPage] = useState(1);
  const [globalSort, setGlobalSort] = useState<{key:string;direction:"asc"|"desc"}|null>(null);
  const cursorPages = useRef(new Map<number,{afterCode:string;expectedVersion:string|null}>([[1,{afterCode:"",expectedVersion:null}]]));
  const [cursorStale, setCursorStale] = useState(false);
  const [marginA, setMarginA] = useState(0.1);
  const [marginB, setMarginB] = useState(0.15);
  const [rows, setRows] = useState<MasterPreviewRow[]>([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const searchingRef = useRef(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [exportingMaster, setExportingMaster] = useState(false);
  const [expandedOfferKey, setExpandedOfferKey] = useState<string | null>(null);

  const selectedBrand = brands.find((item) => item.id === brandId) || null;
  const brandName = selectedBrand?.name || "";
  const offerKey = (row: MasterRow) => JSON.stringify([brandId, row.product_code, row.product_id]);

  useEffect(() => { setExpandedOfferKey(null); }, [brandId, submittedSearch, scope, page, searchRevision, globalSort]);
  useEffect(() => { cursorPages.current = new Map([[1,{afterCode:"",expectedVersion:null}]]); setCursorStale(false); }, [brandId, scope, submittedSearch, searchRevision, globalSort]);

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
        setLoadingRows(false);
        if (searchingRef.current) {
          searchingRef.current = false;
          setSearching(false);
          actionFeedback.fail(r("master.errors.selectBrandFirst"));
        }
        return;
      }

      setLoadingRows(true);
      setError("");
      try {
        const request = {
          search: submittedSearch,
          brand: brandName,
          brandId,
          scope,
          page,
          pageSize: 50,
          marginA,
          marginB,
        };
        let result: MasterPreviewRow[];
        if (globalSort && scope === "priced") {
          result = await fetchCloudMasterGloballySorted({ ...request, sort: globalSort.key, direction: globalSort.direction });
        } else if (scope === "priced" && !submittedSearch.trim()) {
          const cursor = cursorPages.current.get(page);
          if (!cursor) throw new Error(locale === "tr" ? "Sayfa sırası doğrulanamadı. Raporu yeniden başlatın." : "The page cursor could not be verified. Restart the report.");
          const next = await fetchCloudMasterCursor({ ...request, ...cursor });
          if (cancelled) return;
          cursorPages.current.set(page,{...cursor,expectedVersion:next.sourceVersion});
          if (next.nextCode) cursorPages.current.set(page+1,{afterCode:next.nextCode,expectedVersion:next.sourceVersion});
          result = next.rows;
        } else {
          result = await fetchCloudMasterFast(request);
        }
        if (cancelled) return;
        // Retrieve exact catalog details and note presence for this visible page.
        let complete: typeof result;
        try {
          const [enriched, noteIndicators] = await Promise.all([
            scope === "priced" ? enrichSupplierReportCatalog(brandId, result) : Promise.resolve(result),
            fetchSupplierComparisonNoteIndicators(brandId, result.map((row) => row.product_code)),
          ]);
          complete = enriched.map((row) => ({ ...row, has_notes: noteIndicators[row.product_code] }));
        } catch {
          throw new Error(locale === "tr" ? "Katalog veya tedarikçi notları yüklenemedi. Tekrar deneyin." : "Catalog details or supplier notes could not be loaded. Please try again.");
        }
        if (!cancelled) {
          setRows(complete);
          setCursorStale(false);
          if (searchingRef.current) {
            const nextTotal = result[0]?.total_count ?? result.length;
            actionFeedback.succeed(result[0]?.total_count_is_estimate || result[0]?.total_count_is_unknown
              ? r("master.meta.rowsShown", { shown: result.length.toLocaleString("en-US") })
              : r("master.feedback.rowsLoaded", { count: nextTotal.toLocaleString("en-US") }));
            searchingRef.current = false;
            setSearching(false);
          }
        }
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          const code = caught instanceof Error ? (caught as Error & {code?:string}).code : "";
          setCursorStale(code === "SUPPLIER_CURSOR_STALE");
          const message = code === "SUPPLIER_CURSOR_STALE"
            ? locale === "tr" ? "Tedarikçi fiyatları değişti. Yeni verilerle ilk sayfadan başlayın."
              : "Supplier prices changed. Restart from the first page with current data."
            : code === "SORT_SEARCH_UNSUPPORTED"
              ? locale === "tr" ? "Bu aramanın tüm sonuçları için genel sıralama henüz hazır değil. Tüm sonuçları görmek için sıralamayı kaldırın."
                : "Global sorting is not yet available for this search. Clear sorting to see all results."
            : code === "SORT_SCOPE_TOO_LARGE"
            ? locale === "tr" ? "Bu markanın tamamını sıralamak için arka plan hazırlığı gerekiyor. Şimdilik tam parça numarasıyla arayın veya sıralamayı kaldırın."
              : "This brand needs background preparation for global sorting. Search by exact part number or clear the sort for now."
            : caught instanceof Error ? caught.message : r("master.errors.requestFailed");
          setError(message);
          if (searchingRef.current) {
            actionFeedback.fail(message);
            searchingRef.current = false;
            setSearching(false);
          }
        }
      } finally {
        if (!cancelled) setLoadingRows(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [brandId, brandName, scope, submittedSearch, marginA, marginB, page, searchRevision, globalSort]);

  const total = rows[0]?.total_count ?? rows.length;
  const totalIsEstimate = rows[0]?.total_count_is_estimate === true;
  const totalIsUnknown = rows[0]?.total_count_is_unknown === true;
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
        render: (row: MasterRow) => <>
          <ProductIdentityCell row={row} />
          {row.notes?.trim() ? <span className="additional-supplier-offers__summary-note">{locale === "tr" ? "Tedarikçi notu" : "Supplier note"}: {row.notes}</span>
            : row.has_notes ? <span className="additional-supplier-offers__summary-note">{locale === "tr" ? "Tedarikçi notu var" : "Supplier note available"}</span> : null}
        </>,
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
            <SupplierOffersToggle brandId={brandId} row={row} open={expandedOfferKey === offerKey(row)} onToggle={() => setExpandedOfferKey((current) => current === offerKey(row) ? null : offerKey(row))} />
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
    [t, brandId, locale, expandedOfferKey],
  );

  async function handleMasterExport() {
    if (!brandId || !brandName) {
      const message = r("master.errors.selectBrandFirst");
      setError(message);
      actionFeedback.fail(message);
      return;
    }
    try {
      setError("");
      setExportingMaster(true);
      const preparingMessage = r("master.feedback.preparingExport");
      actionFeedback.begin(preparingMessage);
      const initialJob = await startMasterExport({
        brandId,
        brandName,
        search: submittedSearch,
        scope: scope === "priced" ? "priced" : "catalog",
        marginA,
        marginB,
      });
      const readyJob = await waitForExportJob(initialJob, (job) => {
        const progress = job.progressTotal
          ? ` ${job.progressDone.toLocaleString("en-US")} / ${job.progressTotal.toLocaleString("en-US")}`
          : job.progressDone ? ` ${job.progressDone.toLocaleString("en-US")}` : "";
        actionFeedback.begin(`${preparingMessage}${progress}`);
      });
      if (!readyJob.rowCount) throw new Error(r("master.errors.noRowsForExport"));
      await downloadExportJob(readyJob.id);
      actionFeedback.clear();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : r("master.errors.exportFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setExportingMaster(false);
    }
  }

  function handleSearch() {
    if (!brandId || !brandName) {
      actionFeedback.fail(r("master.errors.selectBrandFirst"));
      return;
    }
    searchingRef.current = true;
    setSearching(true);
    actionFeedback.begin(r("master.feedback.searching", { target: search.trim() || brandName || r("values.allItems") }));
    setPage(1);
    setSubmittedSearch(search);
    setSearchRevision((current) => current + 1);
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
            disabled={!brandId || !brandName}
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
            <Select label={r("fields.brand")} value={brandId} options={brandOptions} onChange={(value) => { setPage(1); setBrandId(value); }} />
            <Select label={r("master.fields.scope")} value={scope} options={scopeOptions} onChange={(value) => { setPage(1); setGlobalSort(null); setScope(value); }} />
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
        <MetricTile label={r(totalIsEstimate ? "master.summary.estimatedItems" : "master.summary.totalItems")} value={!totalIsUnknown && total ? total.toLocaleString("en-US") : "-"} detail={r(totalIsUnknown ? "master.summary.countNotLoaded" : totalIsEstimate ? "master.summary.estimatedCountHint" : "master.summary.filteredResultSet")} tone="neutral" />
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
                  : total && !totalIsUnknown
                    ? r(totalIsEstimate ? "master.meta.rowsShownFromEstimatedTotal" : "master.meta.rowsShownFromTotal", { shown: summary.rowsShown.toLocaleString("en-US"), total: total.toLocaleString("en-US") })
                    : r("master.meta.rowsShown", { shown: summary.rowsShown.toLocaleString("en-US") })}
            </p>
          </div>
          {globalSort ? <Button variant="secondary" className="button--compact" onClick={() => { setPage(1); setGlobalSort(null); }}>
            {locale === "tr" ? "Sıralamayı kaldır" : "Clear sort"}
          </Button> : null}
          {cursorStale ? <Button variant="secondary" className="button--compact" onClick={() => { setPage(1); setSearchRevision((current) => current+1); }}>
            {locale === "tr" ? "İlk sayfadan yenile" : "Restart from first page"}
          </Button> : null}
          {error ? <div className="procurement-error-state">{error}</div> : null}
        </div>
        <div className="section-card__body">
          {scope === "catalog" ? <p className="info-text">{locale === "tr" ? "Katalog kapsamı için marka genelinde sıralama henüz hazır değil." : "Global sorting is not yet available for catalog scope."}</p> : null}
          {loadingRows ? (
            <div className="procurement-loading-state" role="status">
              <span className="procurement-loading-state__label">{r("master.loading.buildingSupplierComparison")}</span>
              <span className="procurement-loading-state__bar" />
              <span className="procurement-loading-state__bar procurement-loading-state__bar--short" />
            </div>
          ) : (
            <DataTable
              rows={rows}
              columns={scope === "priced" ? columns : columns.map(({sortValue: _sortValue, ...column}) => column)}
              className="decision-table"
              wrapClassName="decision-table-wrap"
              externalSort={globalSort}
              onExternalSort={(next) => { setPage(1); setGlobalSort(next); }}
              renderRowDetails={(row: MasterRow) => expandedOfferKey === offerKey(row) ? <SupplierOffersPanel key={offerKey(row)} brandId={brandId} row={row} /> : null}
              emptyText={!brandId ? r("master.empty.selectBrandOrSearch") : r("master.empty.noComparisons")}
            />
          )}
          {brandId ? (
            <div className="toolbar toolbar--wrap" aria-label={locale === "tr" ? "Rapor sayfaları" : "Report pages"}>
              <Button variant="secondary" className="button--compact" disabled={loadingRows || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                {locale === "tr" ? "Önceki" : "Previous"}
              </Button>
              <span role="status">{locale === "tr" ? `Sayfa ${page}` : `Page ${page}`}</span>
              <Button variant="secondary" className="button--compact" disabled={loadingRows || rows.length < 50 || (globalSort ? page * 50 >= total : scope === "priced" && !!submittedSearch.trim() && page >= 100)} onClick={() => setPage((current) => current + 1)}>
                {locale === "tr" ? "Sonraki" : "Next"}
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </PageShell>
  );
}
