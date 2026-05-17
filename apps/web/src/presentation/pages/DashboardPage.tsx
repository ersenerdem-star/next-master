import { useEffect, useState } from "react";
import {
  fetchDashboardLatestQuotes,
  fetchDashboardSnapshot,
  type DashboardSalesOrderSummary,
  type DashboardSnapshot,
  type RevenueSource,
} from "../../infrastructure/api/dashboardApi";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { SectionCard } from "../components/common/SectionCard";
import { StatCard } from "../components/common/StatCard";
import { deleteSupplierBrandSummaryRow, fetchCloudSupplierBrandSummary, fetchCloudSupplierBrandSummaryAll, fetchCloudSuppliers } from "../../infrastructure/api/suppliersApi";
import type { SupplierBrandSummaryRow, SupplierSummary } from "../../types/suppliers";
import { downloadCsv, toCsv } from "../../shared/csv";

type DashboardPageProps = {
  onOpenSalesOrder?: (salesOrderId: string) => void;
};

export function DashboardPage({ onOpenSalesOrder }: DashboardPageProps) {
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
  const [revenueSource, setRevenueSource] = useState<RevenueSource>("quotes");
  const [brandSummarySearch, setBrandSummarySearch] = useState("");
  const [brandSummarySupplier, setBrandSummarySupplier] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setSnapshotError("");
      try {
        const result = await fetchDashboardSnapshot();
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
  }, []);

  useEffect(() => {
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
  }, []);

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
  }, [brandSummarySupplier, suppliers]);

  async function reloadDashboard() {
    setSnapshotError("");
    setLatestQuotesError("");
    setBrandSummaryError("");
    try {
      const [snapshotResult, latestQuotesResult] = await Promise.all([
        fetchDashboardSnapshot(),
        fetchDashboardLatestQuotes(),
      ]);
      setSnapshot(snapshotResult);
      setLatestQuotes(latestQuotesResult);
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

  const supplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: supplier.name,
  }));
  const brandSummarySupplierOptions = [{ value: "", label: "All Suppliers" }, ...supplierOptions];

  const filteredBrandSummary = brandSummary.filter((row) => {
    const search = brandSummarySearch.trim().toLowerCase();
    const matchesSearch =
      !search ||
      row.brand.toLowerCase().includes(search) ||
      row.supplier_name.toLowerCase().includes(search);
    return matchesSearch;
  });

  function handleExportBrandSummary() {
    const rows = [
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
    downloadCsv("brand-summary.csv", toCsv(rows));
    actionFeedback.succeed("Brand summary CSV downloaded.");
  }

  function formatMoney(value: number) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(value || 0);
  }

  return (
    <div className="dashboard">
      <div className="stats-grid">
        <StatCard label="Catalog Products" value={catalogCount.toLocaleString("en-US")} subtext="Live cloud catalog" tone="success" />
        <StatCard label="Brands" value={brandCount.toLocaleString("en-US")} subtext="Available in workspace" tone="warning" />
        <StatCard label="Suppliers" value={supplierCount.toLocaleString("en-US")} subtext="Live supplier accounts" tone="success" />
        <StatCard label="Quotes" value={quoteCount.toLocaleString("en-US")} subtext="Recent cloud sales orders" tone="neutral" />
      </div>

      {newPortalOrders > 0 ? (
        <SectionCard title="New Order Came">
          <div className="dashboard-alert dashboard-alert--warning">
            <strong>{newPortalOrders.toLocaleString("en-US")} new portal order</strong>
            <span>Customer confirmed order is waiting in Sales Orders.</span>
          </div>
        </SectionCard>
      ) : null}

      <div className="dashboard-grid">
        <SectionCard title="Latest Sales Orders">
          {latestQuotesError ? <div className="error-text">{latestQuotesError}</div> : null}
          <div className="list-stack">
            {latestQuotes.map((quote) => (
              <div key={quote.id} className="list-row">
                <strong>{quote.sales_order_no || quote.id}</strong>
                <span>{quote.customer_name || "-"}</span>
                <span className="dashboard-order-meta">
                  {quote.source_channel === "portal" && quote.portal_submitted_at && !quote.portal_seen_at ? (
                    <span className="mark-badge mark-badge--accent">New Order</span>
                  ) : null}
                  <span>{quote.status || "-"}</span>
                </span>
                <Button variant="secondary" onClick={() => onOpenSalesOrder?.(quote.id)}>
                  Open Sales Order
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
            <button
              className={`module-tab${revenueSource === "quotes" ? " active" : ""}`}
              onClick={() => setRevenueSource("quotes")}
            >
              Quotes
            </button>
            <button
              className={`module-tab${revenueSource === "bills" ? " active" : ""}`}
              onClick={() => setRevenueSource("bills")}
            >
              Bills
            </button>
          </div>
          {revenueSource === "bills" ? (
            <div className="empty-state">Coming soon: bill-based turnover analysis will appear here after billing module goes live.</div>
          ) : revenue ? (
            <div className="stats-grid stats-grid--compact">
              <StatCard
                label="This Month"
                value={formatMoney(revenue.currentMonth.total)}
                subtext={`${revenue.currentMonth.count.toLocaleString("en-US")} sales orders`}
                tone="success"
              />
              <StatCard
                label="This Year"
                value={formatMoney(revenue.currentYear.total)}
                subtext={`${revenue.currentYear.count.toLocaleString("en-US")} sales orders`}
                tone="neutral"
              />
              <StatCard
                label="Previous Year"
                value={formatMoney(revenue.previousYear.total)}
                subtext={`${revenue.previousYear.count.toLocaleString("en-US")} sales orders`}
                tone="warning"
              />
            </div>
          ) : !snapshotError && !issues.revenue ? (
            <div className="chart-placeholder">Loading revenue analysis...</div>
          ) : issues.revenue ? (
            <div className="error-text">{issues.revenue}</div>
          ) : snapshotError ? (
            <div className="error-text">{snapshotError}</div>
          ) : null}
        </SectionCard>
        <SectionCard title="Brand Summary">
          <div className="toolbar toolbar--wrap dashboard-toolbar">
            <Select value={brandSummarySupplier} options={brandSummarySupplierOptions} onChange={setBrandSummarySupplier} />
            <Input value={brandSummarySearch} placeholder="Search brand or supplier" onChange={setBrandSummarySearch} />
            <Button variant="secondary" className="button--compact" onClick={handleExportBrandSummary} disabled={!filteredBrandSummary.length}>
              Export CSV
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
                      <td>{row.brand}</td>
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
      </div>
    </div>
  );
}
