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
import { NavGlyph } from "../components/common/NextMasterBrand";

type DashboardPageProps = {
  role?: string;
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenInventoryTab?: (tab: "Warehouses" | "On Hand") => void;
  /** Navigate a reference dashboard action into the existing application route. */
  onNavigatePage?: (page: string, subPage?: string) => void;
};

export function DashboardPage({ role = "", onOpenSalesOrder, onOpenInventoryTab, onNavigatePage }: DashboardPageProps) {
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

  // The reference dashboard deliberately keeps these cards compact and scannable.  The
  // activity rows are presentation data until the upload history API is wired to this
  // surface; keeping them in one place makes that swap safe without changing layout.
  const referenceUploadActivity = [
    { file: "acme_prices_oct_2024.xlsx", supplier: "ACME Parts", rows: "12,482", updated: "12,326", added: "134", issues: "22", status: "Published", uploaded: "Today, 09:14" },
    { file: "motonex_q4_prices.csv", supplier: "Motonex", rows: "8,771", updated: "8,690", added: "61", issues: "20", status: "Published", uploaded: "Oct 16, 14:22" },
    { file: "brakepro_price_list.xlsx", supplier: "BrakePro", rows: "4,205", updated: "4,178", added: "17", issues: "10", status: "Published", uploaded: "Oct 15, 10:06" },
    { file: "nordic_parts_2024_10.csv", supplier: "Nordic Parts", rows: "15,630", updated: "15,102", added: "412", issues: "116", status: "Published", uploaded: "Oct 14, 16:38" },
    { file: "omega_pricing.xlsx", supplier: "Omega Auto", rows: "6,311", updated: "6,289", added: "8", issues: "14", status: "Published", uploaded: "Oct 12, 11:03" },
  ];

  const referenceCategories = [
    { label: "Brake System", glyph: "warning" as const },
    { label: "Filters", glyph: "catalog" as const },
    { label: "Suspension", glyph: "inventory" as const },
    { label: "Engine Parts", glyph: "categories" as const },
  ];

  const referenceFeaturedParts = [
    { name: "Brake Disc", code: "NM-BD31028", detail: "Ø310 × 28 mm", price: "$42.50", glyph: "warning" as const },
    { name: "Brake Pad Set", code: "NM-BP1024", detail: "Front Axle", price: "$28.90", glyph: "catalog" as const },
    { name: "Oil Filter", code: "NM-OF003", detail: "Spin-on", price: "$6.75", glyph: "categories" as const },
    { name: "Air Filter", code: "NM-AF2201", detail: "Panel Type", price: "$12.40", glyph: "inventory" as const },
  ];

  return (
    <PageShell className="dashboard dashboard-page">
      <PageHeader title={t("dashboard.overview.title")} subtitle={t("dashboard.overview.subtitle")} />

      <section className="dashboard-command-hero" aria-label="Operations workspace">
        <div className="dashboard-command-hero__copy">
          <span>Operations Console</span>
          <h2>Keep markets moving.</h2>
          <p>Parts. Data. People. In sync.</p>
        </div>
      </section>

      <section className="dashboard-reference-grid" aria-label="Supplier upload and customer portal preview">
        <article className="dashboard-upload-center">
          <header className="dashboard-reference-card__header">
            <div className="dashboard-reference-card__title-wrap">
              <span className="dashboard-reference-card__icon dashboard-reference-card__icon--upload" aria-hidden="true">
                <NavGlyph name="upload" />
              </span>
              <div>
                <h2>Supplier Price Upload Center</h2>
                <p>Upload supplier price files to validate and publish to your catalog.</p>
              </div>
            </div>
            <button type="button" className="dashboard-reference-card__link" onClick={() => onNavigatePage?.("Purchases", "Supplier Price Upload")}>
              Supported file formats <span aria-hidden="true">ⓘ</span>
            </button>
          </header>

          <div className="dashboard-upload-steps" aria-label="Upload progress">
            {[
              { label: "Received", detail: "File uploaded successfully", time: "Today, 09:14", state: "done" },
              { label: "Validated", detail: "12,482 rows processed", time: "Today, 09:16", state: "done" },
              { label: "Published", detail: "Prices live in catalog", time: "Today, 09:17", state: "current" },
            ].map((step, index) => (
              <div className={`dashboard-upload-step dashboard-upload-step--${step.state}`} key={step.label}>
                <span className="dashboard-upload-step__marker" aria-hidden="true">{step.state === "current" ? "" : "✓"}</span>
                <strong>{index + 1}. {step.label}</strong>
                <small>{step.detail}</small>
                <time>{step.time}</time>
              </div>
            ))}
          </div>

          <button type="button" className="dashboard-upload-dropzone" onClick={() => onNavigatePage?.("Purchases", "Supplier Price Upload")}>
            <span className="dashboard-upload-dropzone__cloud" aria-hidden="true"><NavGlyph name="upload" /></span>
            <strong>Upload Price File</strong>
            <span>Drag and drop a file or click to browse</span>
            <small>Supported formats: XLSX, CSV <b>•</b> Max file size: 25 MB</small>
          </button>

          <div className="dashboard-upload-metrics" aria-label="Upload metrics">
            <div><span className="dashboard-upload-metric__icon dashboard-upload-metric__icon--file" aria-hidden="true"><NavGlyph name="documents" /></span><strong>12,482</strong><small>Rows processed</small></div>
            <div><span className="dashboard-upload-metric__icon dashboard-upload-metric__icon--success" aria-hidden="true">✓</span><strong>12,326</strong><small>Prices updated</small></div>
            <div><span className="dashboard-upload-metric__icon dashboard-upload-metric__icon--new" aria-hidden="true">＋</span><strong>134</strong><small>New parts</small></div>
            <div><span className="dashboard-upload-metric__icon dashboard-upload-metric__icon--warning" aria-hidden="true"><NavGlyph name="warning" /></span><strong>22</strong><small>Rows with issues</small></div>
          </div>

          <div className="dashboard-upload-activity">
            <div className="dashboard-upload-activity__heading"><h3>Recent Upload Activity</h3><button type="button" onClick={() => onNavigatePage?.("Purchases", "Supplier Price Upload")}>View all</button></div>
            <div className="dashboard-upload-activity__table-wrap">
              <table>
                <thead><tr><th>File name</th><th>Supplier</th><th>Rows</th><th>Updated</th><th>New</th><th>Issues</th><th>Status</th><th>Uploaded</th><th aria-label="Actions" /></tr></thead>
                <tbody>{referenceUploadActivity.map((row) => <tr key={row.file}>
                  <td title={row.file}>{row.file}</td><td>{row.supplier}</td><td>{row.rows}</td><td>{row.updated}</td><td>{row.added}</td><td>{row.issues}</td><td><span className="dashboard-upload-status">{row.status}</span></td><td>{row.uploaded}</td><td><button type="button" aria-label={`Open ${row.file}`} onClick={() => onNavigatePage?.("Purchases", "Supplier Price Upload")}>•••</button></td>
                </tr>)}</tbody>
              </table>
            </div>
          </div>
        </article>

        <aside className="dashboard-customer-preview">
          <header className="dashboard-reference-card__header">
            <div>
              <h2>Customer Portal Preview</h2>
              <p>How your customers experience Next Master.</p>
            </div>
            <button type="button" className="dashboard-reference-card__open" aria-label="Open customer portal preview" onClick={() => onNavigatePage?.("Sales", "Price Lists")}>↗</button>
          </header>
          <div className="dashboard-preview-tabs" role="tablist" aria-label="Customer portal preview sections">
            {[
              ["Search Parts", "active"],
              ["Price Lists", ""],
              ["Documents", ""],
              ["Account", ""],
            ].map(([label, state]) => <button key={label} type="button" className={state ? "is-active" : ""} onClick={() => onNavigatePage?.("Sales", label === "Price Lists" ? "Price Lists" : undefined)}>{label}</button>)}
          </div>
          <div className="dashboard-preview-search"><NavGlyph name="search" /><input aria-label="Search customer portal preview" placeholder="Search by part number, vehicle or keyword..." /><button type="button" aria-label="Search customer portal" onClick={() => onNavigatePage?.("Items", "Catalog")}>⌕</button></div>
          <div className="dashboard-preview-section__heading"><strong>Popular categories</strong><button type="button" onClick={() => onNavigatePage?.("Items", "Catalog")}>View all</button></div>
          <div className="dashboard-preview-categories">{referenceCategories.map((category) => <button key={category.label} type="button" onClick={() => onNavigatePage?.("Items", "Catalog")}><span><NavGlyph name={category.glyph} /></span><small>{category.label}</small></button>)}</div>
          <div className="dashboard-preview-section__heading"><strong>Featured parts</strong><button type="button" onClick={() => onNavigatePage?.("Items", "Catalog")}>View all</button></div>
          <div className="dashboard-preview-featured">{referenceFeaturedParts.map((part) => <button key={part.code} type="button" className="dashboard-preview-product" onClick={() => onNavigatePage?.("Items", "Catalog")}>
            <span className="dashboard-preview-product__visual"><NavGlyph name={part.glyph} /></span>
            <span className="dashboard-preview-product__copy"><strong>{part.name}</strong><small>{part.code}</small><small>{part.detail}</small></span>
            <span className="dashboard-preview-product__price"><strong>{part.price}</strong><small>List price</small></span><span className="dashboard-preview-product__cart" aria-hidden="true">＋</span>
          </button>)}</div>
        </aside>
      </section>

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
