import { callAppRpc } from "./appRpcApi";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";
import { buildLooseOriginalNumberPattern, normalizeOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";
import type { MasterRow } from "../../types/master";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

type MasterParams = {
  search: string;
  brand: string;
  brandId?: string;
  scope: string;
  page?: number;
  pageSize?: number;
  marginA?: number;
  marginB?: number;
};

type MasterExportParams = Omit<MasterParams, "page" | "pageSize"> & {
  maxRows?: number;
  pageSize?: number;
};

export const CLOUD_MASTER_EXPORT_MAX_ROWS = 5000;
const CLOUD_MASTER_EXPORT_DEFAULT_PAGE_SIZE = 500;
const CLOUD_MASTER_EXPORT_RETRY_PAGE_SIZES = [500, 250, 100];

type BrandLookup = {
  id: string;
  name: string;
};

type CatalogMasterBaseRow = {
  id: string;
  product_code: string;
  normalized_code: string | null;
  normalized_oem: string | null;
  description: string | null;
  oem_no: string | null;
  hs_code: string | null;
  origin: string | null;
  weight_kg: number | null;
};

type SupplierPriceLookupRow = {
  id: string | null;
  normalized_code: string | null;
  supplier_id: string | null;
  buy_price: number | null;
  valid_from: string | null;
  updated_at: string | null;
  notes: string | null;
  suppliers?: { name?: string | null } | null;
};

type SupplierPriceRollupLookupRow = {
  normalized_code: string | null;
  cheapest_supplier_id: string | null;
  cheapest_price: number | null;
  second_supplier_id: string | null;
  second_supplier_name: string | null;
  second_price: number | null;
  price_gap: number | null;
  price_gap_percent: number | null;
  price_date: string | null;
  supplier_count: number | null;
  notes: string | null;
  has_notes: boolean | null;
};

type MasterSupplierStats = {
  cheapestSupplier: string;
  cheapestPrice: number | null;
  secondSupplierName: string;
  secondPrice: number | null;
  priceGap: number | null;
  priceGapPercent: number | null;
  priceDate: string;
  supplierCount: number;
  notes: string | null;
  hasNotes: boolean;
};

type MasterSearchMode = "strict" | "loose";

function shouldRunLooseOriginalNumberSearch(search: string) {
  return normalizeOriginalNumberSearch(search).length >= 6;
}

function buildMasterSearchOr(rawSearch: string, normalizedSearch: string, mode: MasterSearchMode) {
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(rawSearch);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(rawSearch);
  const clauses = [
    `product_code.ilike.%${rawSearch}%`,
    `description.ilike.%${rawSearch}%`,
    `oem_no.ilike.%${rawSearch}%`,
  ];
  if (normalizedSearch.length >= 3) {
    clauses.push(
      `normalized_code.eq.${normalizedSearch}`,
      `normalized_oem.eq.${normalizedSearch}`,
      `normalized_code.like.${normalizedSearch}%`,
      `normalized_oem.like.${normalizedSearch}%`,
    );
  }
  if (mode === "loose" && looseOriginalPattern.length >= 6) {
    clauses.push(`oem_no.ilike.%${looseOriginalPattern}%`);
  }
  if (mode === "loose" && normalizedOriginalSearch.length >= 6) {
    clauses.push(
      `normalized_oem.like.%${normalizedOriginalSearch}%`,
    );
  }
  return clauses.join(",");
}

async function resolveBrand(organizationId: string, brandName: string): Promise<BrandLookup> {
  const normalizedBrand = brandName.trim();
  if (!normalizedBrand) {
    throw new Error("Brand is required");
  }

  const { data, error } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .ilike("name", normalizedBrand)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Brand lookup failed"));
  if (!data?.id) throw new Error(`Brand not found: ${normalizedBrand}`);
  return {
    id: String(data.id),
    name: String(data.name || normalizedBrand),
  };
}

function chunkValues<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function comparePriceRows(a: SupplierPriceLookupRow, b: SupplierPriceLookupRow) {
  const priceDiff = Number(a.buy_price || 0) - Number(b.buy_price || 0);
  if (priceDiff !== 0) return priceDiff;
  const validFromDiff = String(b.valid_from || "").localeCompare(String(a.valid_from || ""));
  if (validFromDiff !== 0) return validFromDiff;
  const updatedAtDiff = String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  if (updatedAtDiff !== 0) return updatedAtDiff;
  return String(b.id || "").localeCompare(String(a.id || ""));
}

function isMissingRollupSurface(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("supplier_price_rollups") &&
    (
      message.includes("does not exist") ||
      message.includes("schema cache") ||
      message.includes("Could not find")
    )
  );
}

function isMissingExportRpc(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("cloud_master_export") &&
    (
      message.includes("does not exist") ||
      message.includes("schema cache") ||
      message.includes("Could not find") ||
      message.includes("RPC is not allowed")
    )
  );
}

function shouldFallbackFromFastMasterRpc(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  return (
    isRequestTimeoutError(error) ||
    normalized.includes("schema cache") ||
    normalized.includes("could not find") ||
    normalized.includes("does not exist") ||
    normalized.includes("rpc is not allowed") ||
    normalized.includes("the request could not be completed right now")
  );
}

function isRequestTimeoutError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error || "")).toLowerCase();
  return (
    message.includes("request took too long") ||
    message.includes("request timed out") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("504") ||
    message.includes("524")
  );
}

function clampPositiveInteger(value: unknown, fallback: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(Math.floor(numeric), 1), max);
}

function roundPriceMetric(value: number) {
  return Math.round(value * 10000) / 10000;
}

async function fetchSupplierNamesById(supplierIds: string[]) {
  const uniqueIds = [...new Set(supplierIds.map((id) => id.trim()).filter(Boolean))];
  const names = new Map<string, string>();
  for (const chunk of chunkValues(uniqueIds, 500)) {
    const { data, error } = await supabaseClient
      .from("suppliers")
      .select("id,name")
      .in("id", chunk);

    if (error) {
      throw new Error(sanitizeUserFacingMessage(error.message, "Supplier names could not be loaded"));
    }
    for (const row of data || []) {
      names.set(String(row.id), String(row.name || ""));
    }
  }
  return names;
}

async function fetchSupplierStatsFromRollups(input: {
  organizationId: string;
  brandId: string;
  normalizedCodes: string[];
}) {
  const rollupRows: SupplierPriceRollupLookupRow[] = [];
  for (const chunk of chunkValues(input.normalizedCodes, 500)) {
    const { data, error } = await supabaseClient
      .from("supplier_price_rollups")
      .select("normalized_code,cheapest_supplier_id,cheapest_price,second_supplier_id,second_supplier_name,second_price,price_gap,price_gap_percent,price_date,supplier_count,notes,has_notes")
      .eq("organization_id", input.organizationId)
      .eq("brand_id", input.brandId)
      .in("normalized_code", chunk);

    if (error) {
      throw new Error(error.message || "Supplier price rollups could not be loaded");
    }
    rollupRows.push(...((data || []) as SupplierPriceRollupLookupRow[]));
  }

  const supplierNames = await fetchSupplierNamesById(
    rollupRows
      .flatMap((row) => [row.cheapest_supplier_id, row.second_supplier_id])
      .map((id) => String(id || ""))
      .filter(Boolean),
  );
  const supplierStats = new Map<string, MasterSupplierStats>();
  for (const row of rollupRows) {
    const normalizedCode = String(row.normalized_code || "");
    if (!normalizedCode) continue;
    const supplierId = String(row.cheapest_supplier_id || "");
    const secondSupplierId = String(row.second_supplier_id || "");
    const cheapestPrice = row.cheapest_price == null ? null : Number(row.cheapest_price);
    const secondPrice = row.second_price == null ? null : Number(row.second_price);
    supplierStats.set(normalizedCode, {
      cheapestSupplier: supplierNames.get(supplierId) || "",
      cheapestPrice,
      secondSupplierName: String(row.second_supplier_name || supplierNames.get(secondSupplierId) || ""),
      secondPrice,
      priceGap: row.price_gap == null ? null : Number(row.price_gap),
      priceGapPercent: row.price_gap_percent == null ? null : Number(row.price_gap_percent),
      priceDate: String(row.price_date || ""),
      supplierCount: Number(row.supplier_count || 0),
      notes: row.notes || null,
      hasNotes: Boolean(row.has_notes || row.notes),
    });
  }
  return supplierStats;
}

async function fetchSupplierStatsFromPrices(input: {
  organizationId: string;
  brandId: string;
  normalizedCodes: string[];
}) {
  const supplierRows: SupplierPriceLookupRow[] = [];

  for (const chunk of chunkValues(input.normalizedCodes, 200)) {
    const { data, error } = await supabaseClient
      .from("supplier_prices")
      .select("id,normalized_code,supplier_id,buy_price,valid_from,updated_at,notes,suppliers(name)")
      .eq("organization_id", input.organizationId)
      .eq("brand_id", input.brandId)
      .eq("is_active", true)
      .not("buy_price", "is", null)
      .in("normalized_code", chunk);

    if (error) {
      throw new Error(sanitizeUserFacingMessage(error.message, "Supplier pricing could not be loaded"));
    }
    supplierRows.push(...((data || []) as SupplierPriceLookupRow[]));
  }

  const priceStats = new Map<
    string,
    {
      bestBySupplier: Map<string, SupplierPriceLookupRow>;
      supplierIds: Set<string>;
      notes: Set<string>;
    }
  >();

  for (const row of supplierRows) {
    const normalizedCode = String(row.normalized_code || "");
    if (!normalizedCode) continue;
    const current = priceStats.get(normalizedCode) || {
      bestBySupplier: new Map<string, SupplierPriceLookupRow>(),
      supplierIds: new Set<string>(),
      notes: new Set<string>(),
    };
    if (row.supplier_id) current.supplierIds.add(String(row.supplier_id));
    const note = String(row.notes || "").trim();
    if (note) current.notes.add(note);
    const supplierKey = row.supplier_id ? String(row.supplier_id) : "__missing_supplier__";
    const currentSupplierBest = current.bestBySupplier.get(supplierKey);
    if (!currentSupplierBest || comparePriceRows(row, currentSupplierBest) < 0) {
      current.bestBySupplier.set(supplierKey, row);
    }
    priceStats.set(normalizedCode, current);
  }

  const supplierStats = new Map<string, MasterSupplierStats>();
  for (const [normalizedCode, stats] of priceStats.entries()) {
    const rankedRows = [...stats.bestBySupplier.values()].sort(comparePriceRows);
    const best = rankedRows[0] || null;
    const secondBest = rankedRows[1] || null;
    const cheapestPrice = best?.buy_price == null ? null : Number(best.buy_price);
    const secondPrice = secondBest?.buy_price == null ? null : Number(secondBest.buy_price);
    const priceGap = cheapestPrice == null || secondPrice == null ? null : roundPriceMetric(secondPrice - cheapestPrice);
    const priceGapPercent = cheapestPrice == null || secondPrice == null || cheapestPrice === 0
      ? null
      : roundPriceMetric(((secondPrice - cheapestPrice) / cheapestPrice) * 100);
    supplierStats.set(normalizedCode, {
      cheapestSupplier: String(best?.suppliers?.name || ""),
      cheapestPrice,
      secondSupplierName: String(secondBest?.suppliers?.name || ""),
      secondPrice,
      priceGap,
      priceGapPercent,
      priceDate: String(best?.valid_from || ""),
      supplierCount: stats.supplierIds.size,
      notes: stats.notes.size ? [...stats.notes].join(" | ") : null,
      hasNotes: Boolean(stats.notes.size),
    });
  }
  return supplierStats;
}

async function fetchSupplierStatsForRows(input: {
  organizationId: string;
  brandId: string;
  normalizedCodes: string[];
}) {
  try {
    return await fetchSupplierStatsFromRollups(input);
  } catch (error) {
    if (!isMissingRollupSurface(error)) {
      throw new Error(sanitizeUserFacingMessage(error instanceof Error ? error.message : String(error), "Supplier pricing could not be loaded"));
    }
    return fetchSupplierStatsFromPrices(input);
  }
}

async function fetchCatalogMasterBaseRows(input: {
  organizationId: string;
  brandId: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  const page = Math.max(1, input.page);
  const pageSize = Math.min(Math.max(1, input.pageSize), 1000);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const rawSearch = input.search.trim();
  const normalizedSearch = normalizePartCode(rawSearch);

  let query = supabaseClient
    .from("catalog_products")
    .select("id,product_code,normalized_code,normalized_oem,description,oem_no,hs_code,origin,weight_kg", { count: "planned" })
    .eq("organization_id", input.organizationId)
    .eq("brand_id", input.brandId)
    .order("product_code", { ascending: true })
    .range(from, to);

  if (rawSearch) {
    query = query.or(buildMasterSearchOr(rawSearch, normalizedSearch, "strict"));
  }

  let { data, error, count } = await query;
  if (!error && rawSearch && shouldRunLooseOriginalNumberSearch(rawSearch) && !(data || []).length) {
    let looseQuery = supabaseClient
      .from("catalog_products")
      .select("id,product_code,normalized_code,normalized_oem,description,oem_no,hs_code,origin,weight_kg", { count: "planned" })
      .eq("organization_id", input.organizationId)
      .eq("brand_id", input.brandId)
      .order("product_code", { ascending: true })
      .range(from, to)
      .or(buildMasterSearchOr(rawSearch, normalizedSearch, "loose"));
    ({ data, error, count } = await looseQuery);
  }
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Catalog search failed"));
  return {
    rows: ((data || []) as CatalogMasterBaseRow[]).map((row) => ({
      ...row,
      normalized_code: row.normalized_code || normalizePartCode(row.product_code),
      normalized_oem: row.normalized_oem || normalizePartCode(String(row.oem_no || "")),
    })),
    totalCount: count ?? 0,
  };
}

async function enrichCatalogMasterRows(input: {
  organizationId: string;
  brand: BrandLookup;
  rows: CatalogMasterBaseRow[];
  marginA: number;
  marginB: number;
  totalCount: number;
}) {
  if (!input.rows.length) return [] as MasterRow[];

  const normalizedCodes = [...new Set(input.rows.map((row) => String(row.normalized_code || "")).filter(Boolean))];
  const supplierStats = await fetchSupplierStatsForRows({
    organizationId: input.organizationId,
    brandId: input.brand.id,
    normalizedCodes,
  });

  return input.rows.map((row) => {
    const normalizedCode = String(row.normalized_code || "");
    const stats = supplierStats.get(normalizedCode);
    const cheapestPrice = stats?.cheapestPrice ?? null;
    return {
      total_count: input.totalCount,
      product_id: row.id,
      product_code: row.product_code,
      brand: input.brand.name,
      description: row.description,
      oem_no: row.oem_no,
      hs_code: row.hs_code,
      origin: row.origin,
      weight_kg: row.weight_kg,
      cheapest_supplier: stats?.cheapestSupplier || "",
      cheapest_price: cheapestPrice,
      second_supplier_name: stats?.secondSupplierName || "",
      second_price: stats?.secondPrice ?? null,
      price_gap: stats?.priceGap ?? null,
      price_gap_percent: stats?.priceGapPercent ?? null,
      price_date: stats?.priceDate || "",
      sales_a: cheapestPrice == null ? null : Math.round(cheapestPrice * (1 + input.marginA) * 100) / 100,
      sales_b: cheapestPrice == null ? null : Math.round(cheapestPrice * (1 + input.marginB) * 100) / 100,
      supplier_count: stats?.supplierCount ?? 0,
      catalog_status: "In Catalog",
      notes: stats?.notes || null,
      has_notes: Boolean(stats?.hasNotes),
    } satisfies MasterRow;
  });
}

async function fetchCatalogOnlyMaster(input: {
  search: string;
  brand: string;
  page: number;
  pageSize: number;
  marginA: number;
  marginB: number;
}) {
  const organizationId = await getCurrentOrgId();
  const brand = await resolveBrand(organizationId, input.brand);
  const { rows, totalCount } = await fetchCatalogMasterBaseRows({
    organizationId,
    brandId: brand.id,
    search: input.search,
    page: input.page,
    pageSize: input.pageSize,
  });
  return enrichCatalogMasterRows({
    organizationId,
    brand,
    rows,
    marginA: input.marginA,
    marginB: input.marginB,
    totalCount,
  });
}

export async function fetchCloudMaster({
  search,
  brand,
  scope,
  page = 1,
  pageSize = 50,
  marginA = 0.1,
  marginB = 0.15,
}: MasterParams): Promise<MasterRow[]> {
  const data = await callAppRpc<MasterRow[]>("cloud_master_page", {
    input_search: search,
    input_brand: brand,
    input_page: page,
    input_page_size: pageSize,
    input_margin_a: marginA,
    input_margin_b: marginB,
    input_scope: scope,
  });

  return (data || []) as MasterRow[];
}

export async function fetchCloudMasterFast(params: MasterParams): Promise<MasterRow[]> {
  const brandId = String(params.brandId || "").trim();
  if (!brandId || params.scope !== "catalog") {
    return fetchCloudMaster(params);
  }

  try {
    const pageSize = params.pageSize ?? 50;
    const data = await callAppRpc<MasterRow[]>("cloud_master_page_fast", {
      input_search: params.search,
      input_brand_id: brandId,
      input_page: params.page ?? 1,
      input_page_size: pageSize,
      input_margin_a: params.marginA ?? 0.1,
      input_margin_b: params.marginB ?? 0.15,
    });
    const rows = (data || []) as MasterRow[];
    return rows.map((row) => ({
      ...row,
      total_count: row.total_count ?? rows.length,
    }));
  } catch (error) {
    if (!shouldFallbackFromFastMasterRpc(error)) throw error;
    return fetchCloudMaster(params);
  }
}

async function fetchCloudMasterExportPage({
  search,
  brand,
  scope,
  page = 1,
  pageSize = 1000,
  marginA = 0.1,
  marginB = 0.15,
}: MasterParams): Promise<MasterRow[]> {
  const data = await callAppRpc<MasterRow[]>("cloud_master_export", {
    input_search: search,
    input_brand: brand,
    input_page: page,
    input_page_size: pageSize,
    input_margin_a: marginA,
    input_margin_b: marginB,
    input_scope: scope,
  });

  return (data || []) as MasterRow[];
}

async function fetchCloudMasterExportRows(params: MasterExportParams, pageSize: number, maxRows: number) {
  const { maxRows: _maxRows, pageSize: _pageSize, ...masterParams } = params;
  const allRows: MasterRow[] = [];
  const maxPages = Math.ceil(maxRows / pageSize);

  for (let page = 1; page <= maxPages && allRows.length < maxRows; page += 1) {
    const currentPageSize = Math.min(pageSize, maxRows - allRows.length);
    let rows: MasterRow[];
    try {
      rows = await fetchCloudMasterExportPage({
        ...masterParams,
        page,
        pageSize: currentPageSize,
      });
    } catch (error) {
      if (!isMissingExportRpc(error)) throw error;
      rows = await fetchCloudMaster({
        ...masterParams,
        page,
        pageSize: currentPageSize,
      });
    }
    allRows.push(...rows);
    if (rows.length < currentPageSize) break;
  }

  return allRows.slice(0, maxRows);
}

export async function fetchAllCloudMaster(params: MasterExportParams): Promise<MasterRow[]> {
  const maxRows = clampPositiveInteger(params.maxRows, CLOUD_MASTER_EXPORT_MAX_ROWS, CLOUD_MASTER_EXPORT_MAX_ROWS);
  const requestedPageSize = clampPositiveInteger(
    params.pageSize,
    CLOUD_MASTER_EXPORT_DEFAULT_PAGE_SIZE,
    Math.min(1000, maxRows),
  );
  const retryPageSizes = [requestedPageSize, ...CLOUD_MASTER_EXPORT_RETRY_PAGE_SIZES]
    .filter((size, index, sizes) => size <= maxRows && size <= requestedPageSize && sizes.indexOf(size) === index);
  let timeoutError: unknown = null;

  for (const pageSize of retryPageSizes) {
    try {
      const allRows = await fetchCloudMasterExportRows(params, pageSize, maxRows);
      return allRows.map((row) => ({
        ...row,
        total_count: allRows.length,
      }));
    } catch (error) {
      if (!isRequestTimeoutError(error)) throw error;
      timeoutError = error;
    }
  }

  throw new Error(
    timeoutError
      ? "Master export is too large for the current filters. Narrow the search or export a smaller scope."
      : "Master export failed.",
  );
}
