import { useEffect, useMemo, useRef, useState } from "react";
import { CATALOG_MARKET_SEGMENT_OPTIONS, normalizeCatalogMarketSegment } from "../../domain/shared/catalogSegments";
import { normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { syncBrandCatalog } from "../../infrastructure/api/adminApi";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import {
  CatalogDeleteBlockedError,
  createCloudCatalogRow,
  deleteCloudCatalogRow,
  fetchCatalogExportRows,
  fetchCatalogRowsByCodes,
  fetchCloudCatalogIntegrity,
  fetchCatalogIntegritySummary,
  updateCloudCatalogRow,
  type CatalogDeleteReferenceSummary,
} from "../../infrastructure/api/catalogApi";
import { fetchCatalogProductMedia } from "../../infrastructure/api/catalogMediaApi";
import { createCodeReference, fetchCatalogReferenceCoverage, inspectCodeReferenceUsage } from "../../infrastructure/api/codeReferencesApi";
import { bulkImportCatalog, type CatalogImportResult } from "../../infrastructure/api/importApi";
import { matchesOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";
import type { BrandOption } from "../../types/brand";
import type { CatalogIntegrityFilter, CatalogIntegrityStatus, CatalogIntegritySummary, CatalogRow } from "../../types/catalog";
import type { CodeReferenceUsage } from "../../types/codeReferences";
import { Button } from "../components/common/Button";
import { DraggableSurface } from "../components/common/DraggableSurface";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { ProductVisual, type ProductMediaItem } from "../components/common/ProductVisual";
import { Select } from "../components/common/Select";
import { VehicleBadges } from "../components/common/VehicleBadges";
import { downloadCsv, normalizeNumber, normalizeText, parseCsv, toCsv } from "../../shared/csv";
import { downloadCatalogLifecycleTemplate, downloadCatalogTemplate } from "../../shared/importTemplates";
import { dispatchAppNavigation, PENDING_CATALOG_PURCHASE_ITEM_KEY, PENDING_CATALOG_SALES_ITEM_KEY, storeCatalogTransfer } from "../../shared/catalogTransfer";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { useI18n } from "../../i18n/I18nProvider";
import { shouldDisplayCatalogIntegrityCounts } from "../../shared/catalogIntegritySummary";
import { CompactFilterBar, PageActions, PageHeader, PageShell } from "../components/common/VisualPrimitives";

const CATALOG_CACHE_KEY = "next-master-catalog-cache";
const CATALOG_CACHE_WRITE_DELAY_MS = 250;
const CATALOG_PAGE_SIZE = 50;

type CatalogRowDraft = Omit<CatalogRow, "weight_kg"> & {
  weight_kg: number | string | null;
};

type CatalogExportFormat = "csv" | "xlsx";

type CatalogOfflineCache = {
  brands: BrandOption[];
  rows: CatalogRow[];
  drafts: Record<string, CatalogRowDraft>;
  search: string;
  submittedSearch: string;
  catalogBrand: string;
  submittedCatalogBrand: string;
  catalogSegment: string;
  submittedCatalogSegment: string;
  selectedCatalogProductId: string;
  updatedAt: string;
};

function parseWeightInput(value: number | string | null | undefined) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(",", ".");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function readCatalogCache() {
  if (typeof window === "undefined") return null as CatalogOfflineCache | null;
  try {
    const raw = window.localStorage.getItem(CATALOG_CACHE_KEY);
    return raw ? (JSON.parse(raw) as CatalogOfflineCache) : null;
  } catch {
    return null;
  }
}

function writeCatalogCache(cache: CatalogOfflineCache | null) {
  if (typeof window === "undefined") return;
  if (!cache) {
    window.localStorage.removeItem(CATALOG_CACHE_KEY);
    return;
  }
  window.localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(cache));
}

function buildCatalogCacheSnapshot(params: {
  brands: BrandOption[];
  rows: CatalogRow[];
  drafts: Record<string, CatalogRowDraft>;
  search: string;
  submittedSearch: string;
  catalogBrand: string;
  submittedCatalogBrand: string;
  catalogSegment: string;
  submittedCatalogSegment: string;
  selectedCatalogProductId: string;
}) {
  const existing = readCatalogCache();
  return {
    brands: params.brands.length ? params.brands : existing?.brands || [],
    rows: params.rows.length ? params.rows : existing?.rows || [],
    drafts: Object.keys(params.drafts).length ? params.drafts : existing?.drafts || {},
    search: params.search || existing?.search || "",
    submittedSearch: params.submittedSearch || "",
    catalogBrand: params.catalogBrand || "",
    submittedCatalogBrand: params.submittedCatalogBrand || "",
    catalogSegment: params.catalogSegment || existing?.catalogSegment || "",
    submittedCatalogSegment: params.submittedCatalogSegment || existing?.submittedCatalogSegment || "",
    selectedCatalogProductId: params.selectedCatalogProductId,
    updatedAt: new Date().toISOString(),
  } satisfies CatalogOfflineCache;
}

function filterCachedCatalogRows(rows: CatalogRow[], search: string, brand: string, marketSegment: string) {
  const trimmedSearch = search.trim();
  const normalizedSearch = normalizePartCode(trimmedSearch);
  const normalizedSegment = normalizeCatalogMarketSegment(marketSegment);
  const filtered = rows.filter((row) => {
    if (brand && String(row.brand || "").toLowerCase() !== brand.toLowerCase()) return false;
    if (normalizedSegment && row.market_segment !== normalizedSegment) return false;
    if (!trimmedSearch) return true;
    const rawMatch = [
      row.product_code,
      row.brand,
      row.description,
      row.oem_no,
      row.vehicle,
      row.hs_code,
      row.origin,
      row.replacement_old_code,
      row.replacement_code,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(trimmedSearch.toLowerCase());
    if (rawMatch) return true;
    if (normalizedSearch) {
      const normalizedFields = [row.product_code, row.oem_no, row.replacement_old_code, row.replacement_code].map((value) => normalizePartCode(String(value || "")));
      if (normalizedFields.some((value) => value.includes(normalizedSearch))) return true;
    }
    return matchesOriginalNumberSearch(row.oem_no || "", trimmedSearch);
  });
  const total = filtered.length;
  return filtered.map((row) => ({ ...row, total_count: total }));
}

function buildCatalogRowDraft(row: CatalogRow, existing?: CatalogRowDraft | null): CatalogRowDraft {
  return {
    ...(existing || row),
    weight_kg: existing?.weight_kg ?? row.weight_kg ?? null,
  };
}

export function CatalogPage() {
  const { locale, t } = useI18n();
  const actionFeedback = useActionFeedback();
  const selectedCatalogPopupRef = useRef<HTMLDivElement | null>(null);
  const catalogCacheHydratedRef = useRef(false);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [importBrand, setImportBrand] = useState("");
  const [importBrandName, setImportBrandName] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [exportBrand, setExportBrand] = useState("");
  const [exportFormat, setExportFormat] = useState<CatalogExportFormat>("csv");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showReferenceDialog, setShowReferenceDialog] = useState(false);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [catalogBrand, setCatalogBrand] = useState("");
  const [submittedCatalogBrand, setSubmittedCatalogBrand] = useState("");
  const [catalogSegment, setCatalogSegment] = useState("");
  const [submittedCatalogSegment, setSubmittedCatalogSegment] = useState("");
  const [integrityFilter, setIntegrityFilter] = useState<CatalogIntegrityFilter>("");
  const [submittedIntegrityFilter, setSubmittedIntegrityFilter] = useState<CatalogIntegrityFilter>("");
  const [catalogPage, setCatalogPage] = useState(1);
  const [integritySummary, setIntegritySummary] = useState<CatalogIntegritySummary | null>(null);
  const [integritySummaryLoading, setIntegritySummaryLoading] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<{ brand: string; codes: string[] } | null>(null);
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CatalogRowDraft>>({});
  const [referenceCoverage, setReferenceCoverage] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [searchingCatalog, setSearchingCatalog] = useState(false);
  const [exportingCatalog, setExportingCatalog] = useState(false);
  const [rowActionKey, setRowActionKey] = useState("");
  const [deleteBlockSummary, setDeleteBlockSummary] = useState<CatalogDeleteReferenceSummary[] | null>(null);
  const [importingCatalog, setImportingCatalog] = useState(false);
  const [catalogImportSummary, setCatalogImportSummary] = useState<CatalogImportResult | null>(null);
  const [syncingBrandCatalog, setSyncingBrandCatalog] = useState(false);
  const [creatingItem, setCreatingItem] = useState(false);
  const [savingReference, setSavingReference] = useState(false);
  const [referenceOldCodeUsage, setReferenceOldCodeUsage] = useState<CodeReferenceUsage | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; code: string; name: string } | null>(null);
  const [selectedCatalogProductId, setSelectedCatalogProductId] = useState("");
  const [selectedCatalogMedia, setSelectedCatalogMedia] = useState<ProductMediaItem[]>([]);
  const [showFullSelectedOem, setShowFullSelectedOem] = useState(false);
  const [importCatalogSegment, setImportCatalogSegment] = useState("");
  const [createDraft, setCreateDraft] = useState({
    product_code: "",
    brand: "",
    brand_name: "",
    description: "",
    oem_no: "",
    vehicle: "",
    hs_code: "",
    origin: "",
    market_segment: "",
    weight_kg: "",
    lifecycle_status: "active",
    lifecycle_note: "",
  });
  const [referenceDraft, setReferenceDraft] = useState({
    brand: "",
    old_code: "",
    new_code: "",
    original_number: "",
    reason: "",
  });
  const numberLocale = locale === "tr" ? "tr-TR" : "en-US";
  const formatCount = (value: number) => value.toLocaleString(numberLocale);
  const displayIntegrityCounts = integritySummary ? shouldDisplayCatalogIntegrityCounts(integritySummary.initialization_state) : false;
  const formatIntegrityCount = (value: number | null | undefined) => displayIntegrityCounts && value != null ? formatCount(value) : "—";
  const getSegmentLabel = (value: string | null | undefined) => {
    const normalized = normalizeCatalogMarketSegment(value);
    return normalized ? t(`catalog.segments.${normalized}`) : t("catalog.segments.unassigned");
  };
  const segmentOptions = CATALOG_MARKET_SEGMENT_OPTIONS.map((option) => ({
    value: option.value,
    label: getSegmentLabel(option.value),
  }));
  const lifecycleOptions = [
    { value: "active", label: t("catalog.lifecycle.active") },
    { value: "discontinued", label: t("catalog.lifecycle.discontinued") },
  ];
  const getLifecycleLabel = (value: string | null | undefined) =>
    normalizeCatalogLifecycleStatus(value) === "discontinued" ? t("catalog.lifecycle.discontinued") : t("catalog.lifecycle.active");
  const getExportFormatLabel = (format: CatalogExportFormat) =>
    format === "xlsx" ? t("catalog.export.formats.excel") : t("catalog.export.formats.csv");
  const integrityFilterOptions = [
    { value: "", label: t("catalog.integrity.filters.all") },
    { value: "conflict", label: t("catalog.integrity.filters.conflict") },
    { value: "incomplete", label: t("catalog.integrity.filters.incomplete") },
    { value: "missing_ean", label: t("catalog.integrity.filters.missingEan") },
    { value: "pending", label: t("catalog.integrity.filters.pending") },
    { value: "failed", label: t("catalog.integrity.filters.failed") },
  ];
  const getIntegrityLabel = (status: CatalogIntegrityStatus | undefined) => {
    if (status === "conflict") return t("catalog.integrity.states.conflict");
    if (status === "incomplete") return t("catalog.integrity.states.incomplete");
    if (status === "failed") return t("catalog.integrity.states.failed");
    if (status === "clear") return t("catalog.integrity.states.clear");
    return t("catalog.integrity.states.pending");
  };
  const getIntegrityTone = (status: CatalogIntegrityStatus | undefined) => {
    if (status === "conflict" || status === "failed") return "is-danger";
    if (status === "incomplete") return "is-warning";
    if (status === "clear") return "is-live";
    return "is-info";
  };

  async function refreshIntegritySummary() {
    if (!isOnline) return;
    setIntegritySummaryLoading(true);
    try {
      setIntegritySummary(await fetchCatalogIntegritySummary());
    } catch {
      // Catalog search remains usable if the operations projection is temporarily unavailable.
    } finally {
      setIntegritySummaryLoading(false);
    }
  }

  useEffect(() => {
    setDeleteBlockSummary(null);
  }, [selectedCatalogProductId]);

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
    let cancelled = false;

    async function run() {
      if (!isOnline) {
        const cached = readCatalogCache();
        if (!cancelled) setBrands(cached?.brands || []);
        return;
      }
      try {
        const result = await fetchCloudBrands();
        if (!cancelled) setBrands(result);
      } catch {
        if (!cancelled) {
          const cached = readCatalogCache();
          setBrands(cached?.brands || []);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  useEffect(() => {
    if (!isOnline) return;
    void refreshIntegritySummary();
    const interval = window.setInterval(() => void refreshIntegritySummary(), 60_000);
    return () => window.clearInterval(interval);
  }, [isOnline]);

  useEffect(() => {
    if (!brands.length) return;
    if (catalogBrand && !brands.some((item) => item.name === catalogBrand)) {
      setCatalogBrand("");
    }
    if (submittedCatalogBrand && !brands.some((item) => item.name === submittedCatalogBrand)) {
      setSubmittedCatalogBrand("");
    }
  }, [brands, catalogBrand, submittedCatalogBrand]);

  useEffect(() => {
    if (catalogCacheHydratedRef.current || typeof window === "undefined") return;
    catalogCacheHydratedRef.current = true;
    const cached = readCatalogCache();
    if (!cached) return;
    if (cached.brands.length) setBrands(cached.brands);
    if (cached.rows.length) setRows(cached.rows);
    if (cached.drafts && Object.keys(cached.drafts).length) setDrafts(cached.drafts);
    setSearch(cached.search || cached.submittedSearch || "");
    setSubmittedSearch(cached.submittedSearch || cached.search || "");
    setCatalogBrand(cached.catalogBrand || cached.submittedCatalogBrand || "");
    setSubmittedCatalogBrand(cached.submittedCatalogBrand || cached.catalogBrand || "");
    setCatalogSegment(cached.catalogSegment || cached.submittedCatalogSegment || "");
    setSubmittedCatalogSegment(cached.submittedCatalogSegment || cached.catalogSegment || "");
    setSelectedCatalogProductId(cached.selectedCatalogProductId || "");
    if (!isOnline) {
      setStatus(t("catalog.status.offlineCachedData"));
      setError("");
    }
  }, [isOnline, t]);

  useEffect(() => {
    if (!CATALOG_MARKET_SEGMENT_OPTIONS.length) return;
    if (catalogSegment && !CATALOG_MARKET_SEGMENT_OPTIONS.some((option) => option.value === catalogSegment)) {
      setCatalogSegment("");
    }
    if (submittedCatalogSegment && !CATALOG_MARKET_SEGMENT_OPTIONS.some((option) => option.value === submittedCatalogSegment)) {
      setSubmittedCatalogSegment("");
    }
  }, [catalogSegment, submittedCatalogSegment]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!isOnline) {
        const cached = readCatalogCache();
        const cachedRows = cached?.rows || [];
        const offlineRows =
          !submittedSearch.trim() && !submittedCatalogBrand && !submittedCatalogSegment
            ? cachedRows
            : filterCachedCatalogRows(cachedRows, submittedSearch, submittedCatalogBrand, submittedCatalogSegment);
        if (!cancelled) {
          setRows(offlineRows);
          setLoading(false);
          setError("");
          if (submittedSearch.trim() || submittedCatalogBrand || submittedCatalogSegment) {
            setStatus(
              offlineRows.length
                ? t("catalog.status.offlineCachedRows", { count: formatCount(offlineRows.length) })
                : t("catalog.status.offlineNoCachedRows"),
            );
          }
        }
        return;
      }

      if (!submittedSearch.trim() && !submittedCatalogBrand && !submittedCatalogSegment && !submittedIntegrityFilter) {
        if (!cancelled) {
          setRows([]);
          setLoading(false);
          setError("");
          setStatus("");
        }
        return;
      }

      setLoading(true);
      setError("");
      setStatus("");
      try {
        const result =
          previewSelection && !submittedSearch.trim() && submittedCatalogBrand === previewSelection.brand
            ? await fetchCatalogRowsByCodes({
                brandName: previewSelection.brand,
                codes: previewSelection.codes,
                marketSegment: submittedCatalogSegment,
              })
            : await fetchCloudCatalogIntegrity({
                search: submittedSearch,
                brandName: submittedCatalogBrand,
                marketSegment: submittedCatalogSegment,
                integrityFilter: submittedIntegrityFilter,
                page: catalogPage,
                pageSize: CATALOG_PAGE_SIZE,
              });
        if (!cancelled) setRows(result);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : t("catalog.errors.requestFailed"));
          setStatus(t("catalog.status.requestFailedKeepingResults"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [isOnline, submittedSearch, submittedCatalogBrand, submittedCatalogSegment, submittedIntegrityFilter, catalogPage, previewSelection, t, numberLocale]);

  useEffect(() => {
    if (!searchingCatalog || loading) return;
    const rawTotal = rows[0]?.total_count ?? (rows.some((row) => row.has_more) || catalogPage > 1 ? -((catalogPage - 1) * CATALOG_PAGE_SIZE + rows.length) : rows.length);
    const nextTotal = Math.abs(rawTotal) || rows.length;
    const totalLabel = `${formatCount(nextTotal)}${rawTotal < 0 ? "+" : ""}`;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(t("catalog.status.rowsLoaded", { count: totalLabel }));
    }
    setSearchingCatalog(false);
  }, [searchingCatalog, loading, error, rows, catalogPage, actionFeedback, numberLocale, t]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!rows.length) {
        setReferenceCoverage({});
        return;
      }

      try {
        const coverage = await fetchCatalogReferenceCoverage(
          rows.map((row) => ({
            brand: row.brand,
            product_code: row.product_code,
          })),
        );
        if (!cancelled) setReferenceCoverage(coverage);
      } catch {
        if (!cancelled) setReferenceCoverage({});
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!showReferenceDialog || !referenceDraft.brand || !referenceDraft.old_code.trim()) {
        setReferenceOldCodeUsage(null);
        return;
      }

      try {
        const usage = await inspectCodeReferenceUsage({
          brand: referenceDraft.brand,
          code: referenceDraft.old_code,
        });
        if (!cancelled) setReferenceOldCodeUsage(usage);
      } catch {
        if (!cancelled) setReferenceOldCodeUsage(null);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [showReferenceDialog, referenceDraft.brand, referenceDraft.old_code]);

  useEffect(() => {
    if (!rows.length) {
      setSelectedCatalogProductId("");
      return;
    }
    if (selectedCatalogProductId && !rows.some((row) => row.product_id === selectedCatalogProductId)) {
      setSelectedCatalogProductId("");
    }
  }, [rows, selectedCatalogProductId]);

  useEffect(() => {
    setShowFullSelectedOem(false);
  }, [selectedCatalogProductId]);

  useEffect(() => {
    if (!selectedCatalogProductId) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (selectedCatalogPopupRef.current?.contains(target)) return;
      setSelectedCatalogProductId("");
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedCatalogProductId("");
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedCatalogProductId]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      writeCatalogCache(
          buildCatalogCacheSnapshot({
            brands,
            rows,
            drafts,
            search,
            submittedSearch,
            catalogBrand,
            submittedCatalogBrand,
            catalogSegment,
            submittedCatalogSegment,
            selectedCatalogProductId,
          }),
        );
    }, CATALOG_CACHE_WRITE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [brands, rows, drafts, search, submittedSearch, catalogBrand, submittedCatalogBrand, catalogSegment, submittedCatalogSegment, selectedCatalogProductId]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const flushCache = () => {
      writeCatalogCache(
          buildCatalogCacheSnapshot({
            brands,
            rows,
            drafts,
            search,
            submittedSearch,
            catalogBrand,
            submittedCatalogBrand,
            catalogSegment,
            submittedCatalogSegment,
            selectedCatalogProductId,
          }),
        );
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushCache();
      }
    };

    window.addEventListener("pagehide", flushCache);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushCache);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [brands, rows, drafts, search, submittedSearch, catalogBrand, submittedCatalogBrand, catalogSegment, submittedCatalogSegment, selectedCatalogProductId]);

  const hasMoreCatalogRows = rows.some((row) => row.has_more);
  const canPageCatalogBack = catalogPage > 1 && !loading;
  const canPageCatalogForward = hasMoreCatalogRows && !loading;
  const total = rows[0]?.total_count ?? (hasMoreCatalogRows || catalogPage > 1 ? -((catalogPage - 1) * CATALOG_PAGE_SIZE + rows.length) : rows.length);
  const hasApproximateTotal = total < 0;
  const visibleTotal = Math.abs(total);
  const trimmedSubmittedSearch = submittedSearch.trim();
  const hasSubmittedSearch = Boolean(trimmedSubmittedSearch);
  const hasSubmittedBrand = Boolean(submittedCatalogBrand);
  const hasSubmittedSegment = Boolean(submittedCatalogSegment);
  const hasSubmittedIntegrity = Boolean(submittedIntegrityFilter);
  const catalogCountLabel = loading
    ? t("catalog.search.countLoading")
    : !hasSubmittedSearch && !hasSubmittedBrand && !hasSubmittedSegment && !hasSubmittedIntegrity
      ? t("catalog.search.countPrompt")
    : hasSubmittedIntegrity && !hasSubmittedSearch && !hasSubmittedBrand && !hasSubmittedSegment
      ? t("catalog.search.countRows", { count: `${formatCount(visibleTotal)}${hasApproximateTotal ? "+" : ""}` })
    : hasSubmittedBrand && !hasSubmittedSearch && !hasSubmittedSegment
        ? t("catalog.search.countBrand", {
            brand: submittedCatalogBrand,
            count: `${formatCount(visibleTotal)}${hasApproximateTotal ? "+" : ""}`,
          })
        : hasSubmittedSegment && !hasSubmittedBrand && !hasSubmittedSearch
          ? t("catalog.search.countSegment", {
              segment: getSegmentLabel(submittedCatalogSegment),
              count: `${formatCount(visibleTotal)}${hasApproximateTotal ? "+" : ""}`,
            })
        : hasSubmittedBrand
          ? t("catalog.search.countMatchesBrand", {
              count: `${formatCount(visibleTotal)}${hasApproximateTotal ? "+" : ""}`,
              brand: submittedCatalogBrand,
              segment: hasSubmittedSegment ? ` / ${getSegmentLabel(submittedCatalogSegment)}` : "",
            })
          : t("catalog.search.countRows", { count: `${formatCount(visibleTotal)}${hasApproximateTotal ? "+" : ""}` });
  const originalNumberBrandMatches = useMemo(() => {
    if (!submittedSearch.trim() || !rows.length) return [];
    return Array.from(
      new Set(
        rows
          .filter((row) => matchesOriginalNumberSearch(row.oem_no || "", submittedSearch))
          .map((row) => String(row.brand || "").trim())
          .filter(Boolean),
      ),
    ).sort((left, right) => left.localeCompare(right));
  }, [rows, submittedSearch]);
  const brandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: t("catalog.common.newBrand") },
  ];
  const editableBrandOptions = brands.map((item) => ({ value: item.name, label: item.name }));
  const createBrandOptions = [
    ...editableBrandOptions,
    { value: "__new__", label: t("catalog.common.newBrand") },
  ];
  const selectedCatalogRow = useMemo(
    () => rows.find((row) => row.product_id === selectedCatalogProductId) || null,
    [rows, selectedCatalogProductId],
  );
  const selectedCatalogDraft = selectedCatalogRow ? drafts[selectedCatalogRow.product_id] || selectedCatalogRow : null;
  const selectedCatalogOemValues = useMemo(() => {
    return String(selectedCatalogDraft?.oem_no || "")
      .split(/\s*,\s*|\s*;\s*/g)
      .map((value) => value.trim())
      .filter(Boolean);
  }, [selectedCatalogDraft]);
  const visibleSelectedCatalogOemValues = showFullSelectedOem ? selectedCatalogOemValues : selectedCatalogOemValues.slice(0, 5);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!selectedCatalogRow) {
        if (!cancelled) setSelectedCatalogMedia([]);
        return;
      }
      const fallbackItems = selectedCatalogRow.image_url ? [{ src: selectedCatalogRow.image_url, label: t("catalog.common.product") }] : [];
      if (!cancelled) setSelectedCatalogMedia(fallbackItems);
      try {
        const items = await fetchCatalogProductMedia({
          brand: selectedCatalogRow.brand,
          code: selectedCatalogRow.product_code,
          imageUrl: selectedCatalogRow.image_url || "",
        });
        if (!cancelled && items.length) setSelectedCatalogMedia(items);
      } catch {
        if (!cancelled) setSelectedCatalogMedia(fallbackItems);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedCatalogRow]);

  function clearCatalogSearch() {
    setSearch("");
    setSubmittedSearch("");
    setCatalogBrand("");
    setSubmittedCatalogBrand("");
    setCatalogSegment("");
    setSubmittedCatalogSegment("");
    setIntegrityFilter("");
    setSubmittedIntegrityFilter("");
    setRows([]);
    setDrafts({});
    setPreviewSelection(null);
    setCatalogPage(1);
    setSelectedCatalogProductId("");
    setStatus("");
    setError("");
    setSearchingCatalog(false);
    actionFeedback.succeed(t("catalog.status.filtersCleared"));
  }

  function applyCatalogFilters(
    nextSearch: string,
    nextBrand: string,
    nextSegment = catalogSegment,
    announce = true,
    nextIntegrityFilter: CatalogIntegrityFilter = integrityFilter,
  ) {
    setSearchingCatalog(true);
    setPreviewSelection(null);
    setSelectedCatalogProductId("");
    setCatalogPage(1);
    if (announce) {
      actionFeedback.begin(
        t(isOnline ? "catalog.status.searchingCatalog" : "catalog.status.filteringCached", {
          brand: nextBrand || t("catalog.search.allBrandsLabel"),
          segment: getSegmentLabel(nextSegment),
          item: nextSearch.trim() || t("catalog.search.allItemsLabel"),
        }),
      );
    }
    setSubmittedSearch(nextSearch);
    setSubmittedCatalogBrand(nextBrand);
    setSubmittedCatalogSegment(normalizeCatalogMarketSegment(nextSegment) || "");
    setSubmittedIntegrityFilter(nextIntegrityFilter);
  }

  function queueCatalogItemForSalesOrder() {
    if (!selectedCatalogDraft) return;
    storeCatalogTransfer(PENDING_CATALOG_SALES_ITEM_KEY, {
      product_code: selectedCatalogDraft.product_code,
      requested_code: selectedCatalogDraft.replacement_old_code || selectedCatalogDraft.product_code,
      brand: selectedCatalogDraft.brand,
      description: selectedCatalogDraft.description || "",
      oem_no: selectedCatalogDraft.oem_no || "",
      hs_code: selectedCatalogDraft.hs_code || "",
      origin: selectedCatalogDraft.origin || "",
      market_segment: selectedCatalogDraft.market_segment || null,
      weight_kg: parseWeightInput(selectedCatalogDraft.weight_kg),
      lifecycle_status: selectedCatalogDraft.lifecycle_status || "active",
      lifecycle_note: selectedCatalogDraft.lifecycle_note || "",
      replacement_warning: selectedCatalogDraft.replacement_warning || "",
    });
    dispatchAppNavigation({ page: "Sales" });
    actionFeedback.succeed(t("catalog.status.sentToSalesOrder", { code: selectedCatalogDraft.product_code }));
  }

  function queueCatalogItemForPurchaseOrder() {
    if (!selectedCatalogDraft) return;
    storeCatalogTransfer(PENDING_CATALOG_PURCHASE_ITEM_KEY, {
      product_code: selectedCatalogDraft.product_code,
      requested_code: selectedCatalogDraft.replacement_old_code || selectedCatalogDraft.product_code,
      brand: selectedCatalogDraft.brand,
      description: selectedCatalogDraft.description || "",
      oem_no: selectedCatalogDraft.oem_no || "",
      hs_code: selectedCatalogDraft.hs_code || "",
      origin: selectedCatalogDraft.origin || "",
      market_segment: selectedCatalogDraft.market_segment || null,
      weight_kg: parseWeightInput(selectedCatalogDraft.weight_kg),
      lifecycle_status: selectedCatalogDraft.lifecycle_status || "active",
      lifecycle_note: selectedCatalogDraft.lifecycle_note || "",
      replacement_warning: selectedCatalogDraft.replacement_warning || "",
    });
    dispatchAppNavigation({ page: "Purchases" });
    actionFeedback.succeed(t("catalog.status.sentToPurchaseDraft", { code: selectedCatalogDraft.product_code }));
  }

  function patchCatalogDraft(row: CatalogRow, patch: Partial<CatalogRowDraft>) {
    setDrafts((current) => ({
      ...current,
      [row.product_id]: {
        ...buildCatalogRowDraft(row, current[row.product_id]),
        ...patch,
      },
    }));
  }

  async function saveCatalogRow(row: CatalogRow) {
    if (!isOnline) {
      setError(t("catalog.errors.connectToSave"));
      return;
    }
    const draft = drafts[row.product_id] || buildCatalogRowDraft(row);
    try {
      setError("");
      setStatus("");
      setRowActionKey(`save:${row.product_id}`);
      actionFeedback.begin(t("catalog.status.savingRow", { code: draft.product_code }));
        await updateCloudCatalogRow(row.product_id, {
          product_code: draft.product_code,
          brand: draft.brand,
          description: draft.description || null,
          oem_no: draft.oem_no || null,
          vehicle: draft.vehicle || null,
          hs_code: draft.hs_code || null,
          origin: draft.origin || null,
          market_segment: normalizeCatalogMarketSegment(draft.market_segment),
          weight_kg: parseWeightInput(draft.weight_kg),
          lifecycle_status: draft.lifecycle_status || "active",
          lifecycle_note: draft.lifecycle_note || null,
        });
      await reloadCatalog(submittedSearch, submittedCatalogBrand, submittedCatalogSegment);
      setStatus(t("catalog.status.rowSaved", { code: draft.product_code }));
      actionFeedback.succeed(t("catalog.status.rowSaved", { code: draft.product_code }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("catalog.errors.updateFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setRowActionKey("");
    }
  }

  async function deleteCatalogRow(row: CatalogRow) {
    if (!isOnline) {
      setError(t("catalog.errors.connectToDelete"));
      return;
    }
    if (!confirm(t("catalog.confirm.deleteRow", { code: row.product_code }))) return;
    try {
      setError("");
      setStatus("");
      setDeleteBlockSummary(null);
      setRowActionKey(`delete:${row.product_id}`);
      actionFeedback.begin(t("catalog.status.deletingRow", { code: row.product_code }));
      await deleteCloudCatalogRow(row.product_id);
      await reloadCatalog(submittedSearch, submittedCatalogBrand, submittedCatalogSegment);
      setSelectedCatalogProductId("");
      setStatus(t("catalog.status.rowDeleted", { code: row.product_code }));
      actionFeedback.succeed(t("catalog.status.rowDeleted", { code: row.product_code }));
    } catch (caught) {
      if (caught instanceof CatalogDeleteBlockedError) {
        setDeleteBlockSummary(caught.references);
        const message = t("catalog.errors.deleteBlocked");
        setError(message);
        actionFeedback.fail(message);
      } else {
        const message = caught instanceof Error ? caught.message : t("catalog.errors.deleteFailed");
        setError(message);
        actionFeedback.fail(message);
      }
    } finally {
      setRowActionKey("");
    }
  }

  async function deactivateCatalogRow(row: CatalogRow) {
    const draft = drafts[row.product_id] || buildCatalogRowDraft(row);
    try {
      setError("");
      setStatus("");
      setRowActionKey(`deactivate:${row.product_id}`);
      actionFeedback.begin(t("catalog.status.deactivatingRow", { code: row.product_code }));
      await updateCloudCatalogRow(row.product_id, {
        product_code: draft.product_code,
        brand: draft.brand,
        description: draft.description || null,
        oem_no: draft.oem_no || null,
        vehicle: draft.vehicle || null,
        hs_code: draft.hs_code || null,
        origin: draft.origin || null,
        market_segment: normalizeCatalogMarketSegment(draft.market_segment),
        weight_kg: parseWeightInput(draft.weight_kg),
        lifecycle_status: "discontinued",
        lifecycle_note: draft.lifecycle_note || null,
      });
      await reloadCatalog(submittedSearch, submittedCatalogBrand, submittedCatalogSegment);
      setStatus(t("catalog.status.rowDeactivated", { code: row.product_code }));
      actionFeedback.succeed(t("catalog.status.rowDeactivated", { code: row.product_code }));
      setDeleteBlockSummary(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("catalog.errors.updateFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setRowActionKey("");
    }
  }

  function openReferenceDialogForRow(row: CatalogRow) {
    if (!isOnline) {
      setError(t("catalog.errors.connectToReferences"));
      return;
    }
    const coverageKey = `${row.brand.trim().toLowerCase()}::${normalizePartCode(row.product_code)}`;
    const hasReference = (referenceCoverage[coverageKey] || 0) > 0;
    const draft = drafts[row.product_id] || buildCatalogRowDraft(row);
    setReferenceDraft({
      brand: draft.brand || row.brand || "",
      old_code: "",
      new_code: draft.product_code || row.product_code || "",
      original_number: draft.oem_no || row.oem_no || "",
      reason: hasReference ? t("catalog.reference.reasonExisting") : t("catalog.reference.reasonReplacement"),
    });
    setError("");
    setStatus("");
    setShowReferenceDialog(true);
  }

  function renderReferenceOldCodeHint(usage: CodeReferenceUsage | null) {
    if (!usage) return null;
    if (usage.matchesOldCode.length) {
      const linked = usage.matchesOldCode[0];
      return (
        <div className="warning-text">
          {t("catalog.reference.oldCodeMappedPrefix")} <strong>{linked.new_code}</strong>.
        </div>
      );
    }
    if (usage.matchesNewCode.length) {
      const linked = usage.matchesNewCode[0];
      return (
        <div className="warning-text">
          {t("catalog.reference.currentCodeAlreadyUsedPrefix")} <strong>{linked.old_code}</strong>.
        </div>
      );
    }
    return null;
  }

  const columns = useMemo(
    () => [
      {
        key: "image",
        header: t("catalog.table.image"),
        render: (row: CatalogRow) => (
          <ProductVisual
            imageUrl={row.image_url}
            brand={drafts[row.product_id]?.brand ?? row.brand}
            alt={row.product_code}
            onPreview={
              row.image_url
                ? () =>
                    setPreviewImage({
                      src: row.image_url || "",
                      code: row.product_code,
                      name: row.description || "",
                    })
                : null
            }
          />
        ),
      },
      {
        key: "code",
        header: t("catalog.common.code"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--code">
            <strong className="catalog-code">{drafts[row.product_id]?.product_code ?? row.product_code}</strong>
          </div>
        ),
      },
      {
        key: "brand",
        header: t("catalog.common.brand"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-brand-badge">{drafts[row.product_id]?.brand ?? row.brand}</span>
          </div>
        ),
      },
      {
        key: "segment",
        header: t("catalog.common.segment"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-segment-badge">
              {getSegmentLabel(drafts[row.product_id]?.market_segment ?? row.market_segment)}
            </span>
          </div>
        ),
      },
      {
        key: "name",
        header: t("catalog.common.name"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <strong className="catalog-name">{drafts[row.product_id]?.description ?? row.description ?? "-"}</strong>
            {row.replacement_warning ? <span className="catalog-inline-flag">{t("catalog.table.replacementMapped")}</span> : null}
            {row.lifecycle_status === "discontinued" && row.lifecycle_note ? <span className="catalog-inline-flag catalog-inline-flag--danger">{row.lifecycle_note}</span> : null}
          </div>
        ),
      },
      {
        key: "oem",
        header: t("catalog.common.oem"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <span className="catalog-mono catalog-clip">{drafts[row.product_id]?.oem_no ?? row.oem_no ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "vehicle",
        header: t("catalog.common.vehicle"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <VehicleBadges value={drafts[row.product_id]?.vehicle ?? row.vehicle ?? ""} limit={3} expandable />
          </div>
        ),
      },
      {
        key: "hs",
        header: t("catalog.common.hs"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-mono">{drafts[row.product_id]?.hs_code ?? row.hs_code ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "origin",
        header: t("catalog.common.origin"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-origin-chip">{drafts[row.product_id]?.origin ?? row.origin ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "weight",
        header: t("catalog.common.weight"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-mono">{String(drafts[row.product_id]?.weight_kg ?? row.weight_kg ?? "-")}</span>
          </div>
        ),
      },
      {
        key: "lifecycle",
        header: t("catalog.common.lifecycle"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className={`catalog-state-badge ${(drafts[row.product_id]?.lifecycle_status ?? row.lifecycle_status ?? "active") === "discontinued" ? "is-danger" : "is-live"}`}>
              {getLifecycleLabel(drafts[row.product_id]?.lifecycle_status ?? row.lifecycle_status ?? "active")}
            </span>
          </div>
        ),
      },
      {
        key: "lifecycleNote",
        header: t("catalog.common.lifecycleNote"),
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <span className="catalog-clip">{drafts[row.product_id]?.lifecycle_note ?? row.lifecycle_note ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "ref",
        header: t("catalog.table.ref"),
        render: (row: CatalogRow) => {
          const key = `${row.brand.trim().toLowerCase()}::${normalizePartCode(row.product_code)}`;
          const count = referenceCoverage[key] || 0;
          return <span className={count ? "status-badge status-badge--success" : "status-badge"}>{count ? t("catalog.table.mappedCount", { count }) : "-"}</span>;
        },
      },
      {
        key: "integrity",
        header: t("catalog.integrity.column"),
        render: (row: CatalogRow) => (
          <span className={`catalog-state-badge ${getIntegrityTone(row.integrity_status)}`}>
            {getIntegrityLabel(row.integrity_status)}
          </span>
        ),
      },
      {
        key: "actions",
        header: t("catalog.table.actions"),
        render: (row: CatalogRow) => (
          <div className="inline-actions">
            <Button
              variant="secondary"
              className="button--compact"
              onClick={() => setSelectedCatalogProductId((current) => (current === row.product_id ? "" : row.product_id))}
            >
              {selectedCatalogProductId === row.product_id ? t("catalog.actions.close") : t("catalog.actions.inspect")}
            </Button>
          </div>
        ),
      },
    ],
    [drafts, referenceCoverage, selectedCatalogProductId, t, locale],
  );

  async function reloadCatalog(nextSearch = submittedSearch, nextBrand = submittedCatalogBrand, nextSegment = submittedCatalogSegment) {
    if (!isOnline) {
      const cached = readCatalogCache();
      const cachedRows = cached?.rows || [];
      setRows(filterCachedCatalogRows(cachedRows, nextSearch, nextBrand, nextSegment));
      setError("");
      setStatus(t("catalog.status.offlineCachedData"));
      return;
    }
    setLoading(true);
    setError("");
    setStatus("");
    try {
      const normalizedSearch = normalizePartCode(nextSearch);
      const shouldTryDirectCodeLookup =
        Boolean(nextBrand) &&
        normalizedSearch.length >= 5 &&
        /\d/.test(nextSearch) &&
        !nextSearch.includes(",");

      if (shouldTryDirectCodeLookup) {
        const directRows = await fetchCatalogRowsByCodes({
          brandName: nextBrand,
          codes: [nextSearch],
          marketSegment: nextSegment,
        });
        if (directRows.length) {
          setRows(directRows);
          return;
        }
      }

      const result = await fetchCloudCatalogIntegrity({
        search: nextSearch,
        brandName: nextBrand,
        marketSegment: nextSegment,
        integrityFilter: submittedIntegrityFilter,
        page: catalogPage,
        pageSize: CATALOG_PAGE_SIZE,
      });
      setRows(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("catalog.errors.requestFailed"));
      setStatus(t("catalog.status.requestFailedKeepingResults"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCatalogImport(file: File) {
    if (!isOnline) {
      setError(t("catalog.errors.connectToImport"));
      return;
    }
    setLoading(true);
    setError("");
    setStatus("");
    setCatalogImportSummary(null);
    setImportingCatalog(true);
    try {
      const text = await file.text();
      const parsedRows = parseCsv(text);
      const [header = [], ...dataRows] = parsedRows;
      const indexOfAny = (...names: string[]) =>
        header.findIndex((cell) => {
          const value = cell.trim().toLowerCase();
          return names.some((name) => value === name.toLowerCase());
        });

      const codeIndex = indexOfAny("Product_Code", "Part_No", "Code");
      const brandIndex = indexOfAny("Brand");
      const nameIndex = indexOfAny("Product_Name", "Name", "Description");
      const oemIndex = indexOfAny("OEM_No", "OEM", "Original_Number");
      const hsIndex = indexOfAny("HS_Code", "HS", "GTIP");
      const vehicleIndex = indexOfAny("Vehicle", "Vehicles", "Fit_Vehicles", "Fit Vehicles", "Applications");
      const originIndex = indexOfAny("Origin", "Country_Of_Origin");
      const segmentIndex = indexOfAny("Market_Segment", "Market Segment", "Segment", "Catalog_Segment");
      const weightIndex = indexOfAny("Weight_kg", "Weight", "Net_Weight");
      const imageUrlIndex = indexOfAny("Image_URL", "Image Url", "Image");
      const lifecycleStatusIndex = indexOfAny("Lifecycle_Status", "Lifecycle");
      const lifecycleNoteIndex = indexOfAny("Lifecycle_Note", "Lifecycle Note", "Discontinued_Note", "Discontinued Note");
      const selectedImportBrand = importBrand === "__new__" ? importBrandName.trim() : importBrand.trim();
      const selectedImportSegment = normalizeCatalogMarketSegment(importCatalogSegment);
      const rowBrands = dataRows.map((row) => normalizeText(row[brandIndex]) ?? "");
      const rowSegments = dataRows.map((row) => normalizeCatalogMarketSegment(normalizeText(row[segmentIndex]) || "") || "");
      const detectedBrands = Array.from(
        new Set(
          rowBrands
            .filter((value) => value.length > 0)
            .map((value) => value.toLowerCase()),
        ),
      );
      const detectedSegments = Array.from(new Set(rowSegments.filter(Boolean)));
      const activeImportBrand =
        selectedImportBrand ||
        (detectedBrands.length === 1
          ? rowBrands.find((value) => value.length > 0) || ""
          : "");
      const activeImportSegment =
        selectedImportSegment ||
        (detectedSegments.length === 1
          ? detectedSegments[0] || ""
          : "");

      if (!activeImportBrand) {
        throw new Error(t("catalog.errors.importBrandRequired"));
      }
      if (!activeImportSegment) {
        throw new Error(t("catalog.errors.importSegmentRequired"));
      }

      actionFeedback.begin(t("catalog.status.importingForBrand", { brand: activeImportBrand }));

      const payload = dataRows
        .map((row) => ({
          product_code: normalizeText(row[codeIndex]),
          brand: normalizeText(row[brandIndex]) || activeImportBrand || "Unbranded",
          description: normalizeText(row[nameIndex]),
          oem_no: normalizeText(row[oemIndex]),
          vehicle: normalizeText(row[vehicleIndex]),
          hs_code: normalizeText(row[hsIndex]),
          origin: normalizeText(row[originIndex]),
          market_segment: normalizeCatalogMarketSegment(normalizeText(row[segmentIndex]) || activeImportSegment) || activeImportSegment,
          weight_kg: normalizeNumber(row[weightIndex]),
          image_url: normalizeText(row[imageUrlIndex]),
          lifecycle_status: normalizeCatalogLifecycleStatus(normalizeText(row[lifecycleStatusIndex])),
          lifecycle_note: normalizeText(row[lifecycleNoteIndex]),
        }))
        .filter((row) => Object.values(row).some((value) => value != null && String(value).trim().length > 0));

      if (!payload.length) {
        throw new Error(t("catalog.errors.noValidImportRows"));
      }

      const importedCodes = Array.from(
        new Set(
          payload
            .map((row) => row.product_code ?? "")
            .filter((code) => code.length > 0),
        ),
      );

      const importResult = await bulkImportCatalog(payload, {
        brandName: activeImportBrand,
        marketSegment: activeImportSegment,
        onProgress: ({ processedChunks, totalChunks, processedRows, totalRows }) => {
          setStatus(
            `Catalog import running for ${activeImportBrand}: ${processedRows}/${totalRows} rows (${processedChunks}/${totalChunks} batches).`,
          );
        },
      });
      setCatalogImportSummary(importResult);

      const summaryText = `Catalog import ${importResult.finalized ? "finalized" : "validated"} for ${activeImportBrand}. ` +
        `${importResult.insertCount.toLocaleString("en-US")} inserted, ${importResult.updateCount.toLocaleString("en-US")} updated, ` +
        `${importResult.skipCount.toLocaleString("en-US")} skipped, ${importResult.errorCount.toLocaleString("en-US")} errors, ` +
        `${importResult.conflictCount.toLocaleString("en-US")} conflicts.`;

      if (!importResult.finalized) {
        const blockedMessage = importResult.message || "Catalog import validation failed. Finalize is blocked.";
        setError(blockedMessage);
        setStatus(`${summaryText} Finalize blocked.`);
        actionFeedback.fail(blockedMessage);
        return;
      }

      const refreshedBrands = await fetchCloudBrands();
      setBrands(refreshedBrands);
      const matchedBrand = refreshedBrands.find((item) => item.name.trim().toLowerCase() === activeImportBrand.trim().toLowerCase());
      const refreshedBrandName = matchedBrand?.name ?? activeImportBrand;
      if (matchedBrand) {
        setImportBrand(matchedBrand.name);
        setImportBrandName(matchedBrand.name);
      } else {
        setImportBrand(activeImportBrand);
        setImportBrandName(activeImportBrand);
      }
      setPreviewSelection({
        brand: refreshedBrandName,
        codes: importedCodes,
      });
      setCatalogBrand(refreshedBrandName);
      setSubmittedCatalogBrand(refreshedBrandName);
      setCatalogSegment(activeImportSegment);
      setSubmittedCatalogSegment(activeImportSegment);
      setImportCatalogSegment(activeImportSegment);
      setSearch("");
      setSubmittedSearch("");
      setExportBrand(refreshedBrandName);
      const importedRows = await fetchCatalogRowsByCodes({
        brandName: refreshedBrandName,
        codes: importedCodes,
        marketSegment: activeImportSegment,
      });
      setRows(importedRows);
      setDrafts({});
      setShowImportDialog(false);
      setImportFile(null);
      setStatus(`${summaryText} Showing imported codes for review.`);
      actionFeedback.succeed(`Catalog import finalized for ${activeImportBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("catalog.errors.importFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setLoading(false);
      setImportingCatalog(false);
    }
  }

  function openCatalogExport(format: CatalogExportFormat) {
    setExportFormat(format);
    setShowExportDialog(true);
  }

  function buildCatalogExportName(format: CatalogExportFormat) {
    const brandSlug = exportBrand
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `catalog-${brandSlug || "export"}.${format}`;
  }

  async function handleCatalogExport() {
    if (!isOnline) {
      setError(t("catalog.errors.connectToExport"));
      return;
    }
    if (!exportBrand) {
      setError(t("catalog.errors.exportBrandRequired"));
      return;
    }

    setExportingCatalog(true);
    setError("");
    setStatus("");
    const exportLabel = getExportFormatLabel(exportFormat);
    actionFeedback.begin(t("catalog.status.preparingExport", { format: exportLabel, brand: exportBrand }));

    try {
      const exportData = await fetchCatalogExportRows({ brandName: exportBrand, marketSegment: catalogSegment || undefined });
      const exportRows = [
        ["Product_Code", "Brand", "Product_Name", "OEM_No", "Vehicle", "HS_Code", "Origin", "Market_Segment", "Weight_kg", "Image_URL", "Lifecycle_Status", "Lifecycle_Note"],
        ...exportData.map((row) => [
          row.product_code,
          row.brand,
          row.description || "",
          row.oem_no || "",
          row.vehicle || "",
          row.hs_code || "",
          row.origin || "",
          row.market_segment || "",
          row.weight_kg ?? "",
          row.image_url || "",
          row.lifecycle_status || "active",
          row.lifecycle_note || "",
        ]),
      ];
      if (exportFormat === "xlsx") {
        const sheetName = `${exportBrand} Catalog`.slice(0, 31) || "Catalog";
        downloadBlob(buildCatalogExportName("xlsx"), buildXlsxBlob(sheetName, exportRows, [8]));
      } else {
        downloadCsv(buildCatalogExportName("csv"), toCsv(exportRows));
      }
      setShowExportDialog(false);
      setStatus(t("catalog.status.exportDownloaded", { format: exportLabel, brand: exportBrand }));
      actionFeedback.succeed(t("catalog.status.exportDownloaded", { format: exportLabel, brand: exportBrand }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("catalog.errors.exportFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setExportingCatalog(false);
    }
  }

  async function handleSyncSelectedBrand() {
    if (!isOnline) {
      const message = t("catalog.errors.connectToSync");
      setError(message);
      actionFeedback.fail(message);
      return;
    }
    if (!catalogBrand.trim()) {
      const message = t("catalog.errors.selectBrandFirst");
      setError(message);
      actionFeedback.fail(message);
      return;
    }

    setSyncingBrandCatalog(true);
    setError("");
    setStatus("");
    actionFeedback.begin(t("catalog.status.resyncingBrand", { brand: catalogBrand }));

    try {
      const result = await syncBrandCatalog(catalogBrand, true);
      const sourceNote = result.fallbackUsed
        ? t("catalog.status.syncFallbackSource", {
            preferred: result.preferredProviderLabel,
            current: result.executionProviderLabel,
          })
        : t("catalog.status.syncSource", { source: result.executionProviderLabel });
      setStatus(
        t("catalog.status.syncSummary", {
          brand: result.targetBrandName,
          synced: formatCount(result.resolvedRows),
          newRows: formatCount(result.newRowsInListing),
          discontinued: formatCount(result.discontinuedRows),
          replacements: formatCount(result.replacementRows),
          errors: formatCount(result.errorRows),
          sourceNote,
        }),
      );
      actionFeedback.succeed(
        t("catalog.status.syncComplete", {
          brand: result.targetBrandName,
          rows: formatCount(result.resolvedRows),
          replacements: formatCount(result.replacementRows),
        }),
      );
      applyCatalogFilters(search, catalogBrand, catalogSegment, false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("catalog.errors.syncFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setSyncingBrandCatalog(false);
    }
  }

  return (
    <PageShell className="catalog-page">
      <PageHeader
        eyebrow={t("catalog.search.eyebrow")}
        title={t("catalog.search.title")}
        subtitle={t("catalog.search.description")}
        actions={
          <Button
            onClick={() => {
              setCreateDraft((current) => ({ ...current, market_segment: catalogSegment }));
              setShowCreateDialog(true);
            }}
            disabled={!isOnline}
          >
            {t("catalog.actions.addNewItem")}
          </Button>
        }
      />

      <CompactFilterBar className="catalog-filter-bar">
            <Select
              value={catalogBrand}
              options={[{ value: "", label: t("catalog.search.allBrands") }, ...editableBrandOptions]}
              onChange={(value) => {
                setCatalogBrand(value);
                if (value || search.trim() || catalogSegment) {
                  applyCatalogFilters(search, value, catalogSegment);
                  return;
                }
                clearCatalogSearch();
              }}
            />
            <Select
              value={catalogSegment}
              options={[{ value: "", label: t("catalog.search.allSegments") }, ...segmentOptions]}
              onChange={(value) => {
                setCatalogSegment(value);
                if (value || search.trim() || catalogBrand) {
                  applyCatalogFilters(search, catalogBrand, value);
                  return;
                }
                clearCatalogSearch();
              }}
            />
            <Select
              value={integrityFilter}
              options={integrityFilterOptions}
              onChange={(value) => {
                const nextFilter = value as CatalogIntegrityFilter;
                setIntegrityFilter(nextFilter);
                if (nextFilter || search.trim() || catalogBrand || catalogSegment) {
                  applyCatalogFilters(search, catalogBrand, catalogSegment, true, nextFilter);
                  return;
                }
                clearCatalogSearch();
              }}
            />
            <Input value={search} onChange={setSearch} placeholder={t("catalog.search.placeholder")} onEnter={() => applyCatalogFilters(search, catalogBrand, catalogSegment)} />
            <Button
              onClick={() => {
                applyCatalogFilters(search, catalogBrand, catalogSegment);
              }}
              busy={searchingCatalog}
              busyLabel={isOnline ? t("catalog.actions.searching") : t("catalog.actions.filtering")}
            >
              {t("catalog.actions.search")}
            </Button>
            <Button variant="secondary" onClick={clearCatalogSearch} disabled={!search && !submittedSearch && !catalogBrand && !submittedCatalogBrand && !catalogSegment && !submittedCatalogSegment && !integrityFilter && !submittedIntegrityFilter && !rows.length}>
              {t("catalog.actions.clearSearch")}
            </Button>
      </CompactFilterBar>

      <details className="catalog-secondary-actions">
        <summary>{t("common.actions")}</summary>
        <PageActions>
            <Button variant="secondary" onClick={() => openCatalogExport("csv")} disabled={!brands.length || !isOnline} busy={exportingCatalog && exportFormat === "csv"} busyLabel={t("catalog.actions.preparing")}>
              {t("catalog.actions.exportCsv")}
            </Button>
            <Button variant="secondary" onClick={() => openCatalogExport("xlsx")} disabled={!brands.length || !isOnline} busy={exportingCatalog && exportFormat === "xlsx"} busyLabel={t("catalog.actions.preparing")}>
              {t("catalog.actions.exportExcel")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setImportCatalogSegment(catalogSegment);
                setCatalogImportSummary(null);
                setShowImportDialog(true);
              }}
              disabled={!isOnline}
            >
              {t("catalog.actions.importCsv")}
            </Button>
            {catalogBrand ? (
              <Button variant="secondary" onClick={() => void handleSyncSelectedBrand()} disabled={!isOnline} busy={syncingBrandCatalog} busyLabel={t("catalog.actions.resyncing")}>
                {t("catalog.actions.resync")}
              </Button>
            ) : null}
        </PageActions>
      </details>

      <section className="section-card catalog-workbench catalog-results-card">
        <div className="section-card__body section-card__body--catalog">
          <div className="catalog-integrity-heading">
            <div>
              <strong>{t("catalog.integrity.title")}</strong>
              <span>{t("catalog.integrity.clearDefinition")}</span>
            </div>
            <Button variant="secondary" className="button--compact" onClick={() => void refreshIntegritySummary()} busy={integritySummaryLoading}>
              {t("catalog.integrity.refresh")}
            </Button>
          </div>
          {integritySummary?.initialization_state === "not_initialized" ? <div className="warning-text">{t("catalog.integrity.notInitialized")}</div> : null}
          {integritySummary?.initialization_state === "partial" ? <div className="warning-text">{t("catalog.integrity.partial")}</div> : null}
          {integritySummary?.initialization_state === "running" ? (
            <div className="operations-subtle">
              {t("catalog.integrity.runningProgress", {
                processed: formatCount(integritySummary.projected_products),
                total: integritySummary.total_products == null ? "—" : formatCount(integritySummary.total_products),
              })}
            </div>
          ) : null}
          {integritySummary?.initialization_state === "failed" ? <div className="error-text">{integritySummary.backfill_error || t("catalog.integrity.syncFailed")}</div> : null}
          <div className="metric-strip catalog-integrity-summary">
            <div className="metric-tile metric-tile--info"><span className="metric-tile__label">{t("catalog.integrity.total")}</span><strong className="metric-tile__value">{formatIntegrityCount(integritySummary?.total_products)}</strong></div>
            <div className="metric-tile metric-tile--success"><span className="metric-tile__label">{t("catalog.integrity.clear")}</span><strong className="metric-tile__value">{formatIntegrityCount(integritySummary?.clear_count)}</strong></div>
            <div className="metric-tile metric-tile--warning"><span className="metric-tile__label">{t("catalog.integrity.incomplete")}</span><strong className="metric-tile__value">{formatIntegrityCount(integritySummary?.incomplete_count)}</strong></div>
            <div className="metric-tile metric-tile--danger"><span className="metric-tile__label">{t("catalog.integrity.conflict")}</span><strong className="metric-tile__value">{formatIntegrityCount(integritySummary?.conflict_count)}</strong></div>
            <div className="metric-tile metric-tile--info"><span className="metric-tile__label">{t("catalog.integrity.pending")}</span><strong className="metric-tile__value">{formatIntegrityCount(integritySummary?.pending_count)}</strong></div>
            <div className="metric-tile metric-tile--danger"><span className="metric-tile__label">{t("catalog.integrity.failed")}</span><strong className="metric-tile__value">{formatIntegrityCount(integritySummary?.failed_count)}</strong></div>
          </div>
          <div className="meta-row catalog-meta-strip">
            <span>{catalogCountLabel}</span>
            {(hasSubmittedSearch || hasSubmittedBrand || hasSubmittedSegment || hasSubmittedIntegrity) && rows.length ? (
              <span className="toolbar toolbar--compact">
                <Button variant="secondary" className="button--compact" onClick={() => setCatalogPage((page) => Math.max(1, page - 1))} disabled={!canPageCatalogBack}>
                  {t("catalog.search.previousPage")}
                </Button>
                <span>{t("catalog.search.page", { page: String(catalogPage) })}</span>
                <Button variant="secondary" className="button--compact" onClick={() => setCatalogPage((page) => page + 1)} disabled={!canPageCatalogForward}>
                  {t("catalog.search.nextPage")}
                </Button>
              </span>
            ) : null}
            {integritySummary?.last_evaluated_at ? <span>{t("catalog.integrity.lastEvaluation")}: <strong>{new Date(integritySummary.last_evaluated_at).toLocaleString(locale)}</strong></span> : null}
            {originalNumberBrandMatches.length ? (
              <span>
                {t("catalog.search.originalNoBrands")}: <strong>{originalNumberBrandMatches.join(", ")}</strong>
              </span>
            ) : null}
            {status ? <span className="success-text">{status}</span> : null}
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          {!isOnline ? <div className="warning-text">{t("catalog.search.offlineWarning")}</div> : null}
          <div className="workbench-main-layout catalog-workbench-layout">
            <div className="workbench-main-layout__table">
              <DataTable
                wrapClassName="table-wrap--catalog"
                className="data-table--catalog"
                rows={rows}
                columns={columns}
                emptyText={loading ? t("catalog.empty.loading") : !submittedSearch.trim() && !submittedCatalogBrand && !submittedCatalogSegment && !submittedIntegrityFilter ? t("catalog.empty.prompt") : t("catalog.empty.noProducts")}
                onRowClick={(row) => setSelectedCatalogProductId((current) => (current === row.product_id ? "" : row.product_id))}
                rowClassName={(row) => (row.product_id === selectedCatalogProductId ? "data-table__row--active" : "")}
              />
            </div>
          </div>
        </div>
      </section>

      {selectedCatalogRow && selectedCatalogDraft ? (
        <DraggableSurface className="catalog-selected-popup" ref={selectedCatalogPopupRef} dragHandleSelector=".draggable-surface__handle">
        <div className="workbench-detail-panel workbench-detail-panel--catalog">
            <div className="toolbar toolbar--wrap workbench-detail-panel__dragbar draggable-surface__handle">
              <span className="workbench-detail-panel__eyebrow">{t("catalog.detail.selectedItem")}</span>
              <Button variant="secondary" className="button--compact" onClick={() => setSelectedCatalogProductId("")}>
                {t("catalog.actions.close")}
              </Button>
            </div>
            <div className="workbench-detail-panel__media">
              <ProductVisual
                imageUrl={selectedCatalogRow.image_url}
                imageGallery={selectedCatalogMedia}
                brand={selectedCatalogDraft.brand}
                alt={selectedCatalogDraft.product_code}
                detail
                onPreview={
                  selectedCatalogMedia.length || selectedCatalogRow.image_url
                    ? (item) =>
                        setPreviewImage({
                          src: item?.src || selectedCatalogRow.image_url || "",
                          code: selectedCatalogDraft.product_code,
                          name: selectedCatalogDraft.description || "",
                        })
                    : null
                }
              />
            </div>
            <div className="catalog-integrity-detail">
              <span className={`catalog-state-badge ${getIntegrityTone(selectedCatalogRow.integrity_status)}`}>
                {getIntegrityLabel(selectedCatalogRow.integrity_status)}
              </span>
              {selectedCatalogRow.conflict_fields?.length ? <span>{t("catalog.integrity.affectedFields")}: {selectedCatalogRow.conflict_fields.join(", ")}</span> : null}
              {selectedCatalogRow.critical_missing_fields?.length ? <span>{t("catalog.integrity.missingFields")}: {selectedCatalogRow.critical_missing_fields.join(", ")}</span> : null}
              {selectedCatalogRow.optional_missing_fields?.includes("ean") ? <span>{t("catalog.integrity.missingEan")}</span> : null}
              {selectedCatalogRow.integrity_last_error ? <span className="error-text">{selectedCatalogRow.integrity_last_error}</span> : null}
            </div>
            <div className="workbench-detail-panel__title">{selectedCatalogDraft.product_code}</div>
            <div className="document-marks document-marks--compact">
              <span className="mark-badge">{selectedCatalogDraft.brand || t("catalog.detail.noBrand")}</span>
              <span className="mark-badge">{getSegmentLabel(selectedCatalogDraft.market_segment)}</span>
              {selectedCatalogDraft.replacement_warning ? <span className="mark-badge mark-badge--accent">{t("catalog.detail.replacement")}</span> : null}
              <span className={`mark-badge ${selectedCatalogDraft.lifecycle_status === "discontinued" ? "mark-badge--danger" : "mark-badge--success"}`}>
                {getLifecycleLabel(selectedCatalogDraft.lifecycle_status || "active")}
              </span>
            </div>
            <div className="catalog-detail-editor">
              <Input
                label={t("catalog.common.code")}
                value={selectedCatalogDraft.product_code || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { product_code: value })}
              />
              <Select
                label={t("catalog.common.brand")}
                value={selectedCatalogDraft.brand || selectedCatalogRow.brand || ""}
                options={editableBrandOptions}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { brand: value })}
              />
              <Select
                label={t("catalog.common.marketSegment")}
                value={selectedCatalogDraft.market_segment || selectedCatalogRow.market_segment || ""}
                options={segmentOptions}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { market_segment: normalizeCatalogMarketSegment(value) })}
              />
              <Select
                label={t("catalog.common.lifecycle")}
                value={selectedCatalogDraft.lifecycle_status || "active"}
                options={lifecycleOptions.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { lifecycle_status: normalizeCatalogLifecycleStatus(value) })}
              />
              <Input
                label={t("catalog.common.weight")}
                value={String(selectedCatalogDraft.weight_kg ?? "")}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { weight_kg: value })}
              />
              <Input
                label={t("catalog.common.description")}
                value={selectedCatalogDraft.description || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { description: value })}
              />
              <Input
                label={t("catalog.common.oem")}
                value={selectedCatalogDraft.oem_no || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { oem_no: value })}
              />
              <Input
                label={t("catalog.common.vehicle")}
                value={selectedCatalogDraft.vehicle || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { vehicle: value })}
              />
              <Input
                label={t("catalog.common.lifecycleNote")}
                value={selectedCatalogDraft.lifecycle_note || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { lifecycle_note: value })}
              />
              <Input
                label={t("catalog.common.hs")}
                value={selectedCatalogDraft.hs_code || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { hs_code: value })}
              />
              <Input
                label={t("catalog.common.origin")}
                value={selectedCatalogDraft.origin || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { origin: value })}
              />
            </div>
            <div className="workbench-detail-list">
              <div><span>{t("catalog.common.description")}</span><strong>{selectedCatalogDraft.description || "-"}</strong></div>
              <div>
                <span>{t("catalog.common.oem")}</span>
                <strong className="catalog-detail-list-text">
                  {visibleSelectedCatalogOemValues.length ? visibleSelectedCatalogOemValues.join(", ") : "-"}
                  {selectedCatalogOemValues.length > 5 ? (
                    <button
                      type="button"
                      className="catalog-detail-expand"
                      onClick={() => setShowFullSelectedOem((current) => !current)}
                    >
                      {showFullSelectedOem ? t("catalog.actions.less") : "..."}
                    </button>
                  ) : null}
                </strong>
              </div>
              <div><span>{t("catalog.common.segment")}</span><strong>{getSegmentLabel(selectedCatalogDraft.market_segment)}</strong></div>
              <div>
                <span>{t("catalog.common.vehicle")}</span>
                <strong className="catalog-detail-list-text">
                  <VehicleBadges value={selectedCatalogDraft.vehicle || ""} limit={5} expandable />
                </strong>
              </div>
              <div><span>{t("catalog.common.hs")}</span><strong>{selectedCatalogDraft.hs_code || "-"}</strong></div>
              <div><span>{t("catalog.common.origin")}</span><strong>{selectedCatalogDraft.origin || "-"}</strong></div>
              <div><span>{t("catalog.common.weight")}</span><strong>{selectedCatalogDraft.weight_kg ?? "-"}</strong></div>
              <div><span>{t("catalog.detail.referenceLinks")}</span><strong>{referenceCoverage[`${selectedCatalogRow.brand.trim().toLowerCase()}::${normalizePartCode(selectedCatalogRow.product_code)}`] || 0}</strong></div>
              {selectedCatalogDraft.replacement_warning ? <div><span>{t("catalog.detail.replacement")}</span><strong>{selectedCatalogDraft.replacement_warning}</strong></div> : null}
            </div>
            <div className="toolbar toolbar--wrap">
              <Button
                variant="secondary"
                onClick={() => void saveCatalogRow(selectedCatalogRow)}
                disabled={!isOnline || !selectedCatalogDraft.market_segment}
                busy={rowActionKey === `save:${selectedCatalogRow.product_id}`}
                busyLabel={t("catalog.actions.saving")}
              >
                {t("catalog.actions.saveChanges")}
              </Button>
              <Button
                variant="secondary"
                className="danger-button"
                onClick={() => void deleteCatalogRow(selectedCatalogRow)}
                disabled={!isOnline}
                busy={rowActionKey === `delete:${selectedCatalogRow.product_id}`}
                busyLabel={t("catalog.actions.deleting")}
              >
                {t("catalog.actions.deleteItem")}
              </Button>
              {deleteBlockSummary?.length && selectedCatalogRow.lifecycle_status !== "discontinued" ? (
                <Button
                  variant="secondary"
                  onClick={() => void deactivateCatalogRow(selectedCatalogRow)}
                  disabled={!isOnline}
                  busy={rowActionKey === `deactivate:${selectedCatalogRow.product_id}`}
                  busyLabel={t("catalog.actions.deactivating")}
                >
                  {t("catalog.actions.deactivateInstead")}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => openReferenceDialogForRow(selectedCatalogRow)} disabled={!isOnline}>
                {(() => {
                  const coverageKey = `${selectedCatalogRow.brand.trim().toLowerCase()}::${normalizePartCode(selectedCatalogRow.product_code)}`;
                  return (referenceCoverage[coverageKey] || 0) > 0 ? t("catalog.actions.editReference") : t("catalog.actions.addReference");
                })()}
              </Button>
              <Button variant="secondary" onClick={queueCatalogItemForSalesOrder}>
                {t("catalog.actions.addToSalesOrder")}
              </Button>
              <Button variant="secondary" onClick={queueCatalogItemForPurchaseOrder}>
                {t("catalog.actions.addToPurchaseDraft")}
              </Button>
            </div>
            {deleteBlockSummary?.length ? (
              <div className="info-text">
                <strong>{t("catalog.detail.deleteBlockedTitle")}</strong>
                <ul>
                  {deleteBlockSummary.map((item) => (
                    <li key={item.key}>
                      {item.label} ({item.count})
                    </li>
                  ))}
                </ul>
                <div>{t("catalog.detail.deleteBlockedHint")}</div>
              </div>
            ) : null}
            {selectedCatalogDraft.lifecycle_note ? <div className="info-text">{selectedCatalogDraft.lifecycle_note}</div> : null}
          </div>
        </DraggableSurface>
      ) : null}

      {showImportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
	            <div className="modal-card__header draggable-surface__handle">
	              <div>
	                <h3>{t("catalog.import.title")}</h3>
	                <p>{t("catalog.import.description")}</p>
	              </div>
	            </div>
            <div className="modal-form-grid">
              <Select
	                label={t("catalog.common.brand")}
                value={importBrand}
                options={brandOptions}
                onChange={(value) => {
                  setImportBrand(value);
                  if (value !== "__new__") {
                    setImportBrandName(value);
                  } else {
                    setImportBrandName("");
                  }
                }}
              />
              <Select
	                label={t("catalog.common.marketSegment")}
	                value={importCatalogSegment}
	                options={[{ value: "", label: t("catalog.import.selectSegment") }, ...segmentOptions]}
                onChange={setImportCatalogSegment}
              />
              <Input
	                label={t("catalog.common.brandName")}
                value={importBrandName}
                onChange={setImportBrandName}
                disabled={importBrand !== "__new__"}
              />
	              <Input label={t("catalog.import.target")} value={t("catalog.import.cloudTarget")} onChange={() => undefined} disabled />
	              <label className="field">
	                <span className="field__label">{t("catalog.common.file")}</span>
                <input
                  className="field__input"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    setCatalogImportSummary(null);
                    setImportFile(event.target.files?.[0] ?? null);
                  }}
                />
              </label>
	              <Input label={t("catalog.common.selectedFile")} value={importFile?.name ?? ""} onChange={() => undefined} disabled />
	            </div>
	            <div className="modal-hint">{t("catalog.import.hint")}</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
	                onClick={() => {
	                  downloadCatalogTemplate();
	                  actionFeedback.succeed(t("catalog.import.sampleTemplateDownloaded"));
	                }}
	              >
	                {t("catalog.import.downloadSampleTemplate")}
	              </Button>
              <Button
                variant="secondary"
                className="button--compact"
	                onClick={() => {
	                  downloadCatalogLifecycleTemplate();
	                  actionFeedback.succeed(t("catalog.import.lifecycleTemplateDownloaded"));
	                }}
	              >
	                {t("catalog.import.downloadLifecycleTemplate")}
	              </Button>
            </div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowImportDialog(false);
                  setImportFile(null);
                  setImportBrand("");
                  setImportBrandName("");
                  setImportCatalogSegment("");
                  setCatalogImportSummary(null);
                }}
              >
	                {t("catalog.actions.cancelImport")}
	              </Button>
              <Button
                onClick={() => {
                  if (importFile) void handleCatalogImport(importFile);
                }}
	                disabled={!importFile || loading || (importBrand === "__new__" && !importBrandName.trim())}
	                busy={importingCatalog}
	                busyLabel={t("catalog.actions.importing")}
	              >
	                {t("catalog.actions.import")}
	              </Button>
            </div>
            {catalogImportSummary ? (
              <div className="info-text">
                <strong>{catalogImportSummary.finalized ? "Finalize summary" : "Validation summary"}</strong>
                <ul>
                  <li>Total rows: {formatCount(catalogImportSummary.totalRows)}</li>
                  <li>Insert: {formatCount(catalogImportSummary.insertCount)}</li>
                  <li>Update: {formatCount(catalogImportSummary.updateCount)}</li>
                  <li>Skip: {formatCount(catalogImportSummary.skipCount)}</li>
                  <li>Error: {formatCount(catalogImportSummary.errorCount)}</li>
                  <li>Conflict: {formatCount(catalogImportSummary.conflictCount)}</li>
                </ul>
                <div>
                  {catalogImportSummary.finalized
                    ? "Catalog import finalized successfully."
                    : catalogImportSummary.message || "Validation errors detected. Finalize is blocked."}
                </div>
              </div>
            ) : null}
          </DraggableSurface>
        </div>
      ) : null}

      {showExportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
	            <div className="modal-card__header draggable-surface__handle">
	              <div>
	                <h3>{t("catalog.export.title", { format: getExportFormatLabel(exportFormat) })}</h3>
	                <p>{t("catalog.export.description", { format: getExportFormatLabel(exportFormat) })}</p>
	              </div>
	            </div>
	            <div className="modal-form-grid">
	              <Select label={t("catalog.common.brand")} value={exportBrand} options={editableBrandOptions} onChange={setExportBrand} />
	              <Input label={t("catalog.export.scope")} value={t("catalog.export.allItemsForBrand")} onChange={() => undefined} disabled />
	            </div>
	            <div className="modal-hint">{t("catalog.export.hint")}</div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowExportDialog(false);
                  setExportBrand("");
                }}
              >
	                {t("catalog.actions.cancel")}
	              </Button>
	              <Button onClick={() => void handleCatalogExport()} disabled={!exportBrand} busy={exportingCatalog} busyLabel={t("catalog.actions.preparing")}>
	                {t("catalog.export.exportFormat", { format: getExportFormatLabel(exportFormat) })}
	              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {showCreateDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
	            <div className="modal-card__header draggable-surface__handle">
	              <div>
	                <h3>{t("catalog.create.title")}</h3>
	                <p>{t("catalog.create.description")}</p>
	              </div>
	            </div>
	            <div className="modal-form-grid">
	              <Input label={t("catalog.common.productCode")} value={createDraft.product_code} onChange={(value) => setCreateDraft((current) => ({ ...current, product_code: value }))} />
	              <Select
	                label={t("catalog.common.brand")}
                value={createDraft.brand}
                options={createBrandOptions}
                onChange={(value) =>
                  setCreateDraft((current) => ({
                    ...current,
                    brand: value,
                    brand_name: value === "__new__" ? "" : value,
                  }))
                }
              />
	              <Select
	                label={t("catalog.common.marketSegment")}
	                value={createDraft.market_segment}
	                options={segmentOptions}
                onChange={(value) => setCreateDraft((current) => ({ ...current, market_segment: value }))}
              />
              <Input
	                label={t("catalog.common.brandName")}
                value={createDraft.brand_name}
                onChange={(value) => setCreateDraft((current) => ({ ...current, brand_name: value }))}
                disabled={createDraft.brand !== "__new__"}
              />
	              <Input label={t("catalog.common.productName")} value={createDraft.description} onChange={(value) => setCreateDraft((current) => ({ ...current, description: value }))} />
	              <Input label={t("catalog.common.oem")} value={createDraft.oem_no} onChange={(value) => setCreateDraft((current) => ({ ...current, oem_no: value }))} />
	              <Input label={t("catalog.common.vehicle")} value={createDraft.vehicle} onChange={(value) => setCreateDraft((current) => ({ ...current, vehicle: value }))} />
	              <Input label={t("catalog.common.hsCode")} value={createDraft.hs_code} onChange={(value) => setCreateDraft((current) => ({ ...current, hs_code: value }))} />
	              <Input label={t("catalog.common.origin")} value={createDraft.origin} onChange={(value) => setCreateDraft((current) => ({ ...current, origin: value }))} />
	              <Input label={t("catalog.common.weight")} value={createDraft.weight_kg} onChange={(value) => setCreateDraft((current) => ({ ...current, weight_kg: value }))} />
	              <Select
	                label={t("catalog.common.lifecycle")}
                value={createDraft.lifecycle_status}
                options={lifecycleOptions}
                onChange={(value) => setCreateDraft((current) => ({ ...current, lifecycle_status: value }))}
              />
	              <Input label={t("catalog.common.lifecycleNote")} value={createDraft.lifecycle_note} onChange={(value) => setCreateDraft((current) => ({ ...current, lifecycle_note: value }))} />
	            </div>
	            <div className="modal-hint">{t("catalog.create.hint")}</div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShowCreateDialog(false)}>
	                {t("catalog.actions.cancel")}
              </Button>
              <Button
                onClick={async () => {
	                  if (!isOnline) {
	                    setError(t("catalog.errors.connectToCreate"));
	                    return;
	                  }
                  try {
                    setError("");
	                    setStatus("");
	                    setCreatingItem(true);
	                    actionFeedback.begin(t("catalog.status.creatingItem", { code: createDraft.product_code.trim() }));
                    const activeBrand = createDraft.brand === "__new__" ? createDraft.brand_name.trim() : createDraft.brand;
                    await createCloudCatalogRow({
                      product_code: createDraft.product_code.trim(),
                      brand: activeBrand,
                      description: createDraft.description.trim() || null,
                      oem_no: createDraft.oem_no.trim() || null,
                      vehicle: createDraft.vehicle.trim() || null,
                      hs_code: createDraft.hs_code.trim() || null,
                      origin: createDraft.origin.trim() || null,
                      market_segment: normalizeCatalogMarketSegment(createDraft.market_segment),
                      weight_kg: parseWeightInput(createDraft.weight_kg),
                      lifecycle_status: createDraft.lifecycle_status,
                      lifecycle_note: createDraft.lifecycle_note.trim() || null,
                    });
                    setCreateDraft({
                      product_code: "",
                      brand: "",
                      brand_name: "",
                      description: "",
                      oem_no: "",
                      vehicle: "",
                      hs_code: "",
                      origin: "",
                      market_segment: "",
                      weight_kg: "",
                      lifecycle_status: "active",
                      lifecycle_note: "",
                    });
                    const refreshedBrands = await fetchCloudBrands();
                    setBrands(refreshedBrands);
                    setShowCreateDialog(false);
                    await reloadCatalog(submittedSearch, submittedCatalogBrand, submittedCatalogSegment);
	                    setStatus(t("catalog.status.itemCreated"));
	                    actionFeedback.succeed(t("catalog.status.itemCreatedWithCode", { code: createDraft.product_code.trim() }));
	                  } catch (caught) {
	                    const message = caught instanceof Error ? caught.message : t("catalog.errors.createFailed");
                    setError(message);
                    actionFeedback.fail(message);
                  } finally {
                    setCreatingItem(false);
                  }
                }}
                disabled={
                  !isOnline ||
                  !createDraft.product_code.trim() ||
                  !createDraft.brand ||
                  !createDraft.market_segment ||
                  (createDraft.brand === "__new__" && !createDraft.brand_name.trim())
                }
	                busy={creatingItem}
	                busyLabel={t("catalog.actions.creating")}
	              >
	                {t("catalog.actions.createItem")}
	              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {showReferenceDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
	            <div className="modal-card__header draggable-surface__handle">
	              <div>
	                <h3>{t("catalog.reference.title")}</h3>
	                <p>{t("catalog.reference.description")}</p>
	              </div>
	            </div>
	            <div className="modal-form-grid">
	              <Select
	                label={t("catalog.common.brand")}
                value={referenceDraft.brand}
                options={editableBrandOptions}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, brand: value }))}
              />
	              <Input
	                label={t("catalog.reference.oldCode")}
                value={referenceDraft.old_code}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, old_code: value }))}
              />
	              <Input label={t("catalog.reference.newCode")} value={referenceDraft.new_code} onChange={() => undefined} disabled />
	              <Input
	                label={t("catalog.reference.originalNumber")}
                value={referenceDraft.original_number}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, original_number: value }))}
              />
	              <Input label={t("catalog.reference.reason")} value={referenceDraft.reason} onChange={(value) => setReferenceDraft((current) => ({ ...current, reason: value }))} />
	            </div>
	            {renderReferenceOldCodeHint(referenceOldCodeUsage)}
	            <div className="modal-hint">{t("catalog.reference.hint")}</div>
	            <div className="modal-actions">
	              <Button variant="secondary" onClick={() => setShowReferenceDialog(false)}>
	                {t("catalog.actions.cancel")}
	              </Button>
              <Button
	                onClick={async () => {
	                  if (!isOnline) {
	                    setError(t("catalog.errors.connectToSaveReference"));
	                    return;
	                  }
                  try {
                    setError("");
	                    setStatus("");
	                    setSavingReference(true);
	                    actionFeedback.begin(t("catalog.status.savingReference", { code: referenceDraft.old_code.trim() }));
                    await createCodeReference({
                      brand: referenceDraft.brand,
                      old_code: referenceDraft.old_code.trim(),
                      new_code: referenceDraft.new_code.trim(),
                      original_number: referenceDraft.original_number.trim() || null,
                      reason: referenceDraft.reason.trim() || null,
                    });
                    setReferenceCoverage((current) => {
                      const key = `${referenceDraft.brand.trim().toLowerCase()}::${normalizePartCode(referenceDraft.new_code)}`;
                      return {
                        ...current,
                        [key]: (current[key] || 0) + 1,
                      };
                    });
                    setStatus(
	                      t("catalog.status.referenceSaved", {
	                        oldCode: referenceDraft.old_code.trim(),
	                        newCode: referenceDraft.new_code.trim(),
	                      }),
	                    );
	                    setShowReferenceDialog(false);
	                    actionFeedback.succeed(t("catalog.status.referenceSavedForOldCode", { code: referenceDraft.old_code.trim() }));
	                  } catch (caught) {
	                    const message = caught instanceof Error ? caught.message : t("catalog.errors.referenceCreateFailed");
	                    if (message.includes("item_code_references_organization_id_brand_id_normalized_ol_key")) {
	                      setError(t("catalog.errors.duplicateReference"));
	                    } else {
                      setError(message);
                    }
                    actionFeedback.fail(message);
                  } finally {
                    setSavingReference(false);
                  }
                }}
	                disabled={!isOnline || !referenceDraft.brand || !referenceDraft.old_code.trim() || !referenceDraft.new_code.trim()}
	                busy={savingReference}
	                busyLabel={t("catalog.actions.saving")}
	              >
	                {t("catalog.actions.saveReference")}
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
	                <p>{previewImage.name || t("catalog.preview.imageFallback")}</p>
              </div>
            </div>
            <div className="image-preview-wrap">
              <img src={previewImage.src} alt={previewImage.code} className="image-preview" />
            </div>
            <div className="modal-actions">
	              <Button variant="secondary" onClick={() => setPreviewImage(null)}>
	                {t("catalog.actions.close")}
	              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}
    </PageShell>
  );
}
