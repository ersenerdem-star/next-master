import type { CatalogRow } from "../../types/catalog";
import { normalizeCatalogDescription, normalizeCatalogDisplayCode } from "../../domain/shared/catalogFormatting";
import { normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { buildLooseOriginalNumberPattern, normalizeOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";
import { callAppRpc } from "./appRpcApi";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";

const CATALOG_SELECT_WITH_IMAGE =
  "id,product_code,image_url,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note";
const CATALOG_SELECT_NO_IMAGE =
  "id,product_code,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note";
const CATALOG_GLOBAL_SELECT_WITH_IMAGE =
  "id,product_code,image_url,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note,brands!inner(name)";
const CATALOG_GLOBAL_SELECT_NO_IMAGE =
  "id,product_code,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note,brands!inner(name)";

type CatalogSearchMode = "strict" | "loose";

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
    clauses.push(`description.ilike.%${escaped}%`);
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

async function resolveBrandId(brandName: string) {
  const organizationId = await getCurrentOrgId();
  const normalizedBrand = brandName.trim();
  if (!normalizedBrand) {
    throw new Error("Brand is required");
  }

  const { data: brandRow, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .ilike("name", normalizedBrand)
    .limit(1)
    .maybeSingle();

  if (brandError) throw new Error(brandError.message || "Brand lookup failed");
  if (!brandRow?.id) throw new Error(`Brand not found: ${normalizedBrand}`);
  return brandRow.id as string;
}

async function resolveOrCreateBrandId(brandName: string) {
  const normalizedBrand = brandName.trim();
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

  if (error) throw new Error(error.message || "Brand create failed");
  if (!data?.id) throw new Error(`Brand could not be created: ${normalizedBrand}`);
  return data.id as string;
}

export async function fetchCloudCatalog(input: {
  search: string;
  brandName?: string;
  page?: number;
  pageSize?: number;
}): Promise<CatalogRow[]> {
  const brandName = input.brandName?.trim();
  if (brandName) {
    const brandId = await resolveBrandId(brandName);
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const search = input.search.trim();
    const normalizedSearch = normalizePartCode(search);
    const buildQuery = (selectClause: string, mode: CatalogSearchMode) => {
      let query = supabaseClient
        .from("catalog_products")
        .select(selectClause, { count: "planned" })
        .eq("brand_id", brandId)
        .order("product_code", { ascending: true })
        .range(from, to);

      if (search) {
        query = query.or(buildCatalogSearchOr(search, normalizedSearch, mode));
      }

      return query;
    };

    let { data, error, count } = await buildQuery(CATALOG_SELECT_WITH_IMAGE, "strict");
    if (error && isMissingCatalogImageError(error)) {
      ({ data, error, count } = await buildQuery(CATALOG_SELECT_NO_IMAGE, "strict"));
    }
    if (!error && search && shouldRunLooseOriginalNumberSearch(search) && !(data || []).length) {
      ({ data, error, count } = await buildQuery(CATALOG_SELECT_WITH_IMAGE, "loose"));
      if (error && isMissingCatalogImageError(error)) {
        ({ data, error, count } = await buildQuery(CATALOG_SELECT_NO_IMAGE, "loose"));
      }
    }
    if (error) throw error;

    return ((data ?? []) as unknown as Array<{
      id: string;
      product_code: string;
      image_url?: string | null;
      description: string | null;
      oem_no: string | null;
      hs_code: string | null;
      origin: string | null;
      weight_kg: number | null;
      lifecycle_status: string | null;
      lifecycle_note: string | null;
    }>).map((row) => ({
      total_count: count ?? 0,
      product_id: row.id,
      product_code: row.product_code,
      brand: brandName,
      image_url: row.image_url ?? "",
      description: row.description ?? "",
      oem_no: row.oem_no ?? "",
      hs_code: row.hs_code ?? "",
      origin: row.origin ?? "",
      weight_kg: row.weight_kg,
      lifecycle_status: normalizeCatalogLifecycleStatus(row.lifecycle_status),
      lifecycle_note: row.lifecycle_note ?? "",
    }));
  }

  if (input.search.trim()) {
    const organizationId = await getCurrentOrgId();
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const search = input.search.trim();
    const normalizedSearch = normalizePartCode(search);

    const buildGlobalQuery = (selectClause: string, mode: CatalogSearchMode) => {
      return supabaseClient
        .from("catalog_products")
        .select(selectClause, { count: "planned" })
        .eq("organization_id", organizationId)
        .order("product_code", { ascending: true })
        .range(from, to)
        .or(buildCatalogSearchOr(search, normalizedSearch, mode));
    };

    let { data, error, count } = await buildGlobalQuery(CATALOG_GLOBAL_SELECT_WITH_IMAGE, "strict");
    if (error && isMissingCatalogImageError(error)) {
      ({ data, error, count } = await buildGlobalQuery(CATALOG_GLOBAL_SELECT_NO_IMAGE, "strict"));
    }
    if (!error && shouldRunLooseOriginalNumberSearch(search) && !(data || []).length) {
      ({ data, error, count } = await buildGlobalQuery(CATALOG_GLOBAL_SELECT_WITH_IMAGE, "loose"));
      if (error && isMissingCatalogImageError(error)) {
        ({ data, error, count } = await buildGlobalQuery(CATALOG_GLOBAL_SELECT_NO_IMAGE, "loose"));
      }
    }
    if (error) throw error;

    return ((data ?? []) as unknown as Array<{
      id: string;
      product_code: string;
      image_url?: string | null;
      description: string | null;
      oem_no: string | null;
      hs_code: string | null;
      origin: string | null;
      weight_kg: number | null;
      lifecycle_status: string | null;
      lifecycle_note: string | null;
      brands?: { name?: string | null } | null;
    }>).map((row) => ({
      total_count: count ?? 0,
      product_id: String(row.id || ""),
      product_code: String(row.product_code || ""),
      brand: String(row.brands?.name || ""),
      image_url: String(row.image_url || ""),
      description: String(row.description || ""),
      oem_no: String(row.oem_no || ""),
      hs_code: String(row.hs_code || ""),
      origin: String(row.origin || ""),
      weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
      lifecycle_status: normalizeCatalogLifecycleStatus(String(row.lifecycle_status || "")),
      lifecycle_note: String(row.lifecycle_note || ""),
    }));
  }

  const data = await callAppRpc<Array<Record<string, unknown>>>("cloud_catalog_page", {
    input_search: input.search,
    input_page: input.page ?? 1,
    input_page_size: input.pageSize ?? 50,
  });
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    total_count: Number(row.total_count ?? 0),
    product_id: String(row.product_id || ""),
    product_code: String(row.product_code || ""),
    brand: String(row.brand || ""),
    image_url: String(row.image_url || ""),
    description: String(row.description || ""),
    oem_no: String(row.oem_no || ""),
    hs_code: String(row.hs_code || ""),
    origin: String(row.origin || ""),
    weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
    lifecycle_status: normalizeCatalogLifecycleStatus(String(row.lifecycle_status || "")),
    lifecycle_note: String(row.lifecycle_note || ""),
  }));
}

export async function updateCloudCatalogRow(
  productId: string,
  updates: {
    product_code: string;
    brand: string;
    description: string | null;
    oem_no: string | null;
    hs_code: string | null;
    origin: string | null;
    weight_kg: number | null;
    lifecycle_status: string | null;
    lifecycle_note: string | null;
  },
) {
  const brandId = await resolveBrandId(updates.brand);

  const { error } = await supabaseClient
    .from("catalog_products")
    .update({
      product_code: normalizeCatalogDisplayCode(updates.product_code, updates.brand),
      brand_id: brandId,
      description: updates.description ? normalizeCatalogDescription(updates.description) : null,
      oem_no: updates.oem_no,
      hs_code: updates.hs_code,
      origin: updates.origin,
      weight_kg: updates.weight_kg,
      lifecycle_status: normalizeCatalogLifecycleStatus(updates.lifecycle_status),
      lifecycle_note: updates.lifecycle_note?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", productId);

  if (error) throw new Error(error.message || "Catalog update failed");
}

export async function createCloudCatalogRow(input: {
  product_code: string;
  brand: string;
  description: string | null;
  oem_no: string | null;
  hs_code: string | null;
  origin: string | null;
  weight_kg: number | null;
  lifecycle_status?: string | null;
  lifecycle_note?: string | null;
}) {
  const organizationId = await getCurrentOrgId();
  const brandId = await resolveOrCreateBrandId(input.brand);

  const { error } = await supabaseClient.from("catalog_products").insert({
    organization_id: organizationId,
    brand_id: brandId,
    product_code: normalizeCatalogDisplayCode(input.product_code, input.brand),
    description: input.description ? normalizeCatalogDescription(input.description) : null,
    oem_no: input.oem_no,
    hs_code: input.hs_code,
    origin: input.origin,
    weight_kg: input.weight_kg,
    lifecycle_status: normalizeCatalogLifecycleStatus(input.lifecycle_status),
    lifecycle_note: input.lifecycle_note?.trim() || null,
  });

  if (error) throw new Error(error.message || "Catalog create failed");
}

export async function deleteCloudCatalogRow(productId: string) {
  const { error } = await supabaseClient.from("catalog_products").delete().eq("id", productId);
  if (error) throw new Error(error.message || "Catalog delete failed");
}

export async function fetchCatalogExportRows(input: { brandName: string; search?: string }) {
  const organizationId = await getCurrentOrgId();
  const brandName = input.brandName.trim();
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
    throw new Error(brandError.message || "Brand lookup failed");
  }
  if (!brandRow?.id) {
    throw new Error(`Brand not found: ${brandName}`);
  }

  const allRows: Array<{
    product_code: string;
    image_url?: string | null;
    description: string | null;
    oem_no: string | null;
    hs_code: string | null;
    origin: string | null;
    weight_kg: number | null;
    lifecycle_status: string | null;
    lifecycle_note: string | null;
  }> = [];

  let from = 0;
  const pageSize = 1000;

  while (true) {
    const search = input.search?.trim();
    const normalizedSearch = normalizePartCode(search || "");
    const buildQuery = (selectClause: string, mode: CatalogSearchMode) => {
      let query = supabaseClient
        .from("catalog_products")
        .select(selectClause)
        .eq("brand_id", brandRow.id)
        .order("product_code", { ascending: true })
        .range(from, from + pageSize - 1);

      if (search) {
        query = query.or(buildCatalogSearchOr(search, normalizedSearch, mode));
      }

      return query;
    };

    let { data, error } = await buildQuery(
      "product_code,image_url,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note",
      "strict",
    );
    if (error && isMissingCatalogImageError(error)) {
      ({ data, error } = await buildQuery(
        "product_code,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note",
        "strict",
      ));
    }
    if (!error && search && shouldRunLooseOriginalNumberSearch(search) && !(data || []).length) {
      ({ data, error } = await buildQuery(
        "product_code,image_url,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note",
        "loose",
      ));
      if (error && isMissingCatalogImageError(error)) {
        ({ data, error } = await buildQuery(
          "product_code,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note",
          "loose",
        ));
      }
    }
    if (error) {
      throw new Error(error.message || "Catalog export load failed");
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
    oem_no: row.oem_no || "",
    hs_code: row.hs_code || "",
    origin: row.origin || "",
    weight_kg: row.weight_kg,
    lifecycle_status: normalizeCatalogLifecycleStatus(row.lifecycle_status),
    lifecycle_note: row.lifecycle_note || "",
  }));
}

export async function fetchCatalogRowsByCodes(input: { brandName: string; codes: string[] }): Promise<CatalogRow[]> {
  const organizationId = await getCurrentOrgId();
  const brandName = input.brandName.trim();
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
    throw new Error(brandError.message || "Brand lookup failed");
  }
  if (!brandRow?.id) {
    throw new Error(`Brand not found: ${brandName}`);
  }

  const result: CatalogRow[] = [];
  const chunkSize = 500;

  for (let index = 0; index < normalizedCodes.length; index += chunkSize) {
    const codeChunk = normalizedCodes.slice(index, index + chunkSize);
    const buildQuery = (selectClause: string) =>
      supabaseClient
        .from("catalog_products")
        .select(selectClause)
        .eq("organization_id", organizationId)
        .eq("brand_id", brandRow.id)
        .in("product_code", codeChunk)
        .order("product_code", { ascending: true });

    let { data, error } = await buildQuery(CATALOG_SELECT_WITH_IMAGE);
    if (error && isMissingCatalogImageError(error)) {
      ({ data, error } = await buildQuery(CATALOG_SELECT_NO_IMAGE));
    }

    if (error) {
      throw new Error(error.message || "Imported catalog rows load failed");
    }

    result.push(
      ...((data ?? []) as unknown as Array<{
        id: string;
        product_code: string;
        image_url?: string | null;
        description: string | null;
        oem_no: string | null;
        hs_code: string | null;
        origin: string | null;
        weight_kg: number | null;
        lifecycle_status: string | null;
        lifecycle_note: string | null;
      }>).map((row) => ({
        total_count: normalizedCodes.length,
        product_id: row.id,
        product_code: row.product_code,
        brand: brandRow.name as string,
        image_url: row.image_url ?? "",
        description: row.description ?? "",
        oem_no: row.oem_no ?? "",
        hs_code: row.hs_code ?? "",
        origin: row.origin ?? "",
        weight_kg: row.weight_kg,
        lifecycle_status: normalizeCatalogLifecycleStatus(row.lifecycle_status),
        lifecycle_note: row.lifecycle_note ?? "",
      })),
    );
  }

  return result.sort((left, right) => left.product_code.localeCompare(right.product_code));
}
