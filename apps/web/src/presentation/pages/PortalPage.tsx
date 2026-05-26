import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPortalSnapshot, loginPortal } from "../../infrastructure/api/portalAccessApi";
import type { PortalCredentials, PortalSnapshot } from "../../types/portalSession";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { SectionCard } from "../components/common/SectionCard";
import { BrandPill } from "../components/common/BrandPill";
import { buildBusinessDocumentHtml } from "../../shared/documentPrint";
import { openAccountStatementPrintWindow } from "../../shared/accountStatementPrint";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { matchesOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";
import { downloadQuoteTemplate } from "../../shared/importTemplates";
import {
  deletePortalDraftOrder,
  downloadPortalPriceList,
  preparePortalOrderLines as preparePortalOrderLinesApi,
  searchPortalCatalogItems,
  submitPortalOrder,
  type PortalCatalogSearchItem,
  type PortalPreparedLine,
} from "../../infrastructure/api/portalOrderApi";
import { parseOrderImportFile } from "../../shared/orderImport";

const SESSION_KEY = "next-master-portal-session";

function formatMoney(value: number, currency = "EUR") {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatWeight(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function formatDate(value?: string) {
  return value || "-";
}

function isWithinDateRange(value: string | undefined, dateFrom: string, dateTo: string) {
  if (!value) return false;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return false;
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00`);
    if (!Number.isNaN(from.getTime()) && target < from) return false;
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59`);
    if (!Number.isNaN(to.getTime()) && target > to) return false;
  }
  return true;
}

function buildDateRangeLabel(dateFrom: string, dateTo: string) {
  if (dateFrom && dateTo) return `${dateFrom} - ${dateTo}`;
  if (dateFrom) return `From ${dateFrom}`;
  if (dateTo) return `Until ${dateTo}`;
  return "All Dates";
}

function sanitizeFileName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-");
}

function chunkRows<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function mergePortalPreparedLines(current: PortalPreparedLine[], next: PortalPreparedLine[]) {
  const merged = [...current];
  for (const line of next) {
    const lineCode = normalizePartCode(String(line.requestedCode || line.resolvedCode || ""));
    const existing = merged.find(
      (item) =>
        normalizePartCode(String(item.requestedCode || item.resolvedCode || "")) === lineCode &&
        String(item.brand || "").toLowerCase() === String(line.brand || "").toLowerCase(),
    );
    if (existing) {
      existing.qty += line.qty;
    } else {
      merged.push(line);
    }
  }
  return merged;
}

function getPaymentStatusTone(status: string | undefined) {
  const normalized = String(status || "").trim().toLowerCase().replaceAll("_", " ");
  if (normalized === "paid") return { label: "Paid", tone: "success" as const };
  if (normalized === "partial paid" || normalized === "partially paid") return { label: "Partial Paid", tone: "warning" as const };
  if (normalized === "unpaid" || normalized === "open" || normalized === "overdue") return { label: normalized === "overdue" ? "Overdue" : "Unpaid", tone: "danger" as const };
  return { label: status || "-", tone: "neutral" as const };
}

function renderStatusLamp(status: string | undefined) {
  const state = getPaymentStatusTone(status);
  return (
    <span className={`status-lamp status-lamp--${state.tone}`}>
      <span className="status-lamp__dot" />
      {state.label}
    </span>
  );
}

function renderDiscontinuedBadge(row: { lifecycle_status?: string | null; lifecycle_warning?: string | null }) {
  if (String(row.lifecycle_status || "").trim().toLowerCase() !== "discontinued") return null;
  return (
    <div>
      <span className="mark-badge mark-badge--danger">Discontinued</span>
      {row.lifecycle_warning ? <div className="warning-text">{row.lifecycle_warning}</div> : null}
    </div>
  );
}

function matchesPaymentStatusFilter(status: string | undefined, filter: string) {
  if (!filter) return true;
  const normalized = String(status || "").trim().toLowerCase().replaceAll("_", " ");
  if (filter === "paid") return normalized === "paid";
  if (filter === "partial") return normalized === "partial paid" || normalized === "partially paid";
  if (filter === "unpaid") return normalized === "unpaid" || normalized === "open" || normalized === "overdue";
  return true;
}

type PortalSelection =
  | { kind: "sales-order"; id: string }
  | { kind: "invoice"; id: string }
  | { kind: "purchase-order"; id: string }
  | { kind: "bill"; id: string };
type PortalSection = "desk" | "pricelist" | "orders" | "billing" | "statement" | "account";

type PortalLine = NonNullable<PortalSnapshot["invoices"][number]["lines"]>[number];
type PortalSalesOrderRow = PortalSnapshot["salesOrders"][number];

function mapPortalSalesOrderToPreparedLines(row: PortalSalesOrderRow): PortalPreparedLine[] {
  return (row.lines || []).map((line, index) => {
    const requestedCode = String(line.requested_code || line.code || "");
    const resolvedCode = String(line.code || requestedCode || "");
    const qty = Math.max(1, Number(line.qty || 1) || 1);
    const buyPrice = line.buy_price == null ? null : Number(line.buy_price);
    const sellPrice = line.sell_price == null ? null : Number(line.sell_price);
    const codeChanged = Boolean(
      line.old_code || (requestedCode && resolvedCode && requestedCode.trim().toLowerCase() !== resolvedCode.trim().toLowerCase()),
    );
    return {
      lineId: `${row.id}-${index + 1}`,
      requestedCode,
      resolvedCode,
      brand: String(line.brand || ""),
      description: String(line.description || ""),
      qty,
      oem_no: String(line.oem_no || ""),
      hs_code: String(line.hs_code || ""),
      origin: String(line.origin || ""),
      weight_kg: line.weight_kg == null ? null : Number(line.weight_kg),
      image_url: "",
      supplier_name: String(line.supplier_name || ""),
      buy_price: buyPrice,
      sell_price: sellPrice,
      c_sell_price: null,
      price_date: String(line.price_date || ""),
      notes: String(line.notes || ""),
      found: true,
      codeChanged,
      codeChangeWarning: codeChanged ? `Old Code ${requestedCode} => New Code ${resolvedCode}` : "",
      lifecycle_status: line.lifecycle_status ?? "active",
      lifecycle_note: line.lifecycle_note ?? null,
      lifecycle_warning: line.lifecycle_warning ?? null,
      supplierOptions: [],
      selectedSupplierKey: "",
    };
  });
}

function matchesSearch(value: string, row: { id: string; sales_order_no?: string; lines?: PortalLine[] }) {
  if (!value) return true;
  const needle = value.trim().toLowerCase();
  const normalizedNeedle = normalizePartCode(value);
  if (!needle) return true;
  const headerText = [row.id, row.sales_order_no || ""].join(" ").toLowerCase();
  if (headerText.includes(needle)) return true;
  if (normalizedNeedle) {
    const normalizedHeader = normalizePartCode([row.id, row.sales_order_no || ""].join(" "));
    if (normalizedHeader.includes(normalizedNeedle)) return true;
  }
  return (row.lines || []).some((line) => {
    const rawMatch = [line.code, line.requested_code, line.old_code, line.brand, line.description, line.oem_no]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle);
    if (rawMatch) return true;
    if (!normalizedNeedle) return false;
    return [line.code, line.requested_code, line.old_code, line.oem_no]
      .some((part) => normalizePartCode(String(part || "")).includes(normalizedNeedle));
  });
}

function matchesBrand(value: string, row: { lines?: PortalLine[] }) {
  if (!value) return true;
  return (row.lines || []).some((line) => String(line.brand || "").toLowerCase() === value.toLowerCase());
}

function readStoredCredentials(): PortalCredentials | null {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PortalCredentials>;
    if (!parsed.email) return null;
    return { email: parsed.email, token: "" };
  } catch {
    return null;
  }
}

function writeStoredCredentials(credentials: PortalCredentials | null) {
  if (!credentials) {
    window.sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  window.sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      email: credentials.email,
    }),
  );
}

function clearPortalQueryParams() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("email") && !url.searchParams.has("token")) return;
  url.searchParams.delete("email");
  url.searchParams.delete("token");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function getDefaultPortalSection(snapshot: PortalSnapshot) {
  if (snapshot.invite.party_type === "customer" && snapshot.invite.access.can_view_orders) return "desk" as const;
  if (snapshot.invite.access.can_view_orders) return "orders" as const;
  if (snapshot.invite.access.can_view_invoices) return "billing" as const;
  return "statement" as const;
}

export function PortalPage() {
  const search = new URLSearchParams(window.location.search);
  const portalImportRef = useRef<HTMLInputElement | null>(null);
  const portalDraftLinesRef = useRef<HTMLDivElement | null>(null);
  const [credentials, setCredentials] = useState<PortalCredentials>(() => {
    const stored = typeof window !== "undefined" ? readStoredCredentials() : null;
    return {
      email: search.get("email") || stored?.email || "",
      token: search.get("token") || stored?.token || "",
    };
  });
  const [snapshot, setSnapshot] = useState<PortalSnapshot | null>(null);
  const [selection, setSelection] = useState<PortalSelection | null>(null);
  const [activeSection, setActiveSection] = useState<PortalSection>("desk");
  const [documentSearch, setDocumentSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("");
  const [statementDateFrom, setStatementDateFrom] = useState("");
  const [statementDateTo, setStatementDateTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSearchBrand, setOrderSearchBrand] = useState("");
  const [catalogResults, setCatalogResults] = useState<PortalCatalogSearchItem[]>([]);
  const [portalDraftLines, setPortalDraftLines] = useState<PortalPreparedLine[]>([]);
  const [portalOrderId, setPortalOrderId] = useState("");
  const [portalSalesOrderNo, setPortalSalesOrderNo] = useState("");
  const [portalDeliveryTerm, setPortalDeliveryTerm] = useState("");
  const [portalPaymentTerms, setPortalPaymentTerms] = useState("");
  const [portalPackingDetails, setPortalPackingDetails] = useState("");
  const [portalOrderNotes, setPortalOrderNotes] = useState("");
  const [portalOrderStatus, setPortalOrderStatus] = useState("");
  const [portalPriceListBrand, setPortalPriceListBrand] = useState("");
  const [searchingCatalog, setSearchingCatalog] = useState(false);
  const [preparingPortalOrder, setPreparingPortalOrder] = useState(false);
  const [savingPortalOrder, setSavingPortalOrder] = useState(false);
  const [confirmingPortalOrder, setConfirmingPortalOrder] = useState(false);
  const [downloadingPortalPriceList, setDownloadingPortalPriceList] = useState(false);
  const [portalOverlay, setPortalOverlay] = useState<{ title: string; message: string } | null>(null);
  const [orderDeskView, setOrderDeskView] = useState<"simple" | "advanced">("simple");
  const [selectedCatalogCode, setSelectedCatalogCode] = useState("");
  const [selectedDraftLineId, setSelectedDraftLineId] = useState("");
  const [previewImage, setPreviewImage] = useState<{ src: string; code: string; name: string } | null>(null);
  const portalPricingCurrency = snapshot?.pricingProfile?.currency || snapshot?.accountSummary.currency || "EUR";

  useEffect(() => {
    const token = search.get("token");
    const email = search.get("email");
    if (!token || !email) return;
    setLoading(true);
    setError("");
    loginPortal({ email, token })
      .then((next) => {
        setSnapshot(next);
        setSelection(null);
        setActiveSection(getDefaultPortalSection(next));
        setDocumentSearch("");
        setBrandFilter("");
        setPaymentStatusFilter("");
        setStatus("Portal session active.");
        writeStoredCredentials({ email, token });
        clearPortalQueryParams();
      })
      .catch((caught) => {
        setSnapshot(null);
        setError(caught instanceof Error ? caught.message : "Portal login failed");
      })
      .finally(() => setLoading(false));
  }, []);

  const accountColumns = useMemo(
    () => [
      { key: "type", header: "Document", render: (row: PortalSnapshot["accountRows"][number]) => row.document_type },
      { key: "no", header: "No", render: (row: PortalSnapshot["accountRows"][number]) => row.document_no },
      { key: "date", header: "Date", render: (row: PortalSnapshot["accountRows"][number]) => row.document_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["accountRows"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["accountRows"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["accountRows"][number]) => formatMoney(row.amount, row.currency) },
    ],
    [],
  );

  const salesOrderColumns = useMemo(
    () => [
      {
        key: "no",
        header: "Sales Order",
        render: (row: PortalSnapshot["salesOrders"][number]) => (
          <div>
            <strong>{row.sales_order_no || row.id}</strong>
            {row.source_channel === "portal" && row.portal_submitted_at ? (
              <div className="status-lamp status-lamp--info">
                <span className="status-lamp__dot" />
                Submitted
              </div>
            ) : null}
          </div>
        ),
      },
      { key: "date", header: "Date", render: (row: PortalSnapshot["salesOrders"][number]) => row.quote_date || "-" },
      {
        key: "status",
        header: "Status",
        render: (row: PortalSnapshot["salesOrders"][number]) => (row.portal_submitted_at ? "Submitted" : row.status || "-"),
      },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["salesOrders"][number]) => formatMoney(Number(row.sales_total || 0), row.currency) },
    ],
    [],
  );

  const invoiceColumns = useMemo(
    () => [
      { key: "no", header: "Invoice", render: (row: PortalSnapshot["invoices"][number]) => row.id },
      { key: "sales", header: "Sales Order", render: (row: PortalSnapshot["invoices"][number]) => row.sales_order_no || "-" },
      { key: "date", header: "Date", render: (row: PortalSnapshot["invoices"][number]) => row.quote_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["invoices"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["invoices"][number]) => renderStatusLamp(row.status) },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["invoices"][number]) => formatMoney(row.total_amount, row.currency) },
    ],
    [],
  );

  const purchaseOrderColumns = useMemo(
    () => [
      { key: "no", header: "Purchase Order", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.id },
      { key: "sales", header: "Sales Order", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.sales_order_no || "-" },
      { key: "customer", header: "Customer", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.customer_name || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["purchaseOrders"][number]) => formatMoney(Number(row.total_amount || 0), row.currency) },
    ],
    [],
  );

  const billColumns = useMemo(
    () => [
      { key: "no", header: "Bill", render: (row: PortalSnapshot["bills"][number]) => row.id },
      { key: "po", header: "Purchase Order", render: (row: PortalSnapshot["bills"][number]) => row.purchase_order_no || "-" },
      { key: "date", header: "Date", render: (row: PortalSnapshot["bills"][number]) => row.bill_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["bills"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["bills"][number]) => renderStatusLamp(row.status) },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["bills"][number]) => formatMoney(row.total_amount, row.currency) },
    ],
    [],
  );

  const paymentColumns = useMemo(
    () => [
      { key: "no", header: "Payment", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.id },
      {
        key: "applied",
        header: "Applied To",
        render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.invoice_no || row.bill_no || "-",
      },
      { key: "ref", header: "Reference", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.reference_no || "-" },
      { key: "method", header: "Method", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.method || "-" },
      { key: "date", header: "Date", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.received_date || row.payment_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => renderStatusLamp(row.status) },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => formatMoney(row.amount, row.currency) },
    ],
    [],
  );

  const portalCatalogColumns = useMemo(
    () => {
      const columns = [
        {
          key: "image",
          header: "Photo",
          render: (row: PortalCatalogSearchItem) =>
            row.image_url ? (
              <button
                type="button"
                className="catalog-thumb-button"
                onClick={() =>
                  setPreviewImage({
                    src: row.image_url || "",
                    code: row.code,
                    name: row.description || "",
                  })
                }
              >
                <img src={row.image_url} alt={row.code} className="catalog-thumb" loading="lazy" />
              </button>
            ) : (
              <span>-</span>
            ),
        },
        { key: "code", header: "Code", render: (row: PortalCatalogSearchItem) => row.code },
        { key: "brand", header: "Brand", render: (row: PortalCatalogSearchItem) => <BrandPill brand={row.brand} compact /> },
        {
          key: "description",
          header: "Description",
          render: (row: PortalCatalogSearchItem) => (
            <div>
              <div>{row.description || "-"}</div>
              {renderDiscontinuedBadge(row)}
            </div>
          ),
        },
        {
          key: "price",
          header: `Price ${portalPricingCurrency}`,
          render: (row: PortalCatalogSearchItem) => (row.sell_price == null ? "-" : formatMoney(Number(row.sell_price || 0), row.currency || portalPricingCurrency)),
        },
      ];
      if (orderDeskView === "advanced") {
        columns.push(
          { key: "oem", header: "OEM", render: (row: PortalCatalogSearchItem) => row.oem_no || "-" },
          { key: "tariff", header: "Tariff", render: (row: PortalCatalogSearchItem) => row.tariff || "-" },
          { key: "origin", header: "Origin", render: (row: PortalCatalogSearchItem) => row.origin || "-" },
          { key: "weight", header: "Weight", render: (row: PortalCatalogSearchItem) => formatWeight(row.weight_kg) },
        );
      }
      columns.push({
        key: "actions",
        header: "Actions",
        render: (row: PortalCatalogSearchItem) => (
          <Button variant="secondary" className="button--compact" onClick={() => void handleAddPortalCatalogItem(row)}>
            Add to Desk
          </Button>
        ),
      });
      return columns;
    },
    [orderDeskView, portalPricingCurrency],
  );

  const portalDraftColumns = useMemo(
    () => {
      const columns = [
        { key: "code", header: "Code", render: (row: PortalPreparedLine) => row.resolvedCode || row.requestedCode || "-" },
        { key: "brand", header: "Brand", render: (row: PortalPreparedLine) => <BrandPill brand={row.brand} compact /> },
        {
          key: "description",
          header: "Description",
          render: (row: PortalPreparedLine) => (
            <div>
              <div>{row.description || "-"}</div>
              {row.sell_price == null ? <div className="warning-text">No live price found for this item.</div> : null}
              {renderDiscontinuedBadge(row)}
            </div>
          ),
        },
      ];
      if (orderDeskView === "advanced") {
        columns.push(
          { key: "oem", header: "OEM", render: (row: PortalPreparedLine) => row.oem_no || "-" },
          { key: "origin", header: "Origin", render: (row: PortalPreparedLine) => row.origin || "-" },
          { key: "weight", header: "Weight", render: (row: PortalPreparedLine) => formatWeight(row.weight_kg) },
        );
      }
      columns.push(
        {
          key: "qty",
          header: "Qty",
          render: (row: PortalPreparedLine) => (
            <input
              className="inline-edit-input inline-edit-input--qty"
              type="number"
              min={1}
              step={1}
              value={row.qty}
              onChange={(event) => {
                const nextQty = Math.max(1, Number(event.target.value || 1) || 1);
                setPortalDraftLines((current) => current.map((item) => (item.lineId === row.lineId ? { ...item, qty: nextQty } : item)));
              }}
            />
          ),
        },
        {
          key: "sell",
          header: `Price ${portalPricingCurrency}`,
          render: (row: PortalPreparedLine) => (row.sell_price == null ? "-" : formatMoney(Number(row.sell_price || 0), portalPricingCurrency)),
        },
        {
          key: "amount",
          header: `Amount ${portalPricingCurrency}`,
          render: (row: PortalPreparedLine) =>
            row.sell_price == null ? "-" : formatMoney(Number(row.sell_price || 0) * Number(row.qty || 0), portalPricingCurrency),
        },
        {
          key: "actions",
          header: "Actions",
          render: (row: PortalPreparedLine) => (
            <Button
              variant="secondary"
              className="button--compact danger-button"
              onClick={() => setPortalDraftLines((current) => current.filter((item) => item.lineId !== row.lineId))}
            >
              Remove
            </Button>
          ),
        },
      );
      return columns;
    },
    [orderDeskView, portalPricingCurrency],
  );

  const creditColumns = useMemo(
    () => [
      { key: "no", header: "Credit Note", render: (row: PortalSnapshot["creditNotes"][number]) => row.credit_note_no || row.id },
      { key: "date", header: "Date", render: (row: PortalSnapshot["creditNotes"][number]) => row.credit_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["creditNotes"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["creditNotes"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["creditNotes"][number]) => formatMoney(row.total_amount, row.currency) },
    ],
    [],
  );

  const vendorCreditColumns = useMemo(
    () => [
      { key: "no", header: "Vendor Credit", render: (row: PortalSnapshot["vendorCredits"][number]) => row.vendor_credit_no || row.id },
      { key: "date", header: "Date", render: (row: PortalSnapshot["vendorCredits"][number]) => row.credit_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["vendorCredits"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["vendorCredits"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["vendorCredits"][number]) => formatMoney(row.total_amount, row.currency) },
    ],
    [],
  );

  async function handleLogin() {
    try {
      setLoading(true);
      setError("");
      const next = await loginPortal(credentials);
      setSnapshot(next);
      setSelection(null);
      setActiveSection(getDefaultPortalSection(next));
      setDocumentSearch("");
      setBrandFilter("");
      setPaymentStatusFilter("");
      setStatus("Portal session active.");
      writeStoredCredentials(credentials);
      clearPortalQueryParams();
    } catch (caught) {
      setSnapshot(null);
      setError(caught instanceof Error ? caught.message : "Portal login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    try {
      setLoading(true);
      setError("");
      const next = await fetchPortalSnapshot(credentials);
      setSnapshot(next);
      setSelection(null);
      setStatus("Portal data refreshed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal refresh failed");
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    setSnapshot(null);
    setSelection(null);
    setActiveSection("desk");
    setStatus("");
    setError("");
    writeStoredCredentials(null);
    clearPortalQueryParams();
  }

  useEffect(() => {
    if (!snapshot || snapshot.invite.party_type !== "customer" || !snapshot.invite.access.can_view_orders) {
      setPortalOrderId("");
      setPortalSalesOrderNo("");
      setPortalDraftLines([]);
      setPortalDeliveryTerm("");
      setPortalPaymentTerms("");
      setPortalPackingDetails("");
      setPortalOrderNotes("");
      setPortalOrderStatus("");
      setCatalogResults([]);
      return;
    }

    const latestPortalDraft = snapshot.salesOrders.find((row) => row.source_channel === "portal" && !row.portal_submitted_at);
    setPortalOrderId(latestPortalDraft?.id || "");
    setPortalSalesOrderNo(latestPortalDraft?.sales_order_no || "");
    setPortalDraftLines(latestPortalDraft ? mapPortalSalesOrderToPreparedLines(latestPortalDraft) : []);
    setPortalDeliveryTerm(latestPortalDraft?.delivery_term || "");
    setPortalPaymentTerms(latestPortalDraft?.payment_terms || snapshot.pricingProfile?.payment_terms || "");
    setPortalPackingDetails(latestPortalDraft?.packing_details || "");
    setPortalOrderNotes(latestPortalDraft?.notes || "");
    setPortalPriceListBrand((current) => current || snapshot.availableBrands[0] || "");
    setPortalOrderStatus(
      latestPortalDraft
        ? latestPortalDraft.portal_submitted_at
          ? `Basket ${latestPortalDraft.sales_order_no || latestPortalDraft.id} already submitted.`
          : `Basket ${latestPortalDraft.sales_order_no || latestPortalDraft.id} loaded.`
        : "",
    );
    setOrderSearchBrand((current) => (current && snapshot.availableBrands.includes(current) ? current : ""));
  }, [snapshot]);

  useEffect(() => {
    if (!catalogResults.length) {
      setSelectedCatalogCode("");
      return;
    }
    if (!catalogResults.some((row) => row.code === selectedCatalogCode)) {
      setSelectedCatalogCode(catalogResults[0]?.code || "");
    }
  }, [catalogResults, selectedCatalogCode]);

  useEffect(() => {
    if (!portalDraftLines.length) {
      setSelectedDraftLineId("");
      return;
    }
    if (!portalDraftLines.some((line) => line.lineId === selectedDraftLineId)) {
      setSelectedDraftLineId(portalDraftLines[0]?.lineId || "");
    }
  }, [portalDraftLines, selectedDraftLineId]);

  if (!snapshot) {
    return (
      <div className="portal-shell">
        <div className="portal-login-card">
          <h1>Portal Login</h1>
          <p>Enter invite email and token to access customer or vendor self-service.</p>
          <form
            className="portal-login-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleLogin();
            }}
          >
            <Input label="Email" value={credentials.email} placeholder="name@company.com" onChange={(value) => setCredentials((current) => ({ ...current, email: value }))} />
            <Input label="Invite Token" value={credentials.token} placeholder="Portal invite token" onChange={(value) => setCredentials((current) => ({ ...current, token: value }))} />
            <div className="inline-actions">
              <Button type="submit" busy={loading} busyLabel="Signing in..." onClick={() => void handleLogin()}>
                Sign In
              </Button>
            </div>
            {error ? <div className="warning-text">{error}</div> : null}
          </form>
        </div>
      </div>
    );
  }

  const activeSnapshot = snapshot;
  const partyProfile = activeSnapshot.customer || activeSnapshot.vendor;
  const visibleDocumentRows =
    activeSnapshot.invite.party_type === "customer"
      ? [...activeSnapshot.salesOrders, ...activeSnapshot.invoices]
      : [...activeSnapshot.purchaseOrders, ...activeSnapshot.bills];

  const brandOptions = (() => {
    const brands = new Set<string>();
    visibleDocumentRows.forEach((row) => {
      (row.lines || []).forEach((line) => {
        const brand = String(line.brand || "").trim();
        if (brand) brands.add(brand);
      });
    });
    return [{ value: "", label: "All Brands" }, ...Array.from(brands).sort((a, b) => a.localeCompare(b)).map((brand) => ({ value: brand, label: brand }))];
  })();
  const paymentStatusOptions = [
    { value: "", label: "All Statuses" },
    { value: "paid", label: "Paid" },
    { value: "partial", label: "Partial Paid" },
    { value: "unpaid", label: "Unpaid" },
  ];

  const filteredSalesOrders = activeSnapshot.salesOrders.filter((row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row));
  const portalDraftOrders = activeSnapshot.salesOrders.filter(
    (row) => row.source_channel === "portal" && !row.portal_submitted_at && String(row.status || "").toLowerCase() === "draft",
  );
  const filteredInvoices = activeSnapshot.invoices.filter(
    (row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row) && matchesPaymentStatusFilter(row.status, paymentStatusFilter),
  );
  const filteredPurchaseOrders = activeSnapshot.purchaseOrders.filter((row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row));
  const filteredBills = activeSnapshot.bills.filter(
    (row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row) && matchesPaymentStatusFilter(row.status, paymentStatusFilter),
  );
  const filteredAccountRows = activeSnapshot.accountRows.filter((row) => {
    if (!statementDateFrom && !statementDateTo) return true;
    return isWithinDateRange(row.document_date, statementDateFrom, statementDateTo);
  });
  const filteredCreditNotes = activeSnapshot.creditNotes.filter((row) => {
    if (!statementDateFrom && !statementDateTo) return true;
    return isWithinDateRange(row.credit_date, statementDateFrom, statementDateTo);
  });
  const filteredVendorCredits = activeSnapshot.vendorCredits.filter((row) => {
    if (!statementDateFrom && !statementDateTo) return true;
    return isWithinDateRange(row.credit_date, statementDateFrom, statementDateTo);
  });
  const visiblePayments =
    activeSnapshot.invite.party_type === "customer"
      ? activeSnapshot.paymentsReceived.filter((row) => (!statementDateFrom && !statementDateTo ? true : isWithinDateRange(row.received_date, statementDateFrom, statementDateTo)))
      : activeSnapshot.paymentsMade.filter((row) => (!statementDateFrom && !statementDateTo ? true : isWithinDateRange(row.payment_date, statementDateFrom, statementDateTo)));
  const statementPeriodLabel = buildDateRangeLabel(statementDateFrom, statementDateTo);
  const portalCanOrder = activeSnapshot.invite.party_type === "customer" && activeSnapshot.invite.access.can_view_orders;
  const selectedCatalogItem = catalogResults.find((row) => row.code === selectedCatalogCode) || null;
  const selectedDraftLine = portalDraftLines.find((line) => line.lineId === selectedDraftLineId) || null;
  const portalBrandOptions = [{ value: "", label: "All Brands" }, ...activeSnapshot.availableBrands.map((brand) => ({ value: brand, label: brand }))];
  const portalBrandValueOptions = activeSnapshot.availableBrands.map((brand) => ({ value: brand, label: brand }));
  const portalDraftSelectionOptions = [
    { value: "", label: "New Basket" },
    ...portalDraftOrders.map((row) => ({
      value: row.id,
      label: `${row.sales_order_no || row.id} · ${(row.line_count || row.lines?.length || 0).toLocaleString("en-US")} lines`,
    })),
  ];
  const portalOrderTotals = {
    subtotal: portalDraftLines.reduce((sum, line) => sum + Number(line.sell_price || 0) * Number(line.qty || 0), 0),
    purchaseTotal: portalDraftLines.reduce((sum, line) => sum + Number(line.buy_price || 0) * Number(line.qty || 0), 0),
  };
  const portalOrderCurrency = activeSnapshot.pricingProfile?.currency || activeSnapshot.accountSummary.currency || "EUR";
  const portalDraftHasMissingPrices = portalDraftLines.some((line) => line.sell_price == null);
  const portalDraftDiscontinuedCount = portalDraftLines.filter((line) => line.lifecycle_status === "discontinued").length;
  const portalDraftWarningLines = portalDraftLines.filter(
    (line) => line.sell_price == null || line.lifecycle_status === "discontinued" || line.codeChanged,
  );
  const portalOriginalNumberBrandMatches = Array.from(
    new Set(
      catalogResults
        .filter((row) => matchesOriginalNumberSearch(row.oem_no || "", orderSearch))
        .map((row) => String(row.brand || "").trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
  const portalSearchCards = catalogResults.slice(0, orderDeskView === "advanced" ? 12 : 8);
  const portalOrderHistoryRows =
    activeSnapshot.invite.party_type === "customer"
      ? filteredSalesOrders.filter((row) => !(row.source_channel === "portal" && !row.portal_submitted_at && String(row.status || "").toLowerCase() === "draft"))
      : filteredPurchaseOrders;
  const portalBillingRows = activeSnapshot.invite.party_type === "customer" ? filteredInvoices : filteredBills;
  const portalQuickStats = [
    {
      label: portalCanOrder ? "Open Baskets" : "Orders",
      value: portalCanOrder ? portalDraftOrders.length.toLocaleString("en-US") : portalOrderHistoryRows.length.toLocaleString("en-US"),
      note: portalCanOrder ? "Saved work waiting for submission" : "Visible order records",
    },
    {
      label: activeSnapshot.invite.party_type === "customer" ? "Invoices" : "Bills",
      value: portalBillingRows.length.toLocaleString("en-US"),
      note: "Document history available online",
    },
    {
      label: "Balance",
      value: formatMoney(activeSnapshot.accountSummary.openAmount, activeSnapshot.accountSummary.currency),
      note: "Current open account position",
    },
    {
      label: "Payments",
      value: formatMoney(activeSnapshot.accountSummary.paymentAmount, activeSnapshot.accountSummary.currency),
      note: "Total payment movement",
    },
  ];
  const portalSections: Array<{ key: PortalSection; label: string }> = [
    ...(portalCanOrder ? [{ key: "desk" as PortalSection, label: "Part Search" }] : []),
    ...(portalCanOrder ? [{ key: "pricelist" as PortalSection, label: "Download Price List" }] : []),
    ...(activeSnapshot.invite.access.can_view_orders ? [{ key: "orders" as PortalSection, label: "Orders" }] : []),
    ...(activeSnapshot.invite.access.can_view_invoices
      ? [{ key: "billing" as PortalSection, label: activeSnapshot.invite.party_type === "customer" ? "Invoices" : "Bills" }]
      : []),
    ...(activeSnapshot.invite.access.can_view_account || activeSnapshot.invite.access.can_view_payments ? [{ key: "statement" as PortalSection, label: "Statement" }] : []),
    { key: "account", label: "Account" },
  ];
  const activeSectionHelpText =
    activeSection === "desk"
      ? "Search by part number or original number, compare alternatives, then move selected items into the basket."
      : activeSection === "pricelist"
        ? "Select a brand and download the customer-specific price list using the assigned account pricing."
      : activeSection === "orders"
        ? "Track submitted orders and inspect the full line detail when needed."
        : activeSection === "billing"
          ? "Review invoices or bills with payment status and line-level detail."
          : activeSection === "statement"
            ? "Use this area for statement, payments, and credits only."
            : "Review your account identity, addresses, and financial profile.";

  function openPortalDocument(selection: PortalSelection) {
    setSelection(selection);
    setActiveSection(selection.kind === "sales-order" || selection.kind === "purchase-order" ? "orders" : "billing");
  }

  function focusPortalDraftLines(lineId?: string) {
    setActiveSection("desk");
    if (lineId) setSelectedDraftLineId(lineId);
    window.requestAnimationFrame(() => {
      portalDraftLinesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function handlePortalCatalogSearch() {
    try {
      setSearchingCatalog(true);
      setError("");
      const items = await searchPortalCatalogItems(credentials, orderSearch, orderSearchBrand);
      setCatalogResults(items);
      if (items[0]) setSelectedCatalogCode(items[0].code);
      setPortalOrderStatus(`${items.length.toLocaleString("en-US")} matching product and alternative result(s) found for the basket flow.`);
    } catch (caught) {
      setCatalogResults([]);
      setError(caught instanceof Error ? caught.message : "Portal item search failed");
    } finally {
      setSearchingCatalog(false);
    }
  }

  async function appendPortalRows(rows: Array<{ code: string; brand: string; qty: number }>, statusText: string) {
    if (!rows.length) return [] as PortalPreparedLine[];
    try {
      setPreparingPortalOrder(true);
      setError("");
      const chunks = chunkRows(rows, 40);
      let preparedLines: PortalPreparedLine[] = [];
      let latestPricingProfile: PortalSnapshot["pricingProfile"] | null = null;
      let processed = 0;
      let failedChunkMessage = "";

      for (const chunk of chunks) {
        try {
          setPortalOverlay({
            title: rows.length > 1 ? "Importing Sales Order Lines" : "Preparing Item Price",
            message:
              rows.length > 1
                ? `Uploading and pricing lines ${processed + 1}-${processed + chunk.length} of ${rows.length}.`
                : "Fetching live price and item details.",
          });
          const prepared = await preparePortalOrderLinesApi(credentials, chunk);
          preparedLines = mergePortalPreparedLines(preparedLines, prepared.lines);
          setPortalDraftLines((current) => mergePortalPreparedLines(current, prepared.lines));
          latestPricingProfile = prepared.pricingProfile || latestPricingProfile;
          processed += chunk.length;
        } catch (caught) {
          failedChunkMessage = caught instanceof Error ? caught.message : "Portal order pricing failed";
          break;
        }
      }

      if (!preparedLines.length && failedChunkMessage) {
        throw new Error(failedChunkMessage);
      }

      if (!portalPaymentTerms && latestPricingProfile?.payment_terms) {
        setPortalPaymentTerms(latestPricingProfile.payment_terms);
      }
      const missingPriceCount = preparedLines.filter((line) => line.sell_price == null).length;
      const discontinuedCount = preparedLines.filter((line) => line.lifecycle_status === "discontinued").length;
      const pricedCount = preparedLines.length - missingPriceCount;
      setPortalOrderStatus(
        `${statusText.replace("{count}", preparedLines.length.toLocaleString("en-US"))} ${pricedCount > 0 ? `${pricedCount.toLocaleString("en-US")} priced.` : ""}${missingPriceCount > 0 ? ` ${missingPriceCount.toLocaleString("en-US")} need live pricing.` : ""}${discontinuedCount > 0 ? ` ${discontinuedCount.toLocaleString("en-US")} discontinued item(s) detected.` : ""}${failedChunkMessage ? " Some lines could not be processed; save basket and continue later." : ""}`.trim(),
      );
      if (failedChunkMessage) {
        setError(failedChunkMessage);
      }
      return preparedLines;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal order pricing failed");
      return [] as PortalPreparedLine[];
    } finally {
      setPreparingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  async function handleAddPortalCatalogItem(item: PortalCatalogSearchItem) {
    setSelectedCatalogCode(item.code);
    const prepared = await appendPortalRows(
      [{ code: item.code, brand: item.brand, qty: 1 }],
      `{count} item added to ${portalSalesOrderNo || "New Basket"} in Basket.`,
    );
    if (prepared[0]) focusPortalDraftLines(prepared[0].lineId);
  }

  async function handleImportPortalOrderFile(file: File) {
    try {
      const importedRows = await parseOrderImportFile(file, orderSearchBrand);
      if (!importedRows.length) {
        throw new Error("No part rows found in upload.");
      }
      const prepared = await appendPortalRows(
        importedRows,
        `{count} imported line priced for ${portalSalesOrderNo || "New Basket"} in Basket.`,
      );
      if (prepared[0]) focusPortalDraftLines(prepared[0].lineId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal import failed");
    } finally {
      if (portalImportRef.current) portalImportRef.current.value = "";
    }
  }

  async function handleSubmitPortalOrder(mode: "draft" | "confirm") {
    if (!portalDraftLines.length) {
      setError("Add at least one line before saving portal order.");
      return;
    }
    if (mode === "confirm" && portalDraftHasMissingPrices) {
      setError("Some lines do not have a live price yet. Remove them or complete pricing before submitting.");
      return;
    }
    if (
      mode === "confirm" &&
      portalDraftDiscontinuedCount > 0 &&
      !window.confirm(
        `${portalDraftDiscontinuedCount.toLocaleString("en-US")} discontinued item(s) are still in this basket. Continue and submit anyway?`,
      )
    ) {
      return;
    }
    try {
      if (mode === "confirm") setConfirmingPortalOrder(true);
      else setSavingPortalOrder(true);
      setError("");
      setPortalOverlay({
        title: mode === "confirm" ? "Submitting Basket" : "Saving Basket",
        message: mode === "confirm" ? "Submitting the basket and sending it to the internal team." : "Saving current basket lines and details.",
      });
      const result = await submitPortalOrder(credentials, {
        orderId: portalOrderId || undefined,
        salesOrderNo: portalSalesOrderNo || undefined,
        mode,
        deliveryTerm: portalDeliveryTerm,
        paymentTerms: portalPaymentTerms,
        packingDetails: portalPackingDetails,
        notes: portalOrderNotes,
        rows: portalDraftLines.map((line) => ({
          code: line.requestedCode || line.resolvedCode,
          brand: line.brand,
          qty: Number(line.qty || 0),
        })),
      });
      setSnapshot(result.snapshot);
      setSelection({ kind: "sales-order", id: result.orderId });
      setActiveSection(mode === "confirm" ? "statement" : "orders");
      setStatus(
        mode === "confirm"
          ? `Basket ${result.orderId} submitted. Internal team can prepare proforma and next documents.`
          : `Basket ${result.orderId} saved for later continuation.`,
      );
      setPortalOrderStatus("");
      setCatalogResults([]);
      setSelectedDraftLineId("");
      setSelectedCatalogCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal sales order save failed");
    } finally {
      setSavingPortalOrder(false);
      setConfirmingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  function handleResumePortalDraft(row: PortalSalesOrderRow) {
    setPortalOrderId(row.id || "");
    setPortalSalesOrderNo(row.sales_order_no || "");
    setPortalDraftLines(mapPortalSalesOrderToPreparedLines(row));
    setPortalDeliveryTerm(row.delivery_term || "");
    setPortalPaymentTerms(row.payment_terms || activeSnapshot.pricingProfile?.payment_terms || "");
    setPortalPackingDetails(row.packing_details || "");
    setPortalOrderNotes(row.notes || "");
    setPortalOrderStatus(`Basket ${row.sales_order_no || row.id} loaded.`);
    setCatalogResults([]);
    setSelection({ kind: "sales-order", id: row.id });
    setActiveSection("desk");
  }

  function handleClearPortalBuilder() {
    setPortalOrderId("");
    setPortalSalesOrderNo("");
    setPortalDraftLines([]);
    setPortalDeliveryTerm("");
    setPortalPaymentTerms(activeSnapshot.pricingProfile?.payment_terms || "");
    setPortalPackingDetails("");
    setPortalOrderNotes("");
    setPortalOrderStatus("Basket cleared. Start a new search or resume a saved basket.");
    setCatalogResults([]);
    setOrderSearch("");
    setSelection(null);
    setError("");
    setSelectedDraftLineId("");
    setSelectedCatalogCode("");
    setActiveSection("desk");
  }

  async function handleDeletePortalDraft(row: PortalSalesOrderRow) {
    if (!window.confirm(`Delete basket ${row.sales_order_no || row.id}?`)) return;
    try {
      setSavingPortalOrder(true);
      setError("");
      setPortalOverlay({
        title: "Deleting Basket",
        message: `Removing basket ${row.sales_order_no || row.id} from your portal workspace.`,
      });
      const result = await deletePortalDraftOrder(credentials, row.id);
      setSnapshot(result.snapshot);
      if (selection?.kind === "sales-order" && selection.id === row.id) {
        setSelection(null);
      }
      setStatus(`Basket ${row.sales_order_no || row.id} deleted.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal basket delete failed");
    } finally {
      setSavingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  async function handleDownloadPortalPriceList() {
    if (!portalPriceListBrand) {
      setError("Select a brand before downloading the price list.");
      return;
    }
    try {
      setDownloadingPortalPriceList(true);
      setError("");
      setPortalOverlay({
        title: "Preparing Price List",
        message: `Building ${portalPriceListBrand} price list for this customer account.`,
      });
      const result = await downloadPortalPriceList(credentials, portalPriceListBrand);
      const rows: Array<Array<string | number | null>> = [
        ["Product_Code", "Brand", "Product_Name", "OEM_No", "HS_Code", "Origin", "Weight_kg", "Price_List_Type", `Sales_Price_${result.currency}`, "Lifecycle", "Lifecycle_Note"],
        ...result.rows.map((row) => [
          row.product_code,
          row.brand,
          row.description || "",
          row.oem_no || "",
          row.hs_code || "",
          row.origin || "",
          row.weight_kg ?? "",
          `${row.price_list_type} Price List`,
          row.sales_price ?? "",
          row.lifecycle_status,
          row.lifecycle_note || "",
        ]),
      ];
      const blob = buildXlsxBlob(`${portalPriceListBrand} Price List`, rows, [6, 8]);
      downloadBlob(`${sanitizeFileName(`portal-price-list-${portalPriceListBrand}-${result.priceListType}`)}.xlsx`, blob);
      setStatus(`${portalPriceListBrand} ${result.priceListType} price list downloaded.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal price list download failed");
    } finally {
      setDownloadingPortalPriceList(false);
      setPortalOverlay(null);
    }
  }
  const selectedDocument = (() => {
    if (!selection) return null;
    if (selection.kind === "sales-order") {
      const row = activeSnapshot.salesOrders.find((entry) => entry.id === selection.id);
      return row ? { kind: selection.kind, row } : null;
    }
    if (selection.kind === "invoice") {
      const row = activeSnapshot.invoices.find((entry) => entry.id === selection.id);
      return row ? { kind: selection.kind, row } : null;
    }
    if (selection.kind === "purchase-order") {
      const row = activeSnapshot.purchaseOrders.find((entry) => entry.id === selection.id);
      return row ? { kind: selection.kind, row } : null;
    }
    const row = activeSnapshot.bills.find((entry) => entry.id === selection.id);
    return row ? { kind: selection.kind, row } : null;
  })();

  const detailColumns = (() => {
    if (!selectedDocument) return [];
    if (selectedDocument.kind === "sales-order" || selectedDocument.kind === "invoice") {
      return [
        { key: "code", header: "Code", render: (row: PortalLine) => row.code || row.requested_code || "-" },
        { key: "brand", header: "Brand", render: (row: PortalLine) => <BrandPill brand={row.brand} compact /> },
        {
          key: "description",
          header: "Description",
          render: (row: PortalLine) => (
            <div>
              <div>{row.description || "-"}</div>
              {renderDiscontinuedBadge(row)}
            </div>
          ),
        },
        { key: "qty", header: "Qty", render: (row: PortalLine) => row.qty || 0 },
        { key: "oem", header: "OEM", render: (row: PortalLine) => row.oem_no || "-" },
        { key: "origin", header: "Origin", render: (row: PortalLine) => row.origin || "-" },
        { key: "weight", header: "Weight", render: (row: PortalLine) => formatWeight(row.weight_kg) },
        { key: "unit", header: "Unit Price", render: (row: PortalLine) => formatMoney(Number(row.sell_price || 0), selectedDocument.row.currency) },
        { key: "amount", header: "Line Total", render: (row: PortalLine) => formatMoney(Number(row.line_total || row.sales_total || 0), selectedDocument.row.currency) },
      ];
    }
    return [
      { key: "code", header: "Code", render: (row: PortalLine) => row.code || "-" },
      { key: "brand", header: "Brand", render: (row: PortalLine) => <BrandPill brand={row.brand} compact /> },
      {
        key: "description",
        header: "Description",
        render: (row: PortalLine) => (
          <div>
            <div>{row.description || "-"}</div>
            {renderDiscontinuedBadge(row)}
          </div>
        ),
      },
      { key: "qty", header: "Qty", render: (row: PortalLine) => row.qty || 0 },
      { key: "oem", header: "OEM", render: (row: PortalLine) => row.oem_no || "-" },
      { key: "origin", header: "Origin", render: (row: PortalLine) => row.origin || "-" },
      { key: "unit", header: "Unit Price", render: (row: PortalLine) => formatMoney(Number(row.buy_price || 0), selectedDocument.row.currency) },
      { key: "amount", header: "Line Total", render: (row: PortalLine) => formatMoney(Number(row.line_total || 0), selectedDocument.row.currency) },
    ];
  })();

  const detailTitle = selectedDocument
    ? selectedDocument.kind === "sales-order"
      ? `Sales Order Detail · ${selectedDocument.row.sales_order_no || selectedDocument.row.id}`
      : selectedDocument.kind === "invoice"
        ? `Invoice Detail · ${selectedDocument.row.id}`
        : selectedDocument.kind === "purchase-order"
          ? `Purchase Order Detail · ${selectedDocument.row.id}`
          : `Bill Detail · ${selectedDocument.row.id}`
    : "";
  const orderDeskFocusTitle = selectedDraftLine
    ? `${selectedDraftLine.resolvedCode || selectedDraftLine.requestedCode || "-"} · Basket Line`
    : selectedCatalogItem
      ? `${selectedCatalogItem.code} · Search Result`
      : portalSalesOrderNo || "Basket";

  function getPortalDocumentSelection(kind: PortalSelection["kind"], id: string) {
    if (kind === "sales-order") {
      const row = activeSnapshot.salesOrders.find((entry) => entry.id === id);
      return row ? { kind, row } : null;
    }
    if (kind === "invoice") {
      const row = activeSnapshot.invoices.find((entry) => entry.id === id);
      return row ? { kind, row } : null;
    }
    if (kind === "purchase-order") {
      const row = activeSnapshot.purchaseOrders.find((entry) => entry.id === id);
      return row ? { kind, row } : null;
    }
    const row = activeSnapshot.bills.find((entry) => entry.id === id);
    return row ? { kind, row } : null;
  }

  function handleStatementPrint() {
    const company = activeSnapshot.companyProfile
      ? {
          id: activeSnapshot.companyProfile.id || "portal-company",
          companyName: activeSnapshot.companyProfile.company_name || "Next Master",
          email: activeSnapshot.companyProfile.email || "",
          phone: activeSnapshot.companyProfile.phone || "",
          website: activeSnapshot.companyProfile.website || "",
          address: activeSnapshot.companyProfile.address || "",
          bankDetails: activeSnapshot.companyProfile.bank_details || "",
          taxOffice: activeSnapshot.companyProfile.tax_office || "",
          taxNumber: activeSnapshot.companyProfile.tax_number || "",
          footerNote: activeSnapshot.companyProfile.footer_note || "",
          logoDataUrl: activeSnapshot.companyProfile.logo_data_url || "",
        }
      : null;
    openAccountStatementPrintWindow({
      title: activeSnapshot.invite.party_type === "customer" ? "Customer Account Statement" : "Vendor Account Statement",
      company,
      partyName: activeSnapshot.invite.party_name,
      billingAddress: partyProfile?.billing_address || activeSnapshot.invite.party_name,
      shippingAddress: activeSnapshot.invite.party_type === "customer" ? partyProfile?.shipping_address || "" : "",
      periodLabel: statementPeriodLabel,
      rows: filteredAccountRows.map((row) => ({
        document_type: row.document_type,
        date: row.document_date,
        document_no: row.document_no,
        due_date: row.due_date,
        status: row.status,
        currency: row.currency,
        subtotal: Number(row.subtotal ?? row.amount ?? 0),
        discount: Number(row.discount ?? 0),
        shipping: Number(row.shipping ?? 0),
        total: Number(row.total ?? row.amount ?? 0),
      })),
    });
  }

  function handleStatementExportExcel() {
    const title = activeSnapshot.invite.party_type === "customer" ? "Customer Account Statement" : "Vendor Account Statement";
    const rows: Array<Array<string | number | null | undefined>> = [
      [title, activeSnapshot.invite.party_name],
      ["Period", statementPeriodLabel],
      ["Currency", activeSnapshot.accountSummary.currency || "EUR"],
      [],
      ["Document", "No", "Date", "Due Date", "Status", "Subtotal", "Discount", "Shipping", "Total"],
      ...filteredAccountRows.map((row) => [
        row.document_type,
        row.document_no,
        row.document_date,
        row.due_date,
        row.status,
        Number(row.subtotal ?? row.amount ?? 0),
        Number(row.discount ?? 0),
        Number(row.shipping ?? 0),
        Number(row.total ?? row.amount ?? 0),
      ]),
    ];
    const blob = buildXlsxBlob(title.slice(0, 31), rows, [5, 6, 7, 8]);
    downloadBlob(`${sanitizeFileName(`${activeSnapshot.invite.party_name}-account-statement`)}.xlsx`, blob);
  }

  function openPortalDocumentPrint(kind?: PortalSelection["kind"], id?: string) {
    const documentToPrint = kind && id ? getPortalDocumentSelection(kind, id) : selectedDocument;
    if (!documentToPrint) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("Popup blocked while opening PDF view.");
      return;
    }

    const isCustomerDoc = documentToPrint.kind === "sales-order" || documentToPrint.kind === "invoice";
    const currency = documentToPrint.row.currency || activeSnapshot.accountSummary.currency || "EUR";
    const lines = (documentToPrint.row.lines || []).map((line) => ({
      code: line.code || line.requested_code || line.old_code || "-",
      description: line.description || "-",
      origin: line.origin || "",
      brand: line.brand || "",
      orderNo:
        documentToPrint.kind === "sales-order"
          ? documentToPrint.row.sales_order_no || documentToPrint.row.id
          : documentToPrint.kind === "invoice"
            ? documentToPrint.row.sales_order_no || ""
            : documentToPrint.kind === "purchase-order"
              ? documentToPrint.row.id
              : documentToPrint.row.purchase_order_no || documentToPrint.row.id,
      weight: line.weight_kg == null ? "" : formatWeight(line.weight_kg),
      gtip: line.hs_code || "",
      qty: Number(line.qty || 0),
      unitPrice: Number(isCustomerDoc ? line.sell_price || 0 : line.buy_price || 0),
      amount: Number(isCustomerDoc ? line.line_total || line.sales_total || 0 : line.line_total || 0),
    }));

    const html = buildBusinessDocumentHtml({
      docType:
        documentToPrint.kind === "sales-order"
          ? "Sales Order"
          : documentToPrint.kind === "invoice"
            ? "Invoice"
            : documentToPrint.kind === "purchase-order"
              ? "Purchase Order"
              : "Bill",
      docNo:
        documentToPrint.kind === "sales-order"
          ? documentToPrint.row.sales_order_no || documentToPrint.row.id
          : documentToPrint.kind === "invoice"
            ? documentToPrint.row.id
            : documentToPrint.kind === "purchase-order"
              ? documentToPrint.row.id
              : documentToPrint.row.id,
      company: {
        companyName: activeSnapshot.companyProfile?.company_name || "Next Master",
        address: activeSnapshot.companyProfile?.address || "",
        bankDetails: activeSnapshot.companyProfile?.bank_details || "",
        taxNumber: activeSnapshot.companyProfile?.tax_number || "",
        logoDataUrl: activeSnapshot.companyProfile?.logo_data_url || "",
      },
      party: {
        title: isCustomerDoc ? "Bill To" : "Vendor",
        details: isCustomerDoc ? partyProfile?.billing_address || activeSnapshot.invite.party_name : partyProfile?.billing_address || activeSnapshot.invite.party_name,
        shippingTitle: "Shipping Address",
        shippingDetails: isCustomerDoc ? partyProfile?.shipping_address || "" : "",
      },
      meta: [
        {
          label: documentToPrint.kind === "bill" ? "Bill Date" : documentToPrint.kind === "purchase-order" ? "PO Date" : "Date",
          value:
            documentToPrint.kind === "bill"
              ? documentToPrint.row.bill_date || "-"
              : "quote_date" in documentToPrint.row
                ? documentToPrint.row.quote_date || "-"
                : "-",
        },
        ...(documentToPrint.row.payment_terms ? [{ label: "Terms", value: documentToPrint.row.payment_terms }] : []),
        ...("due_date" in documentToPrint.row && documentToPrint.row.due_date ? [{ label: "Due Date", value: documentToPrint.row.due_date }] : []),
        ...("delivery_term" in documentToPrint.row && documentToPrint.row.delivery_term ? [{ label: "Delivery Term", value: documentToPrint.row.delivery_term }] : []),
        ...("contract_nr" in documentToPrint.row && documentToPrint.row.contract_nr ? [{ label: "Contract Nr", value: documentToPrint.row.contract_nr }] : []),
        ...(documentToPrint.kind === "invoice" && documentToPrint.row.sales_order_no ? [{ label: "Sales Order", value: documentToPrint.row.sales_order_no }] : []),
        ...(documentToPrint.kind === "bill" && documentToPrint.row.purchase_order_no ? [{ label: "Purchase Order", value: documentToPrint.row.purchase_order_no }] : []),
      ],
      lines,
      totals: {
        currency,
        subtotal: "subtotal" in documentToPrint.row ? Number(documentToPrint.row.subtotal || 0) : undefined,
        discount: "discount_amount" in documentToPrint.row ? Number(documentToPrint.row.discount_amount || 0) : undefined,
        shipping: "shipping_cost" in documentToPrint.row ? Number(documentToPrint.row.shipping_cost || 0) : undefined,
        total: Number(("sales_total" in documentToPrint.row ? documentToPrint.row.sales_total : documentToPrint.row.total_amount) || 0),
      },
      notes: documentToPrint.row.notes || "",
      totalQty: lines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
      totalWeight: (documentToPrint.row.lines || []).reduce((sum, line) => sum + Number(line.weight_kg || 0), 0),
    });

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  }

  function handlePortalPrint() {
    openPortalDocumentPrint();
  }

  function handlePortalExportExcelRow(kind?: PortalSelection["kind"], id?: string) {
    const documentToExport = kind && id ? getPortalDocumentSelection(kind, id) : selectedDocument;
    if (!documentToExport) return;
    const isCustomerDoc = documentToExport.kind === "sales-order" || documentToExport.kind === "invoice";
    const currency = documentToExport.row.currency || activeSnapshot.accountSummary.currency || "EUR";
    const docNo =
      documentToExport.kind === "sales-order"
        ? documentToExport.row.sales_order_no || documentToExport.row.id
        : documentToExport.kind === "invoice"
          ? documentToExport.row.id
          : documentToExport.kind === "purchase-order"
            ? documentToExport.row.id
            : documentToExport.row.id;
    const rows: Array<Array<string | number | null | undefined>> = [
      [documentToExport.kind === "sales-order" ? "Sales Order" : documentToExport.kind === "invoice" ? "Invoice" : documentToExport.kind === "purchase-order" ? "Purchase Order" : "Bill", docNo],
      ["Party", activeSnapshot.invite.party_name],
      ["Currency", currency],
      [
        "Date",
        documentToExport.kind === "bill"
          ? documentToExport.row.bill_date || ""
          : "quote_date" in documentToExport.row
            ? documentToExport.row.quote_date || ""
            : "",
      ],
      ["Status", documentToExport.row.status || ""],
      [],
      [
        "Code",
        "Brand",
        "Description",
        "Qty",
        "OEM",
        "Origin",
        "Weight",
        isCustomerDoc ? `Unit Price ${currency}` : `Buy Price ${currency}`,
        `Line Total ${currency}`,
        "Notes",
      ],
      ...(documentToExport.row.lines || []).map((line) => [
        line.code || line.requested_code || line.old_code || "-",
        line.brand || "",
        line.description || "",
        Number(line.qty || 0),
        line.oem_no || "",
        line.origin || "",
        line.weight_kg == null ? "" : Number(line.weight_kg),
        Number(isCustomerDoc ? line.sell_price || 0 : line.buy_price || 0),
        Number(isCustomerDoc ? line.line_total || line.sales_total || 0 : line.line_total || 0),
        line.notes || "",
      ]),
      [],
      ["Subtotal", "", "", "", "", "", "", "", Number(("subtotal" in documentToExport.row ? documentToExport.row.subtotal : documentToExport.row.total_amount) || 0)],
      ["Discount", "", "", "", "", "", "", "", Number(("discount_amount" in documentToExport.row ? documentToExport.row.discount_amount : 0) || 0)],
      ["Shipping", "", "", "", "", "", "", "", Number(("shipping_cost" in documentToExport.row ? documentToExport.row.shipping_cost : 0) || 0)],
      ["Total Amount", "", "", "", "", "", "", "", Number(("sales_total" in documentToExport.row ? documentToExport.row.sales_total : documentToExport.row.total_amount) || 0)],
    ];
    const blob = buildXlsxBlob(docNo.slice(0, 31) || "Document", rows, [3, 6, 7, 8]);
    downloadBlob(`${sanitizeFileName(docNo || documentToExport.kind)}.xlsx`, blob);
  }

  function handlePortalExportExcel() {
    handlePortalExportExcelRow();
  }

  const documentDetailSection = selectedDocument ? (
    <SectionCard
      title={detailTitle}
      actions={
        <div className="inline-actions">
          <Button variant="secondary" onClick={handlePortalPrint}>
            PDF / Print
          </Button>
          <Button variant="secondary" onClick={handlePortalExportExcel}>
            Export Excel
          </Button>
          <Button variant="secondary" onClick={() => setSelection(null)}>
            Close
          </Button>
        </div>
      }
    >
      <div className="portal-document-detail">
        <div className="portal-detail-grid">
          <div className="settings-item">
            <span className="settings-label">Status</span>
            <strong>{selectedDocument.row.status || "-"}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">Currency</span>
            <strong>{selectedDocument.row.currency || "-"}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">Date</span>
            <strong>
              {formatDate(
                selectedDocument.kind === "bill"
                  ? selectedDocument.row.bill_date
                  : "quote_date" in selectedDocument.row
                    ? selectedDocument.row.quote_date
                    : undefined,
              )}
            </strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">Due Date</span>
            <strong>{formatDate("due_date" in selectedDocument.row ? selectedDocument.row.due_date : undefined)}</strong>
          </div>
          {"delivery_term" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Delivery Term</span>
              <strong>{selectedDocument.row.delivery_term || "-"}</strong>
            </div>
          ) : null}
          {"payment_terms" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Payment Terms</span>
              <strong>{selectedDocument.row.payment_terms || "-"}</strong>
            </div>
          ) : null}
          {"contract_nr" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Contract Nr</span>
              <strong>{selectedDocument.row.contract_nr || "-"}</strong>
            </div>
          ) : null}
          {"packing_details" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Packing</span>
              <strong>{selectedDocument.row.packing_details || "-"}</strong>
            </div>
          ) : null}
        </div>

        {selectedDocument.row.notes ? (
          <div className="portal-detail-notes">
            <span className="settings-label">Notes</span>
            <strong>{selectedDocument.row.notes}</strong>
          </div>
        ) : null}

        <DataTable rows={selectedDocument.row.lines || []} columns={detailColumns} emptyText="No line details available." />

        <div className="portal-detail-totals">
          {"subtotal" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Sub Total</span>
              <strong>{formatMoney(Number(selectedDocument.row.subtotal || 0), selectedDocument.row.currency)}</strong>
            </div>
          ) : null}
          {"discount_amount" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Discount</span>
              <strong>{formatMoney(Number(selectedDocument.row.discount_amount || 0), selectedDocument.row.currency)}</strong>
            </div>
          ) : null}
          {"shipping_cost" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Shipping</span>
              <strong>{formatMoney(Number(selectedDocument.row.shipping_cost || 0), selectedDocument.row.currency)}</strong>
            </div>
          ) : null}
          {"purchase_total" in selectedDocument.row && selectedDocument.kind !== "sales-order" && selectedDocument.kind !== "invoice" ? (
            <div className="settings-item">
              <span className="settings-label">Purchase Total</span>
              <strong>{formatMoney(Number(selectedDocument.row.purchase_total || 0), selectedDocument.row.currency)}</strong>
            </div>
          ) : null}
          <div className="settings-item">
            <span className="settings-label">Total Amount</span>
            <strong>{formatMoney(Number(("sales_total" in selectedDocument.row ? selectedDocument.row.sales_total : selectedDocument.row.total_amount) || 0), selectedDocument.row.currency)}</strong>
          </div>
        </div>
      </div>
    </SectionCard>
  ) : null;

  return (
    <div className="portal-shell">
      <div className="portal-header">
        <div className="portal-brand">
          {activeSnapshot.companyProfile?.logo_data_url ? <img src={activeSnapshot.companyProfile.logo_data_url} alt="Portal logo" className="portal-brand__logo" /> : null}
          <div>
            <h1>{activeSnapshot.companyProfile?.company_name || "Next Master Portal"}</h1>
            <p>
              {activeSnapshot.invite.party_type === "customer" ? "Customer Portal" : "Vendor Portal"} for {activeSnapshot.invite.party_name}
            </p>
          </div>
        </div>
        <div className="inline-actions">
          <Button variant="secondary" busy={loading} busyLabel="Refreshing..." onClick={() => void handleRefresh()}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={handleLogout}>
            Logout
          </Button>
        </div>
      </div>

      {status ? <div className="success-text">{status}</div> : null}
      {error ? <div className="warning-text">{error}</div> : null}
      {activeSection !== "desk" ? (
        <div className="portal-kpi-strip">
          {portalQuickStats.map((item) => (
            <div key={item.label} className="portal-kpi-card">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.note}</small>
            </div>
          ))}
        </div>
      ) : null}

      <div className="portal-subnav">
        {portalSections.map((section) => (
          <button
            key={section.key}
            type="button"
            className={`portal-subnav__button ${activeSection === section.key ? "portal-subnav__button--active" : ""}`}
            onClick={() => setActiveSection(section.key)}
          >
            {section.label}
          </button>
        ))}
      </div>
      <div className="portal-subnav__hint">{activeSectionHelpText}</div>

      {activeSection === "account" ? (
        <div className="portal-section-stack">
          <div className="portal-summary-grid">
            <SectionCard title="Account Profile">
              <div className="settings-grid settings-grid--compact">
                <div className="settings-item">
                  <span className="settings-label">Party</span>
                  <strong>{activeSnapshot.invite.party_name}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Email</span>
                  <strong>{activeSnapshot.invite.email}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Billing Address</span>
                  <strong>{partyProfile?.billing_address || "-"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Shipping Address</span>
                  <strong>{partyProfile?.shipping_address || "-"}</strong>
                </div>
              </div>
            </SectionCard>
            <SectionCard title="Financial Summary">
              <div className="dashboard-grid">
                <div className="dashboard-stat">
                  <span>Total Documents</span>
                  <strong>{activeSnapshot.accountSummary.totalDocuments}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>{activeSnapshot.invite.party_type === "customer" ? "Invoice Amount" : "Bill Amount"}</span>
                  <strong>{formatMoney(activeSnapshot.accountSummary.documentAmount, activeSnapshot.accountSummary.currency)}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>{activeSnapshot.invite.party_type === "customer" ? "Credit Notes" : "Vendor Credits"}</span>
                  <strong>{formatMoney(activeSnapshot.accountSummary.creditAmount, activeSnapshot.accountSummary.currency)}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>Payment Amount</span>
                  <strong>{formatMoney(activeSnapshot.accountSummary.paymentAmount, activeSnapshot.accountSummary.currency)}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>Balance</span>
                  <strong>{formatMoney(activeSnapshot.accountSummary.openAmount, activeSnapshot.accountSummary.currency)}</strong>
                </div>
              </div>
            </SectionCard>
          </div>
        </div>
      ) : null}

      {activeSection === "statement" ? (
        <div className="portal-section-stack">
          {activeSnapshot.invite.access.can_view_account ? (
            <SectionCard
              title="Statement"
              actions={
                <div className="portal-statement-actions">
                  <Input label="Date From" type="date" value={statementDateFrom} onChange={setStatementDateFrom} />
                  <Input label="Date To" type="date" value={statementDateTo} onChange={setStatementDateTo} />
                  <Button variant="secondary" onClick={handleStatementExportExcel}>
                    Export Excel
                  </Button>
                  <Button variant="secondary" onClick={handleStatementPrint}>
                    PDF / Print
                  </Button>
                </div>
              }
            >
              <div className="portal-summary-list">
                <div className="dashboard-stat">
                  <span>Period</span>
                  <strong>{statementPeriodLabel}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>Open Balance</span>
                  <strong>{formatMoney(activeSnapshot.accountSummary.openAmount, activeSnapshot.accountSummary.currency)}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>Payment Amount</span>
                  <strong>{formatMoney(activeSnapshot.accountSummary.paymentAmount, activeSnapshot.accountSummary.currency)}</strong>
                </div>
              </div>
            </SectionCard>
          ) : null}

          {activeSnapshot.invite.access.can_view_account ? (
            <SectionCard title="Account Statement">
              <DataTable rows={filteredAccountRows} columns={accountColumns} emptyText="No statement rows available." />
            </SectionCard>
          ) : null}

          {activeSnapshot.invite.access.can_view_payments ? (
            <SectionCard title="Payment History">
              <DataTable rows={visiblePayments} columns={paymentColumns} emptyText="No payments available." />
            </SectionCard>
          ) : null}

          {activeSnapshot.invite.party_type === "customer" && activeSnapshot.invite.access.can_view_invoices ? (
            <SectionCard title="Credit Notes">
              <DataTable rows={filteredCreditNotes} columns={creditColumns} emptyText="No credit notes available." />
            </SectionCard>
          ) : null}

          {activeSnapshot.invite.party_type === "vendor" && activeSnapshot.invite.access.can_view_invoices ? (
            <SectionCard title="Vendor Credits">
              <DataTable rows={filteredVendorCredits} columns={vendorCreditColumns} emptyText="No vendor credits available." />
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {activeSection === "pricelist" && portalCanOrder ? (
        <div className="portal-section-stack">
          <SectionCard title="Download Price List">
            <div className="portal-filter-grid">
              <Select
                label="Brand"
                value={portalPriceListBrand}
                options={portalBrandValueOptions}
                onChange={setPortalPriceListBrand}
              />
              <div className="portal-filter-stat">
                <span>Customer Pricing</span>
                <strong>{activeSnapshot.pricingProfile ? "Customer Account Pricing" : "Default Pricing"}</strong>
              </div>
              <div className="portal-builder-actions">
                <Button
                  variant="secondary"
                  busy={downloadingPortalPriceList}
                  busyLabel="Preparing..."
                  onClick={() => void handleDownloadPortalPriceList()}
                >
                  Download Excel
                </Button>
              </div>
            </div>
          </SectionCard>
          <SectionCard title="How This Download Works">
            <div className="portal-inline-note portal-inline-note--soft">
              <span>Pricing Rule</span>
              <strong>The file is built using the price list assigned on this customer account for the selected brand.</strong>
            </div>
            <div className="portal-inline-note portal-inline-note--soft">
              <span>Fields</span>
              <strong>Product code, description, OEM, tariff, origin, weight, lifecycle, and customer sales price are included.</strong>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {activeSection === "orders" ? (
        <div className="portal-section-stack">
          <SectionCard title={activeSnapshot.invite.party_type === "customer" ? "Order Filters" : "Purchase Order Filters"}>
            <div className="portal-filter-grid">
              <Input label="Search" value={documentSearch} placeholder="Order no, code, description" onChange={setDocumentSearch} />
              <Select label="Brand" value={brandFilter} options={brandOptions} onChange={setBrandFilter} />
              <div className="portal-filter-stat">
                <span>Records</span>
                <strong>{portalOrderHistoryRows.length.toLocaleString("en-US")}</strong>
              </div>
            </div>
          </SectionCard>

          <div className={`portal-record-layout ${selectedDocument && (selectedDocument.kind === "sales-order" || selectedDocument.kind === "purchase-order") ? "" : "portal-record-layout--single"}`}>
            <div className="portal-record-layout__main">
              <SectionCard title={activeSnapshot.invite.party_type === "customer" ? "Order History" : "Purchase Orders"}>
                <DataTable
                  rows={portalOrderHistoryRows}
                  columns={activeSnapshot.invite.party_type === "customer" ? salesOrderColumns : purchaseOrderColumns}
                  emptyText={activeSnapshot.invite.party_type === "customer" ? "No orders available." : "No purchase orders available."}
                  onRowClick={(row) => openPortalDocument({ kind: activeSnapshot.invite.party_type === "customer" ? "sales-order" : "purchase-order", id: row.id })}
                  rowClassName={(row) =>
                    selection &&
                    ((selection.kind === "sales-order" && activeSnapshot.invite.party_type === "customer") ||
                      (selection.kind === "purchase-order" && activeSnapshot.invite.party_type === "vendor")) &&
                    selection.id === row.id
                      ? "data-table__row--active"
                      : ""
                  }
                />
              </SectionCard>
            </div>
            {selectedDocument && (selectedDocument.kind === "sales-order" || selectedDocument.kind === "purchase-order") ? (
              <div className="portal-record-layout__detail">{documentDetailSection}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeSection === "billing" ? (
        <div className="portal-section-stack">
          <SectionCard title={activeSnapshot.invite.party_type === "customer" ? "Invoice Filters" : "Bill Filters"}>
            <div className="portal-filter-grid">
              <Input label="Search" value={documentSearch} placeholder="Document no, code, description" onChange={setDocumentSearch} />
              <Select label="Brand" value={brandFilter} options={brandOptions} onChange={setBrandFilter} />
              <Select label={activeSnapshot.invite.party_type === "customer" ? "Invoice Status" : "Bill Status"} value={paymentStatusFilter} options={paymentStatusOptions} onChange={setPaymentStatusFilter} />
            </div>
          </SectionCard>

          <div className={`portal-record-layout ${selectedDocument && (selectedDocument.kind === "invoice" || selectedDocument.kind === "bill") ? "" : "portal-record-layout--single"}`}>
            <div className="portal-record-layout__main">
              <SectionCard title={activeSnapshot.invite.party_type === "customer" ? "Invoices" : "Bills"}>
                <DataTable
                  rows={portalBillingRows}
                  columns={activeSnapshot.invite.party_type === "customer" ? invoiceColumns : billColumns}
                  emptyText={activeSnapshot.invite.party_type === "customer" ? "No invoices available." : "No bills available."}
                  onRowClick={(row) => openPortalDocument({ kind: activeSnapshot.invite.party_type === "customer" ? "invoice" : "bill", id: row.id })}
                  rowClassName={(row) =>
                    selection &&
                    ((selection.kind === "invoice" && activeSnapshot.invite.party_type === "customer") ||
                      (selection.kind === "bill" && activeSnapshot.invite.party_type === "vendor")) &&
                    selection.id === row.id
                      ? "data-table__row--active"
                      : ""
                  }
                />
              </SectionCard>
            </div>
            {selectedDocument && (selectedDocument.kind === "invoice" || selectedDocument.kind === "bill") ? (
              <div className="portal-record-layout__detail">{documentDetailSection}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeSection === "desk" && portalCanOrder ? (
        <div className="portal-section-stack">
          <SectionCard
            title="Part Search"
            actions={
              <div className="workbench-controls workbench-controls--compact">
                <div className="segmented-control">
                  <button
                    type="button"
                    className={`segmented-control__item ${orderDeskView === "simple" ? "active" : ""}`}
                    onClick={() => setOrderDeskView("simple")}
                  >
                    Simple View
                  </button>
                  <button
                    type="button"
                    className={`segmented-control__item ${orderDeskView === "advanced" ? "active" : ""}`}
                    onClick={() => setOrderDeskView("advanced")}
                  >
                    Advanced View
                  </button>
                </div>
              </div>
            }
          >
            <div className="portal-order-builder">
              <div className="portal-order-builder__meta">
                <div className="dashboard-stat">
                  <span>Active Basket</span>
                  <strong>{portalSalesOrderNo || "New Basket"}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>Currency</span>
                  <strong>{portalOrderCurrency}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>Basket Total</span>
                  <strong>{formatMoney(portalOrderTotals.subtotal, portalOrderCurrency)}</strong>
                </div>
                <div className="dashboard-stat">
                  <span>Warning Items</span>
                  <strong>{portalDraftWarningLines.length.toLocaleString("en-US")}</strong>
                </div>
              </div>

              <form
                className="portal-filter-grid portal-filter-grid--desk"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handlePortalCatalogSearch();
                }}
              >
                <Select
                  label="Basket"
                  value={portalOrderId}
                  options={portalDraftSelectionOptions}
                  onChange={(value) => {
                    if (!value) {
                      handleClearPortalBuilder();
                      return;
                    }
                    const target = portalDraftOrders.find((row) => row.id === value);
                    if (target) handleResumePortalDraft(target);
                  }}
                />
                <Input label="Part Search" value={orderSearch} placeholder="Part no, original no, description" onChange={setOrderSearch} />
                <Select label="Brand" value={orderSearchBrand} options={portalBrandOptions} onChange={setOrderSearchBrand} />
                <div className="portal-builder-actions">
                  <input
                    ref={portalImportRef}
                    type="file"
                    hidden
                    accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleImportPortalOrderFile(file);
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={() => portalImportRef.current?.click()}>
                    Import Excel
                  </Button>
                  <Button type="button" variant="secondary" onClick={downloadQuoteTemplate}>
                    Template
                  </Button>
                  <Button type="submit" variant="secondary" busy={searchingCatalog} busyLabel="Searching..." onClick={() => void handlePortalCatalogSearch()}>
                    Search
                  </Button>
                </div>
              </form>

              <div className="portal-inline-note portal-inline-note--soft">
                <span>Search Logic</span>
                <strong>Original number search returns matching alternatives. Added items always appear in the basket below.</strong>
              </div>

              <Input label="Notes" value={portalOrderNotes} placeholder="Order note for your internal buying team" onChange={setPortalOrderNotes} />

              {portalOrderStatus ? <div className="success-text">{portalOrderStatus}</div> : null}
              {portalDraftHasMissingPrices ? <div className="warning-text">Items without live price can be saved in the basket but cannot be submitted.</div> : null}
              {portalDraftDiscontinuedCount > 0 ? (
                <div className="warning-text">
                  {portalDraftDiscontinuedCount.toLocaleString("en-US")} discontinued item(s) detected in this basket. Review before submission.
                </div>
              ) : null}

              <div className="portal-workbench">
                <div className="portal-workbench__tables">
                  <SectionCard title={`Matching Products & Alternatives (${catalogResults.length.toLocaleString("en-US")})`}>
                    {catalogResults.length ? (
                      <div className="portal-search-card-grid">
                        {portalSearchCards.map((row) => (
                          <button
                            key={`${row.brand}-${row.code}`}
                            type="button"
                            className={`portal-search-card ${selectedCatalogCode === row.code ? "portal-search-card--active" : ""}`}
                            onClick={() => setSelectedCatalogCode(row.code)}
                          >
                            <div className="portal-search-card__top">
                              <div className="portal-search-card__media">
                                {row.image_url ? <img src={row.image_url} alt={row.code} className="catalog-thumb catalog-thumb--detail" loading="lazy" /> : <div className="empty-state">No photo</div>}
                              </div>
                              <div className="portal-search-card__meta">
                                <div className="portal-search-card__code">{row.code || "-"}</div>
                                <BrandPill brand={row.brand} compact />
                                <div className="portal-search-card__price">
                                  {row.sell_price == null ? "Price on request" : formatMoney(row.sell_price, row.currency || portalPricingCurrency)}
                                </div>
                              </div>
                            </div>
                            <div className="portal-search-card__body">
                              <strong>{row.description || "-"}</strong>
                              <span>{row.oem_no || "No OEM listed"}</span>
                              <div className="portal-search-card__specs">
                                <span>{row.tariff || "No tariff"}</span>
                                <span>{row.origin || "No origin"}</span>
                                <span>{formatWeight(row.weight_kg)}</span>
                              </div>
                              {row.lifecycle_status === "discontinued" ? (
                                <div className="portal-search-card__warning">Discontinued</div>
                              ) : null}
                            </div>
                            <div className="portal-search-card__actions">
                              <Button
                                variant="secondary"
                                className="button--compact"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleAddPortalCatalogItem(row);
                                }}
                              >
                                Add to Basket
                              </Button>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {orderDeskView === "advanced" ? (
                      <DataTable
                        rows={catalogResults}
                        columns={portalCatalogColumns}
                        emptyText={searchingCatalog ? "Searching items..." : "Search by part number, original number, or description to load matching products and alternatives."}
                        onRowClick={(row) => setSelectedCatalogCode(row.code)}
                        rowClassName={(row) => (selectedCatalogCode === row.code ? "data-table__row--active" : "")}
                      />
                    ) : !catalogResults.length ? (
                      <div className="empty-state">
                        {searchingCatalog ? "Searching items..." : "Search by part number, original number, or description to load matching products and alternatives."}
                      </div>
                    ) : null}
                  </SectionCard>

                  <div ref={portalDraftLinesRef}>
                    <SectionCard title={`Basket (${portalDraftLines.length.toLocaleString("en-US")})`}>
                      <DataTable
                        rows={portalDraftLines}
                        columns={portalDraftColumns}
                        emptyText={preparingPortalOrder ? "Preparing prices..." : "Use Add on a search result or import a file to build the basket here."}
                        onRowClick={(row) => setSelectedDraftLineId(row.lineId)}
                        rowClassName={(row) => (selectedDraftLineId === row.lineId ? "data-table__row--active" : "")}
                      />
                    </SectionCard>
                  </div>
                </div>

                <aside className="portal-workbench__side">
                  <div className="workbench-detail-panel workbench-detail-panel--catalog">
                    <div className="workbench-detail-panel__eyebrow">{selectedDraftLine ? "Basket Focus" : "Part Search Focus"}</div>
                    <div className="workbench-detail-panel__title">{orderDeskFocusTitle}</div>
                    {selectedDraftLine ? (
                      <>
                        <div className="workbench-detail-panel__media">
                          {selectedDraftLine.image_url ? (
                            <button
                              type="button"
                              className="catalog-thumb-button catalog-thumb-button--detail"
                              onClick={() =>
                                setPreviewImage({
                                  src: selectedDraftLine.image_url || "",
                                  code: selectedDraftLine.resolvedCode || selectedDraftLine.requestedCode || "",
                                  name: selectedDraftLine.description || "",
                                })
                              }
                            >
                              <img
                                src={selectedDraftLine.image_url}
                                alt={selectedDraftLine.resolvedCode || selectedDraftLine.requestedCode || ""}
                                className="catalog-thumb catalog-thumb--detail"
                                loading="lazy"
                              />
                            </button>
                          ) : (
                            <div className="empty-state">No photo</div>
                          )}
                        </div>
                        <div className="workbench-detail-list">
                          <div><span>Requested Code</span><strong>{selectedDraftLine.requestedCode || "-"}</strong></div>
                          <div><span>Resolved Code</span><strong>{selectedDraftLine.resolvedCode || "-"}</strong></div>
                          <div><span>Brand</span><strong>{selectedDraftLine.brand || "-"}</strong></div>
                          <div><span>Description</span><strong>{selectedDraftLine.description || "-"}</strong></div>
                          <div><span>OEM</span><strong>{selectedDraftLine.oem_no || "-"}</strong></div>
                          <div><span>Tariff</span><strong>{selectedDraftLine.hs_code || "-"}</strong></div>
                          <div><span>Origin</span><strong>{selectedDraftLine.origin || "-"}</strong></div>
                          <div><span>Weight</span><strong>{formatWeight(selectedDraftLine.weight_kg)}</strong></div>
                          <div><span>Unit Price</span><strong>{selectedDraftLine.sell_price == null ? "-" : formatMoney(selectedDraftLine.sell_price, portalOrderCurrency)}</strong></div>
                          {selectedDraftLine.codeChangeWarning ? <div><span>Replacement</span><strong>{selectedDraftLine.codeChangeWarning}</strong></div> : null}
                          {selectedDraftLine.lifecycle_warning ? <div><span>Lifecycle</span><strong>{selectedDraftLine.lifecycle_warning}</strong></div> : null}
                        </div>
                      </>
                    ) : selectedCatalogItem ? (
                      <>
                        <div className="workbench-detail-panel__media">
                          {selectedCatalogItem.image_url ? (
                            <button
                              type="button"
                              className="catalog-thumb-button catalog-thumb-button--detail"
                              onClick={() =>
                                setPreviewImage({
                                  src: selectedCatalogItem.image_url || "",
                                  code: selectedCatalogItem.code || "",
                                  name: selectedCatalogItem.description || "",
                                })
                              }
                            >
                              <img src={selectedCatalogItem.image_url} alt={selectedCatalogItem.code || ""} className="catalog-thumb catalog-thumb--detail" loading="lazy" />
                            </button>
                          ) : (
                            <div className="empty-state">No photo</div>
                          )}
                        </div>
                        <div className="workbench-detail-list">
                          <div><span>Code</span><strong>{selectedCatalogItem.code || "-"}</strong></div>
                          <div><span>Brand</span><strong>{selectedCatalogItem.brand || "-"}</strong></div>
                          <div><span>Description</span><strong>{selectedCatalogItem.description || "-"}</strong></div>
                          <div><span>OEM</span><strong>{selectedCatalogItem.oem_no || "-"}</strong></div>
                          <div><span>Tariff</span><strong>{selectedCatalogItem.tariff || "-"}</strong></div>
                          <div><span>Origin</span><strong>{selectedCatalogItem.origin || "-"}</strong></div>
                          <div><span>Weight</span><strong>{formatWeight(selectedCatalogItem.weight_kg)}</strong></div>
                          <div><span>Unit Price</span><strong>{selectedCatalogItem.sell_price == null ? "-" : formatMoney(selectedCatalogItem.sell_price, selectedCatalogItem.currency || portalOrderCurrency)}</strong></div>
                          {selectedCatalogItem.lifecycle_warning ? <div><span>Lifecycle</span><strong>{selectedCatalogItem.lifecycle_warning}</strong></div> : null}
                        </div>
                      </>
                    ) : (
                      <div className="chart-placeholder">Search a part number or original number, then select a result or selected item to inspect full detail.</div>
                    )}

                    {portalOriginalNumberBrandMatches.length ? (
                      <div className="portal-inline-note">
                        <span>Original No Match</span>
                        <strong>{portalOriginalNumberBrandMatches.join(", ")}</strong>
                      </div>
                    ) : null}

                    {portalDraftWarningLines.length ? (
                      <div className="portal-warning-list">
                        <h3>Warning Items</h3>
                        {portalDraftWarningLines.slice(0, 6).map((line) => (
                          <button
                            key={line.lineId}
                            type="button"
                            className="portal-warning-list__item"
                            onClick={() => setSelectedDraftLineId(line.lineId)}
                          >
                            <strong>{line.resolvedCode || line.requestedCode || "-"}</strong>
                            <span>
                              {line.sell_price == null
                                ? "Missing live price"
                                : line.lifecycle_status === "discontinued"
                                  ? "Discontinued"
                                  : line.codeChangeWarning || "Review line"}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </aside>
              </div>

              <div className="portal-action-bar">
                <Button variant="secondary" busy={savingPortalOrder} busyLabel="Saving..." onClick={() => void handleSubmitPortalOrder("draft")}>
                  Save Basket
                </Button>
                <Button variant="secondary" onClick={handleClearPortalBuilder}>
                  Clear
                </Button>
                <Button busy={confirmingPortalOrder} busyLabel="Submitting..." disabled={portalDraftHasMissingPrices} onClick={() => void handleSubmitPortalOrder("confirm")}>
                  Submit Basket
                </Button>
              </div>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {portalOverlay ? (
        <div className="modal-backdrop">
          <div className="modal-card modal-card--compact">
            <div className="modal-card__header">
              <h3>{portalOverlay.title}</h3>
              <p>{portalOverlay.message}</p>
            </div>
          </div>
        </div>
      ) : null}

      {previewImage ? (
        <div className="modal-backdrop" onClick={() => setPreviewImage(null)}>
          <div className="modal-card modal-card--image-preview" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card__header">
              <div>
                <h3>{previewImage.code}</h3>
                <p>{previewImage.name || "Portal image preview"}</p>
              </div>
            </div>
            <div className="image-preview-wrap">
              <img src={previewImage.src} alt={previewImage.code} className="image-preview" />
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setPreviewImage(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
