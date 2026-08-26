import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  confirmPortalPasswordReset,
  fetchPortalBranding,
  fetchPortalSnapshot,
  loginPortal,
  logoutPortalSession,
  requestPortalPasswordReset,
} from "../../../infrastructure/api/portalAccessApi";
import type { PortalBranding, PortalCredentials, PortalSnapshot } from "../../../types/portalSession";
import { Button } from "../../../presentation/components/common/Button";
import { DataTable } from "../../../presentation/components/common/DataTable";
import { DraggableSurface } from "../../../presentation/components/common/DraggableSurface";
import { Input } from "../../../presentation/components/common/Input";
import { Select } from "../../../presentation/components/common/Select";
import { SectionCard } from "../../../presentation/components/common/SectionCard";
import { BrandPill } from "../../../presentation/components/common/BrandPill";
import { ProductVisual } from "../../../presentation/components/common/ProductVisual";
import { VehicleBadges } from "../../../presentation/components/common/VehicleBadges";
import { buildBusinessDocumentHtml } from "../../../shared/documentPrint";
import { openAccountStatementPrintWindow } from "../../../shared/accountStatementPrint";
import { buildXlsxBlob, downloadBlob } from "../../../shared/xlsx";
import { formatBrandAwareProductCode } from "../../../shared/productCodeDisplay";
import { matchesOriginalNumberSearch, normalizePartCode } from "../../../domain/shared/normalize";
import { downloadQuoteTemplate } from "../../../shared/importTemplates";
import {
  deletePortalDraftOrder,
  downloadPortalPriceList,
  fetchPortalSalesOrderDetail,
  preparePortalOrderLines as preparePortalOrderLinesApi,
  searchPortalCatalogItems,
  submitPortalOrder,
  type PortalCatalogSearchItem,
  type PortalPreparedLine,
  type PortalSearchField,
} from "../../../infrastructure/api/portalOrderApi";
import { fetchCatalogProductMedia } from "../../../infrastructure/api/catalogMediaApi";
import type { ProductMediaItem } from "../../../presentation/components/common/ProductVisual";
import { parseOrderImportFile } from "../../../shared/orderImport";
import { CustomerDeskHome } from "../components/CustomerDeskHome";
import { PortalSearchResults } from "../components/PortalSearchResults";

const buildMeta = __APP_BUILD_META__;
const buildContextMeta = {
  production: { label: "Production", className: "is-production" },
  "deploy-preview": { label: "Preview", className: "is-preview" },
  "branch-deploy": { label: "Branch", className: "is-branch" },
  local: { label: "Local", className: "is-local" },
} as const;

const SESSION_KEY = "next-master-portal-session";
const PORTAL_CACHE_PREFIX = "next-master-portal-cache";
const PORTAL_CACHE_WRITE_DELAY_MS = 250;
const PORTAL_BACKGROUND_REFRESH_MS = 60_000;
const PORTAL_COMPACT_SEARCH_BREAKPOINT_PX = 1280;
const PORTAL_MOBILE_LAYOUT_BREAKPOINT_PX = 768;
const PORTAL_DESKTOP_BASE_WIDTH_PX = 1440;
const PORTAL_DESKTOP_SCALE_SIDE_PADDING_PX = 24;

type PortalOfflineDraft = {
  portalDraftLines: PortalPreparedLine[];
  portalOrderId: string;
  portalSalesOrderNo: string;
  portalDeliveryTerm: string;
  portalPaymentTerms: string;
  portalPackingDetails: string;
  portalOrderNotes: string;
  portalOrderStatus: string;
  catalogResults: PortalCatalogSearchItem[];
  catalogRecommendations: PortalCatalogSearchItem[];
  orderSearch: string;
  orderSearchBrand: string;
  selectedCatalogCode: string;
  selectedDraftLineId: string;
  activeSection: PortalSection;
};

type PortalOfflineCache = {
  snapshot: PortalSnapshot | null;
  draft: PortalOfflineDraft;
  updatedAt: string;
};

type PortalActivityNotification = {
  id: string;
  title: string;
  detail: string;
};

function mergePortalSnapshotOrderDetails(current: PortalSnapshot | null, next: PortalSnapshot) {
  if (!current) return next;
  const currentOrders = new Map(current.salesOrders.map((order) => [order.id, order]));
  return {
    ...next,
    salesOrders: next.salesOrders.map((order) => {
      const previous = currentOrders.get(order.id);
      // History snapshots intentionally use a compact order projection and
      // omit line JSON. Keep any detail already loaded in the workspace so a
      // background refresh can never blank an open order after an edit.
      if (previous?.lines?.length && !order.lines?.length) {
        return { ...order, lines: previous.lines };
      }
      return order;
    }),
  };
}

function getPortalActivityStorageKey(email: string) {
  return `${getPortalCacheKey(email)}:activity`;
}

function buildPortalActivityFingerprint(snapshot: PortalSnapshot) {
  const compact = (rows: Array<Record<string, unknown>>) =>
    rows.map((row) => ({
      id: String(row.id || ""),
      status: String(row.status || ""),
      updated_at: String(row.updated_at || ""),
      portal_submitted_at: String(row.portal_submitted_at || ""),
    }));
  return {
    salesOrders: compact(snapshot.salesOrders as unknown as Array<Record<string, unknown>>),
    invoices: compact(snapshot.invoices as unknown as Array<Record<string, unknown>>),
    creditNotes: compact(snapshot.creditNotes as unknown as Array<Record<string, unknown>>),
    payments: compact(snapshot.paymentsReceived as unknown as Array<Record<string, unknown>>),
  };
}

function readPortalActivityFingerprint(email: string) {
  if (typeof window === "undefined" || !email) return null;
  try {
    const raw = window.sessionStorage.getItem(getPortalActivityStorageKey(email));
    return raw ? (JSON.parse(raw) as ReturnType<typeof buildPortalActivityFingerprint>) : null;
  } catch {
    return null;
  }
}

function writePortalActivityFingerprint(email: string, snapshot: PortalSnapshot) {
  if (typeof window === "undefined" || !email) return;
  try {
    window.sessionStorage.setItem(getPortalActivityStorageKey(email), JSON.stringify(buildPortalActivityFingerprint(snapshot)));
  } catch {
    // Notifications are best-effort and must never block the portal.
  }
}

function buildPortalActivityNotifications(
  previous: ReturnType<typeof buildPortalActivityFingerprint> | null,
  next: PortalSnapshot,
): PortalActivityNotification[] {
  if (!previous) return [];
  const current = buildPortalActivityFingerprint(next);
  const events: PortalActivityNotification[] = [];
  const compare = (kind: string, title: string, before: Array<Record<string, string>>, after: Array<Record<string, string>>) => {
    const beforeById = new Map(before.map((row) => [row.id, row]));
    after.forEach((row) => {
      const prior = beforeById.get(row.id);
      if (prior && prior.updated_at === row.updated_at && prior.status === row.status && prior.portal_submitted_at === row.portal_submitted_at) return;
      const action = prior ? "updated" : "added";
      events.push({ id: `${kind}:${row.id}:${row.updated_at}:${row.status}`, title: `${title} ${row.id || "record"} ${action}`, detail: "New information is available in your portal." });
    });
  };
  compare("sales-order", "Sales Order", previous.salesOrders, current.salesOrders);
  compare("invoice", "Invoice", previous.invoices, current.invoices);
  compare("credit-note", "Credit Note", previous.creditNotes, current.creditNotes);
  compare("payment", "Payment", previous.payments, current.payments);
  return events.slice(-8).reverse();
}

function buildEmptyPortalOfflineDraft(activeSection: PortalSection = "home"): PortalOfflineDraft {
  return {
    portalDraftLines: [],
    portalOrderId: "",
    portalSalesOrderNo: "",
    portalDeliveryTerm: "",
    portalPaymentTerms: "",
    portalPackingDetails: "",
    portalOrderNotes: "",
    portalOrderStatus: "",
    catalogResults: [],
    catalogRecommendations: [],
    orderSearch: "",
    orderSearchBrand: "",
    selectedCatalogCode: "",
    selectedDraftLineId: "",
    activeSection,
  };
}

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

function buildPortalLoginInitials(value: string) {
  const tokens = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return "PT";
  return tokens
    .slice(0, 2)
    .map((token) => token[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 2);
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
    const lineSegment = String(line.market_segment || "").toLowerCase();
    const existing = merged.find(
      (item) =>
        normalizePartCode(String(item.requestedCode || item.resolvedCode || "")) === lineCode &&
        String(item.brand || "").toLowerCase() === String(line.brand || "").toLowerCase() &&
        String(item.market_segment || "").toLowerCase() === lineSegment,
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

function renderReplacementBadge(row: { replacement_warning?: string | null }) {
  if (!String(row.replacement_warning || "").trim()) return null;
  return (
    <div>
      <span className="mark-badge mark-badge--accent">Replacement</span>
      <div className="warning-text">{row.replacement_warning}</div>
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
type PortalSection = "home" | "desk" | "pricelist" | "orders" | "billing" | "statement" | "account";
type PortalNavGroupKey = "home" | "search" | "pricing" | "documents" | "finance" | "account";
type PortalSearchView = "cards" | "list";

type PortalLine = NonNullable<PortalSnapshot["invoices"][number]["lines"]>[number];
type PortalSalesOrderRow = PortalSnapshot["salesOrders"][number];

function mapPortalSalesOrderToPreparedLines(row: PortalSalesOrderRow): PortalPreparedLine[] {
  return (row.lines || []).map((line, index) => {
    const requestedCode = String(line.old_code || line.requested_code || line.code || "");
    const resolvedCode = String(line.code || requestedCode || "");
    const qty = Math.max(1, Number(line.qty || 1) || 1);
    const sellPrice = line.sell_price == null ? null : Number(line.sell_price);
    const codeChanged = Boolean(
      line.old_code || (requestedCode && resolvedCode && requestedCode.trim().toLowerCase() !== resolvedCode.trim().toLowerCase()),
    );
    return {
      lineId: `${row.id}-${index + 1}`,
      requestedCode,
      resolvedCode,
      brand: String(line.brand || ""),
      market_segment: line.market_segment ?? null,
      description: String(line.description || ""),
      qty,
      oem_no: String(line.oem_no || ""),
      hs_code: String(line.hs_code || ""),
      origin: String(line.origin || ""),
      weight_kg: line.weight_kg == null ? null : Number(line.weight_kg),
      image_url: "",
      sell_price: sellPrice,
      c_sell_price: null,
      price_date: String(line.price_date || ""),
      found: true,
      codeChanged,
      codeChangeWarning: codeChanged ? `Old Code ${requestedCode} => New Code ${resolvedCode}` : "",
      lifecycle_status: line.lifecycle_status ?? "active",
      lifecycle_note: line.lifecycle_note ?? null,
      lifecycle_warning: line.lifecycle_warning ?? null,
    };
  });
}

function buildOfflinePreparedLineFromCatalogItem(item: PortalCatalogSearchItem): PortalPreparedLine {
  const requestedCode = String(item.replacement_old_code || item.code || "").trim();
  const replacementWarning = String(item.replacement_warning || "").trim();
  return {
    lineId: `offline-${requestedCode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedCode,
    resolvedCode: String(item.code || "").trim(),
    brand: String(item.brand || ""),
    market_segment: item.market_segment ?? null,
    description: String(item.description || ""),
    qty: 1,
    oem_no: String(item.oem_no || ""),
    hs_code: String(item.tariff || ""),
    origin: String(item.origin || ""),
    weight_kg: item.weight_kg == null ? null : Number(item.weight_kg),
    image_url: String(item.image_url || ""),
    sell_price: item.sell_price == null ? null : Number(item.sell_price),
    c_sell_price: null,
    price_date: "",
    found: true,
    codeChanged: Boolean(replacementWarning),
    codeChangeWarning: replacementWarning,
    lifecycle_status: item.lifecycle_status ?? "active",
    lifecycle_note: item.lifecycle_note ?? null,
    lifecycle_warning: item.lifecycle_warning ?? null,
    replacement_old_code: item.replacement_old_code ?? null,
    replacement_code: item.replacement_code ?? null,
    replacement_reason: item.replacement_reason ?? null,
    replacement_warning: replacementWarning || null,
  };
}

function normalizePortalQuantity(value: unknown) {
  return Math.max(1, Math.floor(Number(value || 1) || 1));
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
    return { email: parsed.email, password: "", sessionToken: "" };
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
  if (!url.searchParams.has("email") && !url.searchParams.has("token") && !url.searchParams.has("reset") && !url.searchParams.has("reset_token")) return;
  url.searchParams.delete("email");
  url.searchParams.delete("token");
  url.searchParams.delete("reset");
  url.searchParams.delete("reset_token");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function getPortalCacheKey(email: string) {
  const hostname = typeof window === "undefined" ? "server" : window.location.hostname.toLowerCase();
  return `${PORTAL_CACHE_PREFIX}:${hostname}:${String(email || "").trim().toLowerCase()}`;
}

function getPortalSnapshotCacheKey(email: string) {
  return `${getPortalCacheKey(email)}:snapshot`;
}

function getPortalDraftCacheKey(email: string) {
  return `${getPortalCacheKey(email)}:draft`;
}

function readPortalCache(email: string) {
  if (typeof window === "undefined" || !email) return null as PortalOfflineCache | null;
  try {
    // Account, pricing and document data must not persist after the browser
    // session ends. Remove earlier localStorage snapshots on sight, while
    // retaining only the current tab's basket in sessionStorage.
    window.localStorage.removeItem(getPortalCacheKey(email));
    window.localStorage.removeItem(getPortalSnapshotCacheKey(email));
    window.localStorage.removeItem(getPortalDraftCacheKey(email));
    const draftRaw = window.sessionStorage.getItem(getPortalDraftCacheKey(email));
    if (draftRaw) {
      return {
        snapshot: null,
        draft: JSON.parse(draftRaw) as PortalOfflineDraft,
        updatedAt: new Date().toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writePortalCache(email: string, cache: PortalOfflineCache | null) {
  if (typeof window === "undefined" || !email) return;
  if (!cache) {
    window.localStorage.removeItem(getPortalCacheKey(email));
    window.localStorage.removeItem(getPortalSnapshotCacheKey(email));
    window.localStorage.removeItem(getPortalDraftCacheKey(email));
    window.sessionStorage.removeItem(getPortalDraftCacheKey(email));
    return;
  }
  window.localStorage.removeItem(getPortalCacheKey(email));
  window.localStorage.removeItem(getPortalSnapshotCacheKey(email));
  window.localStorage.removeItem(getPortalDraftCacheKey(email));
  window.sessionStorage.setItem(getPortalDraftCacheKey(email), JSON.stringify(cache.draft));
}

function writePortalSnapshotCache(email: string, snapshot: PortalSnapshot | null) {
  if (typeof window === "undefined" || !email) return;
  const key = getPortalSnapshotCacheKey(email);
  window.localStorage.removeItem(getPortalCacheKey(email));
  window.localStorage.removeItem(key);
  // Snapshots deliberately remain memory-only. The argument is retained so
  // existing callers can explicitly clear legacy cache values.
  void snapshot;
}

function writePortalDraftCache(email: string, draft: PortalOfflineDraft | null) {
  if (typeof window === "undefined" || !email) return;
  const key = getPortalDraftCacheKey(email);
  window.localStorage.removeItem(getPortalCacheKey(email));
  window.localStorage.removeItem(key);
  if (!draft) {
    window.sessionStorage.removeItem(key);
    return;
  }
  window.sessionStorage.setItem(key, JSON.stringify(draft));
}

function getDefaultPortalSection(snapshot: PortalSnapshot) {
  if (snapshot.invite.party_type === "customer" && snapshot.invite.access.can_view_orders) return "home" as const;
  if (snapshot.invite.access.can_view_orders) return "orders" as const;
  if (snapshot.invite.access.can_view_invoices) return "billing" as const;
  return "statement" as const;
}

export function PortalPage() {
  const search = new URLSearchParams(window.location.search);
  const portalLinkEmail = search.get("email") || "";
  const portalResetToken = search.get("reset") || search.get("reset_token") || "";
  const portalImportRef = useRef<HTMLInputElement | null>(null);
  const portalDocumentsImportRef = useRef<HTMLInputElement | null>(null);
  const portalDraftLinesRef = useRef<HTMLDivElement | null>(null);
  const portalCachedDraftRef = useRef<PortalOfflineCache["draft"] | null>(null);
  const portalAutoRefreshKeyRef = useRef("");
  const portalBrandingKeyRef = useRef("");
  // Background snapshot reads may race a draft-order mutation. Keep a small
  // client-side revision and grace window so an older read cannot overwrite
  // the line list that was just added/removed by the customer.
  const portalOrderMutationRef = useRef(0);
  const portalOrderMutationSettledAtRef = useRef(0);

  function beginPortalOrderMutation() {
    portalOrderMutationRef.current += 1;
    return portalOrderMutationRef.current;
  }

  function settlePortalOrderMutation() {
    portalOrderMutationSettledAtRef.current = Date.now();
  }
  const portalDesktopFrameRef = useRef<HTMLDivElement | null>(null);
  const [credentials, setCredentials] = useState<PortalCredentials>(() => {
    const stored = typeof window !== "undefined" ? readStoredCredentials() : null;
    return {
      email: portalLinkEmail || stored?.email || "",
      password: "",
      sessionToken: "",
    };
  });
  const [snapshot, setSnapshot] = useState<PortalSnapshot | null>(null);
  const [loginBranding, setLoginBranding] = useState<PortalBranding | null>(null);
  const [selection, setSelection] = useState<PortalSelection | null>(null);
  const [portalDetailLoadingId, setPortalDetailLoadingId] = useState("");
  const [activeSection, setActiveSection] = useState<PortalSection>("home");
  const [documentSearch, setDocumentSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("");
  const [statementDateFrom, setStatementDateFrom] = useState("");
  const [statementDateTo, setStatementDateTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [portalForgotMode, setPortalForgotMode] = useState(false);
  const [portalResetPassword, setPortalResetPassword] = useState("");
  const [portalResetConfirmPassword, setPortalResetConfirmPassword] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSearchBrand, setOrderSearchBrand] = useState("");
  const [catalogResults, setCatalogResults] = useState<PortalCatalogSearchItem[]>([]);
  const [portalRecommendations, setPortalRecommendations] = useState<PortalCatalogSearchItem[]>([]);
  const [portalSearchView, setPortalSearchView] = useState<PortalSearchView>("list");
  const [isCompactPortalSearch, setIsCompactPortalSearch] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < PORTAL_COMPACT_SEARCH_BREAKPOINT_PX,
  );
  const [portalViewportWidth, setPortalViewportWidth] = useState(() =>
    typeof window === "undefined" ? PORTAL_DESKTOP_BASE_WIDTH_PX : window.innerWidth,
  );
  const [portalDesktopFrameHeight, setPortalDesktopFrameHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
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
  const [selectedCatalogCode, setSelectedCatalogCode] = useState("");
  const [selectedDraftLineId, setSelectedDraftLineId] = useState("");
  const [portalPreview, setPortalPreview] = useState<{ kind: "catalog"; item: PortalCatalogSearchItem } | { kind: "basket"; item: PortalPreparedLine } | null>(null);
  const [portalPreviewMedia, setPortalPreviewMedia] = useState<ProductMediaItem[]>([]);
  const [portalDetailQtyEdits, setPortalDetailQtyEdits] = useState<Record<string, number>>({});
  const [portalDetailManualCode, setPortalDetailManualCode] = useState("");
  const [portalDetailManualBrand, setPortalDetailManualBrand] = useState("");
  const [portalDetailManualQty, setPortalDetailManualQty] = useState("1");
  const [portalNotifications, setPortalNotifications] = useState<PortalActivityNotification[]>([]);
  const [previewImage, setPreviewImage] = useState<{ src: string; code: string; name: string } | null>(null);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const portalPricingCurrency = snapshot?.pricingProfile?.currency || snapshot?.accountSummary.currency || "EUR";
  const portalBuildContext = buildContextMeta[buildMeta.context as keyof typeof buildContextMeta] || {
    label: buildMeta.context || "Build",
    className: "is-local",
  };
  const portalCommitShort = buildMeta.commit.slice(0, 8);
  const portalBuiltAtLabel = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(buildMeta.builtAt));
  const effectivePortalSearchView: PortalSearchView = isCompactPortalSearch ? "list" : portalSearchView;
  const shouldScalePortalDesktop =
    Boolean(snapshot) &&
    portalViewportWidth > PORTAL_MOBILE_LAYOUT_BREAKPOINT_PX &&
    portalViewportWidth < PORTAL_DESKTOP_BASE_WIDTH_PX;
  const portalDesktopScale = shouldScalePortalDesktop
    ? Math.min(1, (portalViewportWidth - PORTAL_DESKTOP_SCALE_SIDE_PADDING_PX) / PORTAL_DESKTOP_BASE_WIDTH_PX)
    : 1;
  const portalDesktopScaledHeight = shouldScalePortalDesktop
    ? Math.max(
        typeof window === "undefined" ? 0 : window.innerHeight - PORTAL_DESKTOP_SCALE_SIDE_PADDING_PX,
        Math.ceil(portalDesktopFrameHeight * portalDesktopScale),
      )
    : 0;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncOnlineState = () => setIsOnline(window.navigator.onLine);
    syncOnlineState();
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    return () => {
      window.removeEventListener("online", syncOnlineState);
      window.removeEventListener("offline", syncOnlineState);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncViewportWidth = () => setPortalViewportWidth(window.innerWidth);
    const mediaQuery = window.matchMedia(`(max-width: ${PORTAL_COMPACT_SEARCH_BREAKPOINT_PX - 1}px)`);
    const syncCompactPortalSearch = () => setIsCompactPortalSearch(mediaQuery.matches);
    syncViewportWidth();
    syncCompactPortalSearch();
    window.addEventListener("resize", syncViewportWidth);
    mediaQuery.addEventListener("change", syncCompactPortalSearch);
    return () => {
      window.removeEventListener("resize", syncViewportWidth);
      mediaQuery.removeEventListener("change", syncCompactPortalSearch);
    };
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const node = portalDesktopFrameRef.current;
    if (!node) return;
    const syncFrameHeight = () => setPortalDesktopFrameHeight(node.scrollHeight);
    syncFrameHeight();
    const observer = new ResizeObserver(() => syncFrameHeight());
    observer.observe(node);
    return () => observer.disconnect();
  }, [snapshot]);

  useEffect(() => {
    if (snapshot) {
      setLoginBranding({
        companyProfile: snapshot.companyProfile,
        portalLabel: snapshot.invite.party_type === "customer" ? "Customer Portal" : "Vendor Portal",
        partyName: snapshot.invite.party_name || "",
      });
      return;
    }
    if (!isOnline) return;

    const previewCredentials = credentials.email ? { email: credentials.email, sessionToken: "" } : null;

    if (!previewCredentials) {
      portalBrandingKeyRef.current = "";
      setLoginBranding(null);
      return;
    }

    const previewKey = `${previewCredentials.email}::preview`;
    if (portalBrandingKeyRef.current === previewKey) return;
    portalBrandingKeyRef.current = previewKey;

    let cancelled = false;
    fetchPortalBranding(previewCredentials)
      .then(({ branding }) => {
        if (cancelled) return;
        setLoginBranding(branding);
      })
      .catch(() => {
        if (cancelled) return;
        portalBrandingKeyRef.current = "";
        setLoginBranding(null);
      });

    return () => {
      cancelled = true;
    };
  }, [credentials.email, isOnline, snapshot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (snapshot || !credentials.email || portalResetToken) return;
    const cached = readPortalCache(credentials.email);
    if (!cached) return;
    portalCachedDraftRef.current = cached.draft;
    if (!cached.snapshot) return;
    setSnapshot(cached.snapshot);
    setSelection(null);
    setActiveSection(cached.draft.activeSection || getDefaultPortalSection(cached.snapshot));
    setDocumentSearch("");
    setBrandFilter("");
    setPaymentStatusFilter("");
    setStatus(isOnline ? "Cached portal workspace loaded." : "Offline mode active. Showing cached portal data and local basket.");
    setError("");
  }, [credentials.email, isOnline, portalResetToken, snapshot]);

  useEffect(() => {
    if (!isOnline || !credentials.email || !snapshot || portalResetToken) return;
    const refreshKey = credentials.email;
    if (portalAutoRefreshKeyRef.current === refreshKey) return;
    portalAutoRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    const refreshMutationRevision = portalOrderMutationRef.current;
    fetchPortalSnapshot(credentials)
      .then(({ snapshot: next }) => {
        if (cancelled) return;
        if (
          portalOrderMutationRef.current !== refreshMutationRevision ||
          Date.now() - portalOrderMutationSettledAtRef.current < 15_000
        ) return;
        setSnapshot((current) => mergePortalSnapshotOrderDetails(current, next));
        const nextCredentials = { email: credentials.email, password: "", sessionToken: "" };
        setCredentials(nextCredentials);
        writeStoredCredentials(nextCredentials);
        setError("");
        setStatus((current) =>
          current && current.toLowerCase().includes("offline")
            ? "Portal data refreshed."
            : current || "Portal data refreshed.",
        );
      })
      .catch((caught) => {
        if (cancelled) return;
        portalAutoRefreshKeyRef.current = "";
        const message = caught instanceof Error ? caught.message : "Portal refresh failed";
        if (message.toLowerCase().includes("session expired")) {
          const nextCredentials = { email: credentials.email, password: "", sessionToken: "" };
          setCredentials(nextCredentials);
          writeStoredCredentials(null);
          setError("");
          setStatus("");
          return;
        }
        // A successful login or a cached workspace already provides a usable
        // tenant-scoped snapshot. The opportunistic refresh must never turn
        // that working portal into a blocking error state; the user can keep
        // working and explicitly refresh later.
        setStatus("Portal is open. The latest background refresh could not be completed; retry with Refresh when ready.");
      });

    return () => {
      cancelled = true;
    };
  }, [credentials.email, isOnline, portalResetToken, snapshot]);

  useEffect(() => {
    if (!isOnline || !credentials.email || !snapshot || portalResetToken) return;
    let cancelled = false;
    const refreshInBackground = async () => {
      const refreshMutationRevision = portalOrderMutationRef.current;
      try {
        const { snapshot: next } = await fetchPortalSnapshot(credentials);
        if (cancelled) return;
        if (
          portalOrderMutationRef.current !== refreshMutationRevision ||
          Date.now() - portalOrderMutationSettledAtRef.current < 15_000
        ) return;
        setSnapshot((current) => mergePortalSnapshotOrderDetails(current, next));
        setError("");
      } catch (caught) {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "Portal refresh failed";
        setStatus(message.toLowerCase().includes("session expired") ? "Your portal session expired. Please sign in again." : "The latest portal update is temporarily unavailable. Select Refresh to retry.");
      }
    };
    const interval = window.setInterval(() => void refreshInBackground(), PORTAL_BACKGROUND_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [credentials.email, credentials.sessionToken, isOnline, portalResetToken, Boolean(snapshot)]);

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
      {
        key: "brands",
        header: "Brands",
        render: (row: PortalSnapshot["salesOrders"][number]) => {
          const brands = [...new Set((row.lines || []).map((line) => String(line.brand || "").trim()).filter(Boolean))];
          return brands.length ? brands.join(", ") : "Open order for details";
        },
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
          render: (row: PortalCatalogSearchItem) => (
            <ProductVisual
              imageUrl={row.image_url}
              brand={row.brand}
              alt={row.code}
              onPreview={
                row.image_url
                  ? () =>
                      setPreviewImage({
                        src: row.image_url || "",
                        code: row.code,
                        name: row.description || "",
                      })
                  : null
              }
            />
          ),
        },
        {
          key: "code",
          header: "Code",
          render: (row: PortalCatalogSearchItem) => <span className="portal-result-code">{row.code || "-"}</span>,
        },
        { key: "brand", header: "Brand", render: (row: PortalCatalogSearchItem) => <BrandPill brand={row.brand} compact withLogo /> },
        { key: "segment", header: "Segment", render: (row: PortalCatalogSearchItem) => row.market_segment || "-" },
        {
          key: "description",
          header: "Description",
          render: (row: PortalCatalogSearchItem) => (
            <div className="portal-result-description">
              <div>{row.description || "-"}</div>
              {renderReplacementBadge(row)}
              {renderDiscontinuedBadge(row)}
            </div>
          ),
        },
        {
          key: "price",
          header: `Price ${portalPricingCurrency}`,
          render: (row: PortalCatalogSearchItem) => (
            <span className="portal-result-price" title={row.sell_price == null ? "Price on request" : formatMoney(Number(row.sell_price || 0), row.currency || portalPricingCurrency)}>
              {row.sell_price == null ? "Price on request" : formatMoney(Number(row.sell_price || 0), row.currency || portalPricingCurrency)}
            </span>
          ),
        },
        { key: "tariff", header: "Tariff", render: (row: PortalCatalogSearchItem) => row.tariff || "-" },
        { key: "origin", header: "Origin", render: (row: PortalCatalogSearchItem) => row.origin || "-" },
        { key: "weight", header: "Weight", render: (row: PortalCatalogSearchItem) => formatWeight(row.weight_kg) },
      ];
      columns.push({
        key: "actions",
        header: "Actions",
        render: (row: PortalCatalogSearchItem) => (
          <Button variant="secondary" className="button--compact" onClick={() => void handleAddPortalCatalogItem(row)}>
            Add to Basket
          </Button>
        ),
      });
      return columns;
    },
    [portalPricingCurrency],
  );

  const portalDraftColumns = useMemo(
    () => {
      const columns = [
        { key: "code", header: "Code", render: (row: PortalPreparedLine) => row.resolvedCode || row.requestedCode || "-" },
        { key: "brand", header: "Brand", render: (row: PortalPreparedLine) => <BrandPill brand={row.brand} compact /> },
        { key: "segment", header: "Segment", render: (row: PortalPreparedLine) => row.market_segment || "-" },
        {
          key: "description",
          header: "Description",
          render: (row: PortalPreparedLine) => (
            <div>
              <div>{row.description || "-"}</div>
              {row.sell_price == null ? <div className="warning-text">No live price found for this item.</div> : null}
              {renderReplacementBadge(row)}
              {renderDiscontinuedBadge(row)}
            </div>
          ),
        },
        { key: "origin", header: "Origin", render: (row: PortalPreparedLine) => row.origin || "-" },
        { key: "weight", header: "Weight", render: (row: PortalPreparedLine) => formatWeight(row.weight_kg) },
      ];
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
    [portalPricingCurrency],
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
      setStatus("");
      const { snapshot: next } = await loginPortal({
        email: credentials.email,
        password: credentials.password || "",
        sessionToken: "",
      });
      setSnapshot(next);
      setSelection(null);
      setActiveSection(getDefaultPortalSection(next));
      setDocumentSearch("");
      setBrandFilter("");
      setPaymentStatusFilter("");
      setStatus("Portal session active.");
      const nextCredentials = { email: credentials.email, password: "", sessionToken: "" };
      setCredentials(nextCredentials);
      writeStoredCredentials(nextCredentials);
      clearPortalQueryParams();
    } catch (caught) {
      setSnapshot(null);
      setError(caught instanceof Error ? caught.message : "Portal login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handlePortalForgotPassword() {
    if (!credentials.email.trim()) {
      setError("Enter portal email first.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const response = await requestPortalPasswordReset(credentials.email);
      setStatus(response.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal password reset request failed");
    } finally {
      setLoading(false);
    }
  }

  async function handlePortalResetPassword() {
    if (!credentials.email.trim()) {
      setError("Portal email is required.");
      return;
    }
    if (!portalResetPassword.trim()) {
      setError("Enter a new portal password.");
      return;
    }
    if (portalResetPassword.length < 8) {
      setError("Portal password must be at least 8 characters.");
      return;
    }
    if (portalResetPassword !== portalResetConfirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      setStatus("");
      const { snapshot: next } = await confirmPortalPasswordReset(
        credentials.email,
        portalResetToken,
        portalResetPassword,
      );
      setSnapshot(next);
      setSelection(null);
      setActiveSection(getDefaultPortalSection(next));
      setDocumentSearch("");
      setBrandFilter("");
      setPaymentStatusFilter("");
      setPortalResetPassword("");
      setPortalResetConfirmPassword("");
      setPortalForgotMode(false);
      setStatus("Portal password updated.");
      const nextCredentials = { email: credentials.email, password: "", sessionToken: "" };
      setCredentials(nextCredentials);
      writeStoredCredentials(nextCredentials);
      clearPortalQueryParams();
    } catch (caught) {
      setSnapshot(null);
      setError(caught instanceof Error ? caught.message : "Portal password reset failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    if (!isOnline) {
      setError("");
      setStatus("Connect to the internet to refresh portal data.");
      return;
    }
    try {
      setLoading(true);
      setError("");
      const { snapshot: next } = await fetchPortalSnapshot(credentials);
      setSnapshot(next);
      setSelection(null);
      setStatus("Portal data refreshed.");
      const nextCredentials = { email: credentials.email, password: "", sessionToken: "" };
      setCredentials(nextCredentials);
      writeStoredCredentials(nextCredentials);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal refresh failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await logoutPortalSession();
    writePortalCache(credentials.email, null);
    setCredentials({ email: credentials.email, password: "", sessionToken: "" });
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
      setPortalRecommendations([]);
      return;
    }

    if (portalCachedDraftRef.current) {
      const cachedDraft = portalCachedDraftRef.current;
      portalCachedDraftRef.current = null;
      setPortalOrderId(cachedDraft.portalOrderId || "");
      setPortalSalesOrderNo(cachedDraft.portalSalesOrderNo || "");
      setPortalDraftLines(cachedDraft.portalDraftLines || []);
      setPortalDeliveryTerm(cachedDraft.portalDeliveryTerm || "");
      setPortalPaymentTerms(cachedDraft.portalPaymentTerms || snapshot.pricingProfile?.payment_terms || "");
      setPortalPackingDetails(cachedDraft.portalPackingDetails || "");
      setPortalOrderNotes(cachedDraft.portalOrderNotes || "");
      setPortalOrderStatus(cachedDraft.portalOrderStatus || "");
      setCatalogResults(cachedDraft.catalogResults || []);
      setPortalRecommendations(cachedDraft.catalogRecommendations || []);
      setOrderSearch(cachedDraft.orderSearch || "");
      setPortalPriceListBrand((current) => current || snapshot.availableBrands[0] || "");
      setOrderSearchBrand((current) => {
        const candidate = cachedDraft.orderSearchBrand || current;
        return candidate && snapshot.availableBrands.includes(candidate) ? candidate : "";
      });
      setSelectedCatalogCode(cachedDraft.selectedCatalogCode || "");
      setSelectedDraftLineId(cachedDraft.selectedDraftLineId || "");
      setActiveSection(cachedDraft.activeSection || "home");
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
    if (!snapshot || !credentials.email) return;
    const handle = window.setTimeout(() => {
      writePortalSnapshotCache(credentials.email, snapshot);
    }, PORTAL_CACHE_WRITE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [credentials.email, snapshot]);

  useEffect(() => {
    if (!snapshot || !credentials.email || snapshot.invite.party_type !== "customer") return;
    const previous = readPortalActivityFingerprint(credentials.email);
    const events = buildPortalActivityNotifications(previous, snapshot);
    if (events.length) setPortalNotifications((current) => [...events, ...current.filter((item) => !events.some((event) => event.id === item.id))].slice(0, 8));
    writePortalActivityFingerprint(credentials.email, snapshot);
  }, [credentials.email, snapshot]);

  useEffect(() => {
    if (!snapshot || !credentials.email) return;
    const handle = window.setTimeout(() => {
      writePortalDraftCache(credentials.email, {
        portalDraftLines,
        portalOrderId,
        portalSalesOrderNo,
        portalDeliveryTerm,
        portalPaymentTerms,
        portalPackingDetails,
        portalOrderNotes,
        portalOrderStatus,
        catalogResults,
        catalogRecommendations: portalRecommendations,
        orderSearch,
        orderSearchBrand,
        selectedCatalogCode,
        selectedDraftLineId,
        activeSection,
      });
    }, PORTAL_CACHE_WRITE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [
    activeSection,
    catalogResults,
    portalRecommendations,
    credentials.email,
    orderSearchBrand,
    portalDeliveryTerm,
    portalDraftLines,
    portalOrderId,
    portalOrderNotes,
    portalOrderStatus,
    portalPackingDetails,
    portalPaymentTerms,
    portalSalesOrderNo,
    selectedCatalogCode,
    selectedDraftLineId,
    snapshot,
  ]);

  useEffect(() => {
    const selectableCatalogRows = [...catalogResults, ...portalRecommendations];
    if (!selectableCatalogRows.length) {
      setSelectedCatalogCode("");
      return;
    }
    if (!selectableCatalogRows.some((row) => row.code === selectedCatalogCode)) {
      setSelectedCatalogCode(catalogResults[0]?.code || portalRecommendations[0]?.code || "");
    }
  }, [catalogResults, portalRecommendations, selectedCatalogCode]);

  useEffect(() => {
    if (!portalDraftLines.length) {
      setSelectedDraftLineId("");
      return;
    }
    if (!portalDraftLines.some((line) => line.lineId === selectedDraftLineId)) {
      setSelectedDraftLineId(portalDraftLines[0]?.lineId || "");
    }
  }, [portalDraftLines, selectedDraftLineId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!portalPreview) {
        if (!cancelled) setPortalPreviewMedia([]);
        return;
      }
      const code = portalPreview.kind === "catalog" ? portalPreview.item.code : portalPreview.item.resolvedCode || portalPreview.item.requestedCode;
      const fallbackItems = portalPreview.item.image_url ? [{ src: portalPreview.item.image_url, label: "Product" }] : [];
      if (!cancelled) setPortalPreviewMedia(fallbackItems);
      try {
        const items = await fetchCatalogProductMedia({
          brand: portalPreview.item.brand,
          code: code || "",
          imageUrl: portalPreview.item.image_url || "",
        });
        if (!cancelled && items.length) setPortalPreviewMedia(items);
      } catch {
        if (!cancelled) setPortalPreviewMedia(fallbackItems);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [portalPreview]);

  if (!snapshot) {
    const loginBrandLogo = loginBranding?.companyProfile?.logo_data_url || "";
    const loginBrandName = loginBranding?.companyProfile?.company_name || loginBranding?.partyName || "Portal Workspace";
    const loginBrandLabel = loginBranding?.portalLabel || "Self-Service Access";
    const loginBrandInitials = buildPortalLoginInitials(loginBrandName);
    return (
      <div className="portal-shell portal-shell--login">
        <div className="portal-login-layout">
          <section className="portal-login-visual" aria-label="Customer Desk introduction">
            <div className="portal-login-visual__copy">
              <span className="portal-login-visual__eyebrow">Customer Desk</span>
              <h1>Keep every part search and order moving.</h1>
              <p>One calm workspace for the parts you buy, the prices assigned to your account, and the orders you need to track.</p>
              <div className="portal-login-visual__proof" aria-label="Portal capabilities">
                <span>Part and OEM search</span>
                <span>Account-specific pricing</span>
                <span>Orders and billing visibility</span>
              </div>
            </div>
          </section>

          <div className="portal-login-card">
            <div className="portal-login-brand">
              <div className={`portal-login-brand__logo${loginBrandLogo ? " portal-login-brand__logo--image" : ""}`} aria-hidden="true">
                {loginBrandLogo ? <img src={loginBrandLogo} alt="" className="portal-login-brand__logo-image" /> : loginBrandInitials}
              </div>
              <div className="portal-login-brand__copy">
                <span>{loginBrandLabel}</span>
                <strong>{loginBrandName}</strong>
              </div>
            </div>
            <div className="portal-login-card__intro">
              <span>Secure account access</span>
              <h2>{portalResetToken ? "Create New Password" : portalForgotMode ? "Reset your access" : "Welcome back"}</h2>
              <p>
                {portalResetToken
                  ? "Create a new portal password to continue."
                  : portalForgotMode
                    ? "Enter the portal email address and a reset link will be sent if the account is active."
                    : "Sign in to search parts, review account pricing, and keep your orders on track."}
              </p>
            </div>
            <form
              className="portal-login-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (portalResetToken) {
                  void handlePortalResetPassword();
                  return;
                }
                if (portalForgotMode) {
                  void handlePortalForgotPassword();
                  return;
                }
                void handleLogin();
              }}
            >
              <Input label="Email" value={credentials.email} placeholder="name@company.com" onChange={(value) => setCredentials((current) => ({ ...current, email: value }))} />
              {portalResetToken ? (
                <>
                  <Input
                    label="New Password"
                    type="password"
                    value={portalResetPassword}
                    placeholder="New portal password"
                    onChange={setPortalResetPassword}
                  />
                  <Input
                    label="Confirm Password"
                    type="password"
                    value={portalResetConfirmPassword}
                    placeholder="Repeat new password"
                    onChange={setPortalResetConfirmPassword}
                  />
                </>
              ) : portalForgotMode ? null : (
                <Input
                  label="Password"
                  type="password"
                  value={credentials.password || ""}
                  placeholder="Portal password"
                  onChange={(value) => setCredentials((current) => ({ ...current, password: value }))}
                />
              )}
              <div className="inline-actions">
                <Button
                  type="submit"
                  busy={loading}
                  busyLabel={portalResetToken ? "Saving..." : portalForgotMode ? "Sending..." : "Signing in..."}
                  onClick={() => {
                    if (portalResetToken) {
                      void handlePortalResetPassword();
                      return;
                    }
                    if (portalForgotMode) {
                      void handlePortalForgotPassword();
                      return;
                    }
                    void handleLogin();
                  }}
                >
                  {portalResetToken ? "Save New Password" : portalForgotMode ? "Send Reset Link" : "Sign In"}
                </Button>
              </div>
              {error ? <div className="warning-text">{error}</div> : null}
              {status ? <div className="success-text">{status}</div> : null}
              {!portalResetToken ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setPortalForgotMode((current) => !current);
                    setError("");
                    setStatus("");
                  }}
                >
                  {portalForgotMode ? "Back to sign in" : "Forgot password?"}
                </button>
              ) : null}
            </form>
            <p className="portal-login-card__privacy">Your account data, customer pricing, and order visibility stay within your authorized workspace.</p>
          </div>
        </div>
      </div>
    );
  }

  const activeSnapshot = snapshot;
  const partyProfile = activeSnapshot.customer || activeSnapshot.vendor;
  const portalBasePriceListType = activeSnapshot.pricingProfile?.price_list_type || "";
  const portalCPriceMode = activeSnapshot.pricingProfile?.portal_c_price_mode || "standard";
  const portalPricingLabel =
    !activeSnapshot.pricingProfile
      ? "Default Pricing"
      : portalCPriceMode === "prefer_c_when_available"
        ? "C Where Available"
        : portalBasePriceListType
          ? `${portalBasePriceListType} Price List`
          : "Customer Account Pricing";
  const portalPricingRuleDescription =
    !activeSnapshot.pricingProfile
      ? "The file is built using the default account pricing for this portal."
      : portalCPriceMode === "prefer_c_when_available" && portalBasePriceListType && portalBasePriceListType !== "C"
        ? `Uses C price list where available, then ${portalBasePriceListType} price list for the remaining items.`
        : portalBasePriceListType === "C"
          ? "Uses the C price list assigned on this customer account."
          : `Uses the ${portalBasePriceListType || "assigned"} price list assigned on this customer account.`;
  const portalSellerDetails = [
    activeSnapshot.companyProfile?.email,
    activeSnapshot.companyProfile?.phone,
    activeSnapshot.companyProfile?.website,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("  •  ");
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
  const portalBrandOptions = [{ value: "", label: "All Brands" }, ...activeSnapshot.availableBrands.map((brand) => ({ value: brand, label: brand }))];
  const portalBrandValueOptions = activeSnapshot.availableBrands.map((brand) => ({ value: brand, label: brand }));
  const portalDraftSelectionOptions = [
    { value: "", label: "New Basket" },
    ...portalDraftOrders.map((row) => ({
      value: row.id,
      label: `${row.sales_order_no || row.id} · ${(row.line_count || row.lines?.length || 0).toLocaleString("en-US")} lines`,
    })),
  ];
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
  const portalSearchCards = catalogResults;
  const portalRecommendationCards = portalRecommendations.slice(0, 3);
  const portalOrderHistoryRows =
    activeSnapshot.invite.party_type === "customer"
      ? filteredSalesOrders
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
    ...(portalCanOrder ? [{ key: "home" as PortalSection, label: "Customer Desk" }] : []),
    ...(portalCanOrder ? [{ key: "desk" as PortalSection, label: "Part Search" }] : []),
    ...(portalCanOrder ? [{ key: "pricelist" as PortalSection, label: "Download Price List" }] : []),
    ...(activeSnapshot.invite.access.can_view_orders ? [{ key: "orders" as PortalSection, label: "Orders" }] : []),
    ...(activeSnapshot.invite.access.can_view_invoices
      ? [{ key: "billing" as PortalSection, label: activeSnapshot.invite.party_type === "customer" ? "Invoices" : "Bills" }]
      : []),
    ...(activeSnapshot.invite.access.can_view_account || activeSnapshot.invite.access.can_view_payments ? [{ key: "statement" as PortalSection, label: "Statement" }] : []),
    { key: "account", label: "Account" },
  ];
  const portalNavGroups: Array<{
    key: PortalNavGroupKey;
    code: string;
    title: string;
    caption: string;
    items: Array<{ key: PortalSection; label: string; badge?: string }>;
  }> = [
    {
      key: "home" as const,
      code: "00",
      title: "Home",
      caption: "Customer Desk",
      items: portalSections.filter((section) => section.key === "home"),
    },
    {
      key: "search" as const,
      code: "01",
      title: "Search",
      caption: "Parts",
      items: portalSections.filter((section) => section.key === "desk"),
    },
    {
      key: "pricing" as const,
      code: "02",
      title: "Price Lists",
      caption: "Downloads",
      items: portalSections.filter((section) => section.key === "pricelist"),
    },
    {
      key: "documents" as const,
      code: "03",
      title: "Documents",
      caption: activeSnapshot.invite.party_type === "customer" ? "Orders & Invoices" : "PO & Bills",
      items: portalSections
        .filter((section) => section.key === "orders" || section.key === "billing")
        .map((section) => ({
          ...section,
          badge:
            section.key === "orders"
              ? portalOrderHistoryRows.length.toLocaleString("en-US")
              : portalBillingRows.length.toLocaleString("en-US"),
        })),
    },
    {
      key: "finance" as const,
      code: "04",
      title: "Finance",
      caption: "Statement & Payments",
      items: portalSections.filter((section) => section.key === "statement"),
    },
    {
      key: "account" as const,
      code: "05",
      title: "Account",
      caption: "Profile",
      items: portalSections.filter((section) => section.key === "account"),
    },
  ].filter((group) => group.items.length > 0);
  const activePortalGroup =
    portalNavGroups.find((group) => group.items.some((item) => item.key === activeSection))?.key || portalNavGroups[0]?.key || "search";
  const activeSectionHelpText =
    activeSection === "home"
      ? "Start with a focused part search, review recent orders, and see only verified account and recommendation signals."
      : activeSection === "desk"
      ? "Search by part number or original number, compare alternatives, then move selected items into the basket."
      : activeSection === "pricelist"
        ? "Select a brand and download the customer-specific price list using the account pricing rule shown below."
        : activeSection === "orders"
          ? "Track submitted orders and inspect the full line detail when needed."
        : activeSection === "billing"
          ? "Review invoices or bills with payment status and line-level detail."
          : activeSection === "statement"
            ? "Use this area for statement, payments, and credits only."
            : "Review your account identity, addresses, and financial profile.";
  const portalDeskSummaryText =
    activeSection === "home"
      ? "Customer Desk keeps search, orders, billing, and verified suggestions in one calm starting point."
      : activeSection === "desk"
      ? "Search part numbers, OEM codes, and matched alternatives."
      : activeSectionHelpText;

  function handlePortalGroupNavigate(groupKey: PortalNavGroupKey) {
    const targetGroup = portalNavGroups.find((group) => group.key === groupKey);
    const defaultSection = targetGroup?.items[0]?.key;
    if (defaultSection) setActiveSection(defaultSection);
  }

  async function openPortalDocument(selection: PortalSelection) {
    setSelection(selection);
    setActiveSection(selection.kind === "sales-order" || selection.kind === "purchase-order" ? "orders" : "billing");
    if (selection.kind !== "sales-order" || !isOnline) return;
    const existing = snapshot?.salesOrders.find((row) => row.id === selection.id);
    if (!existing || existing.lines?.length) return;
    try {
      setPortalDetailLoadingId(selection.id);
      const detail = await fetchPortalSalesOrderDetail(credentials, selection.id);
      if (!detail) return;
      setSnapshot((current) =>
        current
          ? { ...current, salesOrders: current.salesOrders.map((row) => (row.id === detail.id ? { ...row, ...detail } : row)) }
          : current,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal order detail load failed");
    } finally {
      setPortalDetailLoadingId("");
    }
  }

  function focusPortalDraftLines(lineId?: string) {
    setActiveSection("desk");
    if (lineId) setSelectedDraftLineId(lineId);
    window.requestAnimationFrame(() => {
      portalDraftLinesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function handlePortalCatalogSearch(searchField: PortalSearchField = "part_number") {
    if (!isOnline) {
      setError("");
      if (catalogResults.length) {
        if (catalogResults[0]) {
          setSelectedCatalogCode(catalogResults[0].code);
          setPortalPreview({ kind: "catalog", item: catalogResults[0] });
        }
        setStatus("Offline mode active. Showing cached search results. Reconnect to refresh search.");
      } else {
        setStatus("Connect to the internet to search new products.");
      }
      return;
    }
    try {
      setSearchingCatalog(true);
      setError("");
      const result = await searchPortalCatalogItems(credentials, orderSearch, orderSearchBrand, searchField);
      const items = result.items;
      setCatalogResults(items);
      setPortalRecommendations(result.recommendations);
      if (items[0]) {
        setSelectedCatalogCode(items[0].code);
        setPortalPreview({ kind: "catalog", item: items[0] });
      } else {
        setSelectedCatalogCode("");
        setPortalPreview(null);
      }
      setPortalOrderStatus(
        `${items.length.toLocaleString("en-US")} matching product and alternative result(s) found for the basket flow.${result.recommendations.length ? ` ${result.recommendations.length.toLocaleString("en-US")} stock-backed recommendation(s) added below.` : ""}`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal item search failed");
      setPortalOrderStatus("Search failed. Keeping the last visible result set.");
    } finally {
      setSearchingCatalog(false);
    }
  }

  async function appendPortalRows(rows: Array<{ code: string; brand: string; qty: number; market_segment?: string | null }>, statusText: string) {
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
          latestPricingProfile = prepared.pricingProfile || latestPricingProfile;
          processed += chunk.length;
        } catch (caught) {
          failedChunkMessage = caught instanceof Error ? caught.message : "Portal order pricing failed";
          break;
        }
      }

      if (failedChunkMessage) {
        throw new Error(failedChunkMessage);
      }

      setPortalDraftLines((current) => mergePortalPreparedLines(current, preparedLines));

      if (!portalPaymentTerms && latestPricingProfile?.payment_terms) {
        setPortalPaymentTerms(latestPricingProfile.payment_terms);
      }
      const missingPriceCount = preparedLines.filter((line) => line.sell_price == null).length;
      const discontinuedCount = preparedLines.filter((line) => line.lifecycle_status === "discontinued").length;
      const pricedCount = preparedLines.length - missingPriceCount;
      setPortalOrderStatus(
        `${statusText.replace("{count}", preparedLines.length.toLocaleString("en-US"))} ${pricedCount > 0 ? `${pricedCount.toLocaleString("en-US")} priced.` : ""}${missingPriceCount > 0 ? ` ${missingPriceCount.toLocaleString("en-US")} need live pricing.` : ""}${discontinuedCount > 0 ? ` ${discontinuedCount.toLocaleString("en-US")} discontinued item(s) detected.` : ""}`.trim(),
      );
      return preparedLines;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal order pricing failed");
      return [] as PortalPreparedLine[];
    } finally {
      setPreparingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  async function handleAddPortalCatalogItem(item: PortalCatalogSearchItem, quantity = 1) {
    const normalizedQuantity = normalizePortalQuantity(quantity);
    setSelectedCatalogCode(item.code);
    if (!isOnline) {
      const offlineLine = buildOfflinePreparedLineFromCatalogItem(item);
      offlineLine.qty = normalizedQuantity;
      setPortalDraftLines((current) => mergePortalPreparedLines(current, [offlineLine]));
      setPortalOrderStatus(`${normalizedQuantity} pcs added to ${portalSalesOrderNo || "Local Basket"} in Basket. Offline changes stay on this device.`);
      focusPortalDraftLines(offlineLine.lineId);
      return;
    }
    const prepared = await appendPortalRows(
      [{ code: item.replacement_old_code || item.code, brand: item.brand, qty: normalizedQuantity, market_segment: item.market_segment || null }],
      `{count} pcs added to ${portalSalesOrderNo || "New Basket"} in Basket.`,
    );
    if (prepared[0]) focusPortalDraftLines(prepared[0].lineId);
  }

  function handleExportPortalBasket() {
    if (!portalDraftLines.length) {
      setError("Add at least one line before exporting the basket.");
      return;
    }

    const rows: Array<Array<string | number | null | undefined>> = [
      [
        "Part_No",
        "Brand",
        "Qty",
        "Description",
        "Market_Segment",
        "HS_Code",
        "Origin",
        "Weight_kg",
        "Customer_Price",
        "Currency",
        "Lifecycle_Status",
      ],
      ...portalDraftLines.map((line) => [
        line.resolvedCode || line.requestedCode,
        line.brand,
        line.qty,
        line.description,
        line.market_segment || "",
        line.hs_code,
        line.origin,
        line.weight_kg,
        line.sell_price,
        portalOrderCurrency,
        line.lifecycle_status || "",
      ]),
      [],
      ["Total lines", portalDraftLines.length],
      ["Total quantity", portalDraftLines.reduce((sum, line) => sum + Number(line.qty || 0), 0)],
      ["Subtotal excl. VAT", "", "", "", "", "", "", "", "", portalDraftLines.reduce((sum, line) => sum + (line.sell_price == null ? 0 : Number(line.sell_price || 0) * Number(line.qty || 0)), 0), portalOrderCurrency],
    ];

    const blob = buildXlsxBlob("Basket", rows, [2, 8, 9]);
    const fileName = sanitizeFileName(`${activeSnapshot.invite.party_name}-basket`);
    downloadBlob(`${fileName || "portal-basket"}.xlsx`, blob);
    setPortalOrderStatus(`Exported ${portalDraftLines.length.toLocaleString("en-US")} basket line${portalDraftLines.length === 1 ? "" : "s"}.`);
    setError("");
  }

  async function handleImportPortalOrderFile(
    file: File,
    resetInputRef: { current: HTMLInputElement | null } = portalImportRef,
  ) {
    if (!isOnline) {
      setError("Connect to the internet to import and price a file.");
      if (resetInputRef.current) resetInputRef.current.value = "";
      return;
    }
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
      if (resetInputRef.current) resetInputRef.current.value = "";
    }
  }

  async function handleSubmitPortalOrder(mode: "draft" | "confirm") {
    if (!portalDraftLines.length) {
      setError("Add at least one line before saving portal order.");
      return;
    }
    if (mode === "confirm" && !isOnline) {
      setError("Connect to the internet to send this basket. Your basket stays saved on this device.");
      return;
    }
    if (mode === "draft" && !isOnline) {
      setError("");
      setPortalSalesOrderNo((current) => current || "Local Basket");
      setPortalOrderStatus("Basket saved on this device. Connect later to send it.");
      setStatus("Basket saved offline on this device.");
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
    beginPortalOrderMutation();
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
          market_segment: line.market_segment || null,
        })),
      });
      // The save response normally includes the new order in its refreshed
      // snapshot. If a concurrent history read briefly misses it, hydrate
      // the just-saved order directly so Documents > Orders never appears
      // empty after a successful Save Draft.
      let nextSnapshot = result.snapshot;
      if (!nextSnapshot.salesOrders.some((row) => row.id === result.orderId)) {
        try {
          const savedOrder = await fetchPortalSalesOrderDetail(credentials, result.orderId);
          if (savedOrder) {
            nextSnapshot = {
              ...nextSnapshot,
              salesOrders: [savedOrder, ...nextSnapshot.salesOrders.filter((row) => row.id !== savedOrder.id)],
            };
          }
        } catch {
          // The successful save remains authoritative; an explicit Refresh
          // can retry the history read if the detail endpoint is transient.
        }
      }
      setSnapshot(nextSnapshot);
      settlePortalOrderMutation();
      setSelection({ kind: "sales-order", id: result.orderId });
      // Keep the newly saved draft visible in the same Sales Orders view as a confirmed order.
      setActiveSection("orders");
      setStatus(
        mode === "confirm"
          ? `Basket ${result.orderId} submitted. Internal team can prepare proforma and next documents.`
          : `Basket ${result.orderId} saved. Use Confirm Basket to send it.`,
      );
      setPortalOrderStatus("");
      setCatalogResults([]);
      setPortalRecommendations([]);
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
    setPortalRecommendations([]);
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
    setPortalRecommendations([]);
    setOrderSearch("");
    setSelection(null);
    setError("");
    setSelectedDraftLineId("");
    setSelectedCatalogCode("");
    setActiveSection("desk");
  }

  function handleClearPortalSearch() {
    setOrderSearch("");
    setOrderSearchBrand("");
    setCatalogResults([]);
    setPortalRecommendations([]);
    setPortalOrderStatus("");
    setError("");
    setSelectedCatalogCode("");
    setPortalPreview(null);
  }

  async function handleDeletePortalDraft(row: PortalSalesOrderRow) {
    if (!isOnline) {
      setError("Connect to the internet to delete saved baskets from the portal.");
      return;
    }
    if (!window.confirm(`Delete basket ${row.sales_order_no || row.id}?`)) return;
    beginPortalOrderMutation();
    try {
      setSavingPortalOrder(true);
      setError("");
      setPortalOverlay({
        title: "Deleting Basket",
        message: `Removing basket ${row.sales_order_no || row.id} from your portal workspace.`,
      });
      const result = await deletePortalDraftOrder(credentials, row.id);
      setSnapshot((current) => mergePortalSnapshotOrderDetails(current, result.snapshot));
      settlePortalOrderMutation();
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
    if (!isOnline) {
      setError("Connect to the internet to download the price list.");
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
        ["Part_No", "Description", `Price_${result.currency}`, "Price_Date", "Lifecycle"],
        ...result.rows.map((row) => [
          formatBrandAwareProductCode(row.product_code, row.brand || portalPriceListBrand),
          row.description || "",
          row.sales_price ?? "",
          row.price_date || "",
          row.lifecycle_status === "discontinued" ? row.lifecycle_note || "Discontinued" : "Active",
        ]),
      ];
      const blob = buildXlsxBlob(`${portalPriceListBrand} Price List`, rows, [2]);
      const fileSuffix =
        result.pricingMode === "prefer_c_when_available" && result.priceListType !== "C"
          ? "c-where-available"
          : result.priceListType;
      downloadBlob(`${sanitizeFileName(`portal-price-list-${portalPriceListBrand}-${fileSuffix}`)}.xlsx`, blob);
      setStatus(
        result.pricingMode === "prefer_c_when_available" && result.priceListType !== "C"
          ? `${portalPriceListBrand} price list downloaded using C where available and ${result.priceListType} fallback.`
          : `${portalPriceListBrand} ${result.priceListType} price list downloaded.`,
      );
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

  function portalDetailQuantityKey(orderId: string, lineIndex: number) {
    return `${orderId}:${lineIndex}`;
  }

  function getPortalDetailQuantity(orderId: string, lineIndex: number, fallback: unknown) {
    return portalDetailQtyEdits[portalDetailQuantityKey(orderId, lineIndex)] ?? normalizePortalQuantity(fallback);
  }

  const detailCanEditQuantities = Boolean(
    selectedDocument?.kind === "sales-order" &&
      String(selectedDocument.row.status || "").toLowerCase() === "draft" &&
      !selectedDocument.row.portal_submitted_at,
  );
  const detailHasQuantityEdits = Boolean(
    detailCanEditQuantities &&
      selectedDocument?.row.lines?.some((line, index) => {
        const edited = portalDetailQtyEdits[portalDetailQuantityKey(selectedDocument.row.id, index)];
        return edited != null && edited !== normalizePortalQuantity(line.qty);
      }),
  );

  async function handleSavePortalDetailQuantities() {
    if (!selectedDocument || selectedDocument.kind !== "sales-order" || !detailCanEditQuantities) return;
    const row = selectedDocument.row;
    const rows = (row.lines || [])
      .map((line, index) => ({
        code: String(line.requested_code || line.old_code || line.code || "").trim(),
        brand: String(line.brand || "").trim(),
        qty: getPortalDetailQuantity(row.id, index, line.qty),
        market_segment: line.market_segment ?? null,
      }))
      .filter((line) => line.code && line.qty > 0);
    if (!rows.length) {
      setError("This order has no editable lines.");
      return;
    }
    beginPortalOrderMutation();
    try {
      setSavingPortalOrder(true);
      setError("");
      setPortalOverlay({ title: "Updating Sales Order", message: "Saving the revised quantities and recalculating prices." });
      const result = await submitPortalOrder(credentials, {
        orderId: row.id,
        salesOrderNo: row.sales_order_no || row.id,
        mode: "draft",
        deliveryTerm: "delivery_term" in row ? String(row.delivery_term || "") : "",
        paymentTerms: "payment_terms" in row ? String(row.payment_terms || "") : "",
        packingDetails: "packing_details" in row ? String(row.packing_details || "") : "",
        notes: String(row.notes || ""),
        rows,
      });
      // The mutation response may contain a compact order row without line
      // details. Hydrate the just-updated order so the new manual line is
      // immediately visible in Documents > Orders.
      let nextSnapshot = result.snapshot;
      try {
        const savedOrder = await fetchPortalSalesOrderDetail(credentials, result.orderId || row.id);
        if (savedOrder) {
          nextSnapshot = {
            ...nextSnapshot,
            salesOrders: [savedOrder, ...nextSnapshot.salesOrders.filter((order) => order.id !== savedOrder.id)],
          };
        }
      } catch {
        // Keep the successful mutation response; Refresh can retry a
        // transient detail-read failure.
      }
      setSnapshot(nextSnapshot);
      settlePortalOrderMutation();
      setSelection({ kind: "sales-order", id: result.orderId || row.id });
      setPortalDetailQtyEdits({});
      setStatus(`Sales order ${row.sales_order_no || row.id} quantities updated.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sales order quantity update failed");
    } finally {
      setSavingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  async function handleAddPortalDetailManualLine() {
    if (!selectedDocument || selectedDocument.kind !== "sales-order" || !detailCanEditQuantities) return;
    const code = portalDetailManualCode.trim();
    const brand = portalDetailManualBrand.trim();
    const qty = normalizePortalQuantity(portalDetailManualQty);
    if (!code || !brand) {
      setError("Enter both the part number and brand before adding a line.");
      return;
    }

    const row = selectedDocument.row;
    const rows = [
      ...(row.lines || []).map((line, index) => ({
        code: String(line.requested_code || line.old_code || line.code || "").trim(),
        brand: String(line.brand || "").trim(),
        qty: getPortalDetailQuantity(row.id, index, line.qty),
        market_segment: line.market_segment ?? null,
      })),
      { code, brand, qty, market_segment: null },
    ].filter((line) => line.code && line.brand && line.qty > 0);

    beginPortalOrderMutation();
    try {
      setSavingPortalOrder(true);
      setError("");
      setPortalOverlay({ title: "Adding Manual Part", message: "Checking the item and refreshing the sales order total." });
      const result = await submitPortalOrder(credentials, {
        orderId: row.id,
        salesOrderNo: row.sales_order_no || row.id,
        mode: "draft",
        deliveryTerm: "delivery_term" in row ? String(row.delivery_term || "") : "",
        paymentTerms: "payment_terms" in row ? String(row.payment_terms || "") : "",
        packingDetails: "packing_details" in row ? String(row.packing_details || "") : "",
        notes: String(row.notes || ""),
        rows,
      });
      const savedId = result.orderId || row.id;
      // Render the line immediately from the successful mutation response.
      // The detail read is intentionally moved to the background so a slow
      // refresh cannot make the table look empty or close the order view.
      const optimisticLines = rows.map((inputLine) => {
        const previous = (row.lines || []).find((line) => String(line.requested_code || line.old_code || line.code || "").trim() === inputLine.code);
        return previous
          ? { ...previous, qty: inputLine.qty }
          : {
              code: inputLine.code,
              requested_code: inputLine.code,
              brand: inputLine.brand,
              market_segment: inputLine.market_segment ?? null,
              description: "",
              qty: inputLine.qty,
              sell_price: null,
              line_total: null,
              sales_total: null,
            };
      });
      const compactOrder = result.snapshot.salesOrders.find((order) => order.id === savedId);
      const optimisticOrder = { ...(compactOrder || row), id: savedId, lines: optimisticLines };
      const nextSnapshot = {
        ...result.snapshot,
        salesOrders: [optimisticOrder, ...result.snapshot.salesOrders.filter((order) => order.id !== savedId)],
      };
      setSnapshot(nextSnapshot);
      settlePortalOrderMutation();
      setSelection({ kind: "sales-order", id: savedId });
      void fetchPortalSalesOrderDetail(credentials, savedId).then((savedOrder) => {
        // A just-written JSON line array can be briefly stale on the read
        // replica. Never replace the optimistic lines with an empty detail.
        if (!savedOrder || !savedOrder.lines?.length) return;
        setSnapshot((current) => current ? {
          ...current,
          salesOrders: [savedOrder, ...current.salesOrders.filter((order) => order.id !== savedOrder.id)],
        } : current);
      }).catch(() => {
        // The optimistic line remains visible; Refresh can retry the detail read.
      });
      setPortalDetailQtyEdits({});
      setPortalDetailManualCode("");
      setPortalDetailManualQty("1");
      const savedLine = optimisticLines.find((line) => String(line.code || line.requested_code || "").trim() === code);
      setStatus(
        savedLine?.sell_price == null
          ? `${code} added. Catalog and price not available; admin can complete it in Sales Orders.`
          : `${code} added to sales order ${row.sales_order_no || row.id}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manual part could not be added to the sales order");
    } finally {
      setSavingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  async function handleRemovePortalDetailLine(lineIndex: number) {
    if (!selectedDocument || selectedDocument.kind !== "sales-order" || !detailCanEditQuantities) return;
    const row = selectedDocument.row;
    const currentLines = row.lines || [];
    if (lineIndex < 0 || lineIndex >= currentLines.length) return;
    if (currentLines.length <= 1) {
      setError("A draft order must keep at least one line. Delete the draft order from the Orders list if it is no longer needed.");
      return;
    }
    const rows = currentLines
      .filter((_, index) => index !== lineIndex)
      .map((line, index) => ({
        code: String(line.requested_code || line.old_code || line.code || "").trim(),
        brand: String(line.brand || "").trim(),
        qty: getPortalDetailQuantity(row.id, index >= lineIndex ? index + 1 : index, line.qty),
        market_segment: line.market_segment ?? null,
      }))
      .filter((line) => line.code && line.brand && line.qty > 0);
    if (!rows.length) {
      setError("The remaining order lines are not valid.");
      return;
    }
    beginPortalOrderMutation();
    try {
      setSavingPortalOrder(true);
      setError("");
      setPortalOverlay({ title: "Removing Order Line", message: "Updating the sales order total." });
      const result = await submitPortalOrder(credentials, {
        orderId: row.id,
        salesOrderNo: row.sales_order_no || row.id,
        mode: "draft",
        deliveryTerm: "delivery_term" in row ? String(row.delivery_term || "") : "",
        paymentTerms: "payment_terms" in row ? String(row.payment_terms || "") : "",
        packingDetails: "packing_details" in row ? String(row.packing_details || "") : "",
        notes: String(row.notes || ""),
        rows,
      });
      const savedId = result.orderId || row.id;
      const compactOrder = result.snapshot.salesOrders.find((order) => order.id === savedId);
      const optimisticOrder = {
        ...(compactOrder || row),
        id: savedId,
        lines: currentLines.filter((_, index) => index !== lineIndex),
      };
      setSnapshot({
        ...result.snapshot,
        salesOrders: [optimisticOrder, ...result.snapshot.salesOrders.filter((order) => order.id !== savedId)],
      });
      settlePortalOrderMutation();
      setSelection({ kind: "sales-order", id: savedId });
      void fetchPortalSalesOrderDetail(credentials, savedId).then((savedOrder) => {
        if (!savedOrder || !savedOrder.lines?.length) return;
        setSnapshot((current) => current ? {
          ...current,
          salesOrders: [savedOrder, ...current.salesOrders.filter((order) => order.id !== savedOrder.id)],
        } : current);
      }).catch(() => {
        // Keep the optimistic removal visible; Refresh can retry the detail read.
      });
      setPortalDetailQtyEdits({});
      setStatus("Order line removed and total recalculated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Order line could not be removed");
    } finally {
      setSavingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  async function handleConfirmPortalDocument() {
    if (!selectedDocument || selectedDocument.kind !== "sales-order" || !detailCanEditQuantities) return;
    const row = selectedDocument.row;
    const rows = (row.lines || [])
      .map((line, index) => ({
        code: String(line.requested_code || line.old_code || line.code || "").trim(),
        brand: String(line.brand || "").trim(),
        qty: getPortalDetailQuantity(row.id, index, line.qty),
        market_segment: line.market_segment ?? null,
      }))
      .filter((line) => line.code && line.qty > 0);
    if (!rows.length) {
      setError("This order has no confirmable lines.");
      return;
    }
    beginPortalOrderMutation();
    try {
      setConfirmingPortalOrder(true);
      setError("");
      setPortalOverlay({ title: "Confirming Sales Order", message: "Sending the order with the current quantities to the internal team." });
      const result = await submitPortalOrder(credentials, {
        orderId: row.id,
        salesOrderNo: row.sales_order_no || row.id,
        mode: "confirm",
        deliveryTerm: "delivery_term" in row ? String(row.delivery_term || "") : "",
        paymentTerms: "payment_terms" in row ? String(row.payment_terms || "") : "",
        packingDetails: "packing_details" in row ? String(row.packing_details || "") : "",
        notes: String(row.notes || ""),
        rows,
      });
      setSnapshot((current) => mergePortalSnapshotOrderDetails(current, result.snapshot));
      settlePortalOrderMutation();
      setSelection({ kind: "sales-order", id: result.orderId || row.id });
      setPortalDetailQtyEdits({});
      setStatus(`Sales order ${row.sales_order_no || row.id} confirmed.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sales order confirmation failed");
    } finally {
      setConfirmingPortalOrder(false);
      setPortalOverlay(null);
    }
  }

  const detailColumns = (() => {
    if (!selectedDocument) return [];
    if (selectedDocument.kind === "sales-order" || selectedDocument.kind === "invoice") {
      return [
        {
          key: "image",
          header: "Image",
          render: (row: PortalLine) => (
            <span className="portal-order-detail-image">
              <ProductVisual imageUrl={row.image_url} brand={row.brand} alt={row.code || row.requested_code || "Part"} />
            </span>
          ),
        },
        { key: "code", header: "Code", render: (row: PortalLine) => row.code || row.requested_code || "-" },
        { key: "brand", header: "Brand", render: (row: PortalLine) => <BrandPill brand={row.brand} compact /> },
        {
          key: "description",
          header: "Description",
          render: (row: PortalLine) => (
            <div>
              <div>{row.description || (row.sell_price == null ? "Catalog and price not available" : "-")}</div>
              {renderDiscontinuedBadge(row)}
            </div>
          ),
        },
        {
          key: "qty",
          header: "Qty",
          render: (row: PortalLine) => {
            const lineIndex = selectedDocument.row.lines?.indexOf(row) ?? -1;
            const quantity = getPortalDetailQuantity(selectedDocument.row.id, lineIndex, row.qty);
            return detailCanEditQuantities ? (
              <input
                className="inline-edit-input inline-edit-input--qty"
                aria-label={`Quantity for ${row.code || row.requested_code || "line"}`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={quantity}
                onChange={(event) => {
                  if (lineIndex < 0) return;
                  setPortalDetailQtyEdits((current) => ({
                    ...current,
                    [portalDetailQuantityKey(selectedDocument.row.id, lineIndex)]: normalizePortalQuantity(event.target.value),
                  }));
                }}
              />
            ) : (
              quantity
            );
          },
        },
        { key: "origin", header: "Origin", render: (row: PortalLine) => row.origin || "-" },
        { key: "weight", header: "Weight", render: (row: PortalLine) => formatWeight(row.weight_kg) },
        { key: "unit", header: "Unit Price", render: (row: PortalLine) => row.sell_price == null ? "Price on request" : formatMoney(Number(row.sell_price), selectedDocument.row.currency) },
        { key: "amount", header: "Line Total", render: (row: PortalLine) => row.line_total == null && row.sales_total == null ? "—" : formatMoney(Number(row.line_total ?? row.sales_total ?? 0), selectedDocument.row.currency) },
        ...(selectedDocument.kind === "sales-order" ? [{
          key: "actions",
          header: "Action",
          render: (row: PortalLine) => {
            const lineIndex = selectedDocument.row.lines?.indexOf(row) ?? -1;
            return detailCanEditQuantities ? (
              <Button
                variant="secondary"
                className="button--compact danger-button"
                disabled={lineIndex < 0 || (selectedDocument.row.lines?.length || 0) <= 1 || savingPortalOrder}
                onClick={() => void handleRemovePortalDetailLine(lineIndex)}
              >
                Remove
              </Button>
            ) : null;
          },
        }] : []),
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
    const isSalesOrderExport = documentToExport.kind === "sales-order";
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
        ...(isSalesOrderExport ? [] : ["OEM"]),
        "Origin",
        "Weight",
        isCustomerDoc ? `Unit Price ${currency}` : `Buy Price ${currency}`,
        `Line Total ${currency}`,
        ...(isCustomerDoc ? [] : ["Notes"]),
      ],
      ...(documentToExport.row.lines || []).map((line) => [
        line.code || line.requested_code || line.old_code || "-",
        line.brand || "",
        line.description || "",
        Number(line.qty || 0),
        ...(isSalesOrderExport ? [] : [line.oem_no || ""]),
        line.origin || "",
        line.weight_kg == null ? "" : Number(line.weight_kg),
        Number(isCustomerDoc ? line.sell_price || 0 : line.buy_price || 0),
        Number(isCustomerDoc ? line.line_total || line.sales_total || 0 : line.line_total || 0),
        ...(isCustomerDoc ? [] : [line.notes || ""]),
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
          {detailCanEditQuantities ? (
            <Button
              variant="secondary"
              busy={savingPortalOrder}
              busyLabel="Updating..."
              disabled={!detailHasQuantityEdits}
              onClick={() => void handleSavePortalDetailQuantities()}
            >
              Update quantities
            </Button>
          ) : null}
          {detailCanEditQuantities ? (
            <Button
              busy={confirmingPortalOrder}
              busyLabel="Confirming..."
              disabled={confirmingPortalOrder}
              onClick={() => void handleConfirmPortalDocument()}
            >
              Confirm order
            </Button>
          ) : null}
          <Button variant="secondary" onClick={handlePortalPrint}>
            PDF / Print
          </Button>
          <Button variant="secondary" onClick={handlePortalExportExcel}>
            Export Excel
          </Button>
          <Button variant="secondary" onClick={() => setSelection(null)}>
            Back to List
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
        </div>

        {("delivery_term" in selectedDocument.row && selectedDocument.row.delivery_term) ||
        ("payment_terms" in selectedDocument.row && selectedDocument.row.payment_terms) ||
        ("contract_nr" in selectedDocument.row && selectedDocument.row.contract_nr) ||
        ("packing_details" in selectedDocument.row && selectedDocument.row.packing_details) ? (
          <div className="portal-detail-grid">
            {"delivery_term" in selectedDocument.row && selectedDocument.row.delivery_term ? (
              <div className="settings-item">
                <span className="settings-label">Delivery Term</span>
                <strong>{selectedDocument.row.delivery_term || "-"}</strong>
              </div>
            ) : null}
            {"payment_terms" in selectedDocument.row && selectedDocument.row.payment_terms ? (
              <div className="settings-item">
                <span className="settings-label">Payment Terms</span>
                <strong>{selectedDocument.row.payment_terms || "-"}</strong>
              </div>
            ) : null}
            {"contract_nr" in selectedDocument.row && selectedDocument.row.contract_nr ? (
              <div className="settings-item">
                <span className="settings-label">Contract Nr</span>
                <strong>{selectedDocument.row.contract_nr || "-"}</strong>
              </div>
            ) : null}
            {"packing_details" in selectedDocument.row && selectedDocument.row.packing_details ? (
              <div className="settings-item">
                <span className="settings-label">Packing</span>
                <strong>{selectedDocument.row.packing_details || "-"}</strong>
              </div>
            ) : null}
          </div>
        ) : null}

        {selectedDocument.row.notes ? (
          <div className="portal-detail-notes">
            <span className="settings-label">Notes</span>
            <strong>{selectedDocument.row.notes}</strong>
          </div>
        ) : null}

        {detailCanEditQuantities ? (
          <div className="portal-manual-line">
            <div>
              <span className="settings-label">Add manual part</span>
              <strong>Enter a known part number directly without returning to Search.</strong>
            </div>
            <div className="portal-manual-line__fields">
              <Input label="Part no" value={portalDetailManualCode} placeholder="e.g. W11025" onChange={setPortalDetailManualCode} onEnter={() => void handleAddPortalDetailManualLine()} />
              <Select label="Brand" value={portalDetailManualBrand} options={[{ value: "", label: "Select brand" }, ...portalBrandValueOptions]} onChange={setPortalDetailManualBrand} />
              <Input label="Qty" type="number" value={portalDetailManualQty} onChange={setPortalDetailManualQty} onEnter={() => void handleAddPortalDetailManualLine()} />
              <Button busy={savingPortalOrder} busyLabel="Adding..." disabled={!portalDetailManualCode.trim() || !portalDetailManualBrand.trim()} onClick={() => void handleAddPortalDetailManualLine()}>
                Add part
              </Button>
            </div>
          </div>
        ) : selectedDocument.kind === "sales-order" && selectedDocument.row.portal_submitted_at ? (
          <div className="portal-inline-note">
            <span>Order locked</span>
            <strong>This order has been confirmed and can no longer be edited.</strong>
          </div>
        ) : null}

        <DataTable
          rows={selectedDocument.row.lines || []}
          columns={detailColumns}
          emptyText={portalDetailLoadingId === selectedDocument.row.id ? "Loading line details..." : "No line details available."}
        />

        <div className="portal-detail-totals">
          {"subtotal" in selectedDocument.row ? (
            <div className="settings-item">
              <span className="settings-label">Sub Total</span>
              <strong>{formatMoney(Number(selectedDocument.row.subtotal || 0), selectedDocument.row.currency)}</strong>
            </div>
          ) : null}
          {"discount_amount" in selectedDocument.row && Number(selectedDocument.row.discount_amount || 0) > 0 ? (
            <div className="settings-item">
              <span className="settings-label">Discount</span>
              <strong>{formatMoney(Number(selectedDocument.row.discount_amount || 0), selectedDocument.row.currency)}</strong>
            </div>
          ) : null}
          {"shipping_cost" in selectedDocument.row && Number(selectedDocument.row.shipping_cost || 0) > 0 ? (
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

  const orderDetailOpen = Boolean(selectedDocument && (selectedDocument.kind === "sales-order" || selectedDocument.kind === "purchase-order"));
  const billingDetailOpen = Boolean(selectedDocument && (selectedDocument.kind === "invoice" || selectedDocument.kind === "bill"));
  const portalDesktopStageStyle: CSSProperties | undefined = shouldScalePortalDesktop
    ? {
        "--portal-desktop-scale": String(portalDesktopScale),
        "--portal-desktop-scaled-height": `${portalDesktopScaledHeight}px`,
        "--portal-desktop-base-width": `${PORTAL_DESKTOP_BASE_WIDTH_PX}px`,
      } as CSSProperties
    : undefined;

  return (
    <div className={`portal-desktop-stage${shouldScalePortalDesktop ? " portal-desktop-stage--scaled" : ""}`} style={portalDesktopStageStyle}>
      <div
        ref={portalDesktopFrameRef}
        className={`portal-desktop-frame${shouldScalePortalDesktop ? " portal-desktop-frame--scaled" : ""}`}
      >
    <div className="portal-shell portal-shell--workspace">
      <div className="portal-header">
        <div className="portal-brand">
          {activeSnapshot.companyProfile?.logo_data_url ? <img src={activeSnapshot.companyProfile.logo_data_url} alt="Portal logo" className="portal-brand__logo" /> : null}
          <div>
            <h1>{activeSnapshot.companyProfile?.company_name || "Next Master Portal"}</h1>
            <p>
              {activeSnapshot.invite.party_type === "customer" ? "Customer Portal" : "Vendor Portal"} for {activeSnapshot.invite.party_name}
            </p>
            {portalSellerDetails ? <div className="portal-brand__meta">{portalSellerDetails}</div> : null}
          </div>
        </div>
        <div className="portal-header__right">
          <div className="topbar-build portal-header__build-context">
            <div className="topbar-build__eyebrow">Build Context</div>
            <div className="topbar-build__chips">
              <span className={`topbar-chip ${portalBuildContext.className}`}>{portalBuildContext.label}</span>
              <span className="topbar-chip">{buildMeta.branch}</span>
              <span className="topbar-chip">{portalCommitShort}</span>
            </div>
            <div className="topbar-build__meta">
              <span>Built {portalBuiltAtLabel}</span>
              {buildMeta.deployUrl ? <span>Deploy ready</span> : null}
            </div>
          </div>
          <div className="inline-actions inline-actions--portal-header">
            <Button variant="secondary" busy={loading} busyLabel="Refreshing..." onClick={() => void handleRefresh()}>
              Refresh
            </Button>
            <Button variant="secondary" onClick={() => void handleLogout()}>
              Logout
            </Button>
          </div>
        </div>
      </div>

      <div className="portal-layout">
        <aside className="portal-sidebar">
          <div className="brand-panel portal-sidebar__panel">
            <div className="brand-panel__eyebrow">Portal Navigation</div>
            <div className="brand">{activeSnapshot.invite.party_type === "customer" ? "Customer" : "Vendor"}</div>
            <div className="brand-panel__sub">{activeSnapshot.invite.party_name}</div>
          </div>
          <nav className="sidebar-nav portal-sidebar-nav">
            {portalNavGroups.map((group) => (
              <div key={group.key} className={`nav-group${activePortalGroup === group.key ? " active" : ""}`}>
                <button className={`nav-item${activePortalGroup === group.key ? " active" : ""}`} onClick={() => handlePortalGroupNavigate(group.key)}>
                  <span className="nav-item__code">{group.code}</span>
                  <span className="nav-item__body">
                    <span className="nav-item__title">{group.title}</span>
                    <span className="nav-item__caption">{group.caption}</span>
                  </span>
                  <span className="nav-item__indicator" />
                </button>
                {activePortalGroup === group.key ? (
                  <div className="nav-submenu" role="menu" aria-label={`${group.title} sections`}>
                    {group.items.map((item) => (
                      <button
                        key={item.key}
                        className={`nav-submenu__item${activeSection === item.key ? " active" : ""}`}
                        onClick={() => setActiveSection(item.key)}
                      >
                        <span className="nav-submenu__dot" />
                        <span className="nav-submenu__label">{item.label}</span>
                        {item.badge ? <span className="nav-submenu__badge">{item.badge}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </nav>
        </aside>

        <div className="portal-content">
          <div className="portal-mobile-subnav" role="tablist" aria-label="Portal mobile sections">
            {(portalNavGroups.find((group) => group.key === activePortalGroup)?.items || []).map((item) => (
              <button
                key={item.key}
                className={`portal-mobile-subnav__item${activeSection === item.key ? " active" : ""}`}
                onClick={() => setActiveSection(item.key)}
              >
                <span>{item.label}</span>
                {item.badge ? <span className="portal-mobile-subnav__badge">{item.badge}</span> : null}
              </button>
            ))}
          </div>
          {status ? <div className="success-text" role="status">{status}</div> : null}
          {error ? <div className="warning-text" role="alert">{error}</div> : null}
          {portalNotifications.length ? (
            <section className="portal-notification-panel" aria-label="Portal updates">
              <div className="portal-notification-panel__header">
                <div>
                  <span className="settings-label">New information</span>
                  <strong>Updates from your seller</strong>
                </div>
                <Button variant="secondary" onClick={() => setPortalNotifications([])}>
                  Mark as read
                </Button>
              </div>
              <div className="portal-notification-panel__list">
                {portalNotifications.map((notification) => (
                  <div className="portal-notification-panel__item" key={notification.id}>
                    <strong>{notification.title}</strong>
                    <span>{notification.detail}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {activeSection !== "home" ? (
            <div className="portal-inline-note portal-inline-note--soft portal-inline-note--compact">
              <span>Current View</span>
              <strong>{portalDeskSummaryText}</strong>
            </div>
          ) : null}
          {!isOnline ? <div className="warning-text">Offline mode active. Basket changes stay on this device until you reconnect and confirm the basket.</div> : null}

          {activeSection === "home" && portalCanOrder ? (
            <CustomerDeskHome
              snapshot={activeSnapshot}
              searchValue={orderSearch}
              onSearchValueChange={setOrderSearch}
              onSearch={() => {
                setActiveSection("desk");
                void handlePortalCatalogSearch();
              }}
              onOpenSearch={() => setActiveSection("desk")}
              onOpenOrders={() => setActiveSection("orders")}
              onOpenBilling={() => setActiveSection("billing")}
            />
          ) : null}

          {activeSection === "statement" ? (
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
            <SectionCard title="Primary Seller">
              <div className="settings-grid settings-grid--compact">
                <div className="settings-item">
                  <span className="settings-label">Seller</span>
                  <strong>{activeSnapshot.companyProfile?.company_name || "-"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Email</span>
                  <strong>{activeSnapshot.companyProfile?.email || "-"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Phone</span>
                  <strong>{activeSnapshot.companyProfile?.phone || "-"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Website</span>
                  <strong>{activeSnapshot.companyProfile?.website || "-"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Address</span>
                  <strong>{activeSnapshot.companyProfile?.address || "-"}</strong>
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
                <strong>{portalPricingLabel}</strong>
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
              <strong>{portalPricingRuleDescription}</strong>
            </div>
            <div className="portal-inline-note portal-inline-note--soft">
              <span>Fields</span>
              <strong>Part no, description, customer price, price date, and lifecycle are included.</strong>
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
          {orderDetailOpen ? (
            documentDetailSection
          ) : (
            <SectionCard
              title={activeSnapshot.invite.party_type === "customer" ? "Order History" : "Purchase Orders"}
              actions={
                activeSnapshot.invite.party_type === "customer" ? (
                  <div className="inline-actions">
                    <input
                      ref={portalDocumentsImportRef}
                      type="file"
                      hidden
                      accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void handleImportPortalOrderFile(file, portalDocumentsImportRef);
                      }}
                    />
                    <Button type="button" variant="secondary" onClick={() => portalDocumentsImportRef.current?.click()}>
                      Import Excel
                    </Button>
                    <Button type="button" variant="secondary" onClick={downloadQuoteTemplate}>
                      Template
                    </Button>
                  </div>
                ) : null
              }
            >
              <DataTable
                rows={portalOrderHistoryRows}
                columns={activeSnapshot.invite.party_type === "customer" ? salesOrderColumns : purchaseOrderColumns}
                emptyText={activeSnapshot.invite.party_type === "customer" ? "No orders available." : "No purchase orders available."}
                onRowClick={(row) => void openPortalDocument({ kind: activeSnapshot.invite.party_type === "customer" ? "sales-order" : "purchase-order", id: row.id })}
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
          )}
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
          {billingDetailOpen ? (
            documentDetailSection
          ) : (
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
          )}
        </div>
          ) : null}

          {activeSection === "desk" && portalCanOrder ? (
        <div className="portal-section-stack">
          <SectionCard title="Part Search" className="search-focus-card search-focus-card--portal">
            <div className="portal-order-builder portal-order-builder--modern">
              <form
                className={`portal-filter-grid portal-filter-grid--desk${catalogResults.length ? " portal-filter-grid--results-hidden" : ""}`}
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
                <Input label="Part No / OEM Search" value={orderSearch} placeholder="Write part number or OEM number here" onChange={setOrderSearch} />
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
                  <Button type="button" variant="secondary" disabled={!portalDraftLines.length} onClick={handleExportPortalBasket}>
                    Export Basket
                  </Button>
                  <Button type="button" variant="secondary" onClick={handleClearPortalSearch}>
                    Clear Search
                  </Button>
                <Button type="submit" variant="secondary" busy={searchingCatalog} busyLabel="Searching...">
                  Search
                </Button>
              </div>
            </form>

              <div className={`portal-inline-note portal-inline-note--soft portal-inline-note--compact${catalogResults.length ? " portal-search-helper--results-hidden" : ""}`}>
                <span>Search Guide</span>
                <strong>Use the middle field for part number or OEM code. Import Brand, Part Code, and Qty files with Excel or CSV; exact matches stay on top and alternatives appear below.</strong>
              </div>

              {portalOrderStatus && !catalogResults.length ? <div className="success-text">{portalOrderStatus}</div> : null}
              {portalDraftHasMissingPrices ? <div className="warning-text">Items without live price can be saved in the basket but cannot be confirmed.</div> : null}
              {portalDraftDiscontinuedCount > 0 ? (
                <div className="warning-text">
                  {portalDraftDiscontinuedCount.toLocaleString("en-US")} discontinued item(s) detected in this basket. Review before submission.
                </div>
              ) : null}

              <PortalSearchResults
                  results={catalogResults}
                  query={orderSearch}
                  brand={orderSearchBrand}
                  brands={portalBrandOptions}
                  snapshot={activeSnapshot}
                  currency={portalOrderCurrency}
                  searching={searchingCatalog}
                  onQueryChange={setOrderSearch}
                  onBrandChange={setOrderSearchBrand}
                  onSearch={(searchField) => void handlePortalCatalogSearch(searchField)}
                  onClear={handleClearPortalSearch}
                  onImport={() => portalImportRef.current?.click()}
                  onTemplate={downloadQuoteTemplate}
                  onExport={handleExportPortalBasket}
                  exportDisabled={!portalDraftLines.length}
                  basketCount={portalDraftLines.length}
                  orderStatus={portalOrderStatus}
                  draftLines={portalDraftLines}
                  savingBasket={savingPortalOrder}
                  confirmingBasket={confirmingPortalOrder}
                  confirmDisabled={portalDraftHasMissingPrices}
                  orderNotes={portalOrderNotes}
                  deliveryTerm={portalDeliveryTerm}
                  paymentTerms={portalPaymentTerms}
                  packingDetails={portalPackingDetails}
                  onOrderNotesChange={setPortalOrderNotes}
                  onDeliveryTermChange={setPortalDeliveryTerm}
                  onPaymentTermsChange={setPortalPaymentTerms}
                  onPackingDetailsChange={setPortalPackingDetails}
                  onQuantityChange={(lineId, quantity) => setPortalDraftLines((current) => current.map((line) => (line.lineId === lineId ? { ...line, qty: quantity } : line)))}
                  onSaveBasket={() => void handleSubmitPortalOrder("draft")}
                  onClearBasket={handleClearPortalBuilder}
                  onConfirmBasket={() => void handleSubmitPortalOrder("confirm")}
                  selectedCode={selectedCatalogCode}
                  onSelect={(item) => {
                    setSelectedCatalogCode(item.code);
                    setPortalPreview({ kind: "catalog", item });
                  }}
                  onAdd={(item, quantity) => void handleAddPortalCatalogItem(item, quantity)}
                  onPreview={(item) => setPortalPreview({ kind: "catalog", item })}
                />

              {false ? <>
              <div className="portal-workbench">
                <div className="portal-workbench__tables">
                  <SectionCard title={`Search Items (${catalogResults.length.toLocaleString("en-US")})`} className={`search-results-focus-card${catalogResults.length ? " search-results-focus-card--legacy" : ""}`}>
                    {catalogResults.length && !isCompactPortalSearch ? (
                      <div className="workbench-controls workbench-controls--compact">
                        <div className="segmented-control" aria-label="Search result view">
                          <button
                            type="button"
                            className={`segmented-control__item ${effectivePortalSearchView === "cards" ? "active" : ""}`}
                            onClick={() => setPortalSearchView("cards")}
                          >
                            Cards
                          </button>
                          <button
                            type="button"
                            className={`segmented-control__item ${effectivePortalSearchView === "list" ? "active" : ""}`}
                            onClick={() => setPortalSearchView("list")}
                          >
                            List
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {catalogResults.length && effectivePortalSearchView === "cards" ? (
                      <div className="portal-search-card-grid">
                        {portalSearchCards.map((row) => (
                          <button
                            key={`${row.brand}-${row.code}`}
                            type="button"
                            className={`portal-search-card ${selectedCatalogCode === row.code ? "portal-search-card--active" : ""}`}
                            onClick={() => {
                              setSelectedCatalogCode(row.code);
                              setPortalPreview({ kind: "catalog", item: row });
                            }}
                          >
                            <div className="portal-search-card__top">
                              <div className="portal-search-card__media">
                                <ProductVisual imageUrl={row.image_url} brand={row.brand} alt={row.code} detail />
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
                              {row.vehicle ? <VehicleBadges value={row.vehicle} compact limit={3} logoOnly className="portal-search-card__vehicles" /> : null}
                              <div className="portal-search-card__specs">
                                <span>{row.tariff || "No tariff"}</span>
                                <span>{row.origin || "No origin"}</span>
                                <span>{formatWeight(row.weight_kg)}</span>
                              </div>
                              {row.replacement_warning ? (
                                <div className="portal-search-card__warning portal-search-card__warning--accent">Replacement</div>
                              ) : null}
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
                    {catalogResults.length && effectivePortalSearchView === "list" ? (
                      <DataTable
                        rows={catalogResults}
                        columns={portalCatalogColumns}
                        className="data-table--portal-search"
                        wrapClassName="table-wrap--portal-search"
                        emptyText={searchingCatalog ? "Searching items..." : "Search by part number, original number, or description to load matching products and alternatives."}
                        onRowClick={(row) => {
                          setSelectedCatalogCode(row.code);
                          setPortalPreview({ kind: "catalog", item: row });
                        }}
                        rowClassName={(row) => (selectedCatalogCode === row.code ? "data-table__row--active" : "")}
                      />
                    ) : (
                      <div className="empty-state">
                        {searchingCatalog ? "Searching items..." : "Search by part number, original number, or description to load matching products and alternatives."}
                      </div>
                    )}
                  </SectionCard>

                  {portalRecommendationCards.length ? (
                    <SectionCard title={`Recommended With This Search (${portalRecommendationCards.length.toLocaleString("en-US")})`} className={catalogResults.length ? "search-results-focus-card--legacy" : ""}>
                      <div className="portal-inline-note portal-inline-note--soft">
                        <span>Recommendation Logic</span>
                        <strong>These items stay outside the exact match list. They are ranked from the same product family and current stock movement.</strong>
                      </div>
                      <div className="portal-search-card-grid">
                        {portalRecommendationCards.map((row) => (
                          <button
                            key={`recommended-${row.brand}-${row.code}`}
                            type="button"
                            className={`portal-search-card ${selectedCatalogCode === row.code ? "portal-search-card--active" : ""}`}
                            onClick={() => {
                              setSelectedCatalogCode(row.code);
                              setPortalPreview({ kind: "catalog", item: row });
                            }}
                          >
                            <div className="portal-search-card__top">
                              <div className="portal-search-card__media">
                                <ProductVisual imageUrl={row.image_url} brand={row.brand} alt={row.code} detail />
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
                              {row.vehicle ? <VehicleBadges value={row.vehicle} compact limit={3} logoOnly className="portal-search-card__vehicles" /> : null}
                              <div className="portal-search-card__specs">
                                <span>{row.available_qty == null ? "Stock check" : `${Number(row.available_qty).toLocaleString("en-US")} in stock`}</span>
                                <span>{row.origin || "No origin"}</span>
                                <span>{formatWeight(row.weight_kg)}</span>
                              </div>
                              {row.recommendation_reason ? <div className="portal-search-card__warning portal-search-card__warning--accent">{row.recommendation_reason}</div> : null}
                              {row.replacement_warning ? (
                                <div className="portal-search-card__warning portal-search-card__warning--accent">Replacement</div>
                              ) : null}
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
                    </SectionCard>
                  ) : null}

                  <div ref={portalDraftLinesRef}>
                    <SectionCard title={`Basket (${portalDraftLines.length.toLocaleString("en-US")})`}>
                      <DataTable
                        rows={portalDraftLines}
                        columns={portalDraftColumns}
                        emptyText={preparingPortalOrder ? "Preparing prices..." : "Use Add on a search result or import a file to build the basket here."}
                        onRowClick={(row) => {
                          setSelectedDraftLineId(row.lineId);
                          setPortalPreview({ kind: "basket", item: row });
                        }}
                        rowClassName={(row) => (selectedDraftLineId === row.lineId ? "data-table__row--active" : "")}
                      />
                    </SectionCard>
                  </div>
                </div>
              </div>

              {portalOriginalNumberBrandMatches.length ? (
                <div className="portal-inline-note">
                  <span>Original No Match</span>
                  <strong>{portalOriginalNumberBrandMatches.join(", ")}</strong>
                </div>
              ) : null}

              {portalDraftWarningLines.length ? (
                <SectionCard title="Warning Items">
                  <div className="portal-warning-list">
                    {portalDraftWarningLines.slice(0, 8).map((line) => (
                      <button
                        key={line.lineId}
                        type="button"
                        className="portal-warning-list__item"
                        onClick={() => {
                          setSelectedDraftLineId(line.lineId);
                          setPortalPreview({ kind: "basket", item: line });
                        }}
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
                </SectionCard>
              ) : null}

              <div className="portal-action-bar">
                <Button variant="secondary" busy={savingPortalOrder} busyLabel="Saving..." onClick={() => void handleSubmitPortalOrder("draft")}>
                  Save Basket
                </Button>
                <Button variant="secondary" onClick={handleClearPortalBuilder}>
                  Clear
                </Button>
                <Button busy={confirmingPortalOrder} busyLabel="Confirming..." disabled={portalDraftHasMissingPrices} onClick={() => void handleSubmitPortalOrder("confirm")}>
                  Confirm Basket
                </Button>
              </div>
              </> : null}
            </div>
          </SectionCard>
        </div>
          ) : null}
        </div>
      </div>
      <nav className="portal-mobile-bottom-nav" aria-label="Portal mobile navigation">
        {portalNavGroups.map((group) => (
          <button
            key={group.key}
            className={`portal-mobile-bottom-nav__item${activePortalGroup === group.key ? " active" : ""}`}
            onClick={() => handlePortalGroupNavigate(group.key)}
          >
            <span className="portal-mobile-bottom-nav__title">{group.title}</span>
            <span className="portal-mobile-bottom-nav__caption">{group.caption}</span>
          </button>
        ))}
      </nav>

      {portalOverlay ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card modal-card--compact" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <h3>{portalOverlay.title}</h3>
              <p>{portalOverlay.message}</p>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {portalPreview ? (
        <div className="modal-backdrop" onClick={() => setPortalPreview(null)}>
          <DraggableSurface className="modal-card modal-card--compact" dragHandleSelector=".draggable-surface__handle" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>
                  {portalPreview.kind === "catalog"
                    ? portalPreview.item.code || "-"
                    : portalPreview.item.resolvedCode || portalPreview.item.requestedCode || "-"}
                </h3>
                <p>{portalPreview.item.brand || (portalPreview.kind === "catalog" ? "Part search result" : "Basket line")}</p>
              </div>
            </div>
            <div className="workbench-detail-panel__media">
              <ProductVisual
                imageUrl={portalPreview.item.image_url}
                imageGallery={portalPreviewMedia}
                brand={portalPreview.item.brand}
                alt={
                  portalPreview.kind === "catalog"
                    ? portalPreview.item.code || ""
                    : portalPreview.item.resolvedCode || portalPreview.item.requestedCode || ""
                }
                detail
                onPreview={
                  portalPreviewMedia.length || portalPreview.item.image_url
                    ? (item) =>
                        setPreviewImage({
                          src: item?.src || portalPreview.item.image_url || "",
                          code:
                            portalPreview.kind === "catalog"
                              ? portalPreview.item.code || ""
                              : portalPreview.item.resolvedCode || portalPreview.item.requestedCode || "",
                          name: portalPreview.item.description || "",
                        })
                    : null
                }
              />
            </div>
            <div className="workbench-detail-list">
              {portalPreview.kind === "basket" ? (
                <>
                  <div><span>Requested Code</span><strong>{portalPreview.item.requestedCode || "-"}</strong></div>
                  <div><span>Resolved Code</span><strong>{portalPreview.item.resolvedCode || "-"}</strong></div>
                  <div><span>Description</span><strong>{portalPreview.item.description || "-"}</strong></div>
                  <div><span>OEM</span><strong>{portalPreview.item.oem_no || "-"}</strong></div>
                  <div><span>Tariff</span><strong>{portalPreview.item.hs_code || "-"}</strong></div>
                  <div><span>Origin</span><strong>{portalPreview.item.origin || "-"}</strong></div>
                  <div><span>Weight</span><strong>{formatWeight(portalPreview.item.weight_kg)}</strong></div>
                  <div><span>Unit Price</span><strong>{portalPreview.item.sell_price == null ? "-" : formatMoney(portalPreview.item.sell_price, portalOrderCurrency)}</strong></div>
                  {portalPreview.item.codeChangeWarning ? <div><span>Replacement</span><strong>{portalPreview.item.codeChangeWarning}</strong></div> : null}
                  {portalPreview.item.lifecycle_warning ? <div><span>Lifecycle</span><strong>{portalPreview.item.lifecycle_warning}</strong></div> : null}
                </>
              ) : (
                <>
                  <div><span>Code</span><strong>{portalPreview.item.code || "-"}</strong></div>
                  <div><span>Description</span><strong>{portalPreview.item.description || "-"}</strong></div>
                  <div><span>OEM</span><strong>{portalPreview.item.oem_no || "-"}</strong></div>
                  <div>
                    <span>Vehicle</span>
                    <strong className="catalog-detail-list-text">
                      <VehicleBadges value={portalPreview.item.vehicle || ""} limit={5} expandable logoOnly />
                    </strong>
                  </div>
                  <div><span>Tariff</span><strong>{portalPreview.item.tariff || "-"}</strong></div>
                  <div><span>Origin</span><strong>{portalPreview.item.origin || "-"}</strong></div>
                  <div><span>Weight</span><strong>{formatWeight(portalPreview.item.weight_kg)}</strong></div>
                  <div><span>Unit Price</span><strong>{portalPreview.item.sell_price == null ? "-" : formatMoney(portalPreview.item.sell_price, portalPreview.item.currency || portalOrderCurrency)}</strong></div>
                  {portalPreview.item.available_qty != null ? (
                    <div><span>Available Stock</span><strong>{Number(portalPreview.item.available_qty).toLocaleString("en-US")}</strong></div>
                  ) : null}
                  {portalPreview.item.recommendation_reason ? <div><span>Why Suggested</span><strong>{portalPreview.item.recommendation_reason}</strong></div> : null}
                  {portalPreview.item.replacement_warning ? <div><span>Replacement</span><strong>{portalPreview.item.replacement_warning}</strong></div> : null}
                  {portalPreview.item.lifecycle_warning ? <div><span>Lifecycle</span><strong>{portalPreview.item.lifecycle_warning}</strong></div> : null}
                </>
              )}
            </div>
            <div className="modal-actions">
              {portalPreview.kind === "catalog" ? (
                <Button
                  onClick={() => {
                    void handleAddPortalCatalogItem(portalPreview.item);
                  }}
                >
                  Add to Basket
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => setPortalPreview(null)}>
                Close
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {previewImage ? (
        <div className="modal-backdrop" onClick={() => setPreviewImage(null)}>
          <DraggableSurface className="modal-card modal-card--image-preview" dragHandleSelector=".draggable-surface__handle" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card__header draggable-surface__handle">
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
          </DraggableSurface>
        </div>
      ) : null}
    </div>
      </div>
    </div>
  );
}
