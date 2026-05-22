import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchCompanyProfiles, findCompanyProfileByName } from "../../infrastructure/api/companyProfilesApi";
import { findCodeReferenceMatch } from "../../infrastructure/api/codeReferencesApi";
import { fetchCustomers, findCustomerByNameInList } from "../../infrastructure/api/customersApi";
import {
  fetchInvoices,
  fetchPurchaseOrders,
  fetchSalesOrders,
  markSalesOrderPortalSeen,
  replacePurchaseOrdersForSalesOrder,
  upsertInvoice,
  upsertSalesOrder,
} from "../../infrastructure/api/ordersApi";
import { batchResolveQuoteImportRows, fetchCatalogMetadataForRows } from "../../infrastructure/api/quoteImportApi";
import { fetchCPriceMapForRows, getCPriceForRow } from "../../infrastructure/api/cPriceApi";
import { fetchPriceListSettings } from "../../infrastructure/api/priceListsApi";
import { resolveQuoteLine } from "../../infrastructure/api/quoteResolverApi";
import { fetchCloudQuoteDetail, fetchCloudQuotes } from "../../infrastructure/api/quotesApi";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { buildInventoryAvailabilityLookup, fetchInventoryAvailabilitySummary, inventoryAvailabilityLookupKey, type InventoryAvailabilitySummary } from "../../infrastructure/api/inventoryApi";
import { normalizePartCode } from "../../domain/shared/normalize";
import { parseCsv } from "../../shared/csv";
import { downloadQuoteTemplate } from "../../shared/importTemplates";
import { buildInvoiceFromSalesOrder, buildLocalSalesOrder, buildPurchaseOrdersFromSalesOrder } from "../../shared/localOrders";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { buildBusinessDocumentHtml } from "../../shared/documentPrint";
import { Select } from "../components/common/Select";
import type { CompanyProfile } from "../../types/company";
import type { LocalCustomer } from "../../types/customers";
import type { CodeReferenceMatch } from "../../types/codeReferences";
import type { LocalInvoice, LocalPurchaseOrder, LocalSalesOrder } from "../../types/orders";
import type { QuoteBuilderLine } from "../../types/quoteBuilder";
import type { QuoteDetail, QuoteSummary } from "../../types/quotes";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";

type QuotesPageProps = {
  selectedSalesOrderId?: string;
  onSelectedSalesOrderChange?: (salesOrderId: string) => void;
  selectedQuoteId?: string;
  onSelectedQuoteChange?: (quoteId: string) => void;
};

type QuoteImportRow = {
  code: string;
  brand: string;
  qty: number;
};

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
  const displayName = customer.display_name || customer.company_name || `${customer.first_name} ${customer.last_name}`.trim() || fallbackName || "-";
  return [displayName, customer.billing_address || "", customer.company_id ? `Company ID ${customer.company_id}` : "", customer.work_phone ? `Phone: ${customer.work_phone}` : "", customer.email || ""]
    .filter(Boolean)
    .join("\n");
}

function buildCustomerShippingBlock(customer: LocalCustomer | null, fallbackName: string) {
  if (!customer) return fallbackName || "-";
  const displayName = customer.display_name || customer.company_name || `${customer.first_name} ${customer.last_name}`.trim() || fallbackName || "-";
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
  return `${brand.trim().toLowerCase()}::${normalizePartCode(productCode)}`;
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

function mapDetailLineToBuilderLine(
  line: QuoteDetail["lines"][number],
  currencyType: "A" | "B" | "C" | "Other",
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
  const sellPrice = currencyType === "C" ? cSell ?? baseSell : baseSell;
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
    requestedCode: line.product_code || "",
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
    codeChanged: false,
    codeChangeWarning: "",
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
        description: line.description || "",
        origin: line.origin || "",
        brand: line.brand || "",
        orderNo: input.quoteNo || "-",
        weight: line.weight_kg == null ? "" : String(line.weight_kg),
        gtip: line.hs_code || "",
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
}: QuotesPageProps) {
  const actionFeedback = useActionFeedback();
  const importRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [salesOrdersView, setSalesOrdersView] = useState<"list" | "detail">(externalSelectedQuoteId || externalSelectedSalesOrderId ? "detail" : "list");
  const [salesOrderFilter, setSalesOrderFilter] = useState<"all" | "draft" | "confirmed" | "purchased" | "invoiced">("all");
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [localSalesOrders, setLocalSalesOrders] = useState<LocalSalesOrder[]>([]);
  const [savedPurchaseOrders, setSavedPurchaseOrders] = useState<LocalPurchaseOrder[]>([]);
  const [savedInvoices, setSavedInvoices] = useState<LocalInvoice[]>([]);
  const [selectedLocalSalesOrderId, setSelectedLocalSalesOrderId] = useState("");
  const [workbenchMode, setWorkbenchMode] = useState<"existing" | "new">("existing");
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [detail, setDetail] = useState<QuoteDetail>({ quote: null, lines: [] });
  const [loadingQuotes, setLoadingQuotes] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [searchingQuotes, setSearchingQuotes] = useState(false);
  const [pdfView, setPdfView] = useState(false);

  const [quoteCode, setQuoteCode] = useState("");
  const [quoteBrand, setQuoteBrand] = useState("");
  const [quoteBrandSelection, setQuoteBrandSelection] = useState("");
  const [quoteQty, setQuoteQty] = useState("1");
  const [brandOptions, setBrandOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [customerType, setCustomerType] = useState<"A" | "B" | "C" | "Other">("A");
  const [marginA, setMarginA] = useState(10);
  const [marginB, setMarginB] = useState(15);
  const [quoteBuilderLines, setQuoteBuilderLines] = useState<QuoteBuilderLine[]>([]);
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [builderStatus, setBuilderStatus] = useState("");
  const [resolvingLine, setResolvingLine] = useState(false);
  const [importingLines, setImportingLines] = useState(false);
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [printingDraft, setPrintingDraft] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [confirmingOrder, setConfirmingOrder] = useState(false);
  const [invoicePromptOpen, setInvoicePromptOpen] = useState(false);
  const [pendingConfirmedOrder, setPendingConfirmedOrder] = useState<LocalSalesOrder | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [inventoryAvailabilityRows, setInventoryAvailabilityRows] = useState<InventoryAvailabilitySummary[]>([]);

  const [quoteNo, setQuoteNo] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerSelection, setCustomerSelection] = useState("");
  const [manualCustomerName, setManualCustomerName] = useState("");
  const [sellerCompany, setSellerCompany] = useState("");
  const [quoteDate, setQuoteDate] = useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState("EUR");
  const [shippingCost, setShippingCost] = useState("0");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [supplierMode, setSupplierMode] = useState("Best price");
  const [sellerInfo, setSellerInfo] = useState("");
  const [buyerInfo, setBuyerInfo] = useState("");
  const [deliveryTermSelection, setDeliveryTermSelection] = useState("");
  const [paymentTermsSelection, setPaymentTermsSelection] = useState("");
  const [deliveryTerm, setDeliveryTerm] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [packingDetails, setPackingDetails] = useState("");
  const [quoteNotes, setQuoteNotes] = useState("");

  const selectedCustomerProfile = useMemo(() => {
    const customerLabel = customerSelection === "__manual__" ? manualCustomerName : customerName;
    return customerLabel ? findCustomerByNameInList(customers, customerLabel) : null;
  }, [customers, customerSelection, customerName, manualCustomerName]);

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
        const [salesOrderRows, purchaseOrderRows, invoiceRows] = await Promise.all([fetchSalesOrders(), fetchPurchaseOrders(), fetchInvoices()]);
        if (!cancelled) {
          setLocalSalesOrders(salesOrderRows);
          setSavedPurchaseOrders(purchaseOrderRows);
          setSavedInvoices(invoiceRows);
        }
      } catch {
        if (!cancelled) {
          setLocalSalesOrders([]);
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
  }, []);

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
              mapDetailLineToBuilderLine(line, customerType, resolvedPatches[index] || undefined, resolvedPatches[index]?.supplierOptions),
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
  }, [selectedQuoteId, customerType, effectiveMarginA, effectiveMarginB]);

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

  useEffect(() => {
    setQuoteBuilderLines((current) =>
      current.map((line) => {
        const selected =
          line.supplierOptions.find((option, index) => `${option.supplier_name}-${index}` === line.selectedSupplierKey) ||
          line.supplierOptions[0] ||
          null;
        const buyPrice = selected?.buy_price ?? line.buy_price;
        if (buyPrice == null) return line;
        if (customerType === "C") {
          return {
            ...line,
            supplier_name: line.supplier_name || selected?.supplier_name || "",
            buy_price: buyPrice,
            sell_price: line.c_sell_price ?? line.sell_price,
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
  }, [customerType, effectiveMarginA, effectiveMarginB]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (customerType !== "C" || !quoteBuilderLines.length) return;

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
          return {
            ...line,
            c_sell_price: cSellPrice,
            sell_price: cSellPrice ?? line.sell_price,
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
    quoteBuilderLines.length,
    quoteBuilderLines.map((line) => `${line.brand}|${line.resolvedCode || line.requestedCode}`).join("||"),
  ]);

  const currentLocalSalesOrder = useMemo(
    () => localSalesOrders.find((item) => item.id === selectedLocalSalesOrderId) || null,
    [localSalesOrders, selectedLocalSalesOrderId],
  );

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

  async function hydrateStoredBuilderLine(line: QuoteBuilderLine, orderCustomerType: "A" | "B" | "C" | "Other") {
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
          sell_price: orderCustomerType === "C" ? line.c_sell_price ?? sellBase : sellBase,
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
          sell_price: orderCustomerType === "C" ? line.c_sell_price ?? sellBase : sellBase,
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
        sell_price:
          orderCustomerType === "C"
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
    setWorkbenchMode("existing");
    setSelectedLocalSalesOrderId(order.id);
    setSelectedQuoteId("");
    onSelectedQuoteChange?.("");
    setQuoteNo(order.sales_order_no);
    setCustomerName(order.customer_name);
    setCustomerSelection(order.customer_name || "");
    setManualCustomerName("");
    setSellerCompany(order.seller_company || "");
    setQuoteDate(order.quote_date);
    setCurrency(order.currency || "EUR");
    setQuoteBrand("");
    setQuoteBrandSelection("");
    setCustomerType(order.customer_type);
    setShippingCost(String(order.shipping_cost ?? 0));
    setDiscountAmount(String(order.discount_amount ?? 0));
    setSupplierMode(order.supplier_mode || "Best price");
    setSellerInfo(order.seller_info || "");
    setBuyerInfo(order.buyer_info || order.purchase_company || "");
    setDeliveryTermSelection(toTermSelection(order.delivery_term || "", DELIVERY_TERM_OPTIONS));
    setPaymentTermsSelection(toTermSelection(order.payment_terms || "", PAYMENT_TERM_OPTIONS));
    setDeliveryTerm(order.delivery_term || "");
    setPaymentTerms(order.payment_terms || "");
    setPackingDetails(order.packing_details || "");
    setQuoteNotes(order.notes || "");
    actionFeedback.begin(`Loading ${order.sales_order_no}...`);
    const metadataMap = await fetchCatalogMetadataForRows(
      (order.lines || []).map((line) => ({
        brand: line.brand || "",
        product_code: line.resolvedCode || line.requestedCode,
      })),
    );
    const hydratedLines = await Promise.all(
      (order.lines || []).map(async (line) => {
        const patched = applyCatalogMetadata(line, metadataMap);
        const selectedFromOptions =
          patched.supplierOptions.find((option, index) => `${option.supplier_name}-${index}` === patched.selectedSupplierKey) ||
          patched.supplierOptions[0] ||
          null;
        const hasVisiblePrices = Number(patched.buy_price ?? 0) > 0 || Number(patched.sell_price ?? 0) > 0;
        const optionHasPrices = selectedFromOptions ? Number(selectedFromOptions.buy_price ?? 0) > 0 || Number(selectedFromOptions.sell_price ?? 0) > 0 : false;
        if (hasVisiblePrices || optionHasPrices) {
          const buyPrice = hasVisiblePrices ? patched.buy_price : selectedFromOptions?.buy_price ?? null;
          const sellBase = hasVisiblePrices ? patched.sell_price : selectedFromOptions?.sell_price ?? null;
          return {
            ...patched,
            supplier_name: patched.supplier_name || selectedFromOptions?.supplier_name || "",
            buy_price: buyPrice,
            sell_price: order.customer_type === "C" ? patched.c_sell_price ?? sellBase : sellBase,
            price_date: patched.price_date || selectedFromOptions?.price_date || "",
            notes: patched.notes || selectedFromOptions?.notes || "",
          };
        }
        return await hydrateStoredBuilderLine(patched, order.customer_type);
      }),
    );
    if (order.source_channel === "portal" && order.portal_submitted_at && !order.portal_seen_at) {
      try {
        const seenOrder = await markSalesOrderPortalSeen(order.id);
        if (seenOrder) {
          setLocalSalesOrders((current) => current.map((item) => (item.id === seenOrder.id ? seenOrder : item)));
        }
      } catch {
        // opening order should continue even if seen state update fails
      }
    }
    setQuoteBuilderLines(hydratedLines);
    setBuilderStatus(`Loaded ${order.sales_order_no} (${order.status}).`);
    actionFeedback.succeed(`${order.sales_order_no} loaded.`);
  }

  function buildSalesOrderPayload(status: "draft" | "confirmed") {
    return buildLocalSalesOrder({
      id: selectedLocalSalesOrderId || undefined,
      sales_order_no: quoteNo.trim() || `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString().slice(-4)}`,
      customer_name: customerSelection === "__manual__" ? manualCustomerName.trim() : customerName.trim(),
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
      { key: "brand", header: "Brand", render: (row: QuoteBuilderLine) => row.brand || "-" },
      { key: "name", header: "Description", render: (row: QuoteBuilderLine) => row.description || "-" },
      { key: "oem", header: "OEM", render: (row: QuoteBuilderLine) => row.oem_no || "-" },
      { key: "origin", header: "Origin", render: (row: QuoteBuilderLine) => row.origin || "-" },
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

    if (!pdfView) {
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
                      customerType === "C"
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
      columns.push({ key: "supplier", header: "Supplier", render: (row: QuoteBuilderLine) => row.supplier_name || "-" });
      columns.push({ key: "buy", header: "Buy", render: (row: QuoteBuilderLine) => formatMoney(row.buy_price, currency) });
      columns.push({ key: "buyTotal", header: "Buy Total", render: (row: QuoteBuilderLine) => formatMoney(roundMoney(toNumber(row.buy_price) * row.qty), currency) });
    }

    columns.push({ key: "sell", header: pdfView ? "Unit Price" : "Sell", render: (row: QuoteBuilderLine) => formatMoney(row.sell_price, currency) });
    columns.push({ key: "sellTotal", header: "Line Total", render: (row: QuoteBuilderLine) => formatMoney(roundMoney(toNumber(row.sell_price) * row.qty), currency) });

    if (!pdfView) {
      columns.push({
        key: "profit",
        header: "Profit",
        render: (row: QuoteBuilderLine) => formatMoney(roundMoney((toNumber(row.sell_price) - toNumber(row.buy_price)) * row.qty), currency),
      });
      columns.push({
        key: "margin",
        header: "Margin %",
        render: (row: QuoteBuilderLine) => {
          const sellTotal = toNumber(row.sell_price) * row.qty;
          const profit = (toNumber(row.sell_price) - toNumber(row.buy_price)) * row.qty;
          return sellTotal > 0 ? `${roundMoney((profit / sellTotal) * 100)}%` : "-";
        },
      });
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
  }, [currency, customerType, pdfView, effectiveMarginA, effectiveMarginB, inventoryAvailabilityLookup]);

  const detailColumns = useMemo(() => {
    const columns = [
      { key: "code", header: "Code", render: (row: QuoteDetail["lines"][number]) => row.product_code || "-" },
      { key: "brand", header: "Brand", render: (row: QuoteDetail["lines"][number]) => row.brand_text || "-" },
      { key: "name", header: "Description", render: (row: QuoteDetail["lines"][number]) => row.description || "-" },
      { key: "qty", header: "Qty", render: (row: QuoteDetail["lines"][number]) => row.qty ?? "-" },
      { key: "sell", header: pdfView ? "Unit Price" : "Sell", render: (row: QuoteDetail["lines"][number]) => formatMoney(row.sell_price, String(detail.quote?.currency || currency)) },
      { key: "lineTotal", header: "Line Total", render: (row: QuoteDetail["lines"][number]) => formatMoney(roundMoney(toNumber(row.sell_price) * toNumber(row.qty)), String(detail.quote?.currency || currency)) },
    ] as Array<{ key: string; header: string; render: (row: QuoteDetail["lines"][number]) => ReactNode }>;

    if (!pdfView) {
      columns.splice(4, 0,
        { key: "supplier", header: "Supplier", render: (row: QuoteDetail["lines"][number]) => row.supplier_name || "-" },
        { key: "buy", header: "Buy", render: (row: QuoteDetail["lines"][number]) => formatMoney(row.buy_price, String(detail.quote?.currency || currency)) },
      );
    }
    return columns;
  }, [currency, detail.quote, pdfView]);

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
    if (customerType === "C") {
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
                sell_price: customerType === "C" ? cSellPrice ?? resolved.sell_price ?? null : resolved.sell_price ?? null,
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
      sell_price:
        customerType === "C"
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

  async function buildImportLines(rows: QuoteImportRow[]) {
    return await batchResolveQuoteImportRows({
      rows,
      customerType,
      marginA: effectiveMarginA,
      marginB: effectiveMarginB,
    });
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
      const hydratedLines = await buildImportLines(normalizedRows);
      setQuoteBuilderLines((current) => [...hydratedLines, ...current]);
      const importedDiscontinuedCount = hydratedLines.filter((line) => line.lifecycle_status === "discontinued").length;
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
        ["Customer", customerSelection === "__manual__" ? manualCustomerName : customerName],
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
        ["Line", "Part No", "Old Code", "Brand", "Description", "OEM", "HS", "Origin", "Weight kg", "Qty", "Supplier", "Price Date", "Buy Unit", "Buy Total", "Sell Unit", "Sell Total", "Profit", "Margin %", "Notes"],
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
      const blob = buildXlsxBlob("Sales Order Draft", rows, [8, 9, 12, 13, 14, 15, 16, 17]);
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
    const win = window.open("about:blank", "_blank");
    if (!win) {
      actionFeedback.fail("Popup blocked while opening PDF view.");
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
    const currentCustomer = findCustomerByNameInList(customers, customerSelection === "__manual__" ? manualCustomerName : customerName);
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
      win.document.write(
        buildDraftQuoteHtml({
          quoteNo,
          quoteDate,
          customerName: customerSelection === "__manual__" ? manualCustomerName : customerName,
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
      win.document.close();
      win.focus();
      actionFeedback.succeed("PDF view opened.");
    } catch (caught) {
      try {
        win.close();
      } catch {
        // no-op
      }
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

  function startNewSalesOrder() {
    setSalesOrdersView("detail");
    setWorkbenchMode("new");
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
    actionFeedback.succeed("New sales order draft ready.");
  }

  function closeSalesOrderEditor() {
    onSelectedSalesOrderChange?.("");
    setSalesOrdersView("list");
    setPdfView(false);
    setBuilderStatus("");
  }

  async function refreshLocalSalesOrders(nextSelectedId?: string) {
    const [nextSalesOrders, nextPurchaseOrders, nextInvoices] = await Promise.all([fetchSalesOrders(), fetchPurchaseOrders(), fetchInvoices()]);
    setLocalSalesOrders(nextSalesOrders);
    setSavedPurchaseOrders(nextPurchaseOrders);
    setSavedInvoices(nextInvoices);
    if (nextSelectedId) {
      setSelectedLocalSalesOrderId(nextSelectedId);
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
      if (!row.sales_order_id) return;
      invoiceCountBySalesOrderId.set(row.sales_order_id, (invoiceCountBySalesOrderId.get(row.sales_order_id) || 0) + 1);
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

  const filteredCloudQuotes = useMemo(() => {
    return quotes.filter((quote) => {
      const status = String(quote.status || "").toLowerCase();
      switch (salesOrderFilter) {
        case "draft":
          return status === "draft";
        case "confirmed":
          return status === "confirmed";
        case "purchased":
        case "invoiced":
          return false;
        default:
          return true;
      }
    });
  }, [quotes, salesOrderFilter]);

  async function handleSaveDraft() {
    if (!quoteBuilderLines.length) {
      actionFeedback.fail("Add sales order lines before saving draft.");
      return;
    }
    try {
      setSavingDraft(true);
      actionFeedback.begin(`Saving draft ${quoteNo || "sales order"}...`);
      const order = buildSalesOrderPayload("draft");
      const saved = await upsertSalesOrder(order);
      await refreshLocalSalesOrders(saved.id);
      setQuoteNo(saved.sales_order_no);
      setBuilderStatus(`Draft saved as ${saved.sales_order_no}.`);
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
      await refreshLocalSalesOrders(saved.id);
      setPendingConfirmedOrder(saved);
      setInvoicePromptOpen(true);
      setQuoteNo(saved.sales_order_no);
      setBuilderStatus(`${saved.sales_order_no} confirmed. ${purchaseOrders.length.toLocaleString("en-US")} purchase orders created by supplier.`);
      actionFeedback.succeed(`${saved.sales_order_no} confirmed. ${purchaseOrders.length.toLocaleString("en-US")} supplier purchase orders created.`);
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
    <div className={`quotes-workspace${salesOrdersView === "list" ? " quotes-workspace--list-only" : ""}`}>
      <aside className={`quote-list-panel${salesOrdersView === "list" ? " quote-list-panel--full" : ""}`}>
        <div className="quote-list-panel__header">
          <div>
            <h2>All Sales Orders</h2>
            <p>Saved cloud sales orders and recent revisions.</p>
          </div>
          <div className="toolbar toolbar--wrap">
            <Button variant="secondary" onClick={startNewSalesOrder}>
              New Sales Order
            </Button>
          </div>
          <div className="sales-order-filter-bar">
            {[
              { value: "all", label: "All" },
              { value: "draft", label: "Draft" },
              { value: "confirmed", label: "Confirmed" },
              { value: "purchased", label: "Purchased" },
              { value: "invoiced", label: "Invoiced" },
            ].map((item) => (
              <button
                key={item.value}
                className={`sales-order-filter-button${salesOrderFilter === item.value ? " active" : ""}`}
                onClick={() => setSalesOrderFilter(item.value as "all" | "draft" | "confirmed" | "purchased" | "invoiced")}
              >
                {item.label}
              </button>
            ))}
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
              <div className="quote-list-section__title">Saved Sales Orders</div>
              <div className="quote-records">
                {filteredLocalSalesOrders.map((order) => {
                  const poCount = salesOrderDocumentState.purchaseOrderCountBySalesOrderId.get(order.id) || 0;
                  const invoiceCount = salesOrderDocumentState.invoiceCountBySalesOrderId.get(order.id) || 0;
                  return (
                  <button
                    key={order.id}
                    className={`quote-record${order.id === selectedLocalSalesOrderId ? " active" : ""}`}
                    onClick={() => {
                      setSalesOrdersView("detail");
                      void loadLocalSalesOrderIntoEditor(order);
                    }}
                  >
                    <div className="quote-record__top">
                      <strong>{order.customer_name || "Unnamed customer"}</strong>
                      <span>{formatMoney(order.sales_total, order.currency || "EUR")}</span>
                    </div>
                    <div className="quote-record__mid">
                      <span>{order.sales_order_no}</span>
                      <span>{formatDate(order.quote_date)}</span>
                    </div>
                    <div className="document-marks">
                      <span className={`mark-badge ${order.status === "confirmed" ? "mark-badge--success" : ""}`}>{order.status.toUpperCase()}</span>
                      {order.source_channel === "portal" && order.portal_submitted_at && !order.portal_seen_at ? (
                        <span className="mark-badge mark-badge--accent">New Order</span>
                      ) : null}
                      {poCount > 0 ? <span className="mark-badge mark-badge--info">{poCount} PO</span> : null}
                      {invoiceCount > 0 ? <span className="mark-badge mark-badge--accent">{invoiceCount} Invoice</span> : null}
                    </div>
                    <div className="quote-record__bottom">{order.lines.length} lines</div>
                  </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="quote-list-section">
            <div className="quote-list-section__title">Cloud Sales Orders</div>
          {loadingQuotes ? <div className="empty-state">Loading sales orders...</div> : null}
          {!loadingQuotes && error ? <div className="empty-state error-text">{error}</div> : null}
          {!loadingQuotes && !error && !filteredCloudQuotes.length ? <div className="empty-state">No sales orders found.</div> : null}
          {!loadingQuotes && !error && filteredCloudQuotes.length ? (
            <div className="quote-records">
              {filteredCloudQuotes.map((quote) => (
                <button
                  key={quote.quote_id}
                  className={`quote-record${quote.quote_id === selectedQuoteId ? " active" : ""}`}
                  onClick={() => {
                    setSalesOrdersView("detail");
                    setWorkbenchMode("existing");
                    setSelectedLocalSalesOrderId("");
                    setSelectedQuoteId(quote.quote_id);
                    onSelectedQuoteChange?.(quote.quote_id);
                  }}
                >
                  <div className="quote-record__top">
                    <strong>{quote.customer_name || "Unnamed customer"}</strong>
                    <span>{formatMoney(quote.sales_total, String(quote.currency || "EUR"))}</span>
                  </div>
                  <div className="quote-record__mid">
                    <span>{quote.quote_no}</span>
                    <span>{formatDate(quote.quote_date)}</span>
                  </div>
                  <div className="quote-record__bottom">{quote.total_quantity ?? 0} pcs</div>
                </button>
              ))}
            </div>
          ) : null}
          </div>
        </div>
      </aside>

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
                    {currentLocalSalesOrder.portal_seen_at ? "Portal Order" : "New Portal Order"}
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
              <p>Purchase options stay visible internally. Switch on PDF View to preview the customer-facing version.</p>
            </div>
            <label className="quote-pdf-toggle">
              <span>Show PDF View</span>
              <input type="checkbox" checked={pdfView} onChange={(event) => setPdfView(event.target.checked)} />
            </label>
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
                      <div className="invoice-address-card__body">{buildCustomerAddressBlock(selectedCustomerProfile, customerName || "-")}</div>
                    </div>
                    <div className="invoice-address-card">
                      <div className="invoice-address-card__title">Shipping Address</div>
                      <div className="invoice-address-card__body">{buildCustomerShippingBlock(selectedCustomerProfile, customerName || "-")}</div>
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
            <DataTable rows={quoteBuilderLines} columns={builderColumns} emptyText="No sales order lines yet. Add a product code or import a sales order file." />
          </div>
        </div>

        <div className="section-card">
          <div className="section-card__header">
            <h2>Saved Cloud Sales Order Detail</h2>
          </div>
          <div className="section-card__body">
            <div className="quote-cloud-summary">
              <div className="settings-item">
                <span className="settings-label">Selected Sales Order</span>
                <strong>{String(detail.quote?.quote_no || "-")}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Customer</span>
                <strong>{String(detail.quote?.customer_name || "-")}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Status</span>
                <strong>{String(detail.quote?.status || "-")}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Currency</span>
                <strong>{String(detail.quote?.currency || "-")}</strong>
              </div>
            </div>
            <div className="meta-row">
              <span>{loadingDetail ? "Loading quote detail..." : `${detail.lines.length.toLocaleString("en-US")} lines loaded`}</span>
              {loadingDetail ? null : <span>{pdfView ? "PDF preview hides purchase-side columns." : "Internal view shows supplier and buy-side columns."}</span>}
            </div>
            <DataTable rows={detail.lines} columns={detailColumns} emptyText={loadingDetail ? "Loading..." : "No quote lines found"} />
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
          <div className="modal-card">
            <div className="modal-card__header">
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
