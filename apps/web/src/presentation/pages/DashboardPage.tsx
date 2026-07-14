import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCustomerOpsDashboardSnapshot,
  fetchDashboardLatestQuotes,
  fetchDashboardSnapshot,
  type RevenuePeriodKey,
  type DashboardSalesOrderSummary,
  type DashboardSnapshot,
} from "../../infrastructure/api/dashboardApi";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { SectionCard } from "../components/common/SectionCard";
import { StatCard } from "../components/common/StatCard";
import { BrandPill } from "../components/common/BrandPill";
import {
  fetchCloudSupplierOperationsStatusAll,
  fetchCloudSuppliers,
  queueSupplierPriceCatalogSync,
  queueSupplierPriceRollupRefresh,
  retrySupplierPriceImportFinalize,
} from "../../infrastructure/api/suppliersApi";
import type { SupplierOperationsStatusRow, SupplierSummary } from "../../types/suppliers";
import { downloadCsv, toCsv } from "../../shared/csv";
import { fetchWarehouseStockItems } from "../../infrastructure/api/inventoryApi";
import { fetchWarehouses } from "../../infrastructure/api/warehousesApi";
import { includesLooseText } from "../../domain/shared/normalize";
import { buildEntityAlias } from "../../shared/entityAlias";
import { getOperationDefinition, isRegisteredOperation } from "../../shared/operationsRegistry";
import { isImportFailedStatus, mapImportStatusToTone, type ImportEngineStatus } from "../../shared/importEngine";
import { canAccessSystemModules } from "../../shared/roles";
import { useI18n } from "../../i18n/I18nProvider";
import { fetchCatalogIntegritySummary } from "../../infrastructure/api/catalogApi";
import type { CatalogIntegritySummary } from "../../types/catalog";
import { PageHeader, PageShell } from "../components/common/VisualPrimitives";

type DashboardPageProps = {
  role?: string;
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenInventoryTab?: (tab: "Warehouses" | "On Hand") => void;
};

export function DashboardPage({ role = "", onOpenSalesOrder, onOpenInventoryTab }: DashboardPageProps) {
  const actionFeedback = useActionFeedback();
  const { locale, t } = useI18n();
  const numberLocale = locale === "tr" ? "tr-TR" : "en-US";
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [latestQuotes, setLatestQuotes] = useState<DashboardSalesOrderSummary[]>([]);
  const [loadingLatestQuotes, setLoadingLatestQuotes] = useState(false);
  const [operationsRows, setOperationsRows] = useState<SupplierOperationsStatusRow[]>([]);
  const [catalogIntegrity, setCatalogIntegrity] = useState<CatalogIntegritySummary | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [loadingOperations, setLoadingOperations] = useState(false);
  const [snapshotErrorKey, setSnapshotErrorKey] = useState<string | null>(null);
  const [latestQuotesErrorKey, setLatestQuotesErrorKey] = useState<string | null>(null);
  const [operationsErrorKey, setOperationsErrorKey] = useState<string | null>(null);
  const operationsLoadInFlight = useRef(false);
  const [inventoryPulse, setInventoryPulse] = useState({
    warehouses: 0,
    stockedItems: 0,
    onHandQty: 0,
    stockValue: 0,
  });
  const [inventoryPulseErrorKey, setInventoryPulseErrorKey] = useState<string | null>(null);
  const [operationsSearch, setOperationsSearch] = useState("");
  const [operationsSupplier, setOperationsSupplier] = useState("");
  const [revenuePeriod, setRevenuePeriod] = useState<RevenuePeriodKey>("thisMonth");
  const showSystemPanels = canAccessSystemModules(role);
  const isDraftPortalAlert = (quote: DashboardSalesOrderSummary) =>
    quote.source_channel === "portal" &&
    Boolean(quote.portal_submitted_at) &&
    !quote.portal_seen_at &&
    String(quote.status || "").toLowerCase() === "draft";

  useEffect(() => {
    if (!showSystemPanels) return;
    let cancelled = false;

    async function run() {
      setSnapshotErrorKey(null);
      try {
        const result = showSystemPanels ? await fetchDashboardSnapshot() : await fetchCustomerOpsDashboardSnapshot();
        if (!cancelled) setSnapshot(result);
      } catch (caught) {
        if (!cancelled) {
          console.error(caught);
          setSnapshotErrorKey("dashboard.errors.snapshotLoadFailed");
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [showSystemPanels]);

  useEffect(() => {
    if (!showSystemPanels) return;
    let cancelled = false;

    async function run() {
      setInventoryPulseErrorKey(null);
      try {
        const [warehouseRows, stockRows] = await Promise.all([fetchWarehouses(), fetchWarehouseStockItems()]);
        if (cancelled) return;
        setInventoryPulse({
          warehouses: warehouseRows.filter((row) => row.is_active).length,
          stockedItems: stockRows.length,
          onHandQty: Math.round(stockRows.reduce((sum, row) => sum + Number(row.on_hand_qty || 0), 0) * 100) / 100,
          stockValue: Math.round(stockRows.reduce((sum, row) => sum + Number(row.stock_value || 0), 0) * 100) / 100,
        });
      } catch (caught) {
        if (!cancelled) {
          console.error(caught);
          setInventoryPulseErrorKey("dashboard.pulse.loadFailed");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [showSystemPanels]);

  useEffect(() => {
    if (!showSystemPanels) return;
    let cancelled = false;

    async function run() {
      setLoadingLatestQuotes(true);
      setLatestQuotesErrorKey(null);
      try {
        const result = await fetchDashboardLatestQuotes();
        if (!cancelled) setLatestQuotes(result);
      } catch (caught) {
        if (!cancelled) {
          setLatestQuotes([]);
          console.error(caught);
          setLatestQuotesErrorKey("dashboard.latestSalesOrders.loadFailed");
        }
      } finally {
        if (!cancelled) setLoadingLatestQuotes(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [showSystemPanels]);

  const reloadOperationsStatus = useCallback(async () => {
    if (operationsLoadInFlight.current) return;
    operationsLoadInFlight.current = true;
    setLoadingOperations(true);
    setOperationsErrorKey(null);
    try {
      const refreshedSuppliers = await fetchCloudSuppliers();
      const result = await fetchCloudSupplierOperationsStatusAll(refreshedSuppliers);
      setSuppliers(refreshedSuppliers);
      setOperationsRows(result);
      setCatalogIntegrity(await fetchCatalogIntegritySummary().catch(() => null));
    } catch (caught) {
      console.error(caught);
      setOperationsErrorKey("dashboard.operationsStatus.loadFailed");
    } finally {
      operationsLoadInFlight.current = false;
      setLoadingOperations(false);
    }
  }, []);

  useEffect(() => {
    if (!showSystemPanels) return;
    let cancelled = false;

    async function run() {
      if (cancelled) return;
      await reloadOperationsStatus();
    }

    void run();
    const intervalId = window.setInterval(() => {
      void run();
    }, 45 * 1000);
    const handleFocus = () => {
      void run();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [reloadOperationsStatus, showSystemPanels]);

  const catalogCount = snapshot?.catalogCount ?? 0;
  const brandCount = snapshot?.brandCount ?? 0;
  const supplierCount = snapshot?.supplierCount ?? 0;
  const quoteCount = snapshot?.quoteCount ?? 0;
  const newPortalOrders = snapshot?.newPortalOrders ?? 0;
  const revenue = snapshot?.revenue;
  const issues = snapshot?.issues ?? {};
  const selectedRevenue = revenue?.periods?.[revenuePeriod] ?? null;

  function formatCount(value: number) {
    return value.toLocaleString(numberLocale);
  }

  function formatOrderStatus(value: string | null | undefined) {
    const normalized = String(value || "").trim().toLowerCase();
    switch (normalized) {
      case "draft":
        return t("statuses.draft");
      case "confirmed":
        return t("statuses.confirmed");
      case "purchased":
        return t("statuses.purchased");
      case "invoiced":
        return t("statuses.invoiced");
      case "paid":
        return t("statuses.paid");
      case "void":
        return t("statuses.void");
      default:
        return value || "-";
    }
  }

  const supplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: supplier.name,
  }));
  const operationsSupplierOptions = [{ value: "", label: t("dashboard.operationsStatus.allSuppliers") }, ...supplierOptions];

  const filteredOperationsRows = operationsRows.filter((row) => {
    const search = operationsSearch.trim().toLowerCase();
    const matchesSearch =
      !search ||
      includesLooseText(row.brand, search) ||
      includesLooseText(row.supplier_name, search);
    const matchesSupplier = !operationsSupplier || row.supplier_id === operationsSupplier;
    return matchesSearch && matchesSupplier;
  });

  function formatDateTime(value: string | null | undefined) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(locale === "tr" ? "tr-TR" : "en-US", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDurationMs(value: number | null | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    const seconds = Math.max(0, Math.round(value / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function toImportEngineStatus(status: string | null | undefined): ImportEngineStatus {
    const normalized = String(status || "").toLowerCase();
    switch (normalized) {
      case "completed":
        return "completed";
      case "running":
        return "finalizing";
      case "pending":
      case "waiting":
        return "validated";
      case "failed":
        return "failed";
      default:
        return "idle";
    }
  }

  function statusTone(status: string | null | undefined) {
    return mapImportStatusToTone(toImportEngineStatus(status));
  }

  function supportsRegisteredRetry(operationType: string) {
    if (!isRegisteredOperation(operationType)) {
      return true;
    }

    return getOperationDefinition(operationType)?.supports_retry ?? true;
  }

  function isOperationsFailedStatus(status: string | null | undefined) {
    return isImportFailedStatus(toImportEngineStatus(status));
  }

  const catalogIntegrityOperationStatus = catalogIntegrity?.backfill_status === "failed" || (catalogIntegrity?.failed_count || 0) > 0
    ? "failed"
    : catalogIntegrity?.initialization_state === "not_initialized"
      ? "idle"
      : catalogIntegrity?.initialization_state === "partial"
        ? "waiting"
    : !catalogIntegrity || catalogIntegrity.backfill_status !== "completed" || catalogIntegrity.pending_count > 0
      ? "running"
      : "completed";

  async function handleRetryRow(row: SupplierOperationsStatusRow) {
    try {
      const supplier = row.supplier_name;
      const brand = row.brand;
      if (row.supplier_import_status === "failed" && row.supplier_import_run_id) {
        actionFeedback.begin(t("dashboard.operationsStatus.retryingSupplierImport", { supplier, brand }));
        await retrySupplierPriceImportFinalize(row.supplier_import_run_id);
      } else if (row.catalog_sync_status === "failed" && row.supplier_import_run_id) {
        actionFeedback.begin(t("dashboard.operationsStatus.retryingCatalogSync", { supplier, brand }));
        await queueSupplierPriceCatalogSync(row.supplier_import_run_id);
      } else if (row.rollup_refresh_status === "failed") {
        actionFeedback.begin(t("dashboard.operationsStatus.retryingRollupRefresh", { supplier, brand }));
        await queueSupplierPriceRollupRefresh();
      } else {
        return;
      }

      await reloadOperationsStatus();
      actionFeedback.succeed(t("dashboard.operationsStatus.retryQueued", { supplier, brand }));
    } catch (caught) {
      console.error(caught);
      actionFeedback.fail(caught instanceof Error ? caught.message : t("dashboard.operationsStatus.retryFailed"));
    }
  }

  function handleExportOperationsStatus() {
    const rows = [
      [
        t("dashboard.operationsStatus.brand"),
        t("dashboard.operationsStatus.supplier"),
        t("dashboard.operationsStatus.lastImport"),
        t("dashboard.operationsStatus.supplierImport"),
        t("dashboard.operationsStatus.rows"),
        t("dashboard.operationsStatus.catalogSync"),
        t("dashboard.operationsStatus.rollupRefresh"),
        t("dashboard.operationsStatus.customerPrice"),
        t("dashboard.operationsStatus.lastSuccessfulRefresh"),
      ],
      ...filteredOperationsRows.map((row) => [
        row.brand,
        row.supplier_name,
        `${formatDateTime(row.supplier_import_started_at)} / ${formatDateTime(row.supplier_import_finished_at)} / ${formatDurationMs(row.supplier_import_duration_ms)}`,
        row.supplier_import_status,
        `${row.supplier_import_staged_rows} / ${row.supplier_import_processed_rows}`,
        row.catalog_sync_status,
        row.rollup_refresh_status,
        row.customer_price_status,
        `${formatDateTime(row.last_successful_refresh_at)} (${row.last_successful_refresh_source || "-"})`,
      ]),
    ];
    downloadCsv("operations-status.csv", toCsv(rows));
    actionFeedback.succeed(t("dashboard.operationsStatus.csvDownloaded"));
  }

  function formatMoney(value: number) {
    return new Intl.NumberFormat(numberLocale, {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(value || 0);
  }

  const revenuePeriodOptions = [
    { value: "thisMonth", label: t("dashboard.revenueAnalysis.period.thisMonth") },
    { value: "thisQuarter", label: t("dashboard.revenueAnalysis.period.thisQuarter") },
    { value: "thisYear", label: t("dashboard.revenueAnalysis.period.thisYear") },
    { value: "previousYear", label: t("dashboard.revenueAnalysis.period.previousYear") },
  ] satisfies Array<{ value: RevenuePeriodKey; label: string }>;

  return (
    <PageShell className="dashboard dashboard-page">
      <PageHeader title={t("dashboard.overview.title")} subtitle={t("dashboard.overview.subtitle")} />

      <div className="stats-grid dashboard-executive-summary" aria-label={t("dashboard.overview.summary")}>
        {showSystemPanels ? <StatCard label={t("dashboard.stats.catalogProducts")} value={formatCount(catalogCount)} subtext={t("dashboard.stats.catalogProductsSubtitle")} tone="success" /> : null}
        {showSystemPanels ? <StatCard label={t("dashboard.stats.brands")} value={formatCount(brandCount)} subtext={t("dashboard.stats.brandsSubtitle")} tone="warning" /> : null}
        {showSystemPanels ? <StatCard label={t("dashboard.stats.suppliers")} value={formatCount(supplierCount)} subtext={t("dashboard.stats.suppliersSubtitle")} tone="success" /> : null}
        <StatCard label={t("dashboard.stats.quotes")} value={formatCount(quoteCount)} subtext={t("dashboard.stats.quotesSubtitle")} tone="neutral" />
      </div>

      {showSystemPanels ? (
        <SectionCard title={t("dashboard.pulse.title")} className="dashboard-operations-pulse">
          {inventoryPulseErrorKey ? <div className="error-text">{t(inventoryPulseErrorKey)}</div> : null}
          <div className="stats-grid stats-grid--compact">
            <StatCard label={t("dashboard.pulse.activeWarehouses")} value={formatCount(inventoryPulse.warehouses)} subtext={t("dashboard.pulse.activeWarehousesSubtitle")} tone="success" onClick={() => onOpenInventoryTab?.("Warehouses")} />
            <StatCard label={t("dashboard.pulse.stockedItems")} value={formatCount(inventoryPulse.stockedItems)} subtext={t("dashboard.pulse.stockedItemsSubtitle")} tone="neutral" onClick={() => onOpenInventoryTab?.("On Hand")} />
            <StatCard label={t("dashboard.pulse.onHandQty")} value={formatCount(inventoryPulse.onHandQty)} subtext={t("dashboard.pulse.onHandQtySubtitle")} tone="success" onClick={() => onOpenInventoryTab?.("On Hand")} />
            <StatCard label={t("dashboard.pulse.stockValue")} value={formatMoney(inventoryPulse.stockValue)} subtext={t("dashboard.pulse.stockValueSubtitle")} tone="warning" onClick={() => onOpenInventoryTab?.("On Hand")} />
          </div>
        </SectionCard>
      ) : null}

      {newPortalOrders > 0 ? (
        <SectionCard title={t("dashboard.alert.title")} className="dashboard-needs-attention">
          <div className="dashboard-alert dashboard-alert--warning">
            <strong>{newPortalOrders === 1 ? t("dashboard.alert.singular", { count: formatCount(newPortalOrders) }) : t("dashboard.alert.plural", { count: formatCount(newPortalOrders) })}</strong>
            <span>{t("dashboard.alert.body")}</span>
          </div>
        </SectionCard>
      ) : null}

      <div className="dashboard-grid dashboard-content-grid">
        <div className="dashboard-section-heading dashboard-section-heading--commercial">
          <span>{t("dashboard.overview.commercialSignals")}</span>
        </div>
        <SectionCard title={t("dashboard.latestSalesOrders.title")} className="dashboard-latest-orders">
          {latestQuotesErrorKey ? <div className="error-text">{t(latestQuotesErrorKey)}</div> : null}
          <div className="list-stack">
            {latestQuotes.map((quote) => (
              <div key={quote.id} className="list-row list-row--dashboard">
                <strong>{quote.sales_order_no || quote.id}</strong>
                <span className="dashboard-order-party">
                  <span className="dashboard-order-party__item" title={quote.customer_name || "-"}>
                    {buildEntityAlias(quote.customer_name)}
                  </span>
                  <span className="dashboard-order-party__item" title={quote.seller_company || "-"}>
                    {buildEntityAlias(quote.seller_company)}
                  </span>
                </span>
                <span className="dashboard-order-meta">
                  {isDraftPortalAlert(quote) ? (
                    <span className="mark-badge mark-badge--accent">{t("dashboard.latestSalesOrders.newOrderBadge")}</span>
                  ) : null}
                  <span>{formatOrderStatus(quote.status)}</span>
                </span>
                <Button variant="secondary" className="button--compact" onClick={() => onOpenSalesOrder?.(quote.id)}>
                  {t("dashboard.latestSalesOrders.open")}
                </Button>
              </div>
            ))}
            {!latestQuotes.length && !latestQuotesErrorKey ? (
              <div className="chart-placeholder">{loadingLatestQuotes ? t("dashboard.latestSalesOrders.loading") : t("dashboard.latestSalesOrders.empty")}</div>
            ) : null}
          </div>
        </SectionCard>
        <SectionCard title={t("dashboard.revenueAnalysis.title")} className="dashboard-revenue-analysis">
          <div className="toolbar toolbar--wrap">
            <Select value={revenuePeriod} options={revenuePeriodOptions} onChange={(value) => setRevenuePeriod(value as RevenuePeriodKey)} />
          </div>
          {selectedRevenue ? (
            <>
              <div className="stats-grid stats-grid--compact">
              <StatCard
                label={t("dashboard.revenueAnalysis.salesAmount")}
                value={formatMoney(selectedRevenue.sales.total)}
                subtext={t("dashboard.revenueAnalysis.salesOrdersSubtitle", { count: formatCount(selectedRevenue.sales.count) })}
                tone="success"
              />
              <StatCard
                label={t("dashboard.revenueAnalysis.purchaseAmount")}
                value={formatMoney(selectedRevenue.purchases.total)}
                subtext={t("dashboard.revenueAnalysis.purchaseOrdersSubtitle", { count: formatCount(selectedRevenue.purchases.count) })}
                tone="neutral"
              />
              <StatCard
                label={t("dashboard.revenueAnalysis.netSpread")}
                value={formatMoney(selectedRevenue.sales.total - selectedRevenue.purchases.total)}
                subtext={t("dashboard.revenueAnalysis.netSpreadSubtitle")}
                tone="warning"
              />
              </div>
              <div className="dashboard-grid dashboard-grid--compact">
                <SectionCard title={t("dashboard.revenueAnalysis.bySeller.title")}>
                  {selectedRevenue.sellerTotals.length ? (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{t("dashboard.revenueAnalysis.bySeller.seller")}</th>
                            <th>{t("dashboard.revenueAnalysis.bySeller.orders")}</th>
                            <th>{t("dashboard.revenueAnalysis.bySeller.amount")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedRevenue.sellerTotals.slice(0, 6).map((row) => (
                            <tr key={row.name}>
                              <td title={row.name}>{buildEntityAlias(row.name)}</td>
                              <td>{formatCount(row.count)}</td>
                              <td>{formatMoney(row.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="chart-placeholder">{t("dashboard.revenueAnalysis.bySeller.empty")}</div>
                  )}
                </SectionCard>
                <SectionCard title={t("dashboard.revenueAnalysis.byPurchaseCompany.title")}>
                  {selectedRevenue.purchaseCompanyTotals.length ? (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{t("dashboard.revenueAnalysis.byPurchaseCompany.purchaseCompany")}</th>
                            <th>{t("dashboard.revenueAnalysis.byPurchaseCompany.orders")}</th>
                            <th>{t("dashboard.revenueAnalysis.byPurchaseCompany.amount")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedRevenue.purchaseCompanyTotals.slice(0, 6).map((row) => (
                            <tr key={row.name}>
                              <td title={row.name}>{buildEntityAlias(row.name)}</td>
                              <td>{formatCount(row.count)}</td>
                              <td>{formatMoney(row.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="chart-placeholder">{t("dashboard.revenueAnalysis.byPurchaseCompany.empty")}</div>
                  )}
                </SectionCard>
              </div>
            </>
          ) : !snapshotErrorKey && !issues.revenue ? (
            <div className="chart-placeholder">{t("dashboard.revenueAnalysis.loading")}</div>
          ) : issues.revenue ? (
            <div className="error-text">{t("dashboard.revenueAnalysis.unavailable")}</div>
          ) : snapshotErrorKey ? (
            <div className="error-text">{t(snapshotErrorKey)}</div>
          ) : null}
        </SectionCard>
        {showSystemPanels ? (
          <SectionCard
            title={t("dashboard.operationsStatus.title")}
            className="dashboard-operations-status"
            actions={
              <Button variant="secondary" className="button--compact" onClick={() => void reloadOperationsStatus()} busy={loadingOperations} busyLabel={t("dashboard.operationsStatus.refreshing")}>
                {t("dashboard.operationsStatus.refresh")}
              </Button>
            }
          >
            {catalogIntegrity ? (
              <div className="operations-catalog-integrity">
                <div>
                  <strong>{t("dashboard.operationsStatus.catalogIntegrity")}</strong>
                  <span className="operations-subtle">
                    {catalogIntegrity.initialization_state === "not_initialized"
                      ? t("catalog.integrity.notInitialized")
                      : catalogIntegrity.initialization_state === "partial"
                        ? t("catalog.integrity.partial")
                        : t("dashboard.operationsStatus.catalogIntegrityProgress", {
                            processed: formatCount(catalogIntegrity.projected_products),
                            total: catalogIntegrity.total_products == null ? "—" : formatCount(catalogIntegrity.total_products),
                          })}
                  </span>
                </div>
                <span className={`mark-badge mark-badge--${statusTone(catalogIntegrityOperationStatus)}`}>
                  {t(`statuses.${catalogIntegrityOperationStatus}`)}
                </span>
                <span className="operations-subtle">
                  {t("dashboard.operationsStatus.catalogIntegrityConditions", {
                    conflict: formatCount(catalogIntegrity.conflict_count),
                    incomplete: formatCount(catalogIntegrity.incomplete_count),
                    pending: formatCount(catalogIntegrity.pending_count),
                    failed: formatCount(catalogIntegrity.failed_count),
                  })}
                </span>
                <span className="operations-subtle">
                  {t("dashboard.operationsStatus.lastEvaluation")}: {formatDateTime(catalogIntegrity.last_evaluated_at)}
                </span>
              </div>
            ) : null}
            <div className="toolbar toolbar--wrap dashboard-toolbar">
              <Select value={operationsSupplier} options={operationsSupplierOptions} onChange={setOperationsSupplier} />
              <Input value={operationsSearch} placeholder={t("dashboard.operationsStatus.searchPlaceholder")} onChange={setOperationsSearch} />
              <Button variant="secondary" className="button--compact" onClick={handleExportOperationsStatus} disabled={!filteredOperationsRows.length}>
                {t("dashboard.operationsStatus.exportCsv")}
              </Button>
            </div>
            {operationsErrorKey ? <div className="error-text">{t(operationsErrorKey)}</div> : null}
            {filteredOperationsRows.length ? (
              <div className="table-wrap table-wrap--tall">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("dashboard.operationsStatus.brand")}</th>
                      <th>{t("dashboard.operationsStatus.lastImport")}</th>
                      <th>{t("dashboard.operationsStatus.supplierImport")}</th>
                      <th>{t("dashboard.operationsStatus.rows")}</th>
                      <th>{t("dashboard.operationsStatus.catalogSync")}</th>
                      <th>{t("dashboard.operationsStatus.rollupRefresh")}</th>
                      <th>{t("dashboard.operationsStatus.customerPrice")}</th>
                      <th>{t("dashboard.operationsStatus.lastSuccessfulRefresh")}</th>
                      <th>{t("dashboard.operationsStatus.action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredOperationsRows.map((row) => {
                      const rowKey = `${row.supplier_id}-${row.brand}`;
                      const retryEnabled =
                        (supportsRegisteredRetry("supplier_import") && isOperationsFailedStatus(row.supplier_import_status)) ||
                        (supportsRegisteredRetry("supplier_catalog_sync") && isOperationsFailedStatus(row.catalog_sync_status)) ||
                        (supportsRegisteredRetry("supplier_rollup_refresh") && isOperationsFailedStatus(row.rollup_refresh_status));
                      return (
                        <tr key={rowKey}>
                          <td>
                            <div className="list-stack">
                              <BrandPill brand={row.brand} compact />
                              <strong>{row.supplier_name}</strong>
                              <span className="operations-subtle">
                                {t("dashboard.operationsStatus.partsAndLines", {
                                  parts: formatCount(row.part_count),
                                  lines: formatCount(row.line_count),
                                })}
                                {row.latest_price_date ? ` · ${t("dashboard.operationsStatus.latestPrice")} ${row.latest_price_date}` : ""}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="list-stack">
                              <span>{t("dashboard.operationsStatus.started")}: {formatDateTime(row.supplier_import_started_at)}</span>
                              <span>{t("dashboard.operationsStatus.finished")}: {formatDateTime(row.supplier_import_finished_at)}</span>
                              <span>{t("dashboard.operationsStatus.duration")}: {formatDurationMs(row.supplier_import_duration_ms)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="list-stack">
                              <span className={`mark-badge mark-badge--${statusTone(row.supplier_import_status)}`}>{t(`statuses.${row.supplier_import_status}`)}</span>
                              {row.supplier_import_status === "failed" ? (
                                <span className="error-text">{row.supplier_import_error_message || t("dashboard.operationsStatus.failed")}</span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <div className="list-stack">
                              <span>{t("dashboard.operationsStatus.staged")}: {formatCount(row.supplier_import_staged_rows)}</span>
                              <span>{t("dashboard.operationsStatus.processed")}: {formatCount(row.supplier_import_processed_rows)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="list-stack">
                              <span className={`mark-badge mark-badge--${statusTone(row.catalog_sync_status)}`}>{t(`statuses.${row.catalog_sync_status}`)}</span>
                              {row.catalog_sync_status === "failed" ? (
                                <span className="error-text">{row.catalog_sync_error_message || t("dashboard.operationsStatus.failed")}</span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <div className="list-stack">
                              <span className={`mark-badge mark-badge--${statusTone(row.rollup_refresh_status)}`}>{t(`statuses.${row.rollup_refresh_status}`)}</span>
                              {row.rollup_refresh_status === "failed" ? (
                                <span className="error-text">{row.rollup_refresh_error_message || t("dashboard.operationsStatus.failed")}</span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <div className="list-stack">
                              <span className={`mark-badge mark-badge--${statusTone(row.customer_price_status)}`}>{t(`statuses.${row.customer_price_status}`)}</span>
                              <span className="operations-subtle">{row.customer_price_waiting_message || t("dashboard.operationsStatus.readyToGenerate")}</span>
                            </div>
                          </td>
                          <td>
                            <div className="list-stack">
                              <span>{formatDateTime(row.last_successful_refresh_at)}</span>
                              <span className="operations-subtle">
                                {row.last_successful_refresh_source
                                  ? `${t("dashboard.operationsStatus.source")}: ${
                                      row.last_successful_refresh_source === "supplier import"
                                        ? t("dashboard.operationsStatus.supplierImport")
                                        : t("dashboard.operationsStatus.rollupRefresh")
                                    }`
                                  : "-"}
                              </span>
                            </div>
                          </td>
                          <td>
                            {retryEnabled ? (
                              <Button variant="secondary" className="button--compact" onClick={() => void handleRetryRow(row)}>
                                {t("common.retry")}
                              </Button>
                            ) : (
                              <span className="operations-subtle">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : !operationsErrorKey ? (
              <div className="chart-placeholder">
                {loadingOperations ? t("dashboard.operationsStatus.loading") : t("dashboard.operationsStatus.noRowsMatchCurrentFilters")}
              </div>
            ) : null}
          </SectionCard>
        ) : null}
        <SectionCard title={t("dashboard.salesByBrand.title")} className="dashboard-sales-by-brand">
          <div className="toolbar toolbar--wrap dashboard-toolbar">
            <Select value={revenuePeriod} options={revenuePeriodOptions} onChange={(value) => setRevenuePeriod(value as RevenuePeriodKey)} />
          </div>
          {selectedRevenue?.brandTotals.length ? (
            <div className="table-wrap table-wrap--tall">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("dashboard.salesByBrand.brand")}</th>
                    <th>{t("dashboard.salesByBrand.salesLines")}</th>
                    <th>{t("dashboard.salesByBrand.amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRevenue.brandTotals.slice(0, 24).map((row) => (
                    <tr key={row.name}>
                      <td><BrandPill brand={row.name} compact /></td>
                      <td>{formatCount(row.count)}</td>
                      <td>{formatMoney(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !snapshotErrorKey && !issues.revenue ? (
            <div className="chart-placeholder">{t("dashboard.salesByBrand.empty")}</div>
          ) : issues.revenue ? (
            <div className="error-text">{t("dashboard.revenueAnalysis.unavailable")}</div>
          ) : snapshotErrorKey ? (
            <div className="error-text">{t(snapshotErrorKey)}</div>
          ) : null}
        </SectionCard>
        <div className="dashboard-section-heading dashboard-section-heading--operations">
          <span>{t("dashboard.overview.operations")}</span>
        </div>
      </div>
    </PageShell>
  );
}
