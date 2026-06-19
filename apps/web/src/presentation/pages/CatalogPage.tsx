import { useEffect, useMemo, useRef, useState } from "react";
import { CATALOG_MARKET_SEGMENT_OPTIONS, formatCatalogMarketSegmentLabel, normalizeCatalogMarketSegment } from "../../domain/shared/catalogSegments";
import { normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { syncBrandCatalog } from "../../infrastructure/api/adminApi";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { createCloudCatalogRow, deleteCloudCatalogRow, fetchCatalogExportRows, fetchCatalogRowsByCodes, fetchCloudCatalog, updateCloudCatalogRow } from "../../infrastructure/api/catalogApi";
import { fetchCatalogProductMedia } from "../../infrastructure/api/catalogMediaApi";
import { createCodeReference, fetchCatalogReferenceCoverage, inspectCodeReferenceUsage } from "../../infrastructure/api/codeReferencesApi";
import { bulkImportCatalog } from "../../infrastructure/api/importApi";
import { matchesOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";
import type { BrandOption } from "../../types/brand";
import type { CatalogRow } from "../../types/catalog";
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

const CATALOG_CACHE_KEY = "next-master-catalog-cache";
const CATALOG_CACHE_WRITE_DELAY_MS = 250;

type CatalogRowDraft = Omit<CatalogRow, "weight_kg"> & {
  weight_kg: number | string | null;
};

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
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showReferenceDialog, setShowReferenceDialog] = useState(false);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [catalogBrand, setCatalogBrand] = useState("");
  const [submittedCatalogBrand, setSubmittedCatalogBrand] = useState("");
  const [catalogSegment, setCatalogSegment] = useState("");
  const [submittedCatalogSegment, setSubmittedCatalogSegment] = useState("");
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
  const [importingCatalog, setImportingCatalog] = useState(false);
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
  const lifecycleOptions = [
    { value: "active", label: "Active" },
    { value: "discontinued", label: "Discontinued" },
  ];

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
      setStatus("Offline mode active. Showing cached catalog data.");
      setError("");
    }
  }, [isOnline]);

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
                ? `Offline mode active. Showing ${offlineRows.length.toLocaleString("en-US")} cached catalog row(s).`
                : "Offline mode active. No cached catalog rows match this filter.",
            );
          }
        }
        return;
      }

      if (!submittedSearch.trim() && !submittedCatalogBrand && !submittedCatalogSegment) {
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
            : await fetchCloudCatalog({
                search: submittedSearch,
                brandName: submittedCatalogBrand,
                marketSegment: submittedCatalogSegment,
                page: 1,
                pageSize: 50,
              });
        if (!cancelled) setRows(result);
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          setError(caught instanceof Error ? caught.message : "Catalog request failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [isOnline, submittedSearch, submittedCatalogBrand, submittedCatalogSegment, previewSelection]);

  useEffect(() => {
    if (!searchingCatalog || loading) return;
    const rawTotal = rows[0]?.total_count ?? rows.length;
    const nextTotal = Math.abs(rawTotal) || rows.length;
    const totalLabel = `${nextTotal.toLocaleString("en-US")}${rawTotal < 0 ? "+" : ""}`;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(`${totalLabel} catalog rows loaded.`);
    }
    setSearchingCatalog(false);
  }, [searchingCatalog, loading, error, rows, actionFeedback]);

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

  const total = rows[0]?.total_count ?? 0;
  const hasApproximateTotal = total < 0;
  const visibleTotal = Math.abs(total);
  const trimmedSubmittedSearch = submittedSearch.trim();
  const hasSubmittedSearch = Boolean(trimmedSubmittedSearch);
  const hasSubmittedBrand = Boolean(submittedCatalogBrand);
  const hasSubmittedSegment = Boolean(submittedCatalogSegment);
  const catalogCountLabel = loading
    ? "Loading catalog..."
    : !hasSubmittedSearch && !hasSubmittedBrand && !hasSubmittedSegment
      ? "Select a brand, segment, or search to load catalog."
    : hasSubmittedBrand && !hasSubmittedSearch && !hasSubmittedSegment
        ? `${submittedCatalogBrand}: ${visibleTotal.toLocaleString("en-US")}${hasApproximateTotal ? "+" : ""} items`
        : hasSubmittedSegment && !hasSubmittedBrand && !hasSubmittedSearch
          ? `${formatCatalogMarketSegmentLabel(submittedCatalogSegment)}: ${visibleTotal.toLocaleString("en-US")}${hasApproximateTotal ? "+" : ""} items`
        : hasSubmittedBrand
          ? `${visibleTotal.toLocaleString("en-US")} matches in ${submittedCatalogBrand}${hasSubmittedSegment ? ` / ${formatCatalogMarketSegmentLabel(submittedCatalogSegment)}` : ""}`
          : `${visibleTotal.toLocaleString("en-US")} catalog rows`;
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
    { value: "__new__", label: "New brand..." },
  ];
  const editableBrandOptions = brands.map((item) => ({ value: item.name, label: item.name }));
  const createBrandOptions = [
    ...editableBrandOptions,
    { value: "__new__", label: "New brand..." },
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
      const fallbackItems = selectedCatalogRow.image_url ? [{ src: selectedCatalogRow.image_url, label: "Product" }] : [];
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
    setRows([]);
    setDrafts({});
    setPreviewSelection(null);
    setSelectedCatalogProductId("");
    setStatus("");
    setError("");
    setSearchingCatalog(false);
    actionFeedback.succeed("Catalog filters cleared.");
  }

  function applyCatalogFilters(nextSearch: string, nextBrand: string, nextSegment = catalogSegment, announce = true) {
    setSearchingCatalog(true);
    setPreviewSelection(null);
    setSelectedCatalogProductId("");
    if (announce) {
      actionFeedback.begin(
        `${isOnline ? "Searching" : "Filtering cached"} catalog for ${nextBrand || "all brands"} / ${formatCatalogMarketSegmentLabel(nextSegment)} / ${nextSearch.trim() || "all items"}...`,
      );
    }
    setSubmittedSearch(nextSearch);
    setSubmittedCatalogBrand(nextBrand);
    setSubmittedCatalogSegment(normalizeCatalogMarketSegment(nextSegment) || "");
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
    actionFeedback.succeed(`${selectedCatalogDraft.product_code} sent to Sales Order Workbench.`);
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
    actionFeedback.succeed(`${selectedCatalogDraft.product_code} sent to Purchase Order draft.`);
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
      setError("Connect to the internet to save catalog changes.");
      return;
    }
    const draft = drafts[row.product_id] || buildCatalogRowDraft(row);
    try {
      setError("");
      setStatus("");
      setRowActionKey(`save:${row.product_id}`);
      actionFeedback.begin(`Saving catalog row ${draft.product_code}...`);
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
      setStatus(`Catalog row ${draft.product_code} saved.`);
      actionFeedback.succeed(`Catalog row ${draft.product_code} saved.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Catalog update failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setRowActionKey("");
    }
  }

  async function deleteCatalogRow(row: CatalogRow) {
    if (!isOnline) {
      setError("Connect to the internet to delete catalog rows.");
      return;
    }
    if (!confirm(`Delete ${row.product_code} from catalog?`)) return;
    try {
      setError("");
      setStatus("");
      setRowActionKey(`delete:${row.product_id}`);
      actionFeedback.begin(`Deleting catalog row ${row.product_code}...`);
      await deleteCloudCatalogRow(row.product_id);
      await reloadCatalog(submittedSearch, submittedCatalogBrand, submittedCatalogSegment);
      setSelectedCatalogProductId("");
      setStatus(`Catalog row ${row.product_code} deleted.`);
      actionFeedback.succeed(`Catalog row ${row.product_code} deleted.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Catalog delete failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setRowActionKey("");
    }
  }

  function openReferenceDialogForRow(row: CatalogRow) {
    if (!isOnline) {
      setError("Connect to the internet to create or edit code references.");
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
      reason: hasReference ? "Update existing replacement mapping" : "Supplier changed / replacement code",
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
          This old customer code already has a mapping to <strong>{linked.new_code}</strong>.
        </div>
      );
    }
    if (usage.matchesNewCode.length) {
      const linked = usage.matchesNewCode[0];
      return (
        <div className="warning-text">
          This code is already used as a current valid code. Old code for it is <strong>{linked.old_code}</strong>.
        </div>
      );
    }
    return null;
  }

  const columns = useMemo(
    () => [
      {
        key: "image",
        header: "Image",
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
        header: "Code",
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--code">
            <strong className="catalog-code">{drafts[row.product_id]?.product_code ?? row.product_code}</strong>
          </div>
        ),
      },
      {
        key: "brand",
        header: "Brand",
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-brand-badge">{drafts[row.product_id]?.brand ?? row.brand}</span>
          </div>
        ),
      },
      {
        key: "segment",
        header: "Segment",
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-segment-badge">
              {formatCatalogMarketSegmentLabel(drafts[row.product_id]?.market_segment ?? row.market_segment)}
            </span>
          </div>
        ),
      },
      {
        key: "name",
        header: "Name",
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <strong className="catalog-name">{drafts[row.product_id]?.description ?? row.description ?? "-"}</strong>
            {row.replacement_warning ? <span className="catalog-inline-flag">Replacement mapped</span> : null}
            {row.lifecycle_status === "discontinued" && row.lifecycle_note ? <span className="catalog-inline-flag catalog-inline-flag--danger">{row.lifecycle_note}</span> : null}
          </div>
        ),
      },
      {
        key: "oem",
        header: "OEM",
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <span className="catalog-mono catalog-clip">{drafts[row.product_id]?.oem_no ?? row.oem_no ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "vehicle",
        header: "Vehicle",
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <VehicleBadges value={drafts[row.product_id]?.vehicle ?? row.vehicle ?? ""} limit={3} expandable />
          </div>
        ),
      },
      {
        key: "hs",
        header: "HS",
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-mono">{drafts[row.product_id]?.hs_code ?? row.hs_code ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "origin",
        header: "Origin",
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-origin-chip">{drafts[row.product_id]?.origin ?? row.origin ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "weight",
        header: "Weight",
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className="catalog-mono">{String(drafts[row.product_id]?.weight_kg ?? row.weight_kg ?? "-")}</span>
          </div>
        ),
      },
      {
        key: "lifecycle",
        header: "Lifecycle",
        render: (row: CatalogRow) => (
          <div className="catalog-cell">
            <span className={`catalog-state-badge ${(drafts[row.product_id]?.lifecycle_status ?? row.lifecycle_status ?? "active") === "discontinued" ? "is-danger" : "is-live"}`}>
              {drafts[row.product_id]?.lifecycle_status ?? row.lifecycle_status ?? "active"}
            </span>
          </div>
        ),
      },
      {
        key: "lifecycleNote",
        header: "Lifecycle Note",
        render: (row: CatalogRow) => (
          <div className="catalog-cell catalog-cell--stack">
            <span className="catalog-clip">{drafts[row.product_id]?.lifecycle_note ?? row.lifecycle_note ?? "-"}</span>
          </div>
        ),
      },
      {
        key: "ref",
        header: "Ref",
        render: (row: CatalogRow) => {
          const key = `${row.brand.trim().toLowerCase()}::${normalizePartCode(row.product_code)}`;
          const count = referenceCoverage[key] || 0;
          return <span className={count ? "status-badge status-badge--success" : "status-badge"}>{count ? `Mapped (${count})` : "-"}</span>;
        },
      },
      {
        key: "actions",
        header: "Actions",
        render: (row: CatalogRow) => (
          <div className="inline-actions">
            <Button
              variant="secondary"
              className="button--compact"
              onClick={() => setSelectedCatalogProductId((current) => (current === row.product_id ? "" : row.product_id))}
            >
              {selectedCatalogProductId === row.product_id ? "Close" : "Inspect"}
            </Button>
          </div>
        ),
      },
    ],
    [drafts, referenceCoverage, selectedCatalogProductId],
  );

  async function reloadCatalog(nextSearch = submittedSearch, nextBrand = submittedCatalogBrand, nextSegment = submittedCatalogSegment) {
    if (!isOnline) {
      const cached = readCatalogCache();
      const cachedRows = cached?.rows || [];
      setRows(filterCachedCatalogRows(cachedRows, nextSearch, nextBrand, nextSegment));
      setError("");
      setStatus("Offline mode active. Showing cached catalog data.");
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

      const result = await fetchCloudCatalog({
        search: nextSearch,
        brandName: nextBrand,
        marketSegment: nextSegment,
        page: 1,
        pageSize: 50,
      });
      setRows(result);
    } catch (caught) {
      setRows([]);
      setError(caught instanceof Error ? caught.message : "Catalog request failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleCatalogImport(file: File) {
    if (!isOnline) {
      setError("Connect to the internet to import catalog data.");
      return;
    }
    setLoading(true);
    setError("");
    setStatus("");
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
        throw new Error("Catalog import requires a single brand selection or a single brand in the file");
      }
      if (!activeImportSegment) {
        throw new Error("Catalog import requires a market segment selection or a single segment in the file");
      }

      actionFeedback.begin(`Importing catalog CSV for ${activeImportBrand}...`);

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
        .filter((row) => row.product_code);

      if (!payload.length) {
        throw new Error("CSV did not contain any valid catalog rows");
      }

      const importedCodes = Array.from(
        new Set(
          payload
            .map((row) => row.product_code ?? "")
            .filter((code) => code.length > 0),
        ),
      );

      await bulkImportCatalog(payload);
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
      setStatus(`Catalog import completed for ${activeImportBrand}. Showing imported codes for review.`);
      actionFeedback.succeed(`Catalog import completed for ${activeImportBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Catalog import failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setLoading(false);
      setImportingCatalog(false);
    }
  }

  async function handleCatalogExport() {
    if (!isOnline) {
      setError("Connect to the internet to export catalog data.");
      return;
    }
    if (!exportBrand) {
      setError("Catalog export requires a brand selection");
      return;
    }

    setExportingCatalog(true);
    setError("");
    setStatus("");
    actionFeedback.begin(`Preparing catalog CSV export for ${exportBrand}...`);

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
      downloadCsv(`catalog-${exportBrand.toLowerCase().replace(/\s+/g, "-")}.csv`, toCsv(exportRows));
      setShowExportDialog(false);
      setStatus(`Catalog CSV downloaded for ${exportBrand}.`);
      actionFeedback.succeed(`Catalog CSV downloaded for ${exportBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Catalog export failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setExportingCatalog(false);
    }
  }

  async function handleSyncSelectedBrand() {
    if (!isOnline) {
      const message = "Connect to the internet to re-synch brand catalog data.";
      setError(message);
      actionFeedback.fail(message);
      return;
    }
    if (!catalogBrand.trim()) {
      const message = "Select a brand first.";
      setError(message);
      actionFeedback.fail(message);
      return;
    }

    setSyncingBrandCatalog(true);
    setError("");
    setStatus("");
    actionFeedback.begin(`Re-Synching ${catalogBrand}...`);

    try {
      const result = await syncBrandCatalog(catalogBrand, true);
      const sourceNote = result.fallbackUsed
        ? ` Preferred source: ${result.preferredProviderLabel}. Current inline sync fallback: ${result.executionProviderLabel}.`
        : ` Source: ${result.executionProviderLabel}.`;
      setStatus(
        `${result.targetBrandName}: ${result.resolvedRows.toLocaleString("en-US")} synced, ${result.newRowsInListing.toLocaleString("en-US")} new, ${result.discontinuedRows.toLocaleString("en-US")} discontinued, ${result.replacementRows.toLocaleString("en-US")} replacements, ${result.errorRows.toLocaleString("en-US")} errors.${sourceNote}`,
      );
      actionFeedback.succeed(
        `${result.targetBrandName}: ${result.resolvedRows.toLocaleString("en-US")} catalog rows synced, ${result.replacementRows.toLocaleString("en-US")} replacement links processed.`,
      );
      applyCatalogFilters(search, catalogBrand, catalogSegment, false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Brand catalog sync failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setSyncingBrandCatalog(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="section-card search-focus-card search-focus-card--admin catalog-workbench">
        <div className="section-card__header section-card__header--row">
          <div>
            <span className="search-focus-card__eyebrow">Admin Search</span>
            <h2 className="search-focus-card__title">Catalog Search</h2>
            <p>Connected to live catalog data.</p>
          </div>
          <div className="toolbar toolbar--wrap catalog-command-bar">
            <Select
              value={catalogBrand}
              options={[{ value: "", label: "All Brands" }, ...editableBrandOptions]}
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
              options={[{ value: "", label: "All Segments" }, ...CATALOG_MARKET_SEGMENT_OPTIONS]}
              onChange={(value) => {
                setCatalogSegment(value);
                if (value || search.trim() || catalogBrand) {
                  applyCatalogFilters(search, catalogBrand, value);
                  return;
                }
                clearCatalogSearch();
              }}
            />
            <Input value={search} onChange={setSearch} placeholder="Search catalog" onEnter={() => applyCatalogFilters(search, catalogBrand, catalogSegment)} />
            <Button
              onClick={() => {
                applyCatalogFilters(search, catalogBrand, catalogSegment);
              }}
              busy={searchingCatalog}
              busyLabel={isOnline ? "Searching..." : "Filtering..."}
            >
              Search
            </Button>
            <Button variant="secondary" onClick={clearCatalogSearch} disabled={!search && !submittedSearch && !catalogBrand && !submittedCatalogBrand && !catalogSegment && !submittedCatalogSegment && !rows.length}>
              Clear Search
            </Button>
            <Button variant="secondary" onClick={() => setShowExportDialog(true)} disabled={!brands.length || !isOnline} busy={exportingCatalog} busyLabel="Preparing...">
              Export CSV
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setCreateDraft((current) => ({ ...current, market_segment: catalogSegment }));
                setShowCreateDialog(true);
              }}
              disabled={!isOnline}
            >
              Add New Item
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setImportCatalogSegment(catalogSegment);
                setShowImportDialog(true);
              }}
              disabled={!isOnline}
            >
              Import CSV
            </Button>
            {catalogBrand ? (
              <Button variant="secondary" onClick={() => void handleSyncSelectedBrand()} disabled={!isOnline} busy={syncingBrandCatalog} busyLabel="Re-Synching...">
                Re-Synch
              </Button>
            ) : null}
          </div>
        </div>
        <div className="section-card__body section-card__body--catalog">
          <div className="meta-row catalog-meta-strip">
            <span>{catalogCountLabel}</span>
            {originalNumberBrandMatches.length ? (
              <span>
                Original No Brands: <strong>{originalNumberBrandMatches.join(", ")}</strong>
              </span>
            ) : null}
            {status ? <span className="success-text">{status}</span> : null}
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          {!isOnline ? <div className="warning-text">Offline mode active. Search works only on cached catalog data. Save, import, export, delete, and re-synch require internet.</div> : null}
          <div className="workbench-main-layout catalog-workbench-layout">
            <div className="workbench-main-layout__table">
              <DataTable
                wrapClassName="table-wrap--catalog"
                className="data-table--catalog"
                rows={rows}
                columns={columns}
                emptyText={loading ? "Loading..." : !submittedSearch.trim() && !submittedCatalogBrand && !submittedCatalogSegment ? "Select a brand, segment, or search to load catalog." : "No products found"}
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
              <span className="workbench-detail-panel__eyebrow">Selected Item</span>
              <Button variant="secondary" className="button--compact" onClick={() => setSelectedCatalogProductId("")}>
                Close
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
            <div className="workbench-detail-panel__title">{selectedCatalogDraft.product_code}</div>
            <div className="document-marks document-marks--compact">
              <span className="mark-badge">{selectedCatalogDraft.brand || "No brand"}</span>
              <span className="mark-badge">{formatCatalogMarketSegmentLabel(selectedCatalogDraft.market_segment)}</span>
              {selectedCatalogDraft.replacement_warning ? <span className="mark-badge mark-badge--accent">Replacement</span> : null}
              <span className={`mark-badge ${selectedCatalogDraft.lifecycle_status === "discontinued" ? "mark-badge--danger" : "mark-badge--success"}`}>
                {selectedCatalogDraft.lifecycle_status || "active"}
              </span>
            </div>
            <div className="catalog-detail-editor">
              <Input
                label="Code"
                value={selectedCatalogDraft.product_code || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { product_code: value })}
              />
              <Select
                label="Brand"
                value={selectedCatalogDraft.brand || selectedCatalogRow.brand || ""}
                options={editableBrandOptions}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { brand: value })}
              />
              <Select
                label="Market Segment"
                value={selectedCatalogDraft.market_segment || selectedCatalogRow.market_segment || ""}
                options={CATALOG_MARKET_SEGMENT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { market_segment: normalizeCatalogMarketSegment(value) })}
              />
              <Select
                label="Lifecycle"
                value={selectedCatalogDraft.lifecycle_status || "active"}
                options={lifecycleOptions.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { lifecycle_status: normalizeCatalogLifecycleStatus(value) })}
              />
              <Input
                label="Weight"
                value={String(selectedCatalogDraft.weight_kg ?? "")}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { weight_kg: value })}
              />
              <Input
                label="Description"
                value={selectedCatalogDraft.description || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { description: value })}
              />
              <Input
                label="OEM"
                value={selectedCatalogDraft.oem_no || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { oem_no: value })}
              />
              <Input
                label="Vehicle"
                value={selectedCatalogDraft.vehicle || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { vehicle: value })}
              />
              <Input
                label="Lifecycle Note"
                value={selectedCatalogDraft.lifecycle_note || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { lifecycle_note: value })}
              />
              <Input
                label="HS"
                value={selectedCatalogDraft.hs_code || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { hs_code: value })}
              />
              <Input
                label="Origin"
                value={selectedCatalogDraft.origin || ""}
                onChange={(value) => patchCatalogDraft(selectedCatalogRow, { origin: value })}
              />
            </div>
            <div className="workbench-detail-list">
              <div><span>Description</span><strong>{selectedCatalogDraft.description || "-"}</strong></div>
              <div>
                <span>OEM</span>
                <strong className="catalog-detail-list-text">
                  {visibleSelectedCatalogOemValues.length ? visibleSelectedCatalogOemValues.join(", ") : "-"}
                  {selectedCatalogOemValues.length > 5 ? (
                    <button
                      type="button"
                      className="catalog-detail-expand"
                      onClick={() => setShowFullSelectedOem((current) => !current)}
                    >
                      {showFullSelectedOem ? "Less" : "..."}
                    </button>
                  ) : null}
                </strong>
              </div>
              <div><span>Segment</span><strong>{formatCatalogMarketSegmentLabel(selectedCatalogDraft.market_segment)}</strong></div>
              <div>
                <span>Vehicle</span>
                <strong className="catalog-detail-list-text">
                  <VehicleBadges value={selectedCatalogDraft.vehicle || ""} limit={5} expandable />
                </strong>
              </div>
              <div><span>HS</span><strong>{selectedCatalogDraft.hs_code || "-"}</strong></div>
              <div><span>Origin</span><strong>{selectedCatalogDraft.origin || "-"}</strong></div>
              <div><span>Weight</span><strong>{selectedCatalogDraft.weight_kg ?? "-"}</strong></div>
              <div><span>Reference Links</span><strong>{referenceCoverage[`${selectedCatalogRow.brand.trim().toLowerCase()}::${normalizePartCode(selectedCatalogRow.product_code)}`] || 0}</strong></div>
              {selectedCatalogDraft.replacement_warning ? <div><span>Replacement</span><strong>{selectedCatalogDraft.replacement_warning}</strong></div> : null}
            </div>
            <div className="toolbar toolbar--wrap">
              <Button
                variant="secondary"
                onClick={() => void saveCatalogRow(selectedCatalogRow)}
                disabled={!isOnline || !selectedCatalogDraft.market_segment}
                busy={rowActionKey === `save:${selectedCatalogRow.product_id}`}
                busyLabel="Saving..."
              >
                Save Changes
              </Button>
              <Button
                variant="secondary"
                className="danger-button"
                onClick={() => void deleteCatalogRow(selectedCatalogRow)}
                disabled={!isOnline}
                busy={rowActionKey === `delete:${selectedCatalogRow.product_id}`}
                busyLabel="Deleting..."
              >
                Delete Item
              </Button>
              <Button variant="secondary" onClick={() => openReferenceDialogForRow(selectedCatalogRow)} disabled={!isOnline}>
                {(() => {
                  const coverageKey = `${selectedCatalogRow.brand.trim().toLowerCase()}::${normalizePartCode(selectedCatalogRow.product_code)}`;
                  return (referenceCoverage[coverageKey] || 0) > 0 ? "Edit Reference" : "Add Reference";
                })()}
              </Button>
              <Button variant="secondary" onClick={queueCatalogItemForSalesOrder}>
                Add to Sales Order
              </Button>
              <Button variant="secondary" onClick={queueCatalogItemForPurchaseOrder}>
                Add to Purchase Draft
              </Button>
            </div>
            {selectedCatalogDraft.lifecycle_note ? <div className="info-text">{selectedCatalogDraft.lifecycle_note}</div> : null}
          </div>
        </DraggableSurface>
      ) : null}

      {showImportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>Catalog CSV Import</h3>
                <p>Fill all required fields before starting the import.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Brand"
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
                label="Market Segment"
                value={importCatalogSegment}
                options={[{ value: "", label: "Select segment..." }, ...CATALOG_MARKET_SEGMENT_OPTIONS]}
                onChange={setImportCatalogSegment}
              />
              <Input
                label="Brand Name"
                value={importBrandName}
                onChange={setImportBrandName}
                disabled={importBrand !== "__new__"}
              />
              <Input label="Target" value="Cloud catalog import" onChange={() => undefined} disabled />
              <label className="field">
                <span className="field__label">File</span>
                <input
                  className="field__input"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] ?? null);
                  }}
                />
              </label>
              <Input label="Selected file" value={importFile?.name ?? ""} onChange={() => undefined} disabled />
            </div>
            <div className="modal-hint">Brand, segment, target, and file are required for every catalog CSV import. For discontinued/EOL updates, use the lifecycle template instead of full export.</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadCatalogTemplate();
                  actionFeedback.succeed("Catalog sample template downloaded.");
                }}
              >
                Download Sample Template
              </Button>
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadCatalogLifecycleTemplate();
                  actionFeedback.succeed("Catalog lifecycle template downloaded.");
                }}
              >
                Download Lifecycle Template
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
                }}
              >
                Cancel Import
              </Button>
              <Button
                onClick={() => {
                  if (importFile) void handleCatalogImport(importFile);
                }}
                disabled={!importFile || loading || (importBrand === "__new__" && !importBrandName.trim())}
                busy={importingCatalog}
                busyLabel="Importing..."
              >
                Import
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {showExportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>Catalog CSV Export</h3>
                <p>Select a brand to download its full catalog list.</p>
              </div>
            </div>
            <div className="modal-form-grid">
            <Select label="Brand" value={exportBrand} options={editableBrandOptions} onChange={setExportBrand} />
            <Input label="Scope" value="All items for selected brand" onChange={() => undefined} disabled />
          </div>
          <div className="modal-hint">This export ignores the current search box and downloads the current catalog scope for the selected brand.</div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowExportDialog(false);
                  setExportBrand("");
                }}
              >
                Cancel
              </Button>
              <Button onClick={() => void handleCatalogExport()} disabled={!exportBrand} busy={exportingCatalog} busyLabel="Preparing...">
                Export CSV
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
                <h3>Add New Item</h3>
                <p>Create a new catalog product under Items.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Input label="Product Code" value={createDraft.product_code} onChange={(value) => setCreateDraft((current) => ({ ...current, product_code: value }))} />
              <Select
                label="Brand"
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
                label="Market Segment"
                value={createDraft.market_segment}
                options={CATALOG_MARKET_SEGMENT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => setCreateDraft((current) => ({ ...current, market_segment: value }))}
              />
              <Input
                label="Brand Name"
                value={createDraft.brand_name}
                onChange={(value) => setCreateDraft((current) => ({ ...current, brand_name: value }))}
                disabled={createDraft.brand !== "__new__"}
              />
              <Input label="Product Name" value={createDraft.description} onChange={(value) => setCreateDraft((current) => ({ ...current, description: value }))} />
              <Input label="OEM" value={createDraft.oem_no} onChange={(value) => setCreateDraft((current) => ({ ...current, oem_no: value }))} />
              <Input label="Vehicle" value={createDraft.vehicle} onChange={(value) => setCreateDraft((current) => ({ ...current, vehicle: value }))} />
              <Input label="HS Code" value={createDraft.hs_code} onChange={(value) => setCreateDraft((current) => ({ ...current, hs_code: value }))} />
              <Input label="Origin" value={createDraft.origin} onChange={(value) => setCreateDraft((current) => ({ ...current, origin: value }))} />
              <Input label="Weight" value={createDraft.weight_kg} onChange={(value) => setCreateDraft((current) => ({ ...current, weight_kg: value }))} />
              <Select
                label="Lifecycle"
                value={createDraft.lifecycle_status}
                options={lifecycleOptions}
                onChange={(value) => setCreateDraft((current) => ({ ...current, lifecycle_status: value }))}
              />
              <Input label="Lifecycle Note" value={createDraft.lifecycle_note} onChange={(value) => setCreateDraft((current) => ({ ...current, lifecycle_note: value }))} />
            </div>
            <div className="modal-hint">Product code, brand, and market segment are required. The item will be created directly in cloud catalog.</div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!isOnline) {
                    setError("Connect to the internet to create catalog items.");
                    return;
                  }
                  try {
                    setError("");
                    setStatus("");
                    setCreatingItem(true);
                    actionFeedback.begin(`Creating item ${createDraft.product_code.trim()}...`);
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
                    setStatus("Catalog item created successfully.");
                    actionFeedback.succeed(`Catalog item ${createDraft.product_code.trim()} created.`);
                  } catch (caught) {
                    const message = caught instanceof Error ? caught.message : "Catalog create failed";
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
                busyLabel="Creating..."
              >
                Create Item
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
                <h3>Add Code Reference</h3>
                <p>Create a mapping from the customer's old code to this current valid catalog code.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Brand"
                value={referenceDraft.brand}
                options={editableBrandOptions}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, brand: value }))}
              />
              <Input
                label="Old Code"
                value={referenceDraft.old_code}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, old_code: value }))}
              />
              <Input label="New Code" value={referenceDraft.new_code} onChange={() => undefined} disabled />
              <Input
                label="Original Number"
                value={referenceDraft.original_number}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, original_number: value }))}
              />
              <Input label="Reason" value={referenceDraft.reason} onChange={(value) => setReferenceDraft((current) => ({ ...current, reason: value }))} />
            </div>
            {renderReferenceOldCodeHint(referenceOldCodeUsage)}
            <div className="modal-hint">Old Code = the obsolete number still asked by customers. New Code = the current active catalog number.</div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShowReferenceDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!isOnline) {
                    setError("Connect to the internet to save code references.");
                    return;
                  }
                  try {
                    setError("");
                    setStatus("");
                    setSavingReference(true);
                    actionFeedback.begin(`Saving code reference for ${referenceDraft.old_code.trim()}...`);
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
                      `Code reference saved. Quotes will warn for old code ${referenceDraft.old_code.trim()} and use ${referenceDraft.new_code.trim()}.`,
                    );
                    setShowReferenceDialog(false);
                    actionFeedback.succeed(`Code reference saved for old code ${referenceDraft.old_code.trim()}.`);
                  } catch (caught) {
                    const message = caught instanceof Error ? caught.message : "Code reference create failed";
                    if (message.includes("item_code_references_organization_id_brand_id_normalized_ol_key")) {
                      setError("This old customer code already has a mapping for this brand. Use the existing reference instead of creating a duplicate.");
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
                busyLabel="Saving..."
              >
                Save Reference
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
                <p>{previewImage.name || "Catalog image preview"}</p>
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
  );
}
