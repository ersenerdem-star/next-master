import { useEffect, useRef, useState } from "react";
import {
  fetchCustomerOpsDashboardSnapshot,
  fetchDashboardLatestQuotes,
  fetchDashboardSnapshot,
  type RevenuePeriodKey,
  type DashboardSalesOrderSummary,
  type DashboardSnapshot,
} from "../../infrastructure/api/dashboardApi";
import { Button } from "../components/common/Button";
import { Select } from "../components/common/Select";
import { SectionCard } from "../components/common/SectionCard";
import { StatCard } from "../components/common/StatCard";
import { BrandPill } from "../components/common/BrandPill";
import { fetchWarehouseStockItems } from "../../infrastructure/api/inventoryApi";
import { fetchWarehouses } from "../../infrastructure/api/warehousesApi";
import { buildEntityAlias } from "../../shared/entityAlias";
import { canAccessCustomerOps, canAccessSystemModules } from "../../shared/roles";
import { useI18n } from "../../i18n/I18nProvider";
import { PageHeader, PageShell } from "../components/common/VisualPrimitives";
import { MiraCompanion } from "../components/common/MiraCompanion";

type DashboardPageProps = {
  role?: string;
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenInventoryTab?: (tab: "Warehouses" | "On Hand") => void;
};

export function DashboardPage({ role = "", onOpenSalesOrder, onOpenInventoryTab }: DashboardPageProps) {
  const { locale, t } = useI18n();
  const numberLocale = locale === "tr" ? "tr-TR" : "en-US";
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [latestQuotes, setLatestQuotes] = useState<DashboardSalesOrderSummary[]>([]);
  const [loadingLatestQuotes, setLoadingLatestQuotes] = useState(false);
  const [snapshotErrorKey, setSnapshotErrorKey] = useState<string | null>(null);
  const [latestQuotesErrorKey, setLatestQuotesErrorKey] = useState<string | null>(null);
  const [inventoryPulse, setInventoryPulse] = useState({
    warehouses: 0,
    stockedItems: 0,
    onHandQty: 0,
    stockValue: 0,
  });
  const [inventoryPulseErrorKey, setInventoryPulseErrorKey] = useState<string | null>(null);
  const [revenuePeriod, setRevenuePeriod] = useState<RevenuePeriodKey>("thisMonth");
  const dashboardLoadInFlight = useRef(false);
  const showSystemPanels = canAccessSystemModules(role);
  const canLoadDashboard = showSystemPanels || canAccessCustomerOps(role);
  const portalAlertCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const isRecentPortalOrder = (submittedAt: string | null | undefined) => {
    if (!submittedAt) return false;
    const submittedMs = new Date(submittedAt).getTime();
    return Number.isFinite(submittedMs) && submittedMs >= portalAlertCutoffMs;
  };
  const isDraftPortalAlert = (quote: DashboardSalesOrderSummary) =>
    quote.source_channel === "portal" &&
    Boolean(quote.portal_submitted_at) &&
    isRecentPortalOrder(quote.portal_submitted_at) &&
    !quote.portal_seen_at &&
    String(quote.status || "").toLowerCase() === "draft";

  useEffect(() => {
    if (!canLoadDashboard) return;
    let cancelled = false;

    async function run() {
      if (dashboardLoadInFlight.current) return;
      dashboardLoadInFlight.current = true;
      setSnapshotErrorKey(null);
      try {
        const result = showSystemPanels ? await fetchDashboardSnapshot() : await fetchCustomerOpsDashboardSnapshot();
        if (!cancelled) setSnapshot(result);
      } catch (caught) {
        if (!cancelled) {
          console.error(caught);
          setSnapshotErrorKey("dashboard.errors.snapshotLoadFailed");
        }
      } finally {
        dashboardLoadInFlight.current = false;
      }
    }

    void run();
    const intervalId = window.setInterval(() => void run(), 60 * 1000);
    const handleFocus = () => void run();
    window.addEventListener("focus", handleFocus);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [canLoadDashboard, showSystemPanels]);

  useEffect(() => {
    if (!canLoadDashboard) return;
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
  }, [canLoadDashboard]);

  useEffect(() => {
    if (!canLoadDashboard) return;
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
  }, [canLoadDashboard]);

  const catalogCount = snapshot?.catalogCount ?? 0;
  const brandCount = snapshot?.brandCount ?? 0;
  const supplierCount = snapshot?.supplierCount ?? 0;
  const quoteCount = snapshot?.quoteCount ?? 0;
  const newPortalOrders = snapshot?.newPortalOrders ?? 0;
  const revenue = snapshot?.revenue;
  const issues = snapshot?.issues ?? {};
  const selectedRevenue = revenue?.periods?.[revenuePeriod] ?? null;
  const selectedSpread = selectedRevenue ? selectedRevenue.sales.total - selectedRevenue.purchases.total : null;
  const topBrand = selectedRevenue?.brandTotals[0] ?? null;
  const openRecentOrders = latestQuotes.filter((quote) => {
    const status = String(quote.status || "").toLowerCase();
    return status === "draft" || status === "confirmed";
  });

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

  function formatMoney(value: number) {
    return new Intl.NumberFormat(numberLocale, {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(value || 0);
  }

  const revenuePeriodOptions = [
    { value: "thisMonth", label: t("dashboard.revenueAnalysis.period.thisMonth") },
    { value: "previousMonth", label: t("dashboard.revenueAnalysis.period.previousMonth") },
    { value: "last2Months", label: t("dashboard.revenueAnalysis.period.last2Months") },
    { value: "last3Months", label: t("dashboard.revenueAnalysis.period.last3Months") },
    { value: "thisQuarter", label: t("dashboard.revenueAnalysis.period.thisQuarter") },
    { value: "thisYear", label: t("dashboard.revenueAnalysis.period.thisYear") },
    { value: "previousYear", label: t("dashboard.revenueAnalysis.period.previousYear") },
  ] satisfies Array<{ value: RevenuePeriodKey; label: string }>;

  return (
    <PageShell className="dashboard dashboard-page">
      <PageHeader title={t("dashboard.overview.title")} subtitle={t("dashboard.overview.subtitle")} />

      <MiraCompanion />

      <SectionCard title={t("dashboard.moneySignals.title")} className="dashboard-money-signals">
        <div className="stats-grid dashboard-executive-summary" aria-label={t("dashboard.overview.summary")}>
          <StatCard
            label={t("dashboard.moneySignals.sales")}
            value={selectedRevenue ? formatMoney(selectedRevenue.sales.total) : "—"}
            subtext={selectedRevenue ? t("dashboard.moneySignals.salesSubtitle", { count: formatCount(selectedRevenue.sales.count) }) : t("dashboard.moneySignals.loading")}
            tone="success"
          />
          <StatCard
            label={t("dashboard.moneySignals.spread")}
            value={selectedSpread == null ? "—" : formatMoney(selectedSpread)}
            subtext={t("dashboard.moneySignals.spreadSubtitle")}
            tone="warning"
          />
          <StatCard
            label={t("dashboard.moneySignals.stockValue")}
            value={showSystemPanels ? formatMoney(inventoryPulse.stockValue) : "—"}
            subtext={t("dashboard.moneySignals.stockValueSubtitle")}
            tone="neutral"
            onClick={showSystemPanels ? () => onOpenInventoryTab?.("On Hand") : undefined}
          />
          <StatCard
            label={t("dashboard.moneySignals.openOrders")}
            value={formatCount(openRecentOrders.length)}
            subtext={t("dashboard.moneySignals.openOrdersSubtitle")}
            tone={openRecentOrders.length ? "warning" : "success"}
            onClick={openRecentOrders[0] ? () => onOpenSalesOrder?.(openRecentOrders[0].id) : undefined}
          />
        </div>
        <div className="dashboard-insight-strip">
          <div>
            <strong>{t("dashboard.moneySignals.nextMove")}</strong>
            <span>
              {newPortalOrders > 0
                ? t("dashboard.moneySignals.nextMovePortal", { count: formatCount(newPortalOrders) })
                : openRecentOrders.length > 0
                  ? t("dashboard.moneySignals.nextMoveOrders", { count: formatCount(openRecentOrders.length) })
                  : topBrand
                    ? t("dashboard.moneySignals.nextMoveBrand", { brand: topBrand.name, amount: formatMoney(topBrand.total) })
                    : t("dashboard.moneySignals.nextMoveEmpty")}
            </span>
          </div>
          <div>
            <strong>{t("dashboard.moneySignals.topBrand")}</strong>
            <span>{topBrand ? `${topBrand.name} · ${formatMoney(topBrand.total)}` : "—"}</span>
          </div>
        </div>
      </SectionCard>

      {showSystemPanels ? (
        <SectionCard title={t("dashboard.systemInventory.title")} className="dashboard-system-inventory">
          <div className="dashboard-system-inventory__grid">
            <div><span>{t("dashboard.stats.catalogProducts")}</span><strong>{formatCount(catalogCount)}</strong><small>{t("dashboard.stats.catalogProductsSubtitle")}</small></div>
            <div><span>{t("dashboard.stats.brands")}</span><strong>{formatCount(brandCount)}</strong><small>{t("dashboard.stats.brandsSubtitle")}</small></div>
            <div><span>{t("dashboard.stats.suppliers")}</span><strong>{formatCount(supplierCount)}</strong><small>{t("dashboard.stats.suppliersSubtitle")}</small></div>
            <div><span>{t("dashboard.stats.salesOrders")}</span><strong>{formatCount(quoteCount)}</strong><small>{t("dashboard.stats.salesOrdersSubtitle")}</small></div>
          </div>
        </SectionCard>
      ) : null}

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
      </div>
    </PageShell>
  );
}
