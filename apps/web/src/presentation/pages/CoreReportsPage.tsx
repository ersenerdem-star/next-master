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
import { useI18n } from "../../i18n/I18nProvider";

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
  headerKey: string;
  render: (row: CoreReportRow) => ReactNode;
  sortValue?: (row: CoreReportRow) => string | number | null | undefined;
};

type ReportDefinition = {
  key: CoreReportKey;
  labelKey: string;
  source: string;
  partyLabelKey: string;
  totalLabelKey: string;
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

const partyColumn = (key: string, headerKey: string): ReportColumn => ({
  key,
  headerKey,
  render: (row) => asText(row, key) || "-",
  sortValue: (row) => asText(row, key),
});

const brandColumn: ReportColumn = {
  key: "brand",
  headerKey: "columns.brand",
  render: (row) => asText(row, "brand") || "-",
  sortValue: (row) => asText(row, "brand"),
};

const productColumn: ReportColumn = {
  key: "product",
  headerKey: "columns.product",
  render: (row) => asText(row, "product_code") || asText(row, "normalized_code") || "-",
  sortValue: (row) => asText(row, "product_code") || asText(row, "normalized_code"),
};

const balanceColumns = (partyKey: string, partyHeaderKey: string): ReportColumn[] => [
  partyColumn(partyKey, partyHeaderKey),
  brandColumn,
  productColumn,
  { key: "debit", headerKey: "columns.debit", render: (row) => money(row, "debit_amount"), sortValue: (row) => asNumber(row, "debit_amount") },
  { key: "credit", headerKey: "columns.credit", render: (row) => money(row, "credit_amount"), sortValue: (row) => asNumber(row, "credit_amount") },
  { key: "balance", headerKey: "columns.balance", render: (row) => money(row, "balance_amount"), sortValue: (row) => asNumber(row, "balance_amount") },
  { key: "due", headerKey: "columns.latestDue", render: (row) => formatDate(getField(row, "latest_due_date")), sortValue: (row) => asText(row, "latest_due_date") },
  { key: "lines", headerKey: "columns.lines", render: (row) => formatQuantity(getField(row, "line_count")), sortValue: (row) => asNumber(row, "line_count") },
];

const openPurchaseColumns: ReportColumn[] = [
  partyColumn("supplier_name", "columns.supplier"),
  { key: "po", headerKey: "columns.po", render: (row) => asText(row, "purchase_order_no") || asText(row, "purchase_order_id") || "-", sortValue: (row) => asText(row, "purchase_order_no") },
  { key: "so", headerKey: "columns.so", render: (row) => asText(row, "sales_order_no") || "-", sortValue: (row) => asText(row, "sales_order_no") },
  brandColumn,
  productColumn,
  { key: "date", headerKey: "columns.date", render: (row) => formatDate(getField(row, "transaction_date")), sortValue: (row) => asText(row, "transaction_date") },
  { key: "status", headerKey: "columns.status", render: (row) => asText(row, "status") || "-", sortValue: (row) => asText(row, "status") },
  { key: "ordered", headerKey: "columns.ordered", render: (row) => formatQuantity(getField(row, "ordered_qty")), sortValue: (row) => asNumber(row, "ordered_qty") },
  { key: "received", headerKey: "columns.received", render: (row) => formatQuantity(getField(row, "received_qty")), sortValue: (row) => asNumber(row, "received_qty") },
  { key: "open", headerKey: "columns.open", render: (row) => formatQuantity(getField(row, "open_qty")), sortValue: (row) => asNumber(row, "open_qty") },
  { key: "amount", headerKey: "columns.openAmount", render: (row) => money(row, "open_amount"), sortValue: (row) => asNumber(row, "open_amount") },
];

const openSalesColumns: ReportColumn[] = [
  partyColumn("customer_name", "columns.customer"),
  { key: "so", headerKey: "columns.so", render: (row) => asText(row, "sales_order_no") || asText(row, "sales_order_id") || "-", sortValue: (row) => asText(row, "sales_order_no") },
  brandColumn,
  productColumn,
  { key: "date", headerKey: "columns.date", render: (row) => formatDate(getField(row, "transaction_date")), sortValue: (row) => asText(row, "transaction_date") },
  { key: "status", headerKey: "columns.status", render: (row) => asText(row, "status") || "-", sortValue: (row) => asText(row, "status") },
  { key: "ordered", headerKey: "columns.ordered", render: (row) => formatQuantity(getField(row, "ordered_qty")), sortValue: (row) => asNumber(row, "ordered_qty") },
  { key: "invoiced", headerKey: "columns.invoiced", render: (row) => formatQuantity(getField(row, "invoiced_qty")), sortValue: (row) => asNumber(row, "invoiced_qty") },
  { key: "open", headerKey: "columns.open", render: (row) => formatQuantity(getField(row, "open_qty")), sortValue: (row) => asNumber(row, "open_qty") },
  { key: "amount", headerKey: "columns.openAmount", render: (row) => money(row, "open_amount"), sortValue: (row) => asNumber(row, "open_amount") },
];

const priceVarianceColumns: ReportColumn[] = [
  partyColumn("party_name", "columns.supplier"),
  { key: "doc", headerKey: "columns.document", render: (row) => asText(row, "document_no") || asText(row, "document_id") || "-", sortValue: (row) => asText(row, "document_no") },
  brandColumn,
  productColumn,
  { key: "qty", headerKey: "columns.qty", render: (row) => formatQuantity(getField(row, "quantity")), sortValue: (row) => asNumber(row, "quantity") },
  { key: "po", headerKey: "columns.poPrice", render: (row) => formatNumber(getField(row, "po_unit_price"), 4), sortValue: (row) => asNumber(row, "po_unit_price") },
  { key: "bill", headerKey: "columns.billPrice", render: (row) => formatNumber(getField(row, "bill_unit_price"), 4), sortValue: (row) => asNumber(row, "bill_unit_price") },
  { key: "last", headerKey: "columns.lastBuy", render: (row) => formatNumber(getField(row, "last_buy_price"), 4), sortValue: (row) => asNumber(row, "last_buy_price") },
  { key: "variance", headerKey: "columns.variance", render: (row) => money(row, "variance_amount"), sortValue: (row) => asNumber(row, "variance_amount") },
  { key: "percent", headerKey: "columns.variancePercent", render: (row) => `${formatNumber(getField(row, "variance_percent"), 2)}%`, sortValue: (row) => asNumber(row, "variance_percent") },
  { key: "severity", headerKey: "columns.severity", render: (row) => asText(row, "severity") || "-", sortValue: (row) => asText(row, "severity") },
  { key: "date", headerKey: "columns.date", render: (row) => formatDate(getField(row, "transaction_date")), sortValue: (row) => asText(row, "transaction_date") },
];

const salesMarginColumns: ReportColumn[] = [
  partyColumn("customer_name", "columns.customer"),
  brandColumn,
  productColumn,
  { key: "qty", headerKey: "columns.qty", render: (row) => formatQuantity(getField(row, "quantity")), sortValue: (row) => asNumber(row, "quantity") },
  { key: "revenue", headerKey: "columns.revenue", render: (row) => money(row, "revenue_amount"), sortValue: (row) => asNumber(row, "revenue_amount") },
  { key: "cost", headerKey: "columns.cost", render: (row) => money(row, "cost_amount"), sortValue: (row) => asNumber(row, "cost_amount") },
  { key: "margin", headerKey: "columns.margin", render: (row) => money(row, "margin_amount"), sortValue: (row) => asNumber(row, "margin_amount") },
  { key: "percent", headerKey: "columns.marginPercent", render: (row) => `${formatNumber(getField(row, "margin_percent"), 2)}%`, sortValue: (row) => asNumber(row, "margin_percent") },
  { key: "lines", headerKey: "columns.lines", render: (row) => formatQuantity(getField(row, "line_count")), sortValue: (row) => asNumber(row, "line_count") },
];

const inventoryColumns: ReportColumn[] = [
  { key: "warehouse", headerKey: "columns.warehouse", render: (row) => asText(row, "warehouse_code") || asText(row, "warehouse_name") || "-", sortValue: (row) => asText(row, "warehouse_code") },
  brandColumn,
  productColumn,
  { key: "description", headerKey: "columns.description", render: (row) => asText(row, "description") || "-", sortValue: (row) => asText(row, "description") },
  { key: "in", headerKey: "columns.in", render: (row) => formatQuantity(getField(row, "qty_in")), sortValue: (row) => asNumber(row, "qty_in") },
  { key: "out", headerKey: "columns.out", render: (row) => formatQuantity(getField(row, "qty_out")), sortValue: (row) => asNumber(row, "qty_out") },
  { key: "onhand", headerKey: "columns.onHand", render: (row) => formatQuantity(getField(row, "on_hand_qty")), sortValue: (row) => asNumber(row, "on_hand_qty") },
  { key: "cost", headerKey: "columns.totalCost", render: (row) => formatNumber(getField(row, "total_cost")), sortValue: (row) => asNumber(row, "total_cost") },
  { key: "last", headerKey: "columns.lastMove", render: (row) => formatDate(getField(row, "last_moved_at")), sortValue: (row) => asText(row, "last_moved_at") },
];

const reports: ReportDefinition[] = [
  {
    key: "supplierBalance",
    labelKey: "core.reports.supplierBalance",
    source: "reporting_supplier_balance_by_brand_product",
    partyLabelKey: "columns.supplier",
    totalLabelKey: "columns.balance",
    totalField: "balance_amount",
    load: fetchSupplierBalanceByBrandProduct,
    columns: balanceColumns("supplier_name", "columns.supplier"),
  },
  {
    key: "customerBalance",
    labelKey: "core.reports.customerBalance",
    source: "reporting_customer_balance_by_brand_product",
    partyLabelKey: "columns.customer",
    totalLabelKey: "columns.balance",
    totalField: "balance_amount",
    load: fetchCustomerBalanceByBrandProduct,
    columns: balanceColumns("customer_name", "columns.customer"),
  },
  {
    key: "purchaseOpen",
    labelKey: "core.reports.purchaseOpen",
    source: "reporting_open_purchase_orders_by_brand_product",
    partyLabelKey: "columns.supplier",
    totalLabelKey: "columns.openAmount",
    totalField: "open_amount",
    load: fetchOpenPurchaseOrdersByBrandProduct,
    columns: openPurchaseColumns,
  },
  {
    key: "salesOpen",
    labelKey: "core.reports.salesOpen",
    source: "reporting_open_sales_orders_by_brand_product",
    partyLabelKey: "columns.customer",
    totalLabelKey: "columns.openAmount",
    totalField: "open_amount",
    load: fetchOpenSalesOrdersByBrandProduct,
    columns: openSalesColumns,
  },
  {
    key: "priceVariance",
    labelKey: "core.reports.priceVariance",
    source: "reporting_purchase_price_variance_report",
    partyLabelKey: "columns.supplier",
    totalLabelKey: "columns.variance",
    totalField: "variance_amount",
    load: fetchPurchasePriceVarianceReport,
    columns: priceVarianceColumns,
  },
  {
    key: "salesMargin",
    labelKey: "core.reports.salesMargin",
    source: "reporting_sales_margin_report",
    partyLabelKey: "columns.customer",
    totalLabelKey: "columns.margin",
    totalField: "margin_amount",
    load: fetchSalesMarginReport,
    columns: salesMarginColumns,
  },
  {
    key: "inventory",
    labelKey: "core.reports.inventory",
    source: "reporting_inventory_by_brand_product_warehouse",
    partyLabelKey: "columns.party",
    totalLabelKey: "columns.onHand",
    totalField: "on_hand_qty",
    load: fetchInventoryByBrandProductWarehouse,
    columns: inventoryColumns,
  },
];

export function CoreReportsPage() {
  const { t } = useI18n();
  const r = (key: string, params?: Record<string, string | number>) => t(`reports.${key}`, params);
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
  const activeReportLabel = r(activeDefinition.labelKey);
  const activePartyLabel = r(activeDefinition.partyLabelKey);
  const activeTotalLabel = r(activeDefinition.totalLabelKey);
  const limitOptions = useMemo(
    () =>
      [
        { value: "100", count: "100" },
        { value: "500", count: "500" },
        { value: "1000", count: "1,000" },
        { value: "2500", count: "2,500" },
      ].map((item) => ({ value: item.value, label: r("core.fields.limitRows", { count: item.count }) })),
    [t],
  );
  const reportOptions = useMemo(() => reports.map((report) => ({ value: report.key, label: r(report.labelKey) })), [t]);
  const translatedColumns = useMemo(
    () => activeDefinition.columns.map((column) => ({ ...column, header: r(column.headerKey) })),
    [activeDefinition, t],
  );
  const totalValue = useMemo(() => rows.reduce((sum, row) => sum + asNumber(row, activeDefinition.totalField), 0), [activeDefinition.totalField, rows]);
  const brandOptions = useMemo(() => [{ value: "", label: r("core.filters.allBrands") }, ...brands.map((brand) => ({ value: brand.id, label: brand.name }))], [brands, t]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [session, brandRows] = await Promise.all([fetchAppSession(), fetchCloudBrands()]);
        if (cancelled) return;
        setOrganizationId(session.organizationId);
        setBrands(brandRows);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : r("core.errors.contextLoadFailed"));
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
      setError(r("core.errors.organizationRequired"));
      return;
    }

    setLoading(true);
    setError("");
    actionFeedback.begin(r("core.feedback.loading", { report: activeReportLabel }));
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
      actionFeedback.succeed(r("core.feedback.rowsLoaded", { count: result.length.toLocaleString("en-US"), report: activeReportLabel }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : r("core.errors.requestFailed");
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
            <h2>{r("core.title")}</h2>
            <p>{activeReportLabel}</p>
          </div>
          <div className="toolbar toolbar--wrap">
            <Select label={r("core.fields.report")} value={activeReport} options={reportOptions} onChange={(value) => setActiveReport(value as CoreReportKey)} />
            <Input label={r("core.fields.organizationId")} value={organizationId} onChange={setOrganizationId} />
            <Input label={r("core.fields.startDate")} type="date" value={startDate} onChange={setStartDate} />
            <Input label={r("core.fields.endDate")} type="date" value={endDate} onChange={setEndDate} />
            <Select label={r("columns.brand")} value={brandId} options={brandOptions} onChange={setBrandId} />
            <Input label={r("columns.product")} value={productQuery} onChange={setProductQuery} placeholder={r("core.placeholders.product")} />
            <Input label={activePartyLabel} value={partyQuery} onChange={setPartyQuery} placeholder={activePartyLabel} />
            <Select label={r("core.fields.limit")} value={limit} options={limitOptions} onChange={setLimit} />
            <Button onClick={() => void loadReport()} busy={loading} busyLabel={t("common.loadingPage")}>
              {r("core.actions.loadReport")}
            </Button>
          </div>
        </div>
        <div className="section-card__body">
          <div className="meta-row">
            <span>{loaded ? r("core.meta.rows", { count: rows.length.toLocaleString("en-US") }) : r("core.meta.noReportLoaded")}</span>
            <span>{loaded ? r("core.meta.total", { label: activeTotalLabel, value: formatNumber(totalValue) }) : activeDefinition.source}</span>
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable rows={rows} columns={translatedColumns} emptyText={loading ? t("common.loadingPage") : r("core.empty.noRows")} />
        </div>
      </section>
    </div>
  );
}
