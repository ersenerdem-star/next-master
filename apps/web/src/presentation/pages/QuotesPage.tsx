import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchCompanyProfiles, findCompanyProfileByName } from "../../infrastructure/api/companyProfilesApi";
import { findCodeReferenceMatch } from "../../infrastructure/api/codeReferencesApi";
import { fetchCustomers, findCustomerByNameInList } from "../../infrastructure/api/customersApi";
import {
  deleteSalesOrder,
  fetchInvoiceSalesLinkSummaries,
  fetchPurchaseOrderSalesLinkSummaries,
  fetchSalesOrderById,
  fetchSalesOrderSummaries,
  markSalesOrderPortalSeen,
  replacePurchaseOrdersForSalesOrder,
  upsertInvoice,
  upsertSalesOrder,
} from "../../infrastructure/api/ordersApi";
import { batchResolveQuoteImportRows } from "../../infrastructure/api/quoteImportApi";
import { fetchCPriceMapForRows, getCPriceForRow } from "../../infrastructure/api/cPriceApi";
import { fetchPriceListSettings } from "../../infrastructure/api/priceListsApi";
import { resolveQuoteLine } from "../../infrastructure/api/quoteResolverApi";
import { fetchCloudQuoteDetail, fetchCloudQuotes } from "../../infrastructure/api/quotesApi";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { buildInventoryAvailabilityLookup, fetchInventoryAvailabilitySummary, inventoryAvailabilityLookupKey, type InventoryAvailabilitySummary } from "../../infrastructure/api/inventoryApi";
import { canonicalizeBrandName, normalizeBrandKey, normalizePartCode } from "../../domain/shared/normalize";
import { parseCsv } from "../../shared/csv";
import { downloadQuoteTemplate } from "../../shared/importTemplates";
import { consumeCatalogTransfer, PENDING_CATALOG_SALES_ITEM_KEY } from "../../shared/catalogTransfer";
import { buildInvoiceFromSalesOrder, buildLocalSalesOrder, buildPurchaseOrdersFromSalesOrder } from "../../shared/localOrders";
import { resyncSalesOrderLinesFromCatalog } from "../../shared/salesOrderCatalogSync";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { buildBusinessDocumentHtml, openBusinessDocumentPreview } from "../../shared/documentPrint";
import { buildEntityAlias } from "../../shared/entityAlias";
import { Select } from "../components/common/Select";
import type { CompanyProfile } from "../../types/company";
import type { LocalCustomer } from "../../types/customers";
import type { CodeReferenceMatch } from "../../types/codeReferences";
import type { LocalSalesOrder } from "../../types/orders";
import type { QuoteBuilderLine } from "../../types/quoteBuilder";
import type { QuoteDetail, QuoteSummary } from "../../types/quotes";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { DraggableSurface } from "../components/common/DraggableSurface";
import { Input } from "../components/common/Input";
import { BrandPill } from "../components/common/BrandPill";

type QuotesPageProps = {
  selectedSalesOrderId?: string;
  onSelectedSalesOrderChange?: (salesOrderId: string) => void;
  selectedQuoteId?: string;
  onSelectedQuoteChange?: (quoteId: string) => void;
  salesOrdersNavTick?: number;
};

type CustomerPricingMode = "standard" | "prefer_c_when_available";

type QuoteImportRow = {
  code: string;
  brand: string;
  qty: number;
};

type PurchaseOrderSalesLinkSummary = {
  id: string;
  sales_order_id: string;
};

type InvoiceSalesLinkSummary = {
  id: string;
  sales_order_id: string;
  sales_order_ids: string[];
};

const SALES_ORDER_WORKSPACE_CACHE_KEY = "next-master-sales-order-workspace";
const SALES_ORDER_WORKSPACE_CACHE_WRITE_DELAY_MS = 250;
const SALES_ORDER_IMPORT_CHUNK_SIZE = 75;

type PersistedSalesOrderWorkspace = {
  salesOrdersView?: "list" | "detail";
  salesOrderFilter?: "all" | "draft" | "confirmed" | "purchased" | "invoiced";
  workbenchMode?: "existing" | "new";
  selectedLocalSalesOrderId?: string;
  selectedQuoteId?: string;
  salesOrderSourceSnapshot?: string;
  builderStatus?: string;
  quoteNo?: string;
  customerName?: string;
  customerSelection?: string;
  manualCustomerName?: string;
  sellerCompany?: string;
  quoteDate?: string;
  currency?: string;
  quoteBrand?: string;
  quoteBrandSelection?: string;
  quoteQty?: string;
  customerType?: "A" | "B" | "C" | "Other";
  shippingCost?: string;
  discountAmount?: string;
  supplierMode?: string;
  sellerInfo?: string;
  buyerInfo?: string;
  deliveryTermSelection?: string;
  paymentTermsSelection?: string;
  deliveryTerm?: string;
  paymentTerms?: string;
  packingDetails?: string;
  quoteNotes?: string;
  quoteBuilderLines?: QuoteBuilderLine[];
  updatedAt?: string;
};

function readSalesOrderWorkspaceCache() {
  if (typeof window === "undefined") return null as PersistedSalesOrderWorkspace | null;
  try {
    const raw = window.localStorage.getItem(SALES_ORDER_WORKSPACE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSalesOrderWorkspace) : null;
  } catch {
    return null;
  }
}

function writeSalesOrderWorkspaceCache(cache: PersistedSalesOrderWorkspace | null) {
  if (typeof window === "undefined") return;
  try {
    if (!cache) {
      window.localStorage.removeItem(SALES_ORDER_WORKSPACE_CACHE_KEY);
      return;
    }
    window.localStorage.setItem(SALES_ORDER_WORKSPACE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Best-effort cache only.
  }
}

function chunkRows<T>(rows: T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }
  return batches;
}

const DELIVERY_TERM_OPTIONS = [
  "EXW",
  "FCA",
  "FOB",
  "CFR",
  "CIF",
  "DAP",
  "DDP",
] as const;

const PAYMENT_TERM_OPTIONS = [
  "Cash in advance",
  "Due on receipt",
  "Net 7",
  "Net 15",
  "Net 30",
  "Net 45",
  "Net 60",
] as const;

const DEFAULT_QUOTE_WORKBENCH_COLUMNS = {
  origin: false,
  stock: true,
  supplierOption: false,
  supplier: false,
  buy: false,
  buyTotal: false,
  profit: false,
  margin: false,
  date: false,
};

function toTermSelection(value: string, options: readonly string[]) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return options.includes(trimmed) ? trimmed : "__manual__";
}

function nextLineId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toNumber(value: number | null | undefined) {
  return Number(value ?? 0);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function shouldUseCPriceForCustomer(customerType: "A" | "B" | "C" | "Other", pricingMode: CustomerPricingMode) {
  return customerType === "C" || pricingMode === "prefer_c_when_available";
}

function compactWarningText(value: string | null | undefined) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isDraftPortalAlert(order: Pick<LocalSalesOrder, "source_channel" | "portal_submitted_at" | "portal_seen_at" | "status">, purchaseOrderCount = 0, invoiceCount = 0) {
  return (
    order.source_channel === "portal" &&
    Boolean(order.portal_submitted_at) &&
    !order.portal_seen_at &&
    String(order.status || "").toLowerCase() === "draft" &&
    purchaseOrderCount === 0 &&
    invoiceCount === 0
  );
}

function buildSalesOrderPrintAlerts(line: QuoteBuilderLine) {
  const alerts: Array<{ text: string; tone?: "warning" | "danger" | "muted" }> = [];
  const codeWarning = compactWarningText(line.codeChangeWarning);
  const lifecycleWarning = compactWarningText(line.lifecycle_warning);
  if (codeWarning) {
    alerts.push({ text: codeWarning, tone: "warning" });
  }
  if (line.lifecycle_status === "discontinued") {
    alerts.push({
      text: lifecycleWarning || `Discontinued item: ${line.resolvedCode || line.requestedCode}.`,
      tone: "danger",
    });
  } else if (lifecycleWarning && lifecycleWarning !== codeWarning) {
    alerts.push({ text: lifecycleWarning, tone: "muted" });
  }
  return alerts;
}

function formatMoney(value: number | null | undefined, currency = "EUR") {
  const numeric = Number(value ?? 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return value.slice(0, 10);
}

function parseQuoteImportRows(text: string) {
  const rows = parseCsv(text);
  if (!rows.length) return [] as QuoteImportRow[];

  const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const firstRow = rows[0].map(normalizeHeader);
  const hasStandardQuoteHeader =
    (firstRow.includes("part_no") || firstRow.includes("part_code")) &&
    firstRow.includes("brand") &&
    (firstRow.includes("qty") || firstRow.includes("quantity"));
  const hasHeader = firstRow.some((value) => ["part_no", "part_code", "product_code", "code", "item_code", "qty", "quantity", "brand"].includes(value));
  const body = hasHeader ? rows.slice(1) : rows;

  return body
    .map((row) => {
      const byHeader = (names: string[]) => {
        if (!hasHeader) return "";
        const index = firstRow.findIndex((header) => names.includes(header));
        return index >= 0 ? String(row[index] ?? "").trim() : "";
      };

      const code = hasHeader
        ? byHeader(hasStandardQuoteHeader ? ["part_no", "part_code"] : ["part_no", "part_code", "product_code", "item_code", "code", "partno"])
        : String(row[0] ?? "").trim();
      const brand = hasHeader ? byHeader(["brand"]) : String(row[1] ?? "").trim();
      const qtyText = hasHeader ? byHeader(hasStandardQuoteHeader ? ["qty", "quantity"] : ["qty", "quantity"]) : String(row[2] ?? "1").trim();
      const qty = Math.max(1, Number(String(qtyText).replace(",", ".")) || 1);
      return {
        code,
        brand,
        qty,
      };
    })
    .filter((row) => row.code);
}

function buildCustomerAddressBlock(customer: LocalCustomer | null, fallbackName: string) {
  if (!customer) return fallbackName || "-";
  const displayName = customer.company_name || customer.display_name || `${customer.first_name} ${customer.last_name}`.trim() || fallbackName || "-";
  return [displayName, customer.billing_address || "", customer.company_id ? `Company ID ${customer.company_id}` : "", customer.work_phone ? `Phone: ${customer.work_phone}` : "", customer.email || ""]
    .filter(Boolean)
    .join("\n");
}

function buildCustomerShippingBlock(customer: LocalCustomer | null, fallbackName: string) {
  if (!customer) return fallbackName || "-";
  const displayName = customer.company_name || customer.display_name || `${customer.first_name} ${customer.last_name}`.trim() || fallbackName || "-";
  return [displayName, customer.shipping_address || customer.billing_address || "", customer.company_id ? `Company ID ${customer.company_id}` : "", customer.mobile_phone ? `Phone: ${customer.mobile_phone}` : customer.work_phone ? `Phone: ${customer.work_phone}` : "", customer.email || ""]
    .filter(Boolean)
    .join("\n");
}

function getSelectedBrandValue(brandSelection: string, manualBrand: string) {
  if (brandSelection === "__manual__") return manualBrand.trim();
  return brandSelection.trim();
}

function inferBrandFromFilename(fileName: string, brands: Array<{ value: string; label: string }>) {
  const lower = fileName.trim().toLowerCase();
  if (!lower) return "";
  const matches = brands.filter((brand) => brand.value && lower.includes(brand.value.trim().toLowerCase()));
  return matches.length === 1 ? matches[0].value : "";
}

function buildPendingImportLine(row: QuoteImportRow): QuoteBuilderLine {
  return {
    lineId: nextLineId(),
    requestedCode: row.code,
    resolvedCode: row.code,
    brand: row.brand,
    description: "",
    qty: row.qty,
    oem_no: "",
    hs_code: "",
    origin: "",
    weight_kg: null,
    supplier_name: "",
    buy_price: null,
    sell_price: null,
    c_sell_price: null,
    price_date: "",
    notes: "Resolving prices...",
    found: false,
    codeChanged: false,
    codeChangeWarning: "",
    supplierOptions: [],
    selectedSupplierKey: "",
  };
}

function lineMetadataKey(brand: string, productCode: string) {
  return `${normalizeBrandKey(brand)}::${normalizePartCode(productCode)}`;
}

function applyCatalogMetadata(line: QuoteBuilderLine, metadataMap: Map<string, {
  product_code: string;
  description: string;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
}>) {
  const metadata = metadataMap.get(lineMetadataKey(line.brand || "", line.resolvedCode || line.requestedCode));
  if (!metadata) return line;
  return {
    ...line,
    brand: canonicalizeBrandName(line.brand || "") || line.brand,
    resolvedCode: metadata.product_code || line.resolvedCode,
    description: metadata.description || line.description,
    oem_no: metadata.oem_no || line.oem_no,
    hs_code: metadata.hs_code || line.hs_code,
    origin: metadata.origin || line.origin,
    weight_kg: metadata.weight_kg ?? line.weight_kg,
    lifecycle_status: metadata.lifecycle_status ?? line.lifecycle_status ?? "active",
    lifecycle_note: metadata.lifecycle_note ?? line.lifecycle_note ?? null,
    lifecycle_warning:
      metadata.lifecycle_status === "discontinued"
        ? `Production ended for ${metadata.product_code || line.resolvedCode || line.requestedCode}.${metadata.lifecycle_note ? ` ${metadata.lifecycle_note}` : ""}`
        : line.lifecycle_warning ?? null,
  };
}

function formatAvailabilityQty(value: number) {
  return Number.isInteger(value) ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function renderLifecycleBadge(row: Pick<QuoteBuilderLine, "lifecycle_status" | "lifecycle_warning">) {
  if (row.lifecycle_status !== "discontinued") return null;
  return (
    <div>
      <span className="mark-badge mark-badge--danger">Discontinued</span>
      {row.lifecycle_warning ? <div className="warning-text">{row.lifecycle_warning}</div> : null}
    </div>
  );
}

function findInventoryAvailability(
  lookup: Map<string, InventoryAvailabilitySummary>,
  brand: string,
  ...codes: Array<string | null | undefined>
) {
  for (const code of codes) {
    const normalized = normalizePartCode(code || "");
    if (!normalized) continue;
    const match = lookup.get(inventoryAvailabilityLookupKey(brand, normalized));
    if (match) return match;
  }
  return null;
}

function renderInventoryAvailabilityBadge(
  lookup: Map<string, InventoryAvailabilitySummary>,
  input: {
    brand: string;
    qty: number;
    resolvedCode?: string | null;
    requestedCode?: string | null;
  },
) {
  const availability = findInventoryAvailability(lookup, input.brand, input.resolvedCode, input.requestedCode);
  if (!availability || availability.available_qty <= 0) {
    return <span className="mark-badge mark-badge--danger">No Stock</span>;
  }
  if (availability.available_qty >= input.qty) {
    return (
      <span
        className="mark-badge mark-badge--success"
        title={`${formatAvailabilityQty(availability.available_qty)} available across ${availability.warehouse_count} warehouse(s)`}
      >
        Avail {formatAvailabilityQty(availability.available_qty)}
      </span>
    );
  }
  return (
    <span
      className="mark-badge mark-badge--accent"
      title={`${formatAvailabilityQty(availability.available_qty)} available across ${availability.warehouse_count} warehouse(s)`}
    >
      Short {formatAvailabilityQty(Math.max(0, input.qty - availability.available_qty))}
    </span>
  );
}

function mergeCatalogLineIntoSalesDraft(currentLines: QuoteBuilderLine[], nextLine: QuoteBuilderLine) {
  const nextKey = lineMetadataKey(nextLine.brand || "", nextLine.resolvedCode || nextLine.requestedCode);
  const existingIndex = currentLines.findIndex((line) => lineMetadataKey(line.brand || "", line.resolvedCode || line.requestedCode) === nextKey);
  if (existingIndex < 0) return [nextLine, ...currentLines];
  return currentLines.map((line, index) =>
    index !== existingIndex
      ? line
      : {
          ...line,
          qty: line.qty + nextLine.qty,
          description: line.description || nextLine.description,
          oem_no: line.oem_no || nextLine.oem_no,
          hs_code: line.hs_code || nextLine.hs_code,
          origin: line.origin || nextLine.origin,
          weight_kg: line.weight_kg ?? nextLine.weight_kg,
          lifecycle_status: nextLine.lifecycle_status ?? line.lifecycle_status,
          lifecycle_note: line.lifecycle_note ?? nextLine.lifecycle_note,
        },
  );
}

function getQuoteBuilderLineIssues(line: QuoteBuilderLine) {
  const issues: string[] = [];
  if (line.codeChanged) issues.push("Replacement");
  if (line.lifecycle_status === "discontinued") issues.push("Discontinued");
  if (!line.found) issues.push("Not matched");
  if (!line.description?.trim()) issues.push("Missing description");
  if ((line.sell_price ?? 0) <= 0) issues.push("Missing sell price");
  return issues;
}

function mapDetailLineToBuilderLine(
  line: QuoteDetail["lines"][number],
  currencyType: "A" | "B" | "C" | "Other",
  pricingMode: CustomerPricingMode,
  fallbackResolved?: {
    supplier_name?: string | null;
    buy_price?: number | null;
    sell_price?: number | null;
    price_date?: string | null;
    notes?: string | null;
  },
  supplierOptionsInput?: QuoteBuilderLine["supplierOptions"],
): QuoteBuilderLine {
  const buyPrice = line.buy_price ?? fallbackResolved?.buy_price ?? null;
  const baseSell = line.sell_price ?? fallbackResolved?.sell_price ?? null;
  const cSell = line.c_sell_price ?? null;
  const sellPrice = shouldUseCPriceForCustomer(currencyType, pricingMode) ? cSell ?? baseSell : baseSell;
  const supplierName = line.supplier_name || fallbackResolved?.supplier_name || "";
  const option =
    supplierOptionsInput?.[0] ||
    {
      supplier_name: supplierName || "Unassigned Supplier",
      buy_price: buyPrice,
      sell_price: sellPrice,
      price_date: line.price_date || fallbackResolved?.price_date || null,
      notes: line.notes || fallbackResolved?.notes || null,
    };
  const supplierOptions =
    supplierOptionsInput && supplierOptionsInput.length
      ? supplierOptionsInput
      : [
          {
            supplier_name: option.supplier_name || "Unassigned Supplier",
            buy_price: option.buy_price ?? buyPrice,
            sell_price: option.sell_price ?? sellPrice,
            price_date: option.price_date || line.price_date || fallbackResolved?.price_date || null,
            notes: option.notes || line.notes || fallbackResolved?.notes || null,
          },
        ];

  return {
    lineId: String(line.id || nextLineId()),
    requestedCode: line.old_code || line.product_code || "",
    resolvedCode: line.product_code || "",
    brand: line.brand_text || "",
    description: line.description || "",
    qty: Math.max(1, Number(line.qty || 1) || 1),
    oem_no: line.oem_no || "",
    hs_code: line.hs_code || "",
    origin: line.origin || "",
    weight_kg: line.weight_kg ?? null,
    supplier_name: supplierName,
    buy_price: buyPrice,
    sell_price: sellPrice,
    c_sell_price: cSell,
    price_date: line.price_date || fallbackResolved?.price_date || "",
    notes: line.notes || fallbackResolved?.notes || "",
    found: true,
    codeChanged: Boolean(
      String(line.old_code || "").trim() &&
        normalizePartCode(String(line.old_code || "")) !== normalizePartCode(String(line.product_code || ""))
    ),
    codeChangeWarning:
      String(line.old_code || "").trim() &&
      normalizePartCode(String(line.old_code || "")) !== normalizePartCode(String(line.product_code || ""))
        ? `Old Code ${String(line.old_code || "").trim()} => New Code ${String(line.product_code || "").trim()}.`
        : "",
    supplierOptions,
    selectedSupplierKey: `${option.supplier_name}-0`,
  };
}

function buildDraftQuoteHtml(input: {
  company: CompanyProfile;
  customer?: LocalCustomer | null;
  quoteNo: string;
  quoteDate: string;
  customerName: string;
  contractNr: string;
  currency: string;
  deliveryTerm: string;
  paymentTerms: string;
  notes: string;
  subtotal: number;
  discount: number;
  shipping: number;
  totalAmount: number;
  lines: QuoteBuilderLine[];
}) {
  const currency = input.currency || "EUR";
  const billingBlock = buildCustomerAddressBlock(input.customer || null, input.customerName);
  const shippingBlock = buildCustomerShippingBlock(input.customer || null, input.customerName);
  const showShipping = Boolean(input.customer?.shipping_address?.trim()) && shippingBlock !== billingBlock;
  const totalQty = input.lines.reduce((sum, line) => sum + line.qty, 0);
  const totalWeight = roundMoney(input.lines.reduce((sum, line) => sum + (Number(line.weight_kg ?? 0) || 0) * line.qty, 0));
  return buildBusinessDocumentHtml({
    docType: "Sales Order",
    docNo: input.quoteNo || "-",
    company: {
      companyName: input.company.companyName || "",
      address: input.company.address || "",
      bankDetails: input.company.bankDetails || "",
      taxNumber: input.company.taxNumber || "",
      logoDataUrl: input.company.logoDataUrl || "",
    },
    party: {
      title: "Bill To",
      details: billingBlock,
      shippingTitle: showShipping ? "Shipping Address" : undefined,
      shippingDetails: showShipping ? shippingBlock : undefined,
    },
    meta: [
      { label: "Sales Order Date", value: input.quoteDate || "-" },
      { label: "Terms", value: input.paymentTerms || "-" },
      { label: "Delivery Term", value: input.deliveryTerm || "-" },
      { label: "Contract Nr", value: input.contractNr || "-" },
    ],
    lines: input.lines.map((line) => {
      const sellUnit = toNumber(line.sell_price);
      const total = roundMoney(sellUnit * line.qty);
      return {
        code: line.resolvedCode,
        oldCode: line.codeChanged ? line.requestedCode : "",
        description: line.description || "",
        origin: line.origin || "",
        brand: line.brand || "",
        orderNo: input.quoteNo || "-",
        weight: line.weight_kg == null ? "" : String(line.weight_kg),
        gtip: line.hs_code || "",
        alerts: buildSalesOrderPrintAlerts(line),
        qty: line.qty,
        unitPrice: sellUnit,
        amount: total,
      };
    }),
    totals: {
      currency,
      subtotal: input.subtotal,
      discount: input.discount,
      shipping: input.shipping,
      total: input.totalAmount,
    },
    notes: input.notes,
    totalQty,
    totalWeight,
  });
}

export function QuotesPage({
  selectedSalesOrderId: externalSelectedSalesOrderId = "",
  onSelectedSalesOrderChange,
  selectedQuoteId: externalSelectedQuoteId = "",
  onSelectedQuoteChange,
  salesOrdersNavTick = 0,
}: QuotesPageProps) {
  const actionFeedback = useActionFeedback();
  const initialWorkspaceCache = typeof window === "undefined" ? null : readSalesOrderWorkspaceCache();
  const importRef = useRef<HTMLInputElement | null>(null);
  const workspaceCacheWriteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceCacheSnapshotRef = useRef<PersistedSalesOrderWorkspace | null>(initialWorkspaceCache);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [salesOrdersView, setSalesOrdersView] = useState<"list" | "detail">(
    externalSelectedQuoteId || externalSelectedSalesOrderId ? "detail" : initialWorkspaceCache?.salesOrdersView || "list",
  );
  const [salesOrderFilter, setSalesOrderFilter] = useState<"all" | "draft" | "confirmed" | "purchased" | "invoiced">(initialWorkspaceCache?.salesOrderFilter || "all");
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [localSalesOrders, setLocalSalesOrders] = useState<LocalSalesOrder[]>([]);
  const [savedPurchaseOrders, setSavedPurchaseOrders] = useState<PurchaseOrderSalesLinkSummary[]>([]);
  const [savedInvoices, setSavedInvoices] = useState<InvoiceSalesLinkSummary[]>([]);
  const [selectedLocalSalesOrderId, setSelectedLocalSalesOrderId] = useState(initialWorkspaceCache?.selectedLocalSalesOrderId || "");
  const [selectedLocalSalesOrderIds, setSelectedLocalSalesOrderIds] = useState<string[]>([]);
  const [salesOrderActionsOpen, setSalesOrderActionsOpen] = useState(false);
  const [workbenchMode, setWorkbenchMode] = useState<"existing" | "new">(initialWorkspaceCache?.workbenchMode || "existing");
  const [salesOrderSourceSnapshot, setSalesOrderSourceSnapshot] = useState(initialWorkspaceCache?.salesOrderSourceSnapshot || "");
  const [selectedQuoteId, setSelectedQuoteId] = useState(externalSelectedQuoteId || initialWorkspaceCache?.selectedQuoteId || "");
  const [detail, setDetail] = useState<QuoteDetail>({ quote: null, lines: [] });
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [searchingQuotes, setSearchingQuotes] = useState(false);
  const [pdfView, setPdfView] = useState(false);
  const [quoteLinePreview, setQuoteLinePreview] = useState<QuoteBuilderLine | null>(null);

  const [quoteCode, setQuoteCode] = useState("");
  const [quoteBrand, setQuoteBrand] = useState(initialWorkspaceCache?.quoteBrand || "");
  const [quoteBrandSelection, setQuoteBrandSelection] = useState(initialWorkspaceCache?.quoteBrandSelection || "");
  const [quoteQty, setQuoteQty] = useState(initialWorkspaceCache?.quoteQty || "1");
  const [brandOptions, setBrandOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [customerType, setCustomerType] = useState<"A" | "B" | "C" | "Other">(initialWorkspaceCache?.customerType || "A");
  const [marginA, setMarginA] = useState(10);
  const [marginB, setMarginB] = useState(15);
  const [quoteBuilderLines, setQuoteBuilderLines] = useState<QuoteBuilderLine[]>(initialWorkspaceCache?.quoteBuilderLines || []);
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [builderStatus, setBuilderStatus] = useState(initialWorkspaceCache?.builderStatus || "");
  const [resolvingLine, setResolvingLine] = useState(false);
  const [importingLines, setImportingLines] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [printingDraft, setPrintingDraft] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [confirmingOrder, setConfirmingOrder] = useState(false);
  const [resyncingCatalog, setResyncingCatalog] = useState(false);
  const [resyncOnlyFillBlanks, setResyncOnlyFillBlanks] = useState(true);
  const [resyncKeepPrices, setResyncKeepPrices] = useState(true);
  const [invoicePromptOpen, setInvoicePromptOpen] = useState(false);
  const [pendingConfirmedOrder, setPendingConfirmedOrder] = useState<LocalSalesOrder | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [inventoryAvailabilityRows, setInventoryAvailabilityRows] = useState<InventoryAvailabilitySummary[]>([]);
  const pendingCatalogSalesHandledRef = useRef(false);

  const [quoteNo, setQuoteNo] = useState(initialWorkspaceCache?.quoteNo || "");
  const [customerName, setCustomerName] = useState(initialWorkspaceCache?.customerName || "");
  const [customerSelection, setCustomerSelection] = useState(initialWorkspaceCache?.customerSelection || "");
  const [manualCustomerName, setManualCustomerName] = useState(initialWorkspaceCache?.manualCustomerName || "");
  const [sellerCompany, setSellerCompany] = useState(initialWorkspaceCache?.sellerCompany || "");
  const [quoteDate, setQuoteDate] = useState(initialWorkspaceCache?.quoteDate || new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState(initialWorkspaceCache?.currency || "EUR");
  const [shippingCost, setShippingCost] = useState(initialWorkspaceCache?.shippingCost || "0");
  const [discountAmount, setDiscountAmount] = useState(initialWorkspaceCache?.discountAmount || "0");
  const [supplierMode, setSupplierMode] = useState(initialWorkspaceCache?.supplierMode || "Best price");
  const [sellerInfo, setSellerInfo] = useState(initialWorkspaceCache?.sellerInfo || "");
  const [buyerInfo, setBuyerInfo] = useState(initialWorkspaceCache?.buyerInfo || "");
  const [deliveryTermSelection, setDeliveryTermSelection] = useState(initialWorkspaceCache?.deliveryTermSelection || "");
  const [paymentTermsSelection, setPaymentTermsSelection] = useState(initialWorkspaceCache?.paymentTermsSelection || "");
  const [deliveryTerm, setDeliveryTerm] = useState(initialWorkspaceCache?.deliveryTerm || "");
  const [paymentTerms, setPaymentTerms] = useState(initialWorkspaceCache?.paymentTerms || "");
  const [packingDetails, setPackingDetails] = useState(initialWorkspaceCache?.packingDetails || "");
  const [quoteNotes, setQuoteNotes] = useState(initialWorkspaceCache?.quoteNotes || "");

  const selectedCustomerProfile = useMemo(() => {
    const customerLabel = customerSelection === "__manual__" ? manualCustomerName : customerSelection;
    return customerLabel ? findCustomerByNameInList(customers, customerLabel) : null;
  }, [customers, customerSelection, manualCustomerName]);
  const resolvedCustomerName = useMemo(() => {
    if (customerSelection === "__manual__") return manualCustomerName.trim();
    return (
      String(selectedCustomerProfile?.display_name || "").trim() ||
      String(selectedCustomerProfile?.company_name || "").trim() ||
      customerSelection.trim() ||
      customerName.trim()
    );
  }, [customerName, customerSelection, manualCustomerName, selectedCustomerProfile]);
  const customerPricingMode: CustomerPricingMode = selectedCustomerProfile?.portal_c_price_mode || "standard";
  const shouldUseCPricePricing = shouldUseCPriceForCustomer(customerType, customerPricingMode);

  const customerMarginOverride = selectedCustomerProfile?.price_list_margin_percent ?? null;
  const effectiveMarginA =
    (customerType === "A" || customerType === "Other") && customerMarginOverride != null ? customerMarginOverride : marginA;
  const effectiveMarginB = customerType === "B" && customerMarginOverride != null ? customerMarginOverride : marginB;
  const otherMarginActive = customerType === "Other" && customerMarginOverride != null;
  const inventoryAvailabilityLookup = useMemo(() => buildInventoryAvailabilityLookup(inventoryAvailabilityRows), [inventoryAvailabilityRows]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const salesOrderRows = await fetchSalesOrderSummaries();
        if (!cancelled) setLocalSalesOrders(salesOrderRows);
      } catch {
        if (!cancelled) setLocalSalesOrders([]);
      }

      try {
        const [purchaseOrderRows, invoiceRows] = await Promise.all([
          fetchPurchaseOrderSalesLinkSummaries(),
          fetchInvoiceSalesLinkSummaries(),
        ]);
        if (!cancelled) {
          setSavedPurchaseOrders(purchaseOrderRows);
          setSavedInvoices(invoiceRows);
        }
      } catch {
        if (!cancelled) {
          setSavedPurchaseOrders([]);
          setSavedInvoices([]);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const rows = await fetchInventoryAvailabilitySummary();
        if (!cancelled) setInventoryAvailabilityRows(rows);
      } catch {
        if (!cancelled) setInventoryAvailabilityRows([]);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    salesOrdersView,
    salesOrderFilter,
    workbenchMode,
    selectedLocalSalesOrderId,
    selectedQuoteId,
    salesOrderSourceSnapshot,
    builderStatus,
    quoteNo,
    customerName,
    customerSelection,
    manualCustomerName,
    sellerCompany,
    quoteDate,
    currency,
    quoteBrand,
    quoteBrandSelection,
    quoteQty,
    customerType,
    shippingCost,
    discountAmount,
    supplierMode,
    sellerInfo,
    buyerInfo,
    deliveryTermSelection,
    paymentTermsSelection,
    deliveryTerm,
    paymentTerms,
    packingDetails,
    quoteNotes,
    quoteBuilderLines,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [customerRows, companyRows] = await Promise.all([fetchCustomers(), fetchCompanyProfiles()]);
        if (cancelled) return;
        setCustomers(customerRows);
        setCompanyProfiles(companyRows);
        if (companyRows[0]?.companyName) {
          setSellerCompany((current) => current || companyRows[0].companyName);
        }
      } catch {
        if (!cancelled) {
          setCustomers([]);
          setCompanyProfiles([]);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sellerCompany && companyProfiles[0]?.companyName) {
      setSellerCompany(companyProfiles[0].companyName);
    }
  }, [companyProfiles, sellerCompany]);

  useEffect(() => {
    if (pendingCatalogSalesHandledRef.current) return;
    const pending = consumeCatalogTransfer(PENDING_CATALOG_SALES_ITEM_KEY);
    if (!pending) return;
    pendingCatalogSalesHandledRef.current = true;
    const pendingItem = pending;

    let cancelled = false;

    async function run() {
      if (!quoteBuilderLines.length) {
        resetSalesOrderEditor();
        setSelectedLocalSalesOrderId("");
        onSelectedSalesOrderChange?.("");
      }
      setSalesOrdersView("detail");
      setPdfView(false);
      setBuilderStatus(`Adding ${pendingItem.product_code} from catalog...`);
      try {
        const line = await buildBuilderLine(
          {
            code: pendingItem.requested_code || pendingItem.product_code,
            brand: pendingItem.brand,
            qty: 1,
          },
          { includeSupplierOptions: true },
        );
        if (cancelled) return;
        const enrichedLine: QuoteBuilderLine = {
          ...line,
          description: pendingItem.description || line.description,
          oem_no: pendingItem.oem_no || line.oem_no,
          hs_code: pendingItem.hs_code || line.hs_code,
          origin: pendingItem.origin || line.origin,
          weight_kg: pendingItem.weight_kg ?? line.weight_kg,
          lifecycle_status: (pendingItem.lifecycle_status as QuoteBuilderLine["lifecycle_status"]) ?? line.lifecycle_status,
          lifecycle_note: pendingItem.lifecycle_note ?? line.lifecycle_note,
          codeChangeWarning: line.codeChangeWarning || pendingItem.replacement_warning || "",
        };
        setQuoteBuilderLines((current) => mergeCatalogLineIntoSalesDraft(current, enrichedLine));
        setBuilderStatus(`${pendingItem.product_code} added from catalog.`);
        actionFeedback.succeed(`${pendingItem.product_code} added to Sales Order Workbench.`);
      } catch (caught) {
        if (cancelled) return;
        setBuilderStatus(`Failed to add ${pendingItem.product_code} from catalog.`);
        actionFeedback.fail(caught instanceof Error ? caught.message : "Catalog item add failed");
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, companyProfiles, onSelectedSalesOrderChange, quoteBuilderLines.length]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const rows = await fetchCloudBrands();
        if (cancelled) return;
        setBrandOptions(rows.map((item) => ({ value: item.name, label: item.name })));
      } catch {
        if (!cancelled) setBrandOptions([]);
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
        if (typeof a?.marginPercent === "number") setMarginA(a.marginPercent);
        if (typeof b?.marginPercent === "number") setMarginB(b.marginPercent);
      } catch {
        if (!cancelled) {
          setMarginA(10);
          setMarginB(15);
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
      setLoadingQuotes(true);
      setError("");
      try {
        const result = await fetchCloudQuotes(submittedSearch);
        if (cancelled) return;
        setQuotes(result);
        setSelectedQuoteId((current) => {
          if (externalSelectedQuoteId && result.some((quote) => quote.quote_id === externalSelectedQuoteId)) {
            return externalSelectedQuoteId;
          }
          if (current && result.some((quote) => quote.quote_id === current)) {
            return current;
          }
          return result[0]?.quote_id || "";
        });
      } catch (caught) {
        if (!cancelled) {
          setQuotes([]);
          setError(caught instanceof Error ? caught.message : "Quotes request failed");
        }
      } finally {
        if (!cancelled) setLoadingQuotes(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [externalSelectedQuoteId, submittedSearch]);

  useEffect(() => {
    if (!searchingQuotes || loadingQuotes) return;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(`${quotes.length.toLocaleString("en-US")} sales orders loaded.`);
    }
    setSearchingQuotes(false);
  }, [searchingQuotes, loadingQuotes, error, quotes.length, actionFeedback]);

  useEffect(() => {
    if (externalSelectedQuoteId) {
      setSelectedQuoteId(externalSelectedQuoteId);
      setSalesOrdersView("detail");
    }
  }, [externalSelectedQuoteId]);

  useEffect(() => {
    if (!externalSelectedSalesOrderId) return;
    if (selectedLocalSalesOrderId === externalSelectedSalesOrderId && salesOrdersView === "detail") return;
    const target = localSalesOrders.find((item) => item.id === externalSelectedSalesOrderId);
    if (!target) return;
    setSalesOrdersView("detail");
    void loadLocalSalesOrderIntoEditor(target);
  }, [externalSelectedSalesOrderId, localSalesOrders, selectedLocalSalesOrderId, salesOrdersView]);

  useEffect(() => {
    setSelectedLocalSalesOrderIds((current) => current.filter((orderId) => localSalesOrders.some((order) => order.id === orderId)));
  }, [localSalesOrders]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!selectedQuoteId) {
        setDetail({ quote: null, lines: [] });
        return;
      }
      setLoadingDetail(true);
      setError("");
      try {
        const result = await fetchCloudQuoteDetail(selectedQuoteId);
        const baseLines = result.lines || [];
        const cPriceMap = await fetchCPriceMapForRows(
          baseLines.map((line) => ({
            brand: line.brand_text || "",
            product_code: line.product_code || "",
          })),
        );
        const resolvedPatches = await Promise.all(
          baseLines.map(async (line) => {
            if (!line.product_code) return null;
            try {
              const { resolved, supplierOptions } = await resolveQuoteLine({
                code: line.product_code,
                brand: line.brand_text || "",
                customerType,
                marginA: effectiveMarginA,
                marginB: effectiveMarginB,
              });
              return {
                description: resolved.description,
                oem_no: resolved.oem_no,
                hs_code: resolved.hs_code,
                origin: resolved.origin,
                weight_kg: resolved.weight_kg,
                supplier_name: resolved.supplier_name,
                buy_price: resolved.buy_price,
                sell_price: resolved.sell_price,
                price_date: resolved.price_date,
                notes: resolved.notes,
                supplierOptions,
              };
            } catch {
              return null;
            }
          }),
        );
        const enrichedLines = baseLines.map((line, index) => ({
          ...line,
          description: resolvedPatches[index]?.description || line.description,
          oem_no: resolvedPatches[index]?.oem_no || line.oem_no,
          hs_code: resolvedPatches[index]?.hs_code || line.hs_code,
          origin: resolvedPatches[index]?.origin || line.origin,
          weight_kg: resolvedPatches[index]?.weight_kg ?? line.weight_kg,
          supplier_name: line.supplier_name || resolvedPatches[index]?.supplier_name || line.supplier_name,
          buy_price: line.buy_price ?? resolvedPatches[index]?.buy_price ?? null,
          sell_price: line.sell_price ?? resolvedPatches[index]?.sell_price ?? null,
          c_sell_price: getCPriceForRow(cPriceMap, {
            brand: line.brand_text || "",
            product_code: line.product_code || "",
          }),
        }));
        if (!cancelled) {
          setDetail({
            quote: result.quote,
            lines: enrichedLines,
          });
          const quoteMeta = (result.quote || {}) as Record<string, unknown>;
          setWorkbenchMode("existing");
          setQuoteNo(String(quoteMeta.quote_no || ""));
          const nextCustomer = String(quoteMeta.customer_name || "");
          setCustomerName(nextCustomer);
          setCustomerSelection(nextCustomer || "");
          setManualCustomerName("");
          setQuoteDate(String(quoteMeta.quote_date || "").slice(0, 10) || new Date().toISOString().slice(0, 10));
          setCurrency(String(quoteMeta.currency || "EUR"));
          setQuoteBuilderLines(
            enrichedLines.map((line, index) =>
              mapDetailLineToBuilderLine(
                line,
                customerType,
                customerPricingMode,
                resolvedPatches[index] || undefined,
                resolvedPatches[index]?.supplierOptions,
              ),
            ),
          );
          setBuilderStatus(`${enrichedLines.length.toLocaleString("en-US")} lines loaded into Sales Order Workbench.`);
        }
      } catch (caught) {
        if (!cancelled) {
          setDetail({ quote: null, lines: [] });
          setError(caught instanceof Error ? caught.message : "Quote detail request failed");
        }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [selectedQuoteId, customerType, customerPricingMode, effectiveMarginA, effectiveMarginB]);

  const draftTotals = useMemo(() => {
    const purchase = roundMoney(quoteBuilderLines.reduce((sum, line) => sum + toNumber(line.buy_price) * line.qty, 0));
    const subtotal = roundMoney(quoteBuilderLines.reduce((sum, line) => sum + toNumber(line.sell_price) * line.qty, 0));
    const shipping = roundMoney(Number(String(shippingCost || "0").replace(",", ".")) || 0);
    const discount = roundMoney(Number(String(discountAmount || "0").replace(",", ".")) || 0);
    const totalAmount = roundMoney(subtotal - discount + shipping);
    const profit = roundMoney(totalAmount - purchase);
    const margin = totalAmount > 0 ? roundMoney((profit / totalAmount) * 100) : 0;
    return { purchase, subtotal, shipping, discount, totalAmount, profit, margin };
  }, [quoteBuilderLines, shippingCost, discountAmount]);
  const discontinuedLineCount = useMemo(
    () => quoteBuilderLines.filter((line) => line.lifecycle_status === "discontinued").length,
    [quoteBuilderLines],
  );
  const effectiveWorkbenchColumnVisibility = DEFAULT_QUOTE_WORKBENCH_COLUMNS;

  useEffect(() => {
    setQuoteBuilderLines((current) =>
      current.map((line) => {
        const selected =
          line.supplierOptions.find((option, index) => `${option.supplier_name}-${index}` === line.selectedSupplierKey) ||
          line.supplierOptions[0] ||
          null;
        const buyPrice = selected?.buy_price ?? line.buy_price;
        if (buyPrice == null) return line;
        if (shouldUseCPricePricing) {
          const marginPercent = customerType === "B" ? effectiveMarginB : effectiveMarginA;
          const fallbackSellPrice =
            customerType === "C"
              ? line.sell_price
              : roundMoney(Number(buyPrice) * (1 + marginPercent / 100));
          return {
            ...line,
            supplier_name: line.supplier_name || selected?.supplier_name || "",
            buy_price: buyPrice,
            sell_price: line.c_sell_price ?? fallbackSellPrice,
            price_date: line.price_date || selected?.price_date || "",
            notes: line.notes || selected?.notes || "",
          };
        }

        const marginPercent = customerType === "B" ? effectiveMarginB : effectiveMarginA;
        return {
          ...line,
          supplier_name: line.supplier_name || selected?.supplier_name || "",
          buy_price: buyPrice,
          sell_price: roundMoney(Number(buyPrice) * (1 + marginPercent / 100)),
          price_date: line.price_date || selected?.price_date || "",
          notes: line.notes || selected?.notes || "",
        };
      }),
    );
  }, [customerType, customerPricingMode, shouldUseCPricePricing, effectiveMarginA, effectiveMarginB]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!shouldUseCPricePricing || !quoteBuilderLines.length) return;

      const cPriceMap = await fetchCPriceMapForRows(
        quoteBuilderLines.map((line) => ({
          brand: line.brand,
          product_code: line.resolvedCode || line.requestedCode,
        })),
      );

      if (cancelled) return;

      setQuoteBuilderLines((current) =>
        current.map((line) => {
          const cSellPrice = getCPriceForRow(cPriceMap, {
            brand: line.brand,
            product_code: line.resolvedCode || line.requestedCode,
          });
          const marginPercent = customerType === "B" ? effectiveMarginB : effectiveMarginA;
          const fallbackSellPrice =
            customerType === "C"
              ? line.sell_price
              : line.buy_price != null
                ? roundMoney(Number(line.buy_price) * (1 + marginPercent / 100))
                : line.sell_price;
          return {
            ...line,
            c_sell_price: cSellPrice,
            sell_price: cSellPrice ?? fallbackSellPrice,
          };
        }),
      );
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    customerType,
    customerPricingMode,
    effectiveMarginA,
    effectiveMarginB,
    shouldUseCPricePricing,
    quoteBuilderLines.length,
    quoteBuilderLines.map((line) => `${line.brand}|${line.resolvedCode || line.requestedCode}`).join("||"),
  ]);

  const currentLocalSalesOrder = useMemo(
    () => localSalesOrders.find((item) => item.id === selectedLocalSalesOrderId) || null,
    [localSalesOrders, selectedLocalSalesOrderId],
  );
  const currentDraftDisplayLabel = quoteNo || currentLocalSalesOrder?.sales_order_no || "sales order";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const snapshot: PersistedSalesOrderWorkspace = {
      salesOrdersView,
      salesOrderFilter,
      workbenchMode,
      selectedLocalSalesOrderId,
      selectedQuoteId,
      salesOrderSourceSnapshot,
      builderStatus,
      quoteNo,
      customerName,
      customerSelection,
      manualCustomerName,
      sellerCompany,
      quoteDate,
      currency,
      quoteBrand,
      quoteBrandSelection,
      quoteQty,
      customerType,
      shippingCost,
      discountAmount,
      supplierMode,
      sellerInfo,
      buyerInfo,
      deliveryTermSelection,
      paymentTermsSelection,
      deliveryTerm,
      paymentTerms,
      packingDetails,
      quoteNotes,
      quoteBuilderLines,
      updatedAt: new Date().toISOString(),
    };
    workspaceCacheSnapshotRef.current = snapshot;

    if (workspaceCacheWriteTimeoutRef.current) {
      window.clearTimeout(workspaceCacheWriteTimeoutRef.current);
    }
    workspaceCacheWriteTimeoutRef.current = window.setTimeout(() => {
      writeSalesOrderWorkspaceCache(snapshot);
      workspaceCacheWriteTimeoutRef.current = null;
    }, SALES_ORDER_WORKSPACE_CACHE_WRITE_DELAY_MS);

    return () => {
      if (workspaceCacheWriteTimeoutRef.current) {
        window.clearTimeout(workspaceCacheWriteTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const flushWorkspaceCache = () => {
      writeSalesOrderWorkspaceCache(workspaceCacheSnapshotRef.current);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushWorkspaceCache();
    };

    window.addEventListener("beforeunload", flushWorkspaceCache);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      flushWorkspaceCache();
      window.removeEventListener("beforeunload", flushWorkspaceCache);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  function getAdminCustomerLabel(value: string) {
    const customer = findCustomerByNameInList(customers, value);
    return customer?.display_name?.trim() || customer?.company_name?.trim() || buildEntityAlias(value);
  }

  const customerOptions = useMemo(() => {
    const names = new Set<string>();
    customers.forEach((customer) => {
      if (customer.display_name) names.add(customer.display_name);
      else if (customer.company_name) names.add(customer.company_name);
    });
    quotes.forEach((quote) => {
      if (quote.customer_name) names.add(String(quote.customer_name));
    });
    localSalesOrders.forEach((order) => {
      if (order.customer_name) names.add(order.customer_name);
    });
    if (customerName.trim()) names.add(customerName.trim());
    return [
      { value: "", label: "Select customer" },
      ...Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ value: name, label: name })),
      { value: "__manual__", label: "Manual entry..." },
    ];
  }, [customers, quotes, localSalesOrders, customerName]);

  const customerContractMap = useMemo(() => {
    const map = new Map<string, string>();
    customers.forEach((customer) => {
      const key = (customer.display_name || customer.company_name || "").trim().toLowerCase();
      if (key && customer.contract_nr?.trim()) {
        map.set(key, customer.contract_nr.trim());
      }
    });
    localSalesOrders
      .filter((order) => order.customer_name?.trim())
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .forEach((order) => {
        const key = order.customer_name.trim().toLowerCase();
        if (!map.has(key) && order.seller_info?.trim()) {
          map.set(key, order.seller_info.trim());
        }
      });
    return map;
  }, [customers, localSalesOrders]);

  const companyOptions = useMemo(() => {
    const rows = companyProfiles.map((item) => ({ value: item.companyName, label: item.companyName }));
    return rows.length ? rows : [{ value: "", label: "No company profile saved yet" }];
  }, [companyProfiles]);

  const inferredContextBrand = useMemo(() => {
    const brands = new Set<string>();
    quoteBuilderLines.forEach((line) => {
      if (line.brand?.trim()) brands.add(line.brand.trim());
    });
    detail.lines.forEach((line) => {
      if (line.brand_text?.trim()) brands.add(line.brand_text.trim());
    });
    if (brands.size === 1) return [...brands][0];
    return "";
  }, [detail.lines, quoteBuilderLines]);

  async function hydrateStoredBuilderLine(
    line: QuoteBuilderLine,
    orderCustomerType: "A" | "B" | "C" | "Other",
    orderPricingMode: CustomerPricingMode,
  ) {
    const selectedFromOptions =
      line.supplierOptions.find((option, index) => `${option.supplier_name}-${index}` === line.selectedSupplierKey) || line.supplierOptions[0] || null;

    const hasVisiblePrices = Number(line.buy_price ?? 0) > 0 || Number(line.sell_price ?? 0) > 0;
    const optionHasPrices = selectedFromOptions ? Number(selectedFromOptions.buy_price ?? 0) > 0 || Number(selectedFromOptions.sell_price ?? 0) > 0 : false;

    if (hasVisiblePrices || optionHasPrices) {
      try {
        const { resolved } = await resolveQuoteLine({
          code: line.resolvedCode || line.requestedCode,
          brand: line.brand || "",
          customerType: orderCustomerType,
          marginA: effectiveMarginA,
          marginB: effectiveMarginB,
          includeSupplierOptions: false,
        });

        const buyPrice = hasVisiblePrices ? line.buy_price : selectedFromOptions?.buy_price ?? null;
        const sellBase = hasVisiblePrices ? line.sell_price : selectedFromOptions?.sell_price ?? null;
        return {
          ...line,
          resolvedCode: resolved.product_code || line.resolvedCode,
          description: resolved.description || line.description,
          oem_no: resolved.oem_no || line.oem_no,
          hs_code: resolved.hs_code || line.hs_code,
          origin: resolved.origin || line.origin,
          weight_kg: resolved.weight_kg ?? line.weight_kg,
          supplier_name: line.supplier_name || selectedFromOptions?.supplier_name || "",
          buy_price: buyPrice,
          sell_price: shouldUseCPriceForCustomer(orderCustomerType, orderPricingMode) ? line.c_sell_price ?? sellBase : sellBase,
          price_date: line.price_date || selectedFromOptions?.price_date || "",
          notes: line.notes || selectedFromOptions?.notes || "",
          lifecycle_status: resolved.lifecycle_status ?? line.lifecycle_status ?? "active",
          lifecycle_note: resolved.lifecycle_note ?? line.lifecycle_note ?? null,
          lifecycle_warning: resolved.lifecycle_warning ?? line.lifecycle_warning ?? null,
        };
      } catch {
        const buyPrice = hasVisiblePrices ? line.buy_price : selectedFromOptions?.buy_price ?? null;
        const sellBase = hasVisiblePrices ? line.sell_price : selectedFromOptions?.sell_price ?? null;
        return {
          ...line,
          supplier_name: line.supplier_name || selectedFromOptions?.supplier_name || "",
          buy_price: buyPrice,
          sell_price: shouldUseCPriceForCustomer(orderCustomerType, orderPricingMode) ? line.c_sell_price ?? sellBase : sellBase,
          price_date: line.price_date || selectedFromOptions?.price_date || "",
          notes: line.notes || selectedFromOptions?.notes || "",
          lifecycle_status: line.lifecycle_status ?? "active",
          lifecycle_note: line.lifecycle_note ?? null,
          lifecycle_warning: line.lifecycle_warning ?? null,
        };
      }
    }

    try {
      const { resolved, supplierOptions } = await resolveQuoteLine({
        code: line.resolvedCode || line.requestedCode,
        brand: line.brand || "",
        customerType: orderCustomerType,
        marginA: effectiveMarginA,
        marginB: effectiveMarginB,
      });

      const cPriceMap = await fetchCPriceMapForRows([
        {
          brand: line.brand || "",
          product_code: line.resolvedCode || line.requestedCode,
        },
      ]);

      const cSellPrice = getCPriceForRow(cPriceMap, {
        brand: line.brand || "",
        product_code: line.resolvedCode || line.requestedCode,
      });

      const selectedKey = supplierOptions[0] ? `${supplierOptions[0].supplier_name}-0` : line.selectedSupplierKey;

      return {
        ...line,
        resolvedCode: resolved.product_code || line.resolvedCode,
        description: resolved.description || line.description,
        oem_no: resolved.oem_no || line.oem_no,
        hs_code: resolved.hs_code || line.hs_code,
        origin: resolved.origin || line.origin,
        weight_kg: resolved.weight_kg ?? line.weight_kg,
        supplier_name: resolved.supplier_name || supplierOptions[0]?.supplier_name || line.supplier_name,
        buy_price: resolved.buy_price ?? supplierOptions[0]?.buy_price ?? line.buy_price,
        sell_price: shouldUseCPriceForCustomer(orderCustomerType, orderPricingMode)
          ? cSellPrice ?? resolved.sell_price ?? supplierOptions[0]?.sell_price ?? line.sell_price
          : resolved.sell_price ?? supplierOptions[0]?.sell_price ?? line.sell_price,
        c_sell_price: cSellPrice ?? line.c_sell_price,
        price_date: resolved.price_date || supplierOptions[0]?.price_date || line.price_date,
        notes: resolved.notes || supplierOptions[0]?.notes || line.notes,
        lifecycle_status: resolved.lifecycle_status ?? line.lifecycle_status ?? "active",
        lifecycle_note: resolved.lifecycle_note ?? line.lifecycle_note ?? null,
        lifecycle_warning: resolved.lifecycle_warning ?? line.lifecycle_warning ?? null,
        supplierOptions: supplierOptions.length ? supplierOptions : line.supplierOptions,
        selectedSupplierKey: selectedKey,
      };
    } catch {
      return line;
    }
  }

  async function loadLocalSalesOrderIntoEditor(order: LocalSalesOrder) {
    const detailOrder = order.lines.length ? order : await fetchSalesOrderById(order.id);
    setWorkbenchMode("existing");
    setSalesOrderSourceSnapshot(serializeSalesOrderForDirtyCheck(detailOrder));
    setSelectedLocalSalesOrderId(detailOrder.id);
    setSelectedQuoteId("");
    onSelectedQuoteChange?.("");
    setQuoteNo(detailOrder.sales_order_no);
    setCustomerName(detailOrder.customer_name);
    setCustomerSelection(detailOrder.customer_name || "");
    setManualCustomerName("");
    setSellerCompany(detailOrder.seller_company || "");
    setQuoteDate(detailOrder.quote_date);
    setCurrency(detailOrder.currency || "EUR");
    setQuoteBrand("");
    setQuoteBrandSelection("");
    setCustomerType(detailOrder.customer_type);
    setShippingCost(String(detailOrder.shipping_cost ?? 0));
    setDiscountAmount(String(detailOrder.discount_amount ?? 0));
    setSupplierMode(detailOrder.supplier_mode || "Best price");
    setSellerInfo(detailOrder.seller_info || "");
    setBuyerInfo(detailOrder.buyer_info || detailOrder.purchase_company || "");
    setDeliveryTermSelection(toTermSelection(detailOrder.delivery_term || "", DELIVERY_TERM_OPTIONS));
    setPaymentTermsSelection(toTermSelection(detailOrder.payment_terms || "", PAYMENT_TERM_OPTIONS));
    setDeliveryTerm(detailOrder.delivery_term || "");
    setPaymentTerms(detailOrder.payment_terms || "");
    setPackingDetails(detailOrder.packing_details || "");
    setQuoteNotes(detailOrder.notes || "");
    actionFeedback.begin(`Loading ${detailOrder.sales_order_no}...`);
    const clonedLines = (detailOrder.lines || []).map((line) => ({ ...line }));
    if (detailOrder.source_channel === "portal" && detailOrder.portal_submitted_at && !detailOrder.portal_seen_at) {
      try {
        const seenOrder = await markSalesOrderPortalSeen(detailOrder.id);
        if (seenOrder) {
          setLocalSalesOrders((current) => current.map((item) => (item.id === seenOrder.id ? seenOrder : item)));
        }
      } catch {
        // opening order should continue even if seen state update fails
      }
    }
    setQuoteBuilderLines(clonedLines);
    setBuilderStatus(`Loaded ${detailOrder.sales_order_no} (${detailOrder.status}).`);
    onSelectedSalesOrderChange?.(detailOrder.id);
    actionFeedback.succeed(`${detailOrder.sales_order_no} loaded.`);
  }

  useEffect(() => {
    if (!salesOrdersNavTick) return;
    if (externalSelectedSalesOrderId || externalSelectedQuoteId) return;
    setSalesOrdersView("list");
    setPdfView(false);
  }, [salesOrdersNavTick, externalSelectedSalesOrderId, externalSelectedQuoteId]);

  async function handleResyncFromCatalog() {
    if (!quoteBuilderLines.length) {
      actionFeedback.fail("No sales order lines to re-sync.");
      return;
    }
    try {
      setResyncingCatalog(true);
      actionFeedback.begin(`Re-syncing ${quoteNo || "sales order"} from catalog...`);
      const syncedLines = await resyncSalesOrderLinesFromCatalog(quoteBuilderLines, {
        customerType,
        customerPricingMode,
        marginA: effectiveMarginA,
        marginB: effectiveMarginB,
        onlyFillBlanks: resyncOnlyFillBlanks,
        keepPrices: resyncKeepPrices,
      });
      setQuoteBuilderLines(syncedLines);

      if (selectedLocalSalesOrderId) {
        const order = buildLocalSalesOrder({
          id: selectedLocalSalesOrderId,
          sales_order_no: quoteNo.trim() || currentLocalSalesOrder?.sales_order_no || "",
          customer_name: resolvedCustomerName,
          seller_company: sellerCompany.trim(),
          purchase_company: buyerInfo.trim(),
          quote_date: quoteDate,
          currency,
          customer_type: customerType,
          shipping_cost: Number(String(shippingCost || "0").replace(",", ".")) || 0,
          discount_amount: Number(String(discountAmount || "0").replace(",", ".")) || 0,
          supplier_mode: supplierMode,
          preferred_supplier: "",
          seller_info: sellerInfo.trim(),
          buyer_info: buyerInfo.trim(),
          delivery_term: deliveryTerm.trim(),
          payment_terms: paymentTerms.trim(),
          packing_details: packingDetails.trim(),
          notes: quoteNotes.trim(),
          status: currentLocalSalesOrder?.status || "draft",
          source_channel: currentLocalSalesOrder?.source_channel || "internal",
          portal_invite_id: currentLocalSalesOrder?.portal_invite_id ?? null,
          portal_submitted_at: currentLocalSalesOrder?.portal_submitted_at ?? null,
          portal_seen_at: currentLocalSalesOrder?.portal_seen_at ?? null,
          lines: syncedLines,
        });
        const saved = await upsertSalesOrder(order);
        setSalesOrderSourceSnapshot(serializeSalesOrderForDirtyCheck(saved));
        await refreshLocalSalesOrders(saved.id);
      }

      setBuilderStatus(
        resyncOnlyFillBlanks
          ? "Catalog re-sync complete. Only blank catalog fields were updated."
          : "Catalog re-sync complete.",
      );
      actionFeedback.succeed("Sales order re-synced from catalog.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Catalog re-sync failed");
    } finally {
      setResyncingCatalog(false);
    }
  }

  function buildSalesOrderPayload(status: "draft" | "confirmed") {
    return buildLocalSalesOrder({
      id: selectedLocalSalesOrderId || undefined,
      sales_order_no: quoteNo.trim() || `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString().slice(-4)}`,
      customer_name: resolvedCustomerName,
      seller_company: sellerCompany.trim(),
      purchase_company: buyerInfo.trim(),
      quote_date: quoteDate,
      currency,
      customer_type: customerType,
      shipping_cost: Number(String(shippingCost || "0").replace(",", ".")) || 0,
      discount_amount: Number(String(discountAmount || "0").replace(",", ".")) || 0,
      supplier_mode: supplierMode,
      preferred_supplier: "",
      seller_info: sellerInfo.trim(),
      buyer_info: buyerInfo.trim(),
      delivery_term: deliveryTerm.trim(),
      payment_terms: paymentTerms.trim(),
      packing_details: packingDetails.trim(),
      notes: quoteNotes.trim(),
      status,
      lines: quoteBuilderLines,
    });
  }

  function serializeSalesOrderForDirtyCheck(order: LocalSalesOrder | null) {
    if (!order) return "";
    return JSON.stringify({
      sales_order_no: order.sales_order_no || "",
      customer_name: order.customer_name || "",
      seller_company: order.seller_company || "",
      purchase_company: order.purchase_company || "",
      quote_date: order.quote_date || "",
      currency: order.currency || "",
      customer_type: order.customer_type || "",
      shipping_cost: Number(order.shipping_cost || 0) || 0,
      discount_amount: Number(order.discount_amount || 0) || 0,
      supplier_mode: order.supplier_mode || "",
      seller_info: order.seller_info || "",
      buyer_info: order.buyer_info || "",
      delivery_term: order.delivery_term || "",
      payment_terms: order.payment_terms || "",
      packing_details: order.packing_details || "",
      notes: order.notes || "",
      status: order.status || "",
      lines: (order.lines || []).map((line) => ({
        requestedCode: line.requestedCode || "",
        resolvedCode: line.resolvedCode || "",
        brand: line.brand || "",
        description: line.description || "",
        qty: Number(line.qty || 0) || 0,
        oem_no: line.oem_no || "",
        hs_code: line.hs_code || "",
        origin: line.origin || "",
        weight_kg: line.weight_kg ?? null,
        supplier_name: line.supplier_name || "",
        buy_price: line.buy_price ?? null,
        sell_price: line.sell_price ?? null,
        price_date: line.price_date || "",
        notes: line.notes || "",
      })),
    });
  }

  const salesOrderDraftSnapshot = useMemo(
    () => serializeSalesOrderForDirtyCheck(buildSalesOrderPayload(currentLocalSalesOrder?.status === "confirmed" ? "confirmed" : "draft")),
    [
      currentLocalSalesOrder?.status,
      selectedLocalSalesOrderId,
      quoteNo,
      customerSelection,
      manualCustomerName,
      customerName,
      resolvedCustomerName,
      sellerCompany,
      buyerInfo,
      quoteDate,
      currency,
      customerType,
      shippingCost,
      discountAmount,
      supplierMode,
      sellerInfo,
      deliveryTerm,
      paymentTerms,
      packingDetails,
      quoteNotes,
      quoteBuilderLines,
    ],
  );
  const salesOrderHasUnsavedChanges = useMemo(() => {
    if (workbenchMode === "new") {
      return Boolean(
        quoteBuilderLines.length ||
          customerName.trim() ||
          resolvedCustomerName.trim() ||
          manualCustomerName.trim() ||
          quoteNotes.trim() ||
          discountAmount !== "0" ||
          shippingCost !== "0",
      );
    }
    return Boolean(selectedLocalSalesOrderId) && salesOrderDraftSnapshot !== salesOrderSourceSnapshot;
  }, [
    customerName,
    resolvedCustomerName,
    discountAmount,
    manualCustomerName,
    quoteBuilderLines.length,
    quoteNotes,
    salesOrderDraftSnapshot,
    salesOrderSourceSnapshot,
    selectedLocalSalesOrderId,
    shippingCost,
    workbenchMode,
  ]);

  async function persistSalesOrderDraft() {
    if (!quoteBuilderLines.length) {
      actionFeedback.fail("Add sales order lines before saving draft.");
      return null;
    }
    const saved = await upsertSalesOrder(buildSalesOrderPayload("draft"));
    setWorkbenchMode("existing");
    setSelectedLocalSalesOrderId(saved.id);
    setSalesOrderSourceSnapshot(serializeSalesOrderForDirtyCheck(saved));
    await refreshLocalSalesOrders(saved.id);
    setQuoteNo(saved.sales_order_no);
    setBuilderStatus(`Draft saved as ${saved.sales_order_no}.`);
    return saved;
  }

  async function confirmSalesOrderNavigation(nextAction: () => void | Promise<void>) {
    if (!salesOrderHasUnsavedChanges) {
      await nextAction();
      return;
    }
    if (!window.confirm(`Unsaved changes detected in ${currentDraftDisplayLabel}. Click OK to save before leaving, or Cancel to stay on this screen.`)) {
      return;
    }
    try {
      setSavingDraft(true);
      actionFeedback.begin(`Saving draft ${currentDraftDisplayLabel} before leaving...`);
      const saved = await persistSalesOrderDraft();
      if (!saved) return;
      actionFeedback.succeed(`Draft ${saved.sales_order_no} saved.`);
      await nextAction();
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Save draft failed");
    } finally {
      setSavingDraft(false);
    }
  }

  const builderColumns = useMemo(() => {
    const columns = [
      { key: "line", header: "#", render: (row: QuoteBuilderLine) => row.lineId.split("-").slice(-1)[0] },
      {
        key: "resolved",
        header: "Code",
        render: (row: QuoteBuilderLine) => (
          <div>
            <div>{row.resolvedCode}</div>
            {row.codeChanged ? <div className="warning-text">{row.codeChangeWarning}</div> : null}
            {renderLifecycleBadge(row)}
          </div>
        ),
      },
      { key: "brand", header: "Brand", render: (row: QuoteBuilderLine) => <BrandPill brand={row.brand} compact /> },
      { key: "name", header: "Description", render: (row: QuoteBuilderLine) => row.description || "-" },
      ...(effectiveWorkbenchColumnVisibility.origin
        ? [{ key: "origin", header: "Origin", render: (row: QuoteBuilderLine) => row.origin || "-" }]
        : []),
      {
        key: "qty",
        header: "Qty",
        render: (row: QuoteBuilderLine) =>
          pdfView ? (
            row.qty
          ) : (
            <input
              className="inline-edit-input inline-edit-input--qty"
              type="number"
              min={1}
              step={1}
              value={row.qty}
              onChange={(event) => {
                const nextQty = Math.max(1, Number(event.target.value || 1) || 1);
                setQuoteBuilderLines((current) =>
                  current.map((item) => (item.lineId === row.lineId ? { ...item, qty: nextQty } : item)),
                );
              }}
            />
          ),
      },
    ] as Array<{ key: string; header: string; render: (row: QuoteBuilderLine) => ReactNode }>;

    if (!pdfView && effectiveWorkbenchColumnVisibility.stock) {
      columns.push({
        key: "stock",
        header: "Stock",
        render: (row: QuoteBuilderLine) =>
          renderInventoryAvailabilityBadge(inventoryAvailabilityLookup, {
            brand: row.brand,
            qty: row.qty,
            resolvedCode: row.resolvedCode,
            requestedCode: row.requestedCode,
          }),
      });
      if (effectiveWorkbenchColumnVisibility.supplierOption) {
        columns.push({
          key: "supplierOption",
          header: "Purchase Option",
          render: (row: QuoteBuilderLine) => (
            <select
              className="inline-edit-input"
              value={row.selectedSupplierKey}
              onChange={(event) => {
                const nextKey = event.target.value;
                setQuoteBuilderLines((current) =>
                  current.map((item) => {
                    if (item.lineId !== row.lineId) return item;
                    const selected = item.supplierOptions.find((option, index) => `${option.supplier_name}-${index}` === nextKey);
                    if (!selected) return { ...item, selectedSupplierKey: nextKey };
                    return {
                      ...item,
                      selectedSupplierKey: nextKey,
                      supplier_name: selected.supplier_name || "",
                      buy_price: selected.buy_price ?? null,
                      sell_price:
                        shouldUseCPricePricing
                          ? item.c_sell_price ?? item.sell_price
                          : selected.buy_price != null
                            ? roundMoney(Number(selected.buy_price) * (1 + (customerType === "B" ? effectiveMarginB : effectiveMarginA) / 100))
                            : selected.sell_price ?? null,
                      price_date: selected.price_date || "",
                      notes: selected.notes || "",
                    };
                  }),
                );
              }}
            >
              {row.supplierOptions.map((option, index) => {
                const optionKey = `${option.supplier_name}-${index}`;
                return (
                  <option key={optionKey} value={optionKey}>
                    {option.supplier_name} | Buy {option.buy_price ?? "-"} | Sell {option.sell_price ?? "-"}
                  </option>
                );
              })}
            </select>
          ),
        });
      }
      if (effectiveWorkbenchColumnVisibility.supplier) {
        columns.push({ key: "supplier", header: "Supplier", render: (row: QuoteBuilderLine) => row.supplier_name || "-" });
      }
      if (effectiveWorkbenchColumnVisibility.buy) {
        columns.push({ key: "buy", header: "Buy", render: (row: QuoteBuilderLine) => formatMoney(row.buy_price, currency) });
      }
      if (effectiveWorkbenchColumnVisibility.buyTotal) {
        columns.push({ key: "buyTotal", header: "Buy Total", render: (row: QuoteBuilderLine) => formatMoney(roundMoney(toNumber(row.buy_price) * row.qty), currency) });
      }
    }

    columns.push({ key: "sell", header: pdfView ? "Unit Price" : "Sell", render: (row: QuoteBuilderLine) => formatMoney(row.sell_price, currency) });
    columns.push({ key: "sellTotal", header: "Line Total", render: (row: QuoteBuilderLine) => formatMoney(roundMoney(toNumber(row.sell_price) * row.qty), currency) });

    if (!pdfView && effectiveWorkbenchColumnVisibility.profit) {
      columns.push({
        key: "profit",
        header: "Profit",
        render: (row: QuoteBuilderLine) => formatMoney(roundMoney((toNumber(row.sell_price) - toNumber(row.buy_price)) * row.qty), currency),
      });
    }
    if (!pdfView && effectiveWorkbenchColumnVisibility.margin) {
      columns.push({
        key: "margin",
        header: "Margin %",
        render: (row: QuoteBuilderLine) => {
          const sellTotal = toNumber(row.sell_price) * row.qty;
          const profit = (toNumber(row.sell_price) - toNumber(row.buy_price)) * row.qty;
          return sellTotal > 0 ? `${roundMoney((profit / sellTotal) * 100)}%` : "-";
        },
      });
    }
    if (!pdfView && effectiveWorkbenchColumnVisibility.date) {
      columns.push({ key: "date", header: "Price Date", render: (row: QuoteBuilderLine) => formatDate(row.price_date) });
    }

    columns.push({
      key: "actions",
      header: "Actions",
      render: (row: QuoteBuilderLine) => (
        <div className="inline-actions">
          <Button variant="secondary" className="button--compact danger-button" onClick={() => setQuoteBuilderLines((current) => current.filter((item) => item.lineId !== row.lineId))}>
            Delete
          </Button>
        </div>
      ),
    });

    return columns;
  }, [currency, customerType, pdfView, effectiveMarginA, effectiveMarginB, inventoryAvailabilityLookup, effectiveWorkbenchColumnVisibility]);

  const attentionColumns = useMemo(
    () => [
      { key: "code", header: "Code", render: (row: QuoteBuilderLine) => row.resolvedCode || row.requestedCode || "-" },
      { key: "brand", header: "Brand", render: (row: QuoteBuilderLine) => <BrandPill brand={row.brand} compact /> },
      { key: "description", header: "Description", render: (row: QuoteBuilderLine) => row.description || "-" },
      { key: "qty", header: "Qty", render: (row: QuoteBuilderLine) => row.qty },
      {
        key: "issues",
        header: "Issue",
        render: (row: QuoteBuilderLine) => (
          <div className="document-marks document-marks--compact">
            {getQuoteBuilderLineIssues(row).map((issue) => (
              <span
                key={`${row.lineId}-${issue}`}
                className={`mark-badge ${
                  issue === "Discontinued"
                    ? "mark-badge--danger"
                    : issue === "Replacement"
                      ? "mark-badge--accent"
                      : "mark-badge--info"
                }`}
              >
                {issue}
              </span>
            ))}
          </div>
        ),
      },
      { key: "sell", header: "Sell", render: (row: QuoteBuilderLine) => formatMoney(row.sell_price, currency) },
    ],
    [currency],
  );

  async function buildBuilderLine(
    input: { code: string; brand: string; qty: number },
    options?: {
      referenceMatch?: CodeReferenceMatch | null;
      cPriceMap?: Map<string, number>;
      includeSupplierOptions?: boolean;
    },
  ) {
    const referenceMatch = options?.referenceMatch ?? (await findCodeReferenceMatch({ code: input.code, brand: input.brand || "" }));
    const codeToResolve = referenceMatch?.new_code || input.code;
    const { resolved, supplierOptions } = await resolveQuoteLine({
      code: codeToResolve,
      brand: input.brand || "",
      customerType,
      marginA: effectiveMarginA,
      marginB: effectiveMarginB,
      includeSupplierOptions: options?.includeSupplierOptions,
    });

    let cSellPrice: number | null = null;
    if (shouldUseCPricePricing) {
      const cPriceMap =
        options?.cPriceMap ||
        (await fetchCPriceMapForRows([
          {
            brand: resolved.brand || input.brand || "",
            product_code: resolved.product_code || codeToResolve,
          },
        ]));

      cSellPrice = getCPriceForRow(cPriceMap, {
        brand: resolved.brand || input.brand || "",
        product_code: resolved.product_code || codeToResolve,
      });
    }

    const effectiveSupplierOptions =
      supplierOptions.length
        ? supplierOptions
        : resolved.found && (resolved.supplier_name || resolved.buy_price != null || resolved.sell_price != null)
          ? [
              {
                supplier_id: resolved.supplier_id || null,
                supplier_name: resolved.supplier_name || "",
                buy_price: resolved.buy_price ?? null,
                price_date: resolved.price_date || null,
                sell_price: shouldUseCPricePricing ? cSellPrice ?? resolved.sell_price ?? null : resolved.sell_price ?? null,
                notes: resolved.notes || null,
              },
            ]
          : [];

    const selectedKey = effectiveSupplierOptions[0] ? `${effectiveSupplierOptions[0].supplier_name}-0` : "";

    return {
      lineId: nextLineId(),
      requestedCode: input.code,
      resolvedCode: resolved.product_code || codeToResolve,
      brand: resolved.brand || input.brand || "",
      description: resolved.description || "",
      qty: input.qty,
      oem_no: resolved.oem_no || "",
      hs_code: resolved.hs_code || "",
      origin: resolved.origin || "",
      weight_kg: resolved.weight_kg ?? null,
      supplier_name: resolved.supplier_name || effectiveSupplierOptions[0]?.supplier_name || "",
      buy_price: resolved.buy_price ?? effectiveSupplierOptions[0]?.buy_price ?? null,
      sell_price: shouldUseCPricePricing
        ? cSellPrice ?? resolved.sell_price ?? effectiveSupplierOptions[0]?.sell_price ?? null
        : resolved.sell_price ?? effectiveSupplierOptions[0]?.sell_price ?? null,
      c_sell_price: cSellPrice,
      price_date: resolved.price_date || effectiveSupplierOptions[0]?.price_date || "",
      notes: resolved.notes || effectiveSupplierOptions[0]?.notes || "",
      found: resolved.found === true,
      codeChanged: Boolean(referenceMatch),
      codeChangeWarning: referenceMatch
        ? `Old Code ${referenceMatch.old_code} => New Code ${referenceMatch.new_code}.${referenceMatch.reason ? ` ${referenceMatch.reason}` : ""}`
        : "",
      lifecycle_status: resolved.lifecycle_status ?? "active",
      lifecycle_note: resolved.lifecycle_note ?? null,
      lifecycle_warning: resolved.lifecycle_warning ?? null,
      supplierOptions: effectiveSupplierOptions,
      selectedSupplierKey: selectedKey,
    } satisfies QuoteBuilderLine;
  }

  async function buildBuilderLineWithTimeout(
    input: { code: string; brand: string; qty: number },
    timeoutMs = 12000,
    options?: {
      referenceMatch?: CodeReferenceMatch | null;
      cPriceMap?: Map<string, number>;
      includeSupplierOptions?: boolean;
    },
  ) {
    return await Promise.race([
      buildBuilderLine(input, options),
      new Promise<QuoteBuilderLine>((_, reject) => {
        window.setTimeout(() => reject(new Error(`Timed out while resolving ${input.code}.`)), timeoutMs);
      }),
    ]);
  }

  async function buildImportLines(
    rows: QuoteImportRow[],
    onChunkResolved?: (resolvedLines: QuoteBuilderLine[], detail: { processedRows: number; totalRows: number }) => void,
  ) {
    const batches = chunkRows(rows, SALES_ORDER_IMPORT_CHUNK_SIZE);
    const allLines: QuoteBuilderLine[] = [];
    let processedRows = 0;

    for (const batch of batches) {
      const resolvedLines = await batchResolveQuoteImportRows({
        rows: batch,
        customerType,
        marginA: effectiveMarginA,
        marginB: effectiveMarginB,
      });
      processedRows += batch.length;
      allLines.push(...resolvedLines);
      onChunkResolved?.(resolvedLines, {
        processedRows,
        totalRows: rows.length,
      });
    }

    return allLines;
  }

  async function handleResolveQuoteLine() {
    const code = quoteCode.trim();
    const brand = getSelectedBrandValue(quoteBrandSelection, quoteBrand);
    const qty = Math.max(1, Number(quoteQty || "1") || 1);
    if (!code) {
      setBuilderStatus("Enter a product code first.");
      return;
    }
    if (!brand) {
      const message = "Select a brand first. Sales order resolve is restricted to brand-based search.";
      setBuilderStatus(message);
      actionFeedback.fail(message);
      return;
    }

    try {
      setBuilderStatus("Resolving quote line...");
      setResolvingLine(true);
      actionFeedback.begin(`Resolving quote line for ${code}...`);
      const line = await buildBuilderLine({ code, brand, qty });
      setQuoteBuilderLines((current) => [line, ...current]);
      setBuilderStatus(
        line.found
          ? line.lifecycle_status === "discontinued"
            ? `Resolved ${code}. Warning: ${line.resolvedCode} is discontinued.`
            : `Resolved ${code} successfully.`
          : `No system match for ${code}.`,
      );
      line.found ? actionFeedback.succeed(`Resolved ${code} successfully.`) : actionFeedback.fail(`No system match for ${code}.`);
      setQuoteCode("");
      setQuoteBrand("");
      setQuoteBrandSelection("");
      setQuoteQty("1");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Quote resolve failed";
      setBuilderStatus(message);
      actionFeedback.fail(message);
    } finally {
      setResolvingLine(false);
    }
  }

  async function handleImportQuoteFile(file: File) {
    try {
      if (!/\.csv$|\.txt$|\.tsv$/i.test(file.name)) {
        throw new Error("Upload CSV/TSV exported from Excel. Native .xlsx import is not enabled yet.");
      }
      setImportingLines(true);
      actionFeedback.begin(`Importing quote file ${file.name}...`);
      const rows = parseQuoteImportRows(await file.text());
      if (!rows.length) {
        throw new Error("No quote rows found in import file.");
      }
      const selectedBrand = getSelectedBrandValue(quoteBrandSelection, quoteBrand);
      const fallbackBrand = selectedBrand || inferredContextBrand || inferBrandFromFilename(file.name, brandOptions);
      const normalizedRows = rows.map((row) => ({
        ...row,
        brand: row.brand.trim() || fallbackBrand,
      }));
      const missingBrandCount = normalizedRows.filter((row) => !row.brand.trim()).length;
      if (missingBrandCount) {
        throw new Error("Brand is required for import. Include a Brand column, choose a brand below, or use a file name that clearly contains a single brand.");
      }
      setBuilderStatus(`Importing and pricing ${normalizedRows.length.toLocaleString("en-US")} lines...`);
      let importedDiscontinuedCount = 0;
      const hydratedLines = await buildImportLines(normalizedRows, (resolvedLines, progress) => {
        importedDiscontinuedCount += resolvedLines.filter((line) => line.lifecycle_status === "discontinued").length;
        setQuoteBuilderLines((current) => [...current, ...resolvedLines]);
        setBuilderStatus(
          `Imported ${progress.processedRows.toLocaleString("en-US")} / ${progress.totalRows.toLocaleString("en-US")} lines...`,
        );
      });
      setBuilderStatus(
        importedDiscontinuedCount
          ? `Pricing ready for ${hydratedLines.length.toLocaleString("en-US")} imported lines. ${importedDiscontinuedCount.toLocaleString("en-US")} item(s) are discontinued.`
          : `Pricing ready for ${hydratedLines.length.toLocaleString("en-US")} imported lines.`,
      );
      actionFeedback.succeed(`${hydratedLines.length.toLocaleString("en-US")} quote lines imported with pricing.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Sales order import failed";
      setBuilderStatus(message);
      actionFeedback.fail(message);
    } finally {
      setImportingLines(false);
      if (importRef.current) importRef.current.value = "";
    }
  }

  function handleExportQuoteXlsx() {
    if (!quoteBuilderLines.length) {
      actionFeedback.fail("Add quote lines first.");
      return;
    }
    setExportingXlsx(true);
    try {
      actionFeedback.begin(`Preparing Sales Order Excel for ${quoteBuilderLines.length.toLocaleString("en-US")} line(s)...`);
      const rows: Array<Array<string | number>> = [
        ["Sales Order No", quoteNo],
        ["Customer", resolvedCustomerName],
        ["Date", quoteDate],
        ["Currency", currency],
        ["Customer Type", customerType],
        ["Seller Company", sellerCompany],
        ["Purchase Company", buyerInfo],
        ["Purchase Company", buyerInfo],
        ["Supplier Mode", supplierMode],
        ["Delivery Term", deliveryTerm],
        ["Payment Terms", paymentTerms],
        [],
        ["Line", "Part No", "Old Code", "Changed No Warning", "Lifecycle Status", "Lifecycle Warning", "Brand", "Description", "OEM", "HS", "Origin", "Weight kg", "Qty", "Supplier", "Price Date", "Buy Unit", "Buy Total", "Sell Unit", "Sell Total", "Profit", "Margin %", "Notes"],
      ];

      quoteBuilderLines.forEach((line, index) => {
        const buyUnit = roundMoney(toNumber(line.buy_price));
        const buyTotal = roundMoney(buyUnit * line.qty);
        const sellUnit = roundMoney(toNumber(line.sell_price));
        const sellTotal = roundMoney(sellUnit * line.qty);
        const profit = roundMoney(sellTotal - buyTotal);
        const margin = sellTotal > 0 ? roundMoney((profit / sellTotal) * 100) : 0;
        rows.push([
          index + 1,
          line.resolvedCode,
          line.codeChanged ? line.requestedCode : "",
          line.codeChangeWarning,
          line.lifecycle_status === "discontinued" ? "Discontinued" : "Active",
          line.lifecycle_warning || "",
          line.brand,
          line.description,
          line.oem_no,
          line.hs_code,
          line.origin,
          line.weight_kg ?? "",
          line.qty,
          line.supplier_name,
          line.price_date,
          buyUnit,
          buyTotal,
          sellUnit,
          sellTotal,
          profit,
          margin,
          line.notes,
        ]);
      });
      rows.push([]);
      rows.push(["Purchase Total", draftTotals.purchase]);
      rows.push(["Subtotal", draftTotals.subtotal]);
      rows.push(["Discount", draftTotals.discount]);
      rows.push(["Shipping", draftTotals.shipping]);
      rows.push(["Total Amount", draftTotals.totalAmount]);
      rows.push(["Profit", draftTotals.profit]);
      rows.push(["Margin %", draftTotals.margin]);
      const blob = buildXlsxBlob("Sales Order Draft", rows, [11, 12, 15, 16, 17, 18, 19, 20]);
      downloadBlob(`${(quoteNo || "sales-order-draft").replace(/[^a-z0-9_-]+/gi, "-")}.xlsx`, blob);
      actionFeedback.succeed("Sales order Excel downloaded.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Sales order Excel export failed");
    } finally {
      setExportingXlsx(false);
    }
  }

  function handlePrintDraftPdf() {
    if (!quoteBuilderLines.length) {
      actionFeedback.fail("Add quote lines first.");
      return;
    }
    const profile =
      findCompanyProfileByName(companyProfiles, sellerCompany) || {
        id: "",
        companyName: "",
        email: "",
        phone: "",
        website: "",
        address: "",
        bankDetails: "",
        taxOffice: "",
        taxNumber: "",
        footerNote: "",
        logoDataUrl: "",
      };
    const currentCustomer = selectedCustomerProfile;
    const safeCompany = profile.companyName
      ? profile
      : {
          ...profile,
          companyName: sellerCompany || "Company",
          address: profile.address || "",
          taxNumber: profile.taxNumber || "",
        };
    setPrintingDraft(true);
    try {
      actionFeedback.begin(`Preparing PDF view for ${quoteNo || "sales order draft"}...`);
      openBusinessDocumentPreview(
        buildDraftQuoteHtml({
          quoteNo,
          quoteDate,
          customerName: resolvedCustomerName,
          contractNr: sellerInfo,
          currency,
          deliveryTerm,
          paymentTerms,
          notes: quoteNotes,
          subtotal: draftTotals.subtotal,
          discount: draftTotals.discount,
          shipping: draftTotals.shipping,
          totalAmount: draftTotals.totalAmount,
          lines: quoteBuilderLines,
          company: safeCompany,
          customer: currentCustomer,
        }),
      );
      actionFeedback.succeed("PDF view opened.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "PDF view failed");
    } finally {
      setPrintingDraft(false);
    }
  }

  function clearDraft() {
    if (!quoteBuilderLines.length && !customerName && !quoteNo && !quoteNotes) {
      actionFeedback.fail("Draft is already empty.");
      return;
    }
    setQuoteBuilderLines([]);
    setCustomerName("");
    setCustomerSelection("");
    setManualCustomerName("");
    setQuoteNo("");
    setSellerCompany(companyProfiles[0]?.companyName || "");
    setQuoteDate(new Date().toISOString().slice(0, 10));
    setCurrency("EUR");
    setQuoteBrand("");
    setQuoteBrandSelection("");
    setShippingCost("0");
    setDiscountAmount("0");
    setSupplierMode("Best price");
    setSellerInfo("");
    setBuyerInfo("");
    setDeliveryTermSelection("");
    setPaymentTermsSelection("");
    setDeliveryTerm("");
    setPaymentTerms("");
    setPackingDetails("");
    setQuoteNotes("");
    setSelectedLocalSalesOrderId("");
    setBuilderStatus("Draft cleared.");
    actionFeedback.succeed("Draft sales order cleared.");
  }

  function resetSalesOrderEditor() {
    setSalesOrdersView("detail");
    setWorkbenchMode("new");
    setSalesOrderSourceSnapshot("");
    onSelectedSalesOrderChange?.("");
    setSelectedQuoteId("");
    onSelectedQuoteChange?.("");
    setSelectedLocalSalesOrderId("");
    setQuoteBuilderLines([]);
    setCustomerName("");
    setCustomerSelection("");
    setManualCustomerName("");
    setQuoteNo(`SO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString().slice(-4)}`);
    setQuoteDate(new Date().toISOString().slice(0, 10));
    setCurrency("EUR");
    setShippingCost("0");
    setDiscountAmount("0");
    setSupplierMode("Best price");
    setSellerCompany(companyProfiles[0]?.companyName || "");
    setSellerInfo("");
    setBuyerInfo("");
    setDeliveryTermSelection("");
    setPaymentTermsSelection("");
    setDeliveryTerm("");
    setPaymentTerms("");
    setPackingDetails("");
    setQuoteNotes("");
    setPdfView(false);
    setBuilderStatus("New sales order draft ready.");
  }

  function startNewSalesOrder() {
    void confirmSalesOrderNavigation(async () => {
      resetSalesOrderEditor();
      actionFeedback.succeed("New sales order draft ready.");
    });
  }

  function closeSalesOrderEditor() {
    void confirmSalesOrderNavigation(async () => {
      onSelectedSalesOrderChange?.("");
      setSalesOrdersView("list");
      setPdfView(false);
      setBuilderStatus("");
    });
  }

  async function refreshLocalSalesOrders(nextSelectedId?: string) {
    const nextSalesOrders = await fetchSalesOrderSummaries();
    setLocalSalesOrders(nextSalesOrders);
    if (nextSelectedId) {
      setSelectedLocalSalesOrderId(nextSelectedId);
    }
    void Promise.all([fetchPurchaseOrderSalesLinkSummaries(), fetchInvoiceSalesLinkSummaries()])
      .then(([nextPurchaseOrders, nextInvoices]) => {
        setSavedPurchaseOrders(nextPurchaseOrders);
        setSavedInvoices(nextInvoices);
      })
      .catch(() => {
        setSavedPurchaseOrders([]);
        setSavedInvoices([]);
      });
  }

  function toggleLocalSalesOrderSelection(orderId: string, forceChecked?: boolean) {
    setSelectedLocalSalesOrderIds((current) => {
      const hasOrder = current.includes(orderId);
      const shouldSelect = typeof forceChecked === "boolean" ? forceChecked : !hasOrder;
      if (shouldSelect) {
        return hasOrder ? current : [...current, orderId];
      }
      return current.filter((item) => item !== orderId);
    });
  }

  async function handleDeleteSalesOrders(orderIds: string[]) {
    const uniqueIds = Array.from(new Set(orderIds.filter(Boolean)));
    if (!uniqueIds.length) {
      actionFeedback.fail("No sales orders selected.");
      return;
    }

    const blocked = uniqueIds.filter((orderId) => {
      const poCount = salesOrderDocumentState.purchaseOrderCountBySalesOrderId.get(orderId) || 0;
      const invoiceCount = salesOrderDocumentState.invoiceCountBySalesOrderId.get(orderId) || 0;
      return poCount > 0 || invoiceCount > 0;
    });

    if (blocked.length) {
      actionFeedback.fail(`Delete blocked. ${blocked.length.toLocaleString("en-US")} selected sales order(s) already have purchase orders or invoices.`);
      return;
    }

    if (!window.confirm(`Delete ${uniqueIds.length.toLocaleString("en-US")} sales order(s)? This cannot be undone.`)) {
      return;
    }

    try {
      actionFeedback.begin(`Deleting ${uniqueIds.length.toLocaleString("en-US")} sales order(s)...`);
      await Promise.all(uniqueIds.map((orderId) => deleteSalesOrder(orderId)));
      await refreshLocalSalesOrders();
      setSelectedLocalSalesOrderIds((current) => current.filter((orderId) => !uniqueIds.includes(orderId)));
      if (uniqueIds.includes(selectedLocalSalesOrderId)) {
        setSelectedLocalSalesOrderId("");
        closeSalesOrderEditor();
      }
      actionFeedback.succeed(`${uniqueIds.length.toLocaleString("en-US")} sales order(s) deleted.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Sales order delete failed");
    }
  }

  async function handleConvertSalesOrdersToInvoices(orderIds: string[]) {
    const uniqueIds = Array.from(new Set(orderIds.filter(Boolean)));
    if (!uniqueIds.length) {
      actionFeedback.fail("No sales orders selected.");
      return;
    }

    const selectedOrders = await Promise.all(
      localSalesOrders.filter((order) => uniqueIds.includes(order.id)).map((order) => fetchSalesOrderById(order.id)),
    );
    const invoiceReadyOrders = selectedOrders.filter((order) => order.status === "confirmed");
    if (!invoiceReadyOrders.length) {
      actionFeedback.fail("Only confirmed sales orders can be converted to invoices.");
      return;
    }

    try {
      actionFeedback.begin(`Converting ${invoiceReadyOrders.length.toLocaleString("en-US")} sales order(s) to invoices...`);
      await Promise.all(invoiceReadyOrders.map((order) => upsertInvoice(buildInvoiceFromSalesOrder(order))));
      await Promise.all(
        invoiceReadyOrders
          .filter((order) => order.source_channel === "portal" && order.portal_submitted_at)
          .map((order) => markSalesOrderPortalSeen(order.id)),
      );
      await refreshLocalSalesOrders();
      actionFeedback.succeed(
        `${invoiceReadyOrders.length.toLocaleString("en-US")} invoice(s) created.${invoiceReadyOrders.length !== selectedOrders.length ? ` ${selectedOrders.length - invoiceReadyOrders.length} non-confirmed order(s) skipped.` : ""}`,
      );
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Bulk invoice conversion failed");
    }
  }

  const salesOrderDocumentState = useMemo(() => {
    const purchaseOrderCountBySalesOrderId = new Map<string, number>();
    const invoiceCountBySalesOrderId = new Map<string, number>();

    savedPurchaseOrders.forEach((row) => {
      if (!row.sales_order_id) return;
      purchaseOrderCountBySalesOrderId.set(row.sales_order_id, (purchaseOrderCountBySalesOrderId.get(row.sales_order_id) || 0) + 1);
    });

    savedInvoices.forEach((row) => {
      const linkedOrderIds = new Set<string>();
      if (row.sales_order_id) linkedOrderIds.add(row.sales_order_id);
      (row.sales_order_ids || []).forEach((id) => {
        if (id) linkedOrderIds.add(id);
      });
      linkedOrderIds.forEach((id) => {
        invoiceCountBySalesOrderId.set(id, (invoiceCountBySalesOrderId.get(id) || 0) + 1);
      });
    });

    return {
      purchaseOrderCountBySalesOrderId,
      invoiceCountBySalesOrderId,
    };
  }, [savedPurchaseOrders, savedInvoices]);

  const filteredLocalSalesOrders = useMemo(() => {
    return localSalesOrders.filter((order) => {
      const poCount = salesOrderDocumentState.purchaseOrderCountBySalesOrderId.get(order.id) || 0;
      const invoiceCount = salesOrderDocumentState.invoiceCountBySalesOrderId.get(order.id) || 0;
      switch (salesOrderFilter) {
        case "draft":
          return order.status === "draft";
        case "confirmed":
          return order.status === "confirmed";
        case "purchased":
          return poCount > 0;
        case "invoiced":
          return invoiceCount > 0;
        default:
          return true;
      }
    });
  }, [localSalesOrders, salesOrderDocumentState, salesOrderFilter]);

  const selectedLocalSalesOrders = useMemo(
    () => localSalesOrders.filter((order) => selectedLocalSalesOrderIds.includes(order.id)),
    [localSalesOrders, selectedLocalSalesOrderIds],
  );

  const attentionLines = useMemo(
    () =>
      quoteBuilderLines.filter((line) => {
        const issues = getQuoteBuilderLineIssues(line);
        return issues.length > 0;
      }),
    [quoteBuilderLines],
  );

  const savedSalesOrderColumns = useMemo(
    () => [
      {
        key: "select",
        header: "",
        render: (row: LocalSalesOrder) => (
          <input
            type="checkbox"
            checked={selectedLocalSalesOrderIds.includes(row.id)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => toggleLocalSalesOrderSelection(row.id, event.target.checked)}
          />
        ),
      },
      {
        key: "customer",
        header: "Customer",
        render: (row: LocalSalesOrder) => <strong title={row.customer_name || "Unnamed customer"}>{getAdminCustomerLabel(row.customer_name)}</strong>,
        sortValue: (row: LocalSalesOrder) => getAdminCustomerLabel(row.customer_name),
      },
      {
        key: "salesOrderNo",
        header: "Sales Order",
        render: (row: LocalSalesOrder) => row.sales_order_no,
        sortValue: (row: LocalSalesOrder) => row.sales_order_no,
      },
      {
        key: "status",
        header: "Status",
        render: (row: LocalSalesOrder) => {
          const poCount = salesOrderDocumentState.purchaseOrderCountBySalesOrderId.get(row.id) || 0;
          const invoiceCount = salesOrderDocumentState.invoiceCountBySalesOrderId.get(row.id) || 0;
          return (
            <span className="document-marks document-marks--compact">
              <span className={`mark-badge ${row.status === "confirmed" ? "mark-badge--success" : ""}`}>{row.status.toUpperCase()}</span>
              <span className={`mark-badge ${row.source_channel === "portal" ? "mark-badge--accent" : "mark-badge--info"}`}>
                {row.source_channel === "portal" ? "Portal" : "Internal"}
              </span>
              {isDraftPortalAlert(row, poCount, invoiceCount) ? (
                <span className="mark-badge mark-badge--accent">New Order</span>
              ) : null}
              {poCount > 0 ? <span className="mark-badge mark-badge--info">{poCount} PO</span> : null}
              {invoiceCount > 0 ? <span className="mark-badge mark-badge--accent">{invoiceCount} Invoice</span> : null}
            </span>
          );
        },
        sortValue: (row: LocalSalesOrder) => row.status,
      },
      {
        key: "sellerCompany",
        header: "Seller Company",
        render: (row: LocalSalesOrder) => <span title={row.seller_company || "-"}>{buildEntityAlias(row.seller_company)}</span>,
        sortValue: (row: LocalSalesOrder) => buildEntityAlias(row.seller_company),
      },
      {
        key: "date",
        header: "Date",
        render: (row: LocalSalesOrder) => formatDate(row.quote_date),
        sortValue: (row: LocalSalesOrder) => row.quote_date,
      },
      {
        key: "amount",
        header: "Amount",
        render: (row: LocalSalesOrder) => formatMoney(row.sales_total, row.currency || "EUR"),
        sortValue: (row: LocalSalesOrder) => row.sales_total,
      },
      {
        key: "actions",
        header: "Delete",
        render: (row: LocalSalesOrder) => (
          <Button
            variant="secondary"
            className="button--compact danger-button"
            onClick={(event) => {
              event.stopPropagation();
              void handleDeleteSalesOrders([row.id]);
            }}
          >
            Delete
          </Button>
        ),
      },
    ],
    [selectedLocalSalesOrderIds, salesOrderDocumentState],
  );

  async function handleSaveDraft() {
    try {
      setSavingDraft(true);
      actionFeedback.begin(`Saving draft ${quoteNo || "sales order"}...`);
      const saved = await persistSalesOrderDraft();
      if (!saved) return;
      actionFeedback.succeed(`Draft saved as ${saved.sales_order_no}.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Save draft failed");
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleMarkConfirmed() {
    if (!quoteBuilderLines.length) {
      actionFeedback.fail("Add sales order lines before confirming.");
      return;
    }
    if (
      discontinuedLineCount > 0 &&
      !window.confirm(
        `${discontinuedLineCount.toLocaleString("en-US")} discontinued item(s) are still in this sales order. Continue and confirm anyway?`,
      )
    ) {
      return;
    }
    try {
      setConfirmingOrder(true);
      actionFeedback.begin(`Confirming ${quoteNo || "sales order"} and creating purchase orders...`);
      const order = buildSalesOrderPayload("confirmed");
      const saved = await upsertSalesOrder(order);
      const purchaseOrders = buildPurchaseOrdersFromSalesOrder(saved);
      await replacePurchaseOrdersForSalesOrder(saved.id, purchaseOrders);
      const seenOrder =
        saved.source_channel === "portal" && saved.portal_submitted_at ? await markSalesOrderPortalSeen(saved.id) : null;
      const effectiveOrder = seenOrder || saved;
      setSalesOrderSourceSnapshot(serializeSalesOrderForDirtyCheck(effectiveOrder));
      await refreshLocalSalesOrders(effectiveOrder.id);
      setPendingConfirmedOrder(effectiveOrder);
      setInvoicePromptOpen(true);
      setQuoteNo(effectiveOrder.sales_order_no);
      setBuilderStatus(`${effectiveOrder.sales_order_no} confirmed. ${purchaseOrders.length.toLocaleString("en-US")} purchase orders created by supplier.`);
      actionFeedback.succeed(`${effectiveOrder.sales_order_no} confirmed. ${purchaseOrders.length.toLocaleString("en-US")} supplier purchase orders created.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Mark as confirmed failed");
    } finally {
      setConfirmingOrder(false);
    }
  }

  async function handleConvertConfirmedToInvoice() {
    if (!pendingConfirmedOrder) {
      actionFeedback.fail("No confirmed sales order is waiting for invoice conversion.");
      return;
    }
    try {
      setCreatingInvoice(true);
      actionFeedback.begin(`Creating invoice from ${pendingConfirmedOrder.sales_order_no}...`);
      const invoice = await upsertInvoice(buildInvoiceFromSalesOrder(pendingConfirmedOrder));
      if (pendingConfirmedOrder.source_channel === "portal" && pendingConfirmedOrder.portal_submitted_at) {
        await markSalesOrderPortalSeen(pendingConfirmedOrder.id);
      }
      await refreshLocalSalesOrders(pendingConfirmedOrder.id);
      setBuilderStatus(`${pendingConfirmedOrder.sales_order_no} confirmed. Invoice ${invoice.id} created.`);
      actionFeedback.succeed(`Invoice ${invoice.id} created from ${pendingConfirmedOrder.sales_order_no}.`);
      setInvoicePromptOpen(false);
      setPendingConfirmedOrder(null);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Convert to invoice failed");
    } finally {
      setCreatingInvoice(false);
    }
  }

  return (
    <div className={`quotes-workspace${salesOrdersView === "list" ? " quotes-workspace--list-only" : " quotes-workspace--detail-only"}`}>
      {salesOrdersView === "list" ? (
      <aside className="quote-list-panel quote-list-panel--full">
        <div className="quote-list-panel__header">
          <div>
            <h2>Sales Orders</h2>
            <p>Shared sales orders and recent revisions.</p>
          </div>
          <div className="toolbar toolbar--wrap">
            <Button variant="secondary" onClick={startNewSalesOrder}>
              New Sales Order
            </Button>
          </div>
          <div className="toolbar toolbar--wrap">
            <Select
              label="Status"
              value={salesOrderFilter}
              options={[
                { value: "all", label: "All" },
                { value: "draft", label: "Draft" },
                { value: "confirmed", label: "Confirmed" },
                { value: "purchased", label: "Purchased" },
                { value: "invoiced", label: "Invoiced" },
              ]}
              onChange={(value) => setSalesOrderFilter(value as "all" | "draft" | "confirmed" | "purchased" | "invoiced")}
            />
          </div>
          <div className="toolbar toolbar--wrap">
            <Input
              value={search}
              onChange={setSearch}
              placeholder="Search sales orders"
              onEnter={() => {
                setSearchingQuotes(true);
                actionFeedback.begin(`Searching sales orders for ${search.trim() || "all sales orders"}...`);
                setSubmittedSearch(search);
              }}
            />
            <Button
              onClick={() => {
                setSearchingQuotes(true);
                actionFeedback.begin(`Searching sales orders for ${search.trim() || "all sales orders"}...`);
                setSubmittedSearch(search);
              }}
              busy={searchingQuotes}
              busyLabel="Searching..."
            >
              Search
            </Button>
          </div>
        </div>

        <div className="quote-list-panel__body">
          {!!filteredLocalSalesOrders.length ? (
            <div className="quote-list-section">
              <div className="quote-list-section__header">
                <div className="quote-list-section__title">Sales Orders</div>
                <div className="toolbar toolbar--wrap">
                  <Button variant="secondary" className="button--compact" onClick={() => setSalesOrderActionsOpen((current) => !current)}>
                    {salesOrderActionsOpen ? "Hide Actions" : "Actions"}
                  </Button>
                </div>
              </div>
              {salesOrderActionsOpen ? (
                <div className="action-menu-card">
                  <div className="meta-row">
                    <span>{selectedLocalSalesOrderIds.length.toLocaleString("en-US")} selected</span>
                    <span>Sales uses invoice conversion. Delete is blocked when PO or invoice already exists.</span>
                  </div>
                  <div className="toolbar toolbar--wrap">
                    <Button
                      variant="secondary"
                      className="button--compact"
                      onClick={() =>
                        setSelectedLocalSalesOrderIds((current) =>
                          current.length === filteredLocalSalesOrders.length ? [] : filteredLocalSalesOrders.map((order) => order.id),
                        )
                      }
                    >
                      {selectedLocalSalesOrderIds.length === filteredLocalSalesOrders.length ? "Clear Selection" : "Select Filtered"}
                    </Button>
                    <Button
                      variant="secondary"
                      className="button--compact danger-button"
                      onClick={() => void handleDeleteSalesOrders(selectedLocalSalesOrderIds)}
                    >
                      Bulk Delete
                    </Button>
                    <Button
                      variant="secondary"
                      className="button--compact"
                      onClick={() => void handleConvertSalesOrdersToInvoices(selectedLocalSalesOrderIds)}
                    >
                      Bulk Convert Invoice
                    </Button>
                    {currentLocalSalesOrder ? (
                      <>
                        <Button
                          variant="secondary"
                          className="button--compact danger-button"
                          onClick={() => void handleDeleteSalesOrders([currentLocalSalesOrder.id])}
                        >
                          Delete Current
                        </Button>
                        <Button
                          variant="secondary"
                          className="button--compact"
                          onClick={() => void handleConvertSalesOrdersToInvoices([currentLocalSalesOrder.id])}
                        >
                          Convert Current Invoice
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <DataTable
                rows={filteredLocalSalesOrders}
                columns={savedSalesOrderColumns}
                emptyText="No saved sales orders found."
                onRowClick={(row) =>
                  void confirmSalesOrderNavigation(async () => {
                    setSalesOrdersView("detail");
                    await loadLocalSalesOrderIntoEditor(row);
                  })
                }
                rowClassName={(row) => (row.id === selectedLocalSalesOrderId ? "data-table__row--active" : "")}
              />
            </div>
          ) : null}
          {loadingQuotes ? <div className="empty-state">Loading sales orders...</div> : null}
          {!loadingQuotes && error ? <div className="empty-state error-text">{error}</div> : null}
        </div>
      </aside>
      ) : null}

      {salesOrdersView === "detail" ? (
      <section className="quote-editor-panel">
        <div className="quote-editor-panel__header">
          <div>
            <span className="settings-label">Sales Order</span>
            <h2>{quoteNo || String(detail.quote?.quote_no || (workbenchMode === "new" ? "New Sales Order" : "Draft Sales Order"))}</h2>
            <p>
              {workbenchMode === "new"
                ? "Create a new manual sales order. Purchase options stay selectable per line."
                : customerName || String(detail.quote?.customer_name || "Open an existing sales order or start a new one.")}
            </p>
            {currentLocalSalesOrder ? (
              <div className="document-marks document-marks--header">
                <div className={`status-badge ${currentLocalSalesOrder.status === "confirmed" ? "status-badge--success" : ""}`}>
                  {currentLocalSalesOrder.status.toUpperCase()}
                </div>
                {currentLocalSalesOrder.source_channel === "portal" && currentLocalSalesOrder.portal_submitted_at ? (
                  <span className="mark-badge mark-badge--accent">
                    {isDraftPortalAlert(
                      currentLocalSalesOrder,
                      salesOrderDocumentState.purchaseOrderCountBySalesOrderId.get(currentLocalSalesOrder.id) || 0,
                      salesOrderDocumentState.invoiceCountBySalesOrderId.get(currentLocalSalesOrder.id) || 0,
                    )
                      ? "New Portal Order"
                      : "Portal Order"}
                  </span>
                ) : null}
                {(salesOrderDocumentState.purchaseOrderCountBySalesOrderId.get(currentLocalSalesOrder.id) || 0) > 0 ? (
                  <span className="mark-badge mark-badge--info">
                    PO {(salesOrderDocumentState.purchaseOrderCountBySalesOrderId.get(currentLocalSalesOrder.id) || 0).toLocaleString("en-US")} created
                  </span>
                ) : null}
                {(salesOrderDocumentState.invoiceCountBySalesOrderId.get(currentLocalSalesOrder.id) || 0) > 0 ? (
                  <span className="mark-badge mark-badge--accent">
                    Invoice {(salesOrderDocumentState.invoiceCountBySalesOrderId.get(currentLocalSalesOrder.id) || 0).toLocaleString("en-US")} created
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="toolbar toolbar--wrap">
            <div className="quote-toolbar-brand">
              <Select
                label="Brand Context"
                value={quoteBrandSelection}
                options={[
                  { value: "", label: "Select brand" },
                  ...brandOptions,
                  { value: "__manual__", label: "Manual entry..." },
                ]}
                onChange={(value) => {
                  setQuoteBrandSelection(value);
                  if (value && value !== "__manual__") setQuoteBrand(value);
                  if (!value) setQuoteBrand("");
                }}
              />
              {quoteBrandSelection === "__manual__" ? (
                <Input value={quoteBrand} onChange={setQuoteBrand} placeholder="Manual brand" />
              ) : null}
            </div>
            <input
              ref={importRef}
              type="file"
              accept=".csv,.tsv,.txt"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImportQuoteFile(file);
              }}
            />
            <Button variant="secondary" onClick={() => importRef.current?.click()} busy={importingLines} busyLabel="Importing...">
              Import CSV
            </Button>
            <Button variant="secondary" onClick={downloadQuoteTemplate}>
              Sample Template
            </Button>
            <Button variant="secondary" onClick={handleExportQuoteXlsx} busy={exportingXlsx} busyLabel="Preparing Excel...">
              Internal Excel
            </Button>
            <Button variant="secondary" onClick={handlePrintDraftPdf} busy={printingDraft} busyLabel="Opening PDF...">
              PDF / Print
            </Button>
            {quoteBuilderLines.length ? (
              <>
                <label className="checkbox-field quote-toolbar-checkbox">
                  <input type="checkbox" checked={resyncOnlyFillBlanks} onChange={(event) => setResyncOnlyFillBlanks(event.target.checked)} />
                  <span className="field__label">Only Fill Blanks</span>
                </label>
                <label className="checkbox-field quote-toolbar-checkbox">
                  <input type="checkbox" checked={resyncKeepPrices} onChange={(event) => setResyncKeepPrices(event.target.checked)} />
                  <span className="field__label">Keep Prices</span>
                </label>
                <Button variant="secondary" onClick={() => void handleResyncFromCatalog()} busy={resyncingCatalog} busyLabel="Re-syncing...">
                  Re-sync from Catalog
                </Button>
              </>
            ) : null}
            <Button variant="secondary" onClick={() => void handleSaveDraft()} busy={savingDraft} busyLabel="Saving Draft...">
              Save Draft
            </Button>
            <Button onClick={() => void handleMarkConfirmed()} busy={confirmingOrder} busyLabel="Confirming...">
              Mark as Confirmed
            </Button>
            <Button variant="secondary" className="danger-button" onClick={clearDraft}>
              Clear Draft
            </Button>
            <Button variant="secondary" onClick={closeSalesOrderEditor}>
              Exit
            </Button>
          </div>
        </div>

        <div className="section-card quote-workbench-card">
          <div className="section-card__header section-card__header--row">
            <div>
              <h2>Sales Order Workbench</h2>
              <p>Purchase options stay visible internally. Use PDF View to preview the customer-facing version.</p>
            </div>
            <div className="workbench-controls">
              <label className="quote-pdf-toggle">
                <span>Show PDF View</span>
                <input type="checkbox" checked={pdfView} onChange={(event) => setPdfView(event.target.checked)} />
              </label>
            </div>
          </div>
          <div className="section-card__body">
            <div className="quote-layout-grid">
              <div className="quote-draft-block">
                <div className="invoice-edit-shell">
                  <div className="invoice-edit-topbar">
                    <div className="invoice-customer-field">
                      <Select
                        label="Customer"
                        value={customerSelection}
                        options={customerOptions}
                        onChange={(value) => {
                          setCustomerSelection(value);
                          if (value !== "__manual__") {
                            setCustomerName(value);
                            const customer = findCustomerByNameInList(customers, value);
                            setSellerInfo(customer?.contract_nr || customerContractMap.get(String(value).trim().toLowerCase()) || "");
                            if (customer?.currency) setCurrency(customer.currency);
                            if (customer?.payment_terms) {
                              setPaymentTermsSelection(toTermSelection(customer.payment_terms, PAYMENT_TERM_OPTIONS));
                              setPaymentTerms(customer.payment_terms);
                            }
                            if (customer?.price_list_type) setCustomerType(customer.price_list_type);
                          }
                        }}
                      />
                    </div>
                    {otherMarginActive ? <span className="mark-badge mark-badge--accent">Other Margin {customerMarginOverride}%</span> : null}
                    <Select
                      label="Currency"
                      value={currency}
                      fieldClassName="field--mini invoice-currency-field"
                      options={[
                        { value: "EUR", label: "EUR" },
                        { value: "USD", label: "USD" },
                        { value: "TRY", label: "TRY" },
                      ]}
                      onChange={setCurrency}
                    />
                  </div>

                  {customerSelection === "__manual__" ? (
                    <label className="field invoice-manual-customer">
                      <span className="field__label">Manual Customer</span>
                      <input
                        className="field__input"
                        value={manualCustomerName}
                        onChange={(event) => {
                          setManualCustomerName(event.target.value);
                          setCustomerName(event.target.value);
                        }}
                        placeholder='LLC "Yural"'
                      />
                    </label>
                  ) : null}

                  <div className="invoice-address-grid">
                    <div className="invoice-address-card">
                      <div className="invoice-address-card__title">Billing Address</div>
                      <div className="invoice-address-card__body">{buildCustomerAddressBlock(selectedCustomerProfile, resolvedCustomerName || "-")}</div>
                    </div>
                    <div className="invoice-address-card">
                      <div className="invoice-address-card__title">Shipping Address</div>
                      <div className="invoice-address-card__body">{buildCustomerShippingBlock(selectedCustomerProfile, resolvedCustomerName || "-")}</div>
                    </div>
                    <div className="invoice-company-pill">{sellerCompany || "No seller company selected"}</div>
                  </div>

                  <div className="invoice-meta-grid">
                    <label className="field">
                      <span className="field__label">Sales Order#</span>
                      <input className="field__input" value={quoteNo} onChange={(event) => setQuoteNo(event.target.value)} placeholder="FU26-Y43921" />
                    </label>
                    <label className="field">
                      <span className="field__label">Order Number</span>
                      <input className="field__input" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Customer order number" />
                    </label>
                    <label className="field field--date-compact">
                      <span className="field__label">Invoice Date</span>
                      <input className="field__input" type="date" value={quoteDate} onChange={(event) => setQuoteDate(event.target.value)} />
                    </label>
                    <Select
                      label="Terms"
                      value={paymentTermsSelection}
                      options={[
                        { value: "", label: "Select payment terms" },
                        ...PAYMENT_TERM_OPTIONS.map((item) => ({ value: item, label: item })),
                        { value: "__manual__", label: "Manual entry..." },
                      ]}
                      onChange={(value) => {
                        setPaymentTermsSelection(value);
                        if (value && value !== "__manual__") setPaymentTerms(value);
                        if (!value) setPaymentTerms("");
                      }}
                    />
                    <label className="field field--date-compact">
                      <span className="field__label">Due Date</span>
                      <input className="field__input" type="date" value={quoteDate} onChange={(event) => setQuoteDate(event.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field__label">Contract Nr</span>
                      <input className="field__input" value={sellerInfo} onChange={(event) => setSellerInfo(event.target.value)} placeholder="Customer contract no" />
                    </label>
                  </div>

                  <div className="invoice-internal-panel">
                    <div className="quote-form-panel__title">Internal Purchase Controls</div>
                    <div className="quote-compact-grid">
                      <Select label="Seller Company" value={sellerCompany} options={companyOptions} onChange={setSellerCompany} />
                      <Select
                        label="Purchase Mode"
                        value={supplierMode}
                        options={[
                          { value: "Best price", label: "Best price" },
                          { value: "Manual comparison", label: "Manual comparison" },
                        ]}
                        onChange={setSupplierMode}
                      />
                      <label className="field">
                        <span className="field__label">Purchase Company</span>
                        <select className="field__input" value={buyerInfo} onChange={(event) => setBuyerInfo(event.target.value)}>
                          <option value="">Select purchase company</option>
                          {companyOptions.map((option) => (
                            <option key={`buyer-${option.value}`} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Select
                        label="Customer Type"
                        value={customerType}
                        options={[
                          { value: "A", label: "A Price List" },
                          { value: "B", label: "B Price List" },
                          { value: "C", label: "C Price List" },
                          { value: "Other", label: "Other Margin" },
                        ]}
                        onChange={(value) => setCustomerType(value as "A" | "B" | "C" | "Other")}
                      />
                      {otherMarginActive ? <div className="field"><span className="field__label">Custom Margin</span><span className="mark-badge mark-badge--accent">{customerMarginOverride}% active</span></div> : null}
                      <Select
                        label="Delivery Terms"
                        value={deliveryTermSelection}
                        options={[
                          { value: "", label: "Select delivery terms" },
                          ...DELIVERY_TERM_OPTIONS.map((item) => ({ value: item, label: item })),
                          { value: "__manual__", label: "Manual entry..." },
                        ]}
                        onChange={(value) => {
                          setDeliveryTermSelection(value);
                          if (value && value !== "__manual__") setDeliveryTerm(value);
                          if (!value) setDeliveryTerm("");
                        }}
                      />
                      {deliveryTermSelection === "__manual__" ? (
                        <label className="field">
                          <span className="field__label">Manual Delivery Terms</span>
                          <input className="field__input" value={deliveryTerm} onChange={(event) => setDeliveryTerm(event.target.value)} placeholder="Custom delivery term" />
                        </label>
                      ) : null}
                      {paymentTermsSelection === "__manual__" ? (
                        <label className="field">
                          <span className="field__label">Manual Payment Terms</span>
                          <input className="field__input" value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value)} placeholder="Custom payment terms" />
                        </label>
                      ) : null}
                      <label className="field">
                        <span className="field__label">Packing</span>
                        <input className="field__input" value={packingDetails} onChange={(event) => setPackingDetails(event.target.value)} placeholder="Pallet / package info" />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="meta-row">
              <span>{quoteBuilderLines.length.toLocaleString("en-US")} sales order draft lines</span>
              {builderStatus ? <span className={builderStatus.includes("No system") || builderStatus.includes("failed") ? "error-text" : "success-text"}>{builderStatus}</span> : null}
            </div>
            {discontinuedLineCount > 0 ? (
              <div className="warning-text">
                {discontinuedLineCount.toLocaleString("en-US")} discontinued item(s) detected in this sales order. Review before confirmation.
              </div>
            ) : null}
            {attentionLines.length ? (
              <div className="attention-panel">
                <div className="attention-panel__header">
                  <div>
                    <strong>Warning Items</strong>
                    <div className="info-text">
                      {attentionLines.length.toLocaleString("en-US")} line(s) need review. This panel isolates discontinued, replacement, unmatched, and no-price rows.
                    </div>
                  </div>
                </div>
                <DataTable rows={attentionLines} columns={attentionColumns} emptyText="No warning items." />
              </div>
            ) : null}
            <DataTable
              rows={quoteBuilderLines}
              columns={builderColumns}
              emptyText="No sales order lines yet. Add a product code or import a sales order file."
              onRowClick={(row) => setQuoteLinePreview(row)}
            />
          </div>
        </div>

        <div className="section-card">
          <div className="section-card__body">
            <div className="quote-bottom-layout">
              <div className="quote-bottom-left">
                <label className="field quote-notes-block">
                  <span className="field__label">Notes</span>
                  <textarea
                    className="field__input quote-notes-input"
                    value={quoteNotes}
                    onChange={(event) => setQuoteNotes(event.target.value)}
                    placeholder="Customer notes or final remarks"
                    rows={4}
                  />
                </label>

                <div className="quote-add-row-panel">
                  <div className="quote-add-row-panel__title">Add New Row</div>
                  <div className="quote-line-toolbar quote-line-toolbar--bottom">
                    <Input value={quoteCode} onChange={setQuoteCode} placeholder="Part No or name" />
                    <Select
                      label=""
                      value={quoteBrandSelection}
                      options={[
                        { value: "", label: "Select brand" },
                        ...brandOptions,
                        { value: "__manual__", label: "Manual entry..." },
                      ]}
                      onChange={(value) => {
                        setQuoteBrandSelection(value);
                        if (value && value !== "__manual__") setQuoteBrand(value);
                        if (!value) setQuoteBrand("");
                      }}
                    />
                    {quoteBrandSelection === "__manual__" ? <Input value={quoteBrand} onChange={setQuoteBrand} placeholder="Manual brand" /> : null}
                    <Input value={quoteQty} onChange={setQuoteQty} placeholder="Qty" />
                    <Button onClick={() => void handleResolveQuoteLine()} busy={resolvingLine} busyLabel="Resolving...">
                      Add New Row
                    </Button>
                    <Button variant="secondary" onClick={() => importRef.current?.click()} busy={importingLines} busyLabel="Importing...">
                      Add Items in Bulk
                    </Button>
                  </div>
                </div>
              </div>

              <div className="quote-bottom-right">
                <div className="quote-summary-card">
                  <div className="quote-summary-row">
                    <span>Sub Total</span>
                    <strong>{formatMoney(draftTotals.subtotal, currency)}</strong>
                  </div>
                  <div className="quote-summary-row">
                    <span>Discount</span>
                    <div className="quote-summary-input-wrap">
                      <input className="field__input quote-total-input" value={discountAmount} onChange={(event) => setDiscountAmount(event.target.value)} placeholder="0.00" />
                    </div>
                  </div>
                  <div className="quote-summary-row">
                    <span>Shipping</span>
                    <div className="quote-summary-input-wrap">
                      <input className="field__input quote-total-input" value={shippingCost} onChange={(event) => setShippingCost(event.target.value)} placeholder="0.00" />
                    </div>
                  </div>
                  <div className="quote-summary-row quote-summary-row--total">
                    <span>Total Amount</span>
                    <strong>{formatMoney(draftTotals.totalAmount, currency)}</strong>
                  </div>

                  <div className="quote-summary-internal">
                    <div className="quote-summary-mini">
                      <span>Purchase Total</span>
                      <strong>{formatMoney(draftTotals.purchase, currency)}</strong>
                    </div>
                    <div className="quote-summary-mini">
                      <span>Profit</span>
                      <strong>{formatMoney(draftTotals.profit, currency)}</strong>
                    </div>
                    <div className="quote-summary-mini">
                      <span>Margin %</span>
                      <strong>{draftTotals.margin}%</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      ) : null}

      {invoicePromptOpen && pendingConfirmedOrder ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <h3>Convert to Invoice?</h3>
              <p>
                {pendingConfirmedOrder.sales_order_no} confirmed and supplier purchase orders created. Do you want to create the sales invoice now?
              </p>
            </div>
            <div className="modal-hint">
              Customer: {pendingConfirmedOrder.customer_name || "-"} | Total Amount: {formatMoney(pendingConfirmedOrder.sales_total, pendingConfirmedOrder.currency)}
            </div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setInvoicePromptOpen(false);
                  setPendingConfirmedOrder(null);
                  actionFeedback.succeed("Purchase orders created. Invoice conversion postponed.");
                }}
                disabled={creatingInvoice}
              >
                Later
              </Button>
              <Button onClick={() => void handleConvertConfirmedToInvoice()} busy={creatingInvoice} busyLabel="Creating Invoice...">
                Convert to Invoice
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {quoteLinePreview ? (
        <div className="modal-backdrop" onClick={() => setQuoteLinePreview(null)}>
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card__header draggable-surface__handle">
              <h3>{quoteLinePreview.resolvedCode || quoteLinePreview.requestedCode || "-"}</h3>
              <p>Sales order line preview</p>
            </div>
            <div className="document-marks document-marks--compact">
              <span className="mark-badge">{quoteLinePreview.brand || "No brand"}</span>
              {getQuoteBuilderLineIssues(quoteLinePreview).map((issue) => (
                <span
                  key={`${quoteLinePreview.lineId}-${issue}`}
                  className={`mark-badge ${
                    issue === "Discontinued" ? "mark-badge--danger" : issue === "Replacement" ? "mark-badge--accent" : "mark-badge--info"
                  }`}
                >
                  {issue}
                </span>
              ))}
            </div>
            <div className="workbench-detail-list">
              <div><span>Description</span><strong>{quoteLinePreview.description || "-"}</strong></div>
              <div><span>Requested Code</span><strong>{quoteLinePreview.requestedCode || "-"}</strong></div>
              <div><span>Quantity</span><strong>{quoteLinePreview.qty}</strong></div>
              <div><span>Origin</span><strong>{quoteLinePreview.origin || "-"}</strong></div>
              <div><span>Weight</span><strong>{quoteLinePreview.weight_kg ?? "-"}</strong></div>
              <div><span>Supplier</span><strong>{quoteLinePreview.supplier_name || "-"}</strong></div>
              <div><span>Buy</span><strong>{formatMoney(quoteLinePreview.buy_price, currency)}</strong></div>
              <div><span>Sell</span><strong>{formatMoney(quoteLinePreview.sell_price, currency)}</strong></div>
              <div><span>Price Date</span><strong>{formatDate(quoteLinePreview.price_date)}</strong></div>
            </div>
            {quoteLinePreview.codeChanged ? <div className="warning-text">{quoteLinePreview.codeChangeWarning}</div> : null}
            {quoteLinePreview.notes ? <div className="info-text">{quoteLinePreview.notes}</div> : null}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setQuoteLinePreview(null)}>
                Close
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}
    </div>
  );
}
