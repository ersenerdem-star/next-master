import type { CatalogIntegrityFilter, CatalogIntegritySummary, CatalogIntegrityStatus, CatalogRow } from "../../types/catalog";
import { normalizeCatalogMarketSegment } from "../../domain/shared/catalogSegments";
import { normalizeCatalogDisplayCode, normalizeCatalogDescription, normalizeCatalogOrigin } from "../../domain/shared/catalogFormatting";
import { normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import {
  buildLooseOriginalNumberPattern,
  matchesOriginalNumberSearch,
  normalizeBrandName,
  normalizeOriginalNumberSearch,
  normalizePartCode,
  sanitizeCatalogOemNumbers,
} from "../../domain/shared/normalize";
import { callAppRpc } from "./appRpcApi";
import { clearCloudBrandsCache, fetchCloudBrands } from "./brandsApi";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

const CATALOG_SELECT_WITH_IMAGE =
  "id,product_code,image_url,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note";
const CATALOG_SELECT_NO_IMAGE =
  "id,product_code,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note";
const CATALOG_GLOBAL_SELECT_WITH_IMAGE =
  "id,product_code,image_url,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note,brands!inner(name)";
const CATALOG_GLOBAL_SELECT_NO_IMAGE =
  "id,product_code,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note,brands!inner(name)";

type CatalogSearchMode = "strict" | "loose";

type CatalogQueryRow = {
  id: string;
  product_code: string;
  image_url?: string | null;
  description: string | null;
  oem_no: string | null;
  vehicle: string | null;
  hs_code: string | null;
  origin: string | null;
  market_segment: string | null;
  weight_kg: number | null;
  lifecycle_status: string | null;
  lifecycle_note: string | null;
  brands?: { name?: string | null } | null;
};

function shouldRunLooseOriginalNumberSearch(search: string) {
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  return normalizedOriginalSearch.length >= 6;
}

function isLikelyCatalogCodeSearch(search: string) {
  const value = String(search || "").trim();
  if (!value) return false;
  return /\d/.test(value) || /[-/+.()]/.test(value);
}

function buildCatalogSearchOr(search: string, normalizedSearch: string, mode: CatalogSearchMode) {
  const escaped = search.replace(/[%(),]/g, " ").trim();
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(search);
  const clauses = [`product_code.ilike.%${escaped}%`, `oem_no.ilike.%${escaped}%`];
  if (!isLikelyCatalogCodeSearch(search)) {
    clauses.push(`description.ilike.%${escaped}%`, `vehicle.ilike.%${escaped}%`);
  }
  if (normalizedSearch.length >= 3) {
    clauses.push(
      `product_code.ilike.%${normalizedSearch}%`,
      `oem_no.ilike.%${normalizedSearch}%`,
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

function isMissingCatalogImageError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  return normalized.includes("image_url") && normalized.includes("does not exist");
}

function dedupeCatalogQueryRows(rows: CatalogQueryRow[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = String(row.id || "").trim() || `${String(row.product_code || "").trim()}::${String(row.oem_no || "").trim()}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchCatalogFallbackRows(input: {
  selectClause: string;
  fallbackSelectClause: string;
  filters: Record<string, string>;
  orderBy?: string;
  limit: number;
}) {
  const orderBy = input.orderBy || "product_code";
  try {
    const query = supabaseClient
      .from("catalog_products")
      .select(input.selectClause)
      .order(orderBy, { ascending: true })
      .limit(input.limit);
    const filteredQuery = Object.entries(input.filters).reduce((current, [column, value]) => {
      if (column === "oem_no__ilike") return current.ilike("oem_no", value);
      if (column === "normalized_oem__like") return current.like("normalized_oem", value);
      return current.eq(column, value);
    }, query as any);
    const { data, error } = await filteredQuery;
    if (error && isMissingCatalogImageError(error)) {
      const noImageQuery = supabaseClient
        .from("catalog_products")
        .select(input.fallbackSelectClause)
        .order(orderBy, { ascending: true })
        .limit(input.limit);
      const filteredNoImageQuery = Object.entries(input.filters).reduce((current, [column, value]) => {
        if (column === "oem_no__ilike") return current.ilike("oem_no", value);
        if (column === "normalized_oem__like") return current.like("normalized_oem", value);
        return current.eq(column, value);
      }, noImageQuery as any);
      const { data: noImageData, error: noImageError } = await filteredNoImageQuery;
      if (noImageError) throw noImageError;
      return (noImageData ?? []) as CatalogQueryRow[];
    }
    if (error) throw error;
    return (data ?? []) as CatalogQueryRow[];
  } catch {
    return [] as CatalogQueryRow[];
  }
}

async function resolveBrandId(brandName: string) {
  const normalizedBrand = normalizeBrandName(brandName);
  if (!normalizedBrand) {
    throw new Error("Brand is required");
  }
  const brands = await fetchCloudBrands();
  const match = brands.find((item) => normalizeBrandName(item.name).toLowerCase() === normalizedBrand.toLowerCase());
  if (!match?.id) throw new Error(`Brand not found: ${normalizedBrand}`);
  return match.id;
}

async function resolveOrCreateBrandId(brandName: string) {
  const normalizedBrand = normalizeBrandName(brandName);
  if (!normalizedBrand) {
    throw new Error("Brand is required");
  }

  const existingId = await resolveBrandId(normalizedBrand).catch(() => null);
  if (existingId) return existingId;

  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("brands")
    .insert({
      organization_id: organizationId,
      name: normalizedBrand,
    })
    .select("id")
    .single();

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Brand create failed"));
  if (!data?.id) throw new Error(`Brand could not be created: ${normalizedBrand}`);
  clearCloudBrandsCache();
  return data.id as string;
}

function requireCatalogMarketSegment(value: string | null | undefined) {
  const normalized = normalizeCatalogMarketSegment(value);
  if (!normalized) {
    throw new Error("Market segment is required. Choose Truck, Bus, Agriculture, Marine, Passenger Car, or Industrial.");
  }
  return normalized;
}

export async function fetchCloudCatalog(input: {
  search: string;
  brandName?: string;
  marketSegment?: string;
  page?: number;
  pageSize?: number;
}): Promise<CatalogRow[]> {
  const data = await callAppRpc<Array<Record<string, unknown>>>("cloud_catalog_page", {
    input_search: input.search,
    input_brand: normalizeBrandName(input.brandName || ""),
    input_market_segment: normalizeCatalogMarketSegment(input.marketSegment) || "",
    input_page: input.page ?? 1,
    input_page_size: input.pageSize ?? 50,
  });
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    total_count: row.total_count == null ? null : Number(row.total_count),
    product_id: String(row.product_id || ""),
    product_code: String(row.product_code || ""),
    brand: String(row.brand || ""),
    image_url: String(row.image_url || ""),
    description: String(row.description || ""),
    oem_no: sanitizeCatalogOemNumbers(String(row.oem_no || "")),
    vehicle: String(row.vehicle || ""),
    hs_code: String(row.hs_code || ""),
    origin: String(row.origin || ""),
    market_segment: normalizeCatalogMarketSegment(String(row.market_segment || "")),
    weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
    lifecycle_status: normalizeCatalogLifecycleStatus(String(row.lifecycle_status || "")),
    lifecycle_note: String(row.lifecycle_note || ""),
    replacement_old_code: String(row.replacement_old_code || "") || null,
    replacement_code: String(row.replacement_code || "") || null,
    replacement_reason: String(row.replacement_reason || "") || null,
    replacement_warning: String(row.replacement_warning || "") || null,
  }));
}

export async function fetchCloudCatalogIntegrity(input: {
  search: string;
  brandName?: string;
  marketSegment?: string;
  integrityFilter?: CatalogIntegrityFilter;
  page?: number;
  pageSize?: number;
}): Promise<CatalogRow[]> {
  const data = await callAppRpc<Array<Record<string, unknown>>>("cloud_catalog_integrity_page", {
    input_search: input.search,
    input_brand: normalizeBrandName(input.brandName || ""),
    input_market_segment: normalizeCatalogMarketSegment(input.marketSegment) || "",
    input_integrity_filter: input.integrityFilter || "",
    input_page: input.page ?? 1,
    input_page_size: input.pageSize ?? 50,
  });

  return (data ?? []).map((row) => ({
    total_count: row.total_count == null ? null : Number(row.total_count),
    product_id: String(row.product_id || ""),
    product_code: String(row.product_code || ""),
    brand: String(row.brand || ""),
    image_url: String(row.image_url || ""),
    description: String(row.description || ""),
    oem_no: sanitizeCatalogOemNumbers(String(row.oem_no || "")),
    vehicle: String(row.vehicle || ""),
    hs_code: String(row.hs_code || ""),
    origin: String(row.origin || ""),
    market_segment: normalizeCatalogMarketSegment(String(row.market_segment || "")),
    weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
    ean: String(row.ean || ""),
    lifecycle_status: normalizeCatalogLifecycleStatus(String(row.lifecycle_status || "")),
    lifecycle_note: String(row.lifecycle_note || ""),
    integrity_status: String(row.integrity_status || "unknown") as CatalogIntegrityStatus,
    critical_missing_fields: Array.isArray(row.critical_missing_fields) ? row.critical_missing_fields.map(String) : [],
    optional_missing_fields: Array.isArray(row.optional_missing_fields) ? row.optional_missing_fields.map(String) : [],
    conflict_fields: Array.isArray(row.conflict_fields) ? row.conflict_fields.map(String) : [],
    pending_conflict_count: Number(row.pending_conflict_count || 0),
    last_evaluated_at: row.last_evaluated_at ? String(row.last_evaluated_at) : null,
    integrity_last_error: row.integrity_last_error ? String(row.integrity_last_error) : null,
  }));
}

export async function fetchCatalogIntegritySummary(): Promise<CatalogIntegritySummary> {
  const data = await callAppRpc<Record<string, unknown>>("get_catalog_integrity_summary");
  return {
    total_products: Number(data?.total_products || 0),
    projected_products: Number(data?.projected_products || 0),
    clear_count: Number(data?.clear_count || 0),
    incomplete_count: Number(data?.incomplete_count || 0),
    conflict_count: Number(data?.conflict_count || 0),
    pending_count: Number(data?.pending_count || 0),
    failed_count: Number(data?.failed_count || 0),
    last_evaluated_at: data?.last_evaluated_at ? String(data.last_evaluated_at) : null,
    backfill_status: String(data?.backfill_status || "queued") as CatalogIntegritySummary["backfill_status"],
    backfill_queued_products: Number(data?.backfill_queued_products || 0),
    backfill_updated_at: data?.backfill_updated_at ? String(data.backfill_updated_at) : null,
    backfill_error: data?.backfill_error ? String(data.backfill_error) : null,
  };
}

export async function fetchCatalogProductIntegrity(productId: string) {
  return callAppRpc<Record<string, unknown>>("get_catalog_product_integrity", { input_product_id: productId });
}

export async function updateCloudCatalogRow(
  productId: string,
  updates: {
    product_code: string;
    brand: string;
    description: string | null;
    oem_no: string | null;
    vehicle: string | null;
    hs_code: string | null;
    origin: string | null;
    market_segment: string | null;
    weight_kg: number | null;
    lifecycle_status: string | null;
    lifecycle_note: string | null;
  },
) {
  const brandId = await resolveBrandId(updates.brand);
  const marketSegment = requireCatalogMarketSegment(updates.market_segment);

  const { error } = await supabaseClient
    .from("catalog_products")
    .update({
      product_code: normalizeCatalogDisplayCode(updates.product_code, updates.brand),
      brand_id: brandId,
      description: updates.description ? normalizeCatalogDescription(updates.description) : null,
      oem_no: sanitizeCatalogOemNumbers(updates.oem_no),
      vehicle: updates.vehicle?.trim() || null,
      hs_code: updates.hs_code,
      origin: updates.origin ? normalizeCatalogOrigin(updates.origin) : null,
      market_segment: marketSegment,
      weight_kg: updates.weight_kg,
      lifecycle_status: normalizeCatalogLifecycleStatus(updates.lifecycle_status),
      lifecycle_note: updates.lifecycle_note?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", productId);

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Catalog update failed"));
}

export async function createCloudCatalogRow(input: {
  product_code: string;
  brand: string;
  description: string | null;
  oem_no: string | null;
  vehicle: string | null;
  hs_code: string | null;
  origin: string | null;
  market_segment: string | null;
  weight_kg: number | null;
  lifecycle_status?: string | null;
  lifecycle_note?: string | null;
}) {
  const organizationId = await getCurrentOrgId();
  const brandId = await resolveOrCreateBrandId(input.brand);
  const marketSegment = requireCatalogMarketSegment(input.market_segment);

  const { error } = await supabaseClient.from("catalog_products").insert({
    organization_id: organizationId,
    brand_id: brandId,
    product_code: normalizeCatalogDisplayCode(input.product_code, input.brand),
    description: input.description ? normalizeCatalogDescription(input.description) : null,
    oem_no: sanitizeCatalogOemNumbers(input.oem_no),
    vehicle: input.vehicle?.trim() || null,
    hs_code: input.hs_code,
    origin: input.origin ? normalizeCatalogOrigin(input.origin) : null,
    market_segment: marketSegment,
    weight_kg: input.weight_kg,
    lifecycle_status: normalizeCatalogLifecycleStatus(input.lifecycle_status),
    lifecycle_note: input.lifecycle_note?.trim() || null,
  });

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Catalog create failed"));
}

export async function deleteCloudCatalogRow(productId: string) {
  const data = await callAppRpc<{
    deleted?: boolean;
    reason?: string;
    product_id?: string;
    product_code?: string;
    brand?: string;
    reference_summary?: Array<{ key?: string; label?: string; count?: number }>;
  }>("delete_catalog_product_guarded", {
    product_id: productId,
  });

  if (!data?.deleted) {
    throw new CatalogDeleteBlockedError({
      productId: String(data?.product_id || productId),
      productCode: String(data?.product_code || ""),
      brand: String(data?.brand || ""),
      references: Array.isArray(data?.reference_summary)
        ? data.reference_summary.map((row) => ({
            key: String(row.key || ""),
            label: String(row.label || ""),
            count: Number(row.count || 0),
          }))
        : [],
    });
  }
}

export type CatalogDeleteReferenceSummary = {
  key: string;
  label: string;
  count: number;
};

export class CatalogDeleteBlockedError extends Error {
  productId: string;
  productCode: string;
  brand: string;
  references: CatalogDeleteReferenceSummary[];

  constructor(input: {
    productId: string;
    productCode: string;
    brand: string;
    references: CatalogDeleteReferenceSummary[];
  }) {
    super("Catalog delete blocked");
    this.name = "CatalogDeleteBlockedError";
    this.productId = input.productId;
    this.productCode = input.productCode;
    this.brand = input.brand;
    this.references = input.references;
  }
}

export async function fetchCatalogExportRows(input: { brandName: string; search?: string; marketSegment?: string }) {
  const organizationId = await getCurrentOrgId();
  const brandName = normalizeBrandName(input.brandName);
  if (!brandName) {
    throw new Error("Brand is required for catalog export");
  }

  const { data: brandRow, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .ilike("name", brandName)
    .limit(1)
    .maybeSingle();

  if (brandError) {
    throw new Error(sanitizeUserFacingMessage(brandError.message, "Brand lookup failed"));
  }
  if (!brandRow?.id) {
    throw new Error(`Brand not found: ${brandName}`);
  }

  const allRows: Array<{
    product_code: string;
    image_url?: string | null;
    description: string | null;
    oem_no: string | null;
    vehicle: string | null;
    hs_code: string | null;
    origin: string | null;
    market_segment: string | null;
    weight_kg: number | null;
    lifecycle_status: string | null;
    lifecycle_note: string | null;
  }> = [];

  let from = 0;
  const pageSize = 1000;

  while (true) {
    const search = input.search?.trim();
    const normalizedSearch = normalizePartCode(search || "");
    const marketSegment = normalizeCatalogMarketSegment(input.marketSegment);
    const buildQuery = (selectClause: string, mode: CatalogSearchMode) => {
      let query = supabaseClient
        .from("catalog_products")
        .select(selectClause)
        .eq("brand_id", brandRow.id)
        .order("product_code", { ascending: true })
        .range(from, from + pageSize - 1);

      if (marketSegment) {
        query = query.eq("market_segment", marketSegment);
      }
      if (search) {
        query = query.or(buildCatalogSearchOr(search, normalizedSearch, mode));
      }

      return query;
    };

    let { data, error } = await buildQuery(
      "product_code,image_url,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note",
      "strict",
    );
    if (error && isMissingCatalogImageError(error)) {
      ({ data, error } = await buildQuery(
        "product_code,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note",
        "strict",
      ));
    }
    if (!error && search && shouldRunLooseOriginalNumberSearch(search) && !(data || []).length) {
      ({ data, error } = await buildQuery(
        "product_code,image_url,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note",
        "loose",
      ));
      if (error && isMissingCatalogImageError(error)) {
        ({ data, error } = await buildQuery(
          "product_code,description,oem_no,vehicle,hs_code,origin,market_segment,weight_kg,lifecycle_status,lifecycle_note",
          "loose",
        ));
      }
    }
    if (error) {
      throw new Error(sanitizeUserFacingMessage(error.message, "Catalog export load failed"));
    }

    const batch = (data || []) as unknown as typeof allRows;
    allRows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return allRows.map((row) => ({
    product_code: row.product_code,
    brand: brandRow.name as string,
    image_url: row.image_url || "",
    description: row.description || "",
    oem_no: sanitizeCatalogOemNumbers(row.oem_no || ""),
    vehicle: row.vehicle || "",
    hs_code: row.hs_code || "",
    origin: row.origin || "",
    market_segment: normalizeCatalogMarketSegment(row.market_segment),
    weight_kg: row.weight_kg,
    lifecycle_status: normalizeCatalogLifecycleStatus(row.lifecycle_status),
    lifecycle_note: row.lifecycle_note || "",
  }));
}

export async function fetchCatalogRowsByCodes(input: { brandName: string; codes: string[]; marketSegment?: string }): Promise<CatalogRow[]> {
  const organizationId = await getCurrentOrgId();
  const brandName = normalizeBrandName(input.brandName);
  const normalizedCodes = Array.from(
    new Set(
      input.codes
        .map((code) => String(code || "").trim())
        .filter(Boolean),
    ),
  );

  if (!brandName) {
    throw new Error("Brand is required to load imported catalog rows");
  }
  if (!normalizedCodes.length) {
    return [];
  }

  const { data: brandRow, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .ilike("name", brandName)
    .limit(1)
    .maybeSingle();

  if (brandError) {
    throw new Error(sanitizeUserFacingMessage(brandError.message, "Brand lookup failed"));
  }
  if (!brandRow?.id) {
    throw new Error(`Brand not found: ${brandName}`);
  }

  const result: CatalogRow[] = [];
  const chunkSize = 500;
  const marketSegment = normalizeCatalogMarketSegment(input.marketSegment);

  for (let index = 0; index < normalizedCodes.length; index += chunkSize) {
    const codeChunk = normalizedCodes.slice(index, index + chunkSize);
    const normalizedCodeChunk = Array.from(new Set(codeChunk.map((code) => normalizePartCode(code)).filter(Boolean)));
    const buildQuery = (selectClause: string, column: "product_code" | "normalized_code", values: string[]) =>
      supabaseClient
        .from("catalog_products")
        .select(selectClause)
        .eq("organization_id", organizationId)
        .eq("brand_id", brandRow.id)
        .match(marketSegment ? { market_segment: marketSegment } : {})
        .in(column, values)
        .order("product_code", { ascending: true });

    const executeQuery = async (column: "product_code" | "normalized_code", values: string[]) => {
      let { data, error } = await buildQuery(CATALOG_SELECT_WITH_IMAGE, column, values);
      if (error && isMissingCatalogImageError(error)) {
        ({ data, error } = await buildQuery(CATALOG_SELECT_NO_IMAGE, column, values));
      }
      if (error) {
        throw new Error(sanitizeUserFacingMessage(error.message, "Imported catalog rows load failed"));
      }
      return (data ?? []) as unknown as Array<{
        id: string;
        product_code: string;
        image_url?: string | null;
        description: string | null;
        oem_no: string | null;
        vehicle: string | null;
        hs_code: string | null;
        origin: string | null;
        market_segment: string | null;
        weight_kg: number | null;
        lifecycle_status: string | null;
        lifecycle_note: string | null;
      }>;
    };

    const exactRows = await executeQuery("product_code", codeChunk);
    const normalizedRows = normalizedCodeChunk.length ? await executeQuery("normalized_code", normalizedCodeChunk) : [];
    const mergedRows = Array.from(
      new Map(
        [...exactRows, ...normalizedRows].map((row) => [String(row.id || row.product_code), row]),
      ).values(),
    );

    result.push(
      ...mergedRows.map((row) => ({
        total_count: normalizedCodes.length,
        product_id: row.id,
        product_code: row.product_code,
        brand: brandRow.name as string,
        image_url: row.image_url ?? "",
        description: row.description ?? "",
        oem_no: sanitizeCatalogOemNumbers(row.oem_no ?? ""),
        vehicle: row.vehicle ?? "",
        hs_code: row.hs_code ?? "",
        origin: row.origin ?? "",
        market_segment: normalizeCatalogMarketSegment(row.market_segment),
        weight_kg: row.weight_kg,
        lifecycle_status: normalizeCatalogLifecycleStatus(row.lifecycle_status),
        lifecycle_note: row.lifecycle_note ?? "",
      })),
    );
  }

  return result.sort((left, right) => left.product_code.localeCompare(right.product_code));
}
