import { useEffect, useState } from "react";
import {
  fetchCustomerOpsDashboardSnapshot,
  fetchDashboardLatestQuotes,
  fetchDashboardSnapshot,
  type RevenuePeriodKey,
  type DashboardSalesOrderSummary,
  type DashboardSnapshot,
} from "../../../infrastructure/api/dashboardApi";
import { Button } from "../../../presentation/components/common/Button";
import { useActionFeedback } from "../../../presentation/components/common/ActionFeedback";
import { Input } from "../../../presentation/components/common/Input";
import { Select } from "../../../presentation/components/common/Select";
import { SectionCard } from "../../../presentation/components/common/SectionCard";
import { StatCard } from "../../../presentation/components/common/StatCard";
import { BrandPill } from "../../../presentation/components/common/BrandPill";
import { deleteSupplierBrandSummaryRow, fetchCloudSupplierBrandSummary, fetchCloudSupplierBrandSummaryAll, fetchCloudSuppliers } from "../../../infrastructure/api/suppliersApi";
import type { SupplierBrandSummaryRow, SupplierSummary } from "../../../types/suppliers";
import type { InventoryManualEntryAlert } from "../../../types/inventory";
import { downloadCsv, toCsv } from "../../../shared/csv";
import { buildXlsxBlob, downloadBlob } from "../../../shared/xlsx";
import { fetchInventoryManualEntryAlertCount, fetchInventoryManualEntryAlerts, fetchWarehouseStockItems } from "../../../infrastructure/api/inventoryApi";
import { fetchWarehouses } from "../../../infrastructure/api/warehousesApi";
import { includesLooseText } from "../../../domain/shared/normalize";
import { buildEntityAlias } from "../../../shared/entityAlias";
import { canAccessSystemModules } from "../../../shared/roles";

type DashboardPageProps = {
  role?: string;
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
  onOpenInventoryTab?: (tab: "Warehouses" | "On Hand") => void;
  onOpenInventoryManualAlerts?: () => void;
  onOpenInventoryManualAlert?: (alert: InventoryManualEntryAlert) => void;
};

export function DashboardPage({
  role = "",
  onOpenSalesOrder,
  onOpenPurchaseOrder,
  onOpenInventoryTab,
  onOpenInventoryManualAlerts,
  onOpenInventoryManualAlert,
}: DashboardPageProps) {
  const actionFeedback = useActionFeedback();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [latestQuotes, setLatestQuotes] = useState<DashboardSalesOrderSummary[]>([]);
  const [loadingLatestQuotes, setLoadingLatestQuotes] = useState(false);
  const [brandSummary, setBrandSummary] = useState<SupplierBrandSummaryRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [loadingBrandSummary, setLoadingBrandSummary] = useState(false);
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");
  const [latestQuotesError, setLatestQuotesError] = useState("");
  const [brandSummaryError, setBrandSummaryError] = useState("");
  const [inventoryPulse, setInventoryPulse] = useState({
    warehouses: 0,
    stockedItems: 0,
    onHandQty: 0,
    reservedQty: 0,
    availableQty: 0,
    stockValue: 0,
  });
  const [inventoryPulseError, setInventoryPulseError] = useState("");
  const [manualEntryAlerts, setManualEntryAlerts] = useState<InventoryManualEntryAlert[]>([]);
  const [manualEntryAlertCount, setManualEntryAlertCount] = useState(0);
  const [loadingManualEntryAlerts, setLoadingManualEntryAlerts] = useState(false);
  const [manualEntryAlertsError, setManualEntryAlertsError] = useState("");
  const [brandSummarySearch, setBrandSummarySearch] = useState("");
  const [brandSummarySupplier, setBrandSummarySupplier] = useState("");
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
      setSnapshotError("");
      try {
        const result = showSystemPanels ? await fetchDashboardSnapshot() : await fetchCustomerOpsDashboardSnapshot();
        if (!cancelled) setSnapshot(result);
      } catch (caught) {
        if (!cancelled) {
          setSnapshotError(caught instanceof Error ? caught.message : "Dashboard load failed");
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
      setLoadingManualEntryAlerts(true);
      setManualEntryAlertsError("");
      try {
        const [count, rows] = await Promise.all([
          fetchInventoryManualEntryAlertCount(),
          fetchInventoryManualEntryAlerts(8),
        ]);
        if (!cancelled) {
          setManualEntryAlertCount(count);
          setManualEntryAlerts(rows);
        }
      } catch (caught) {
        if (!cancelled) {
          setManualEntryAlertCount(0);
          setManualEntryAlerts([]);
          setManualEntryAlertsError(caught instanceof Error ? caught.message : "Manual barcode alerts load failed");
        }
      } finally {
        if (!cancelled) setLoadingManualEntryAlerts(false);
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
      setInventoryPulseError("");
      try {
        const [warehouseRows, stockRows] = await Promise.all([fetchWarehouses(), fetchWarehouseStockItems()]);
        if (cancelled) return;
        setInventoryPulse({
          warehouses: warehouseRows.filter((row) => row.is_active).length,
          stockedItems: stockRows.length,
          onHandQty: Math.round(stockRows.reduce((sum, row) => sum + Number(row.on_hand_qty || 0), 0) * 100) / 100,
          reservedQty: Math.round(stockRows.reduce((sum, row) => sum + Number(row.reserved_qty || 0), 0) * 100) / 100,
          availableQty: Math.round(stockRows.reduce((sum, row) => sum + Number(row.available_qty || 0), 0) * 100) / 100,
          stockValue: Math.round(stockRows.reduce((sum, row) => sum + Number(row.stock_value || 0), 0) * 100) / 100,
        });
      } catch (caught) {
        if (!cancelled) {
          setInventoryPulseError(caught instanceof Error ? caught.message : "Inventory pulse load failed");
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
      setLatestQuotesError("");
      try {
        const result = await fetchDashboardLatestQuotes();
        if (!cancelled) setLatestQuotes(result);
      } catch (caught) {
        if (!cancelled) {
          setLatestQuotes([]);
          setLatestQuotesError(caught instanceof Error ? caught.message : "Latest sales orders load failed");
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

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoadingSuppliers(true);
      setBrandSummaryError("");
      try {
        const result = await fetchCloudSuppliers();
        if (!cancelled) {
          setSuppliers(result);
        }
      } catch (caught) {
        if (!cancelled) {
          setSuppliers([]);
          setBrandSummaryError(caught instanceof Error ? caught.message : "Supplier list load failed");
        }
      } finally {
        if (!cancelled) setLoadingSuppliers(false);
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
      if (!brandSummarySupplier && loadingSuppliers) return;
      if (!brandSummarySupplier && !suppliers.length) {
        setBrandSummary([]);
        return;
      }
      setLoadingBrandSummary(true);
      setBrandSummaryError("");
      try {
        const result = brandSummarySupplier
          ? await fetchCloudSupplierBrandSummary(brandSummarySupplier)
          : await fetchCloudSupplierBrandSummaryAll(suppliers);
        if (!cancelled) setBrandSummary(result);
      } catch (caught) {
        if (!cancelled) {
          setBrandSummary([]);
          setBrandSummaryError(caught instanceof Error ? caught.message : "Brand summary load failed");
        }
      } finally {
        if (!cancelled) setLoadingBrandSummary(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [brandSummarySupplier, suppliers, showSystemPanels]);

  async function reloadDashboard() {
    setSnapshotError("");
    setLatestQuotesError("");
    setBrandSummaryError("");
    setManualEntryAlertsError("");
    try {
      const [snapshotResult, latestQuotesResult] = await Promise.all([
        fetchDashboardSnapshot(),
        fetchDashboardLatestQuotes(),
      ]);
      const [manualAlertCountResult, manualAlertsResult] = await Promise.all([
        fetchInventoryManualEntryAlertCount().catch((caught) => {
          setManualEntryAlertsError(caught instanceof Error ? caught.message : "Manual barcode alerts load failed");
          return 0;
        }),
        fetchInventoryManualEntryAlerts(8).catch((caught) => {
          setManualEntryAlertsError(caught instanceof Error ? caught.message : "Manual barcode alerts load failed");
          return [] as InventoryManualEntryAlert[];
        }),
      ]);
      setSnapshot(snapshotResult);
      setLatestQuotes(latestQuotesResult);
      setManualEntryAlertCount(manualAlertCountResult);
      setManualEntryAlerts(manualAlertsResult);
      const brandSummaryResult = brandSummarySupplier
        ? await fetchCloudSupplierBrandSummary(brandSummarySupplier)
        : await fetchCloudSupplierBrandSummaryAll(suppliers);
      setBrandSummary(brandSummaryResult);
    } catch (caught) {
      setSnapshotError(caught instanceof Error ? caught.message : "Dashboard load failed");
    }
  }

  async function handleDeleteBrandSummary(supplierId: string, brand: string) {
    if (!confirm(`Delete all active supplier prices for ${brand}?`)) return;
    try {
      actionFeedback.begin(`Deleting supplier brand summary for ${brand}...`);
      await deleteSupplierBrandSummaryRow({ supplierId, brand });
      await reloadDashboard();
      actionFeedback.succeed(`Supplier brand summary deleted for ${brand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Supplier brand delete failed";
      setBrandSummaryError(message);
      actionFeedback.fail(message);
    }
  }

  const catalogCount = snapshot?.catalogCount ?? 0;
  const brandCount = snapshot?.brandCount ?? 0;
  const supplierCount = snapshot?.supplierCount ?? 0;
  const quoteCount = snapshot?.quoteCount ?? 0;
  const newPortalOrders = snapshot?.newPortalOrders ?? 0;
  const revenue = snapshot?.revenue;
  const issues = snapshot?.issues ?? {};
  const selectedRevenue = revenue?.periods?.[revenuePeriod] ?? null;
  const supplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: supplier.name,
  }));
  const brandSummarySupplierOptions = [{ value: "", label: "All Suppliers" }, ...supplierOptions];

  const filteredBrandSummary = brandSummary.filter((row) => {
    const search = brandSummarySearch.trim().toLowerCase();
    const matchesSearch =
      !search ||
      includesLooseText(row.brand, search) ||
      includesLooseText(row.supplier_name, search);
    return matchesSearch;
  });

  function buildBrandSummaryExportRows() {
    return [
      ["Brand", "Supplier", "Part Count", "Line Count", "Latest Price Date", "Oldest Price Date"],
      ...filteredBrandSummary.map((row) => [
        row.brand,
        row.supplier_name,
        row.part_count,
        row.line_count,
        row.latest_price_date || "",
        row.oldest_price_date || "",
      ]),
    ];
  }

  function handleExportBrandSummary() {
    downloadCsv("brand-summary.csv", toCsv(buildBrandSummaryExportRows()));
    actionFeedback.succeed("Brand summary CSV downloaded.");
  }

  function handleExportBrandSummaryExcel() {
    const blob = buildXlsxBlob("Brand Summary", buildBrandSummaryExportRows(), [2, 3]);
    downloadBlob("brand-summary.xlsx", blob);
    actionFeedback.succeed("Brand summary Excel downloaded.");
  }

  function formatMoney(value: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(value || 0);
  }

  function formatAlertDate(value: string) {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function openAlertDocument(alert: InventoryManualEntryAlert) {
    if (!alert.document_id) return;
    if (alert.workflow_stage === "receive") {
      onOpenPurchaseOrder?.(alert.document_id);
      return;
    }
    onOpenSalesOrder?.(alert.document_id);
  }

  function alertDocumentButtonLabel(alert: InventoryManualEntryAlert) {
    return alert.workflow_stage === "receive" ? "Open PO" : "Open SO";
  }

  const revenuePeriodOptions = [
    { value: "thisMonth", label: "This Month" },
    { value: "thisQuarter", label: "Quarter" },
    { value: "thisYear", label: "This Year" },
    { value: "previousYear", label: "Previous Year" },
  ] satisfies Array<{ value: RevenuePeriodKey; label: string }>;

  return (
    <div className="dashboard">
      <div className="stats-grid">
        {showSystemPanels ? <StatCard label="Catalog Products" value={catalogCount.toLocaleString("en-US")} subtext="Live cloud catalog" tone="success" /> : null}
        {showSystemPanels ? <StatCard label="Brands" value={brandCount.toLocaleString("en-US")} subtext="Available in workspace" tone="warning" /> : null}
        {showSystemPanels ? <StatCard label="Suppliers" value={supplierCount.toLocaleString("en-US")} subtext="Live supplier accounts" tone="success" /> : null}
        {showSystemPanels ? <StatCard label="Manual Barcode Alerts" value={manualEntryAlertCount.toLocaleString("en-US")} subtext="Needs warehouse review" tone="warning" onClick={() => onOpenInventoryManualAlerts?.()} /> : null}
        <StatCard label="Quotes" value={quoteCount.toLocaleString("en-US")} subtext="Recent cloud sales orders" tone="neutral" />
      </div>

      {showSystemPanels ? (
        <SectionCard title="Inventory Pulse">
          {inventoryPulseError ? <div className="error-text">{inventoryPulseError}</div> : null}
          <div className="stats-grid stats-grid--compact">
            <StatCard label="Active Warehouses" value={inventoryPulse.warehouses.toLocaleString("en-US")} subtext="Warehouses currently open" tone="success" onClick={() => onOpenInventoryTab?.("Warehouses")} />
            <StatCard label="Stocked Items" value={inventoryPulse.stockedItems.toLocaleString("en-US")} subtext="SKU rows with live stock" tone="neutral" onClick={() => onOpenInventoryTab?.("On Hand")} />
            <StatCard label="On Hand Qty" value={inventoryPulse.onHandQty.toLocaleString("en-US")} subtext="Current quantity across warehouses" tone="success" onClick={() => onOpenInventoryTab?.("On Hand")} />
            <StatCard label="Reserved Qty" value={inventoryPulse.reservedQty.toLocaleString("en-US")} subtext="Qty held for packing and shipment" tone="warning" onClick={() => onOpenInventoryTab?.("On Hand")} />
            <StatCard label="Available Qty" value={inventoryPulse.availableQty.toLocaleString("en-US")} subtext="Qty still free to allocate" tone="success" onClick={() => onOpenInventoryTab?.("On Hand")} />
            <StatCard label="Stock Value" value={formatMoney(inventoryPulse.stockValue)} subtext="Approximate warehouse inventory value" tone="warning" onClick={() => onOpenInventoryTab?.("On Hand")} />
          </div>
        </SectionCard>
      ) : null}

      {newPortalOrders > 0 ? (
        <SectionCard title="New Order Came">
          <div className="dashboard-alert dashboard-alert--warning">
            <strong>{newPortalOrders.toLocaleString("en-US")} new portal order</strong>
            <span>Customer confirmed order is waiting in Sales Orders.</span>
          </div>
        </SectionCard>
      ) : null}

      {showSystemPanels ? (
        <SectionCard title="Manual Barcode Alerts">
          {manualEntryAlertsError ? <div className="error-text">{manualEntryAlertsError}</div> : null}
          <div className="toolbar toolbar--wrap">
            <Button variant="secondary" onClick={() => onOpenInventoryManualAlerts?.()}>
              Review Alerts
            </Button>
          </div>
          <div className="list-stack">
            {manualEntryAlerts.map((alert) => (
              <div key={alert.id} className="list-row list-row--dashboard">
                <strong>{alert.barcode || "-"}</strong>
                <span className="dashboard-order-party">
                  <span className="dashboard-order-party__item" title={alert.brand || "-"}>
                    {alert.brand || "-"}
                  </span>
                  <span className="dashboard-order-party__item" title={alert.product_code || alert.old_code || "-"}>
                    {alert.product_code || alert.old_code || "-"}
                  </span>
                </span>
                <span className="dashboard-order-meta">
                  <span>{formatAlertDate(alert.created_at)}</span>
                  <span>{alert.workflow_stage.toUpperCase()}</span>
                </span>
                <div className="toolbar">
                  <Button variant="secondary" className="button--compact" onClick={() => openAlertDocument(alert)}>
                    {alertDocumentButtonLabel(alert)}
                  </Button>
                  <Button variant="secondary" className="button--compact" onClick={() => onOpenInventoryManualAlert?.(alert)}>
                    Review
                  </Button>
                </div>
              </div>
            ))}
            {!manualEntryAlerts.length ? (
              <div className="chart-placeholder">
                {loadingManualEntryAlerts ? "Loading manual barcode alerts..." : "No manual barcode alerts recorded"}
              </div>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      <div className="dashboard-grid">
        <SectionCard title="Latest Sales Orders">
          {latestQuotesError ? <div className="error-text">{latestQuotesError}</div> : null}
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
                    <span className="mark-badge mark-badge--accent">New Order</span>
                  ) : null}
                  <span>{quote.status || "-"}</span>
                </span>
                <Button variant="secondary" className="button--compact" onClick={() => onOpenSalesOrder?.(quote.id)}>
                  Open
                </Button>
              </div>
            ))}
            {!latestQuotes.length && !latestQuotesError ? (
              <div className="chart-placeholder">{loadingLatestQuotes ? "Loading latest sales orders..." : "No sales orders yet"}</div>
            ) : null}
          </div>
        </SectionCard>
        <SectionCard title="Revenue Analysis">
          <div className="toolbar toolbar--wrap">
            <Select value={revenuePeriod} options={revenuePeriodOptions} onChange={(value) => setRevenuePeriod(value as RevenuePeriodKey)} />
          </div>
          {selectedRevenue ? (
            <>
            <div className="stats-grid stats-grid--compact">
              <StatCard
                label="Sales Amount"
                value={formatMoney(selectedRevenue.sales.total)}
                subtext={`${selectedRevenue.sales.count.toLocaleString("en-US")} sales orders`}
                tone="success"
              />
              <StatCard
                label="Purchase Amount"
                value={formatMoney(selectedRevenue.purchases.total)}
                subtext={`${selectedRevenue.purchases.count.toLocaleString("en-US")} purchase orders`}
                tone="neutral"
              />
              <StatCard
                label="Net Spread"
                value={formatMoney(selectedRevenue.sales.total - selectedRevenue.purchases.total)}
                subtext="Sales less purchase amount"
                tone="warning"
              />
            </div>
            <div className="dashboard-grid dashboard-grid--compact">
              <SectionCard title="By Seller">
                {selectedRevenue.sellerTotals.length ? (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Seller</th>
                          <th>Orders</th>
                          <th>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRevenue.sellerTotals.slice(0, 6).map((row) => (
                          <tr key={row.name}>
                            <td title={row.name}>{buildEntityAlias(row.name)}</td>
                            <td>{row.count.toLocaleString("en-US")}</td>
                            <td>{formatMoney(row.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="chart-placeholder">No seller turnover in this period</div>
                )}
              </SectionCard>
              <SectionCard title="By Purchase Company">
                {selectedRevenue.purchaseCompanyTotals.length ? (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Purchase Company</th>
                          <th>Orders</th>
                          <th>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRevenue.purchaseCompanyTotals.slice(0, 6).map((row) => (
                          <tr key={row.name}>
                            <td title={row.name}>{buildEntityAlias(row.name)}</td>
                            <td>{row.count.toLocaleString("en-US")}</td>
                            <td>{formatMoney(row.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="chart-placeholder">No purchase turnover in this period</div>
                )}
              </SectionCard>
            </div>
            </>
          ) : !snapshotError && !issues.revenue ? (
            <div className="chart-placeholder">Loading revenue analysis...</div>
          ) : issues.revenue ? (
            <div className="error-text">{issues.revenue}</div>
          ) : snapshotError ? (
            <div className="error-text">{snapshotError}</div>
          ) : null}
        </SectionCard>
        {showSystemPanels ? (
        <SectionCard title="Brand Summary">
          <div className="toolbar toolbar--wrap dashboard-toolbar">
            <Select value={brandSummarySupplier} options={brandSummarySupplierOptions} onChange={setBrandSummarySupplier} />
            <Input value={brandSummarySearch} placeholder="Search brand or supplier" onChange={setBrandSummarySearch} />
            <Button variant="secondary" className="button--compact" onClick={handleExportBrandSummary} disabled={!filteredBrandSummary.length}>
              Export CSV
            </Button>
            <Button variant="secondary" className="button--compact" onClick={handleExportBrandSummaryExcel} disabled={!filteredBrandSummary.length}>
              Export Excel
            </Button>
          </div>
          {filteredBrandSummary.length ? (
            <div className="table-wrap table-wrap--tall">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Supplier</th>
                    <th>Parts</th>
                    <th>Lines</th>
                    <th>Latest Price</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBrandSummary.map((row) => (
                    <tr key={`${row.supplier_id}-${row.brand}`}>
                      <td><BrandPill brand={row.brand} compact /></td>
                      <td>{row.supplier_name}</td>
                      <td>{row.part_count.toLocaleString("en-US")}</td>
                      <td>{row.line_count.toLocaleString("en-US")}</td>
                      <td>{row.latest_price_date || "-"}</td>
                      <td>
                        <Button variant="secondary" className="button--compact" onClick={() => void handleDeleteBrandSummary(row.supplier_id, row.brand)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !brandSummaryError ? (
            <div className="chart-placeholder">
              {loadingSuppliers || loadingBrandSummary ? "Loading brand summary..." : brandSummary.length ? "No rows match current filters" : "No brand summary yet"}
            </div>
          ) : (
            <div className="error-text">{brandSummaryError}</div>
          )}
        </SectionCard>
        ) : null}
        <SectionCard title="Sales by Brand">
          <div className="toolbar toolbar--wrap dashboard-toolbar">
            <Select value={revenuePeriod} options={revenuePeriodOptions} onChange={(value) => setRevenuePeriod(value as RevenuePeriodKey)} />
          </div>
          {selectedRevenue?.brandTotals.length ? (
            <div className="table-wrap table-wrap--tall">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Sales Lines</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRevenue.brandTotals.slice(0, 24).map((row) => (
                    <tr key={row.name}>
                      <td><BrandPill brand={row.name} compact /></td>
                      <td>{row.count.toLocaleString("en-US")}</td>
                      <td>{formatMoney(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !snapshotError && !issues.revenue ? (
            <div className="chart-placeholder">No brand sales in this period</div>
          ) : issues.revenue ? (
            <div className="error-text">{issues.revenue}</div>
          ) : snapshotError ? (
            <div className="error-text">{snapshotError}</div>
          ) : null}
        </SectionCard>
      </div>
    </div>
  );
}
