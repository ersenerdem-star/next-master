import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchAppSession } from "../../infrastructure/api/appSessionApi";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import {
  fetchCustomerBalanceByBrandProduct,
  fetchInventoryByBrandProductWarehouse,
  fetchOpenPurchaseOrdersByBrandProduct,
  fetchOpenSalesOrdersByBrandProduct,
  fetchPurchasePriceVarianceReport,
  fetchSalesMarginReport,
  fetchSupplierBalanceByBrandProduct,
  type ReportingReportFilters,
} from "../../infrastructure/api/reportingApi";
import type { BrandOption } from "../../types/brand";
import type {
  CustomerBalanceByBrandProductRow,
  InventoryByBrandProductWarehouseRow,
  OpenPurchaseOrdersByBrandProductRow,
  OpenSalesOrdersByBrandProductRow,
  PurchasePriceVarianceReportRow,
  SalesMarginReportRow,
  SupplierBalanceByBrandProductRow,
} from "../../types/reporting";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";

type CoreReportKey =
  | "supplierBalance"
  | "customerBalance"
  | "purchaseOpen"
  | "salesOpen"
  | "priceVariance"
  | "salesMargin"
  | "inventory";

type CoreReportRow =
  | SupplierBalanceByBrandProductRow
  | CustomerBalanceByBrandProductRow
  | OpenPurchaseOrdersByBrandProductRow
  | OpenSalesOrdersByBrandProductRow
  | PurchasePriceVarianceReportRow
  | SalesMarginReportRow
  | InventoryByBrandProductWarehouseRow;

type ReportColumn = {
  key: string;
  header: string;
  render: (row: CoreReportRow) => ReactNode;
  sortValue?: (row: CoreReportRow) => string | number | null | undefined;
};

type ReportDefinition = {
  key: CoreReportKey;
  label: string;
  source: string;
  partyLabel: string;
  totalLabel: string;
  totalField: string;
  load: (filters: ReportingReportFilters) => Promise<CoreReportRow[]>;
  columns: ReportColumn[];
};

function getField(row: CoreReportRow, key: string) {
  return (row as Record<string, unknown>)[key];
}

function asText(row: CoreReportRow, key: string) {
  return String(getField(row, key) ?? "").trim();
}

function asNumber(row: CoreReportRow, key: string) {
  const value = Number(getField(row, key) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function formatNumber(value: unknown, fractionDigits = 2) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "-";
  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatQuantity(value: unknown) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "-";
  return numeric.toLocaleString("en-US", {
    maximumFractionDigits: 3,
  });
}

function formatDate(value: unknown) {
  const text = String(value || "");
  if (!text) return "-";
  return text.slice(0, 10);
}

function money(row: CoreReportRow, amountKey: string) {
  const currency = asText(row, "currency");
  return `${formatNumber(getField(row, amountKey))}${currency ? ` ${currency}` : ""}`;
}

const partyColumn = (key: string, header: string): ReportColumn => ({
  key,
  header,
  render: (row) => asText(row, key) || "-",
  sortValue: (row) => asText(row, key),
});

const brandColumn: ReportColumn = {
  key: "brand",
  header: "Brand",
  render: (row) => asText(row, "brand") || "-",
  sortValue: (row) => asText(row, "brand"),
};

const productColumn: ReportColumn = {
  key: "product",
  header: "Product",
  render: (row) => asText(row, "product_code") || asText(row, "normalized_code") || "-",
  sortValue: (row) => asText(row, "product_code") || asText(row, "normalized_code"),
};

const balanceColumns = (partyKey: string, partyHeader: string): ReportColumn[] => [
  partyColumn(partyKey, partyHeader),
  brandColumn,
  productColumn,
  { key: "debit", header: "Debit", render: (row) => money(row, "debit_amount"), sortValue: (row) => asNumber(row, "debit_amount") },
  { key: "credit", header: "Credit", render: (row) => money(row, "credit_amount"), sortValue: (row) => asNumber(row, "credit_amount") },
  { key: "balance", header: "Balance", render: (row) => money(row, "balance_amount"), sortValue: (row) => asNumber(row, "balance_amount") },
  { key: "due", header: "Latest Due", render: (row) => formatDate(getField(row, "latest_due_date")), sortValue: (row) => asText(row, "latest_due_date") },
  { key: "lines", header: "Lines", render: (row) => formatQuantity(getField(row, "line_count")), sortValue: (row) => asNumber(row, "line_count") },
];

const openPurchaseColumns: ReportColumn[] = [
  partyColumn("supplier_name", "Supplier"),
  { key: "po", header: "PO", render: (row) => asText(row, "purchase_order_no") || asText(row, "purchase_order_id") || "-", sortValue: (row) => asText(row, "purchase_order_no") },
  { key: "so", header: "SO", render: (row) => asText(row, "sales_order_no") || "-", sortValue: (row) => asText(row, "sales_order_no") },
  brandColumn,
  productColumn,
  { key: "date", header: "Date", render: (row) => formatDate(getField(row, "transaction_date")), sortValue: (row) => asText(row, "transaction_date") },
  { key: "status", header: "Status", render: (row) => asText(row, "status") || "-", sortValue: (row) => asText(row, "status") },
  { key: "ordered", header: "Ordered", render: (row) => formatQuantity(getField(row, "ordered_qty")), sortValue: (row) => asNumber(row, "ordered_qty") },
  { key: "received", header: "Received", render: (row) => formatQuantity(getField(row, "received_qty")), sortValue: (row) => asNumber(row, "received_qty") },
  { key: "open", header: "Open", render: (row) => formatQuantity(getField(row, "open_qty")), sortValue: (row) => asNumber(row, "open_qty") },
  { key: "amount", header: "Open Amount", render: (row) => money(row, "open_amount"), sortValue: (row) => asNumber(row, "open_amount") },
];

const openSalesColumns: ReportColumn[] = [
  partyColumn("customer_name", "Customer"),
  { key: "so", header: "SO", render: (row) => asText(row, "sales_order_no") || asText(row, "sales_order_id") || "-", sortValue: (row) => asText(row, "sales_order_no") },
  brandColumn,
  productColumn,
  { key: "date", header: "Date", render: (row) => formatDate(getField(row, "transaction_date")), sortValue: (row) => asText(row, "transaction_date") },
  { key: "status", header: "Status", render: (row) => asText(row, "status") || "-", sortValue: (row) => asText(row, "status") },
  { key: "ordered", header: "Ordered", render: (row) => formatQuantity(getField(row, "ordered_qty")), sortValue: (row) => asNumber(row, "ordered_qty") },
  { key: "invoiced", header: "Invoiced", render: (row) => formatQuantity(getField(row, "invoiced_qty")), sortValue: (row) => asNumber(row, "invoiced_qty") },
  { key: "open", header: "Open", render: (row) => formatQuantity(getField(row, "open_qty")), sortValue: (row) => asNumber(row, "open_qty") },
  { key: "amount", header: "Open Amount", render: (row) => money(row, "open_amount"), sortValue: (row) => asNumber(row, "open_amount") },
];

const priceVarianceColumns: ReportColumn[] = [
  partyColumn("party_name", "Supplier"),
  { key: "doc", header: "Document", render: (row) => asText(row, "document_no") || asText(row, "document_id") || "-", sortValue: (row) => asText(row, "document_no") },
  brandColumn,
  productColumn,
  { key: "qty", header: "Qty", render: (row) => formatQuantity(getField(row, "quantity")), sortValue: (row) => asNumber(row, "quantity") },
  { key: "po", header: "PO Price", render: (row) => formatNumber(getField(row, "po_unit_price"), 4), sortValue: (row) => asNumber(row, "po_unit_price") },
  { key: "bill", header: "Bill Price", render: (row) => formatNumber(getField(row, "bill_unit_price"), 4), sortValue: (row) => asNumber(row, "bill_unit_price") },
  { key: "last", header: "Last Buy", render: (row) => formatNumber(getField(row, "last_buy_price"), 4), sortValue: (row) => asNumber(row, "last_buy_price") },
  { key: "variance", header: "Variance", render: (row) => money(row, "variance_amount"), sortValue: (row) => asNumber(row, "variance_amount") },
  { key: "percent", header: "Variance %", render: (row) => `${formatNumber(getField(row, "variance_percent"), 2)}%`, sortValue: (row) => asNumber(row, "variance_percent") },
  { key: "severity", header: "Severity", render: (row) => asText(row, "severity") || "-", sortValue: (row) => asText(row, "severity") },
  { key: "date", header: "Date", render: (row) => formatDate(getField(row, "transaction_date")), sortValue: (row) => asText(row, "transaction_date") },
];

const salesMarginColumns: ReportColumn[] = [
  partyColumn("customer_name", "Customer"),
  brandColumn,
  productColumn,
  { key: "qty", header: "Qty", render: (row) => formatQuantity(getField(row, "quantity")), sortValue: (row) => asNumber(row, "quantity") },
  { key: "revenue", header: "Revenue", render: (row) => money(row, "revenue_amount"), sortValue: (row) => asNumber(row, "revenue_amount") },
  { key: "cost", header: "Cost", render: (row) => money(row, "cost_amount"), sortValue: (row) => asNumber(row, "cost_amount") },
  { key: "margin", header: "Margin", render: (row) => money(row, "margin_amount"), sortValue: (row) => asNumber(row, "margin_amount") },
  { key: "percent", header: "Margin %", render: (row) => `${formatNumber(getField(row, "margin_percent"), 2)}%`, sortValue: (row) => asNumber(row, "margin_percent") },
  { key: "lines", header: "Lines", render: (row) => formatQuantity(getField(row, "line_count")), sortValue: (row) => asNumber(row, "line_count") },
];

const inventoryColumns: ReportColumn[] = [
  { key: "warehouse", header: "Warehouse", render: (row) => asText(row, "warehouse_code") || asText(row, "warehouse_name") || "-", sortValue: (row) => asText(row, "warehouse_code") },
  brandColumn,
  productColumn,
  { key: "description", header: "Description", render: (row) => asText(row, "description") || "-", sortValue: (row) => asText(row, "description") },
  { key: "in", header: "In", render: (row) => formatQuantity(getField(row, "qty_in")), sortValue: (row) => asNumber(row, "qty_in") },
  { key: "out", header: "Out", render: (row) => formatQuantity(getField(row, "qty_out")), sortValue: (row) => asNumber(row, "qty_out") },
  { key: "onhand", header: "On Hand", render: (row) => formatQuantity(getField(row, "on_hand_qty")), sortValue: (row) => asNumber(row, "on_hand_qty") },
  { key: "cost", header: "Total Cost", render: (row) => formatNumber(getField(row, "total_cost")), sortValue: (row) => asNumber(row, "total_cost") },
  { key: "last", header: "Last Move", render: (row) => formatDate(getField(row, "last_moved_at")), sortValue: (row) => asText(row, "last_moved_at") },
];

const reports: ReportDefinition[] = [
  {
    key: "supplierBalance",
    label: "Supplier Balance",
    source: "reporting_supplier_balance_by_brand_product",
    partyLabel: "Supplier",
    totalLabel: "Balance",
    totalField: "balance_amount",
    load: fetchSupplierBalanceByBrandProduct,
    columns: balanceColumns("supplier_name", "Supplier"),
  },
  {
    key: "customerBalance",
    label: "Customer Balance",
    source: "reporting_customer_balance_by_brand_product",
    partyLabel: "Customer",
    totalLabel: "Balance",
    totalField: "balance_amount",
    load: fetchCustomerBalanceByBrandProduct,
    columns: balanceColumns("customer_name", "Customer"),
  },
  {
    key: "purchaseOpen",
    label: "Purchase Open Balance",
    source: "reporting_open_purchase_orders_by_brand_product",
    partyLabel: "Supplier",
    totalLabel: "Open Amount",
    totalField: "open_amount",
    load: fetchOpenPurchaseOrdersByBrandProduct,
    columns: openPurchaseColumns,
  },
  {
    key: "salesOpen",
    label: "Sales Open Balance",
    source: "reporting_open_sales_orders_by_brand_product",
    partyLabel: "Customer",
    totalLabel: "Open Amount",
    totalField: "open_amount",
    load: fetchOpenSalesOrdersByBrandProduct,
    columns: openSalesColumns,
  },
  {
    key: "priceVariance",
    label: "Price Variance",
    source: "reporting_purchase_price_variance_report",
    partyLabel: "Supplier",
    totalLabel: "Variance",
    totalField: "variance_amount",
    load: fetchPurchasePriceVarianceReport,
    columns: priceVarianceColumns,
  },
  {
    key: "salesMargin",
    label: "Sales Margin",
    source: "reporting_sales_margin_report",
    partyLabel: "Customer",
    totalLabel: "Margin",
    totalField: "margin_amount",
    load: fetchSalesMarginReport,
    columns: salesMarginColumns,
  },
  {
    key: "inventory",
    label: "Inventory by Brand/Product/Warehouse",
    source: "reporting_inventory_by_brand_product_warehouse",
    partyLabel: "Party",
    totalLabel: "On Hand",
    totalField: "on_hand_qty",
    load: fetchInventoryByBrandProductWarehouse,
    columns: inventoryColumns,
  },
];

const reportOptions = reports.map((report) => ({ value: report.key, label: report.label }));
const limitOptions = [
  { value: "100", label: "100 rows" },
  { value: "500", label: "500 rows" },
  { value: "1000", label: "1,000 rows" },
  { value: "2500", label: "2,500 rows" },
];

export function CoreReportsPage() {
  const actionFeedback = useActionFeedback();
  const [activeReport, setActiveReport] = useState<CoreReportKey>("supplierBalance");
  const [organizationId, setOrganizationId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [brandId, setBrandId] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [partyQuery, setPartyQuery] = useState("");
  const [limit, setLimit] = useState("500");
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [rows, setRows] = useState<CoreReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const activeDefinition = useMemo(() => reports.find((report) => report.key === activeReport) || reports[0], [activeReport]);
  const totalValue = useMemo(() => rows.reduce((sum, row) => sum + asNumber(row, activeDefinition.totalField), 0), [activeDefinition.totalField, rows]);
  const brandOptions = useMemo(() => [{ value: "", label: "All brands" }, ...brands.map((brand) => ({ value: brand.id, label: brand.name }))], [brands]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [session, brandRows] = await Promise.all([fetchAppSession(), fetchCloudBrands()]);
        if (cancelled) return;
        setOrganizationId(session.organizationId);
        setBrands(brandRows);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Reporting context could not be loaded");
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setRows([]);
    setLoaded(false);
    setError("");
  }, [activeReport]);

  async function loadReport() {
    const nextOrganizationId = organizationId.trim();
    if (!nextOrganizationId) {
      setError("Organization ID is required.");
      return;
    }

    setLoading(true);
    setError("");
    actionFeedback.begin(`Loading ${activeDefinition.label}...`);
    try {
      const result = await activeDefinition.load({
        organizationId: nextOrganizationId,
        startDate,
        endDate,
        brandId,
        productQuery,
        partyQuery,
        limit: Number(limit) || 500,
      });
      setRows(result);
      setLoaded(true);
      actionFeedback.succeed(`${result.length.toLocaleString("en-US")} ${activeDefinition.label} row(s) loaded.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Report request failed";
      setRows([]);
      setLoaded(false);
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="section-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>Core Reports</h2>
            <p>{activeDefinition.label}</p>
          </div>
          <div className="toolbar toolbar--wrap">
            <Select label="Report" value={activeReport} options={reportOptions} onChange={(value) => setActiveReport(value as CoreReportKey)} />
            <Input label="Organization ID" value={organizationId} onChange={setOrganizationId} />
            <Input label="Start Date" type="date" value={startDate} onChange={setStartDate} />
            <Input label="End Date" type="date" value={endDate} onChange={setEndDate} />
            <Select label="Brand" value={brandId} options={brandOptions} onChange={setBrandId} />
            <Input label="Product" value={productQuery} onChange={setProductQuery} placeholder="Code or description" />
            <Input label={activeDefinition.partyLabel} value={partyQuery} onChange={setPartyQuery} placeholder={activeDefinition.partyLabel} />
            <Select label="Limit" value={limit} options={limitOptions} onChange={setLimit} />
            <Button onClick={() => void loadReport()} busy={loading} busyLabel="Loading...">
              Load Report
            </Button>
          </div>
        </div>
        <div className="section-card__body">
          <div className="meta-row">
            <span>{loaded ? `${rows.length.toLocaleString("en-US")} rows` : "No report loaded"}</span>
            <span>{loaded ? `${activeDefinition.totalLabel}: ${formatNumber(totalValue)}` : activeDefinition.source}</span>
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable rows={rows} columns={activeDefinition.columns} emptyText={loading ? "Loading..." : "No report rows found"} />
        </div>
      </section>
    </div>
  );
}
