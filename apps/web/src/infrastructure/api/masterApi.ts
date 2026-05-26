import { supabaseClient } from "./supabaseClient";
import { buildLooseOriginalNumberPattern, normalizeOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";
import type { MasterRow } from "../../types/master";

type MasterParams = {
  search: string;
  brand: string;
  scope: string;
  page?: number;
  pageSize?: number;
  marginA?: number;
  marginB?: number;
};

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
  normalized_code: string | null;
  supplier_id: string | null;
  buy_price: number | null;
  valid_from: string | null;
  updated_at: string | null;
  notes: string | null;
  suppliers?: { name?: string | null } | null;
};

function buildMasterSearchOr(rawSearch: string, normalizedSearch: string) {
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(rawSearch);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(rawSearch);
  const clauses = [
    `product_code.ilike.%${rawSearch}%`,
    `description.ilike.%${rawSearch}%`,
    `oem_no.ilike.%${rawSearch}%`,
  ];
  if (looseOriginalPattern.length >= 6) {
    clauses.push(`oem_no.ilike.%${looseOriginalPattern}%`);
  }
  if (normalizedSearch.length >= 3) {
    clauses.push(
      `normalized_code.eq.${normalizedSearch}`,
      `normalized_oem.eq.${normalizedSearch}`,
      `normalized_code.like.%${normalizedSearch}%`,
      `normalized_oem.like.%${normalizedSearch}%`,
    );
  }
  if (normalizedOriginalSearch.length >= 3 && normalizedOriginalSearch !== normalizedSearch) {
    clauses.push(
      `normalized_oem.eq.${normalizedOriginalSearch}`,
      `normalized_oem.like.%${normalizedOriginalSearch}%`,
    );
  }
  return clauses.join(",");
}

async function getCurrentOrgId() {
  const { data: authData, error: authError } = await supabaseClient.auth.getUser();
  if (authError) throw new Error(authError.message || "Failed to read current user");
  const userId = authData.user?.id;
  if (!userId) throw new Error("No authenticated user found");

  const { data, error } = await supabaseClient.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  if (error) throw new Error(error.message || "Failed to resolve organization");
  const orgId = data?.organization_id as string | undefined;
  if (!orgId) throw new Error("No organization found for current user");
  return orgId;
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

  if (error) throw new Error(error.message || "Brand lookup failed");
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
  return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
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
    .select("id,product_code,normalized_code,normalized_oem,description,oem_no,hs_code,origin,weight_kg", { count: "exact" })
    .eq("organization_id", input.organizationId)
    .eq("brand_id", input.brandId)
    .order("product_code", { ascending: true })
    .range(from, to);

  if (rawSearch) {
    query = query.or(buildMasterSearchOr(rawSearch, normalizedSearch));
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message || "Catalog master lookup failed");
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

  const codeChunks = chunkValues(
    [...new Set(input.rows.map((row) => String(row.normalized_code || "")).filter(Boolean))],
    200,
  );
  const supplierRows: SupplierPriceLookupRow[] = [];

  for (const chunk of codeChunks) {
    const { data, error } = await supabaseClient
      .from("supplier_prices")
      .select("normalized_code,supplier_id,buy_price,valid_from,updated_at,notes,suppliers(name)")
      .eq("organization_id", input.organizationId)
      .eq("brand_id", input.brand.id)
      .eq("is_active", true)
      .not("buy_price", "is", null)
      .in("normalized_code", chunk);

    if (error) {
      throw new Error(error.message || "Supplier enrichment failed");
    }
    supplierRows.push(...((data || []) as SupplierPriceLookupRow[]));
  }

  const supplierStats = new Map<
    string,
    {
      best: SupplierPriceLookupRow | null;
      supplierIds: Set<string>;
      notes: Set<string>;
    }
  >();

  for (const row of supplierRows) {
    const normalizedCode = String(row.normalized_code || "");
    if (!normalizedCode) continue;
    const current = supplierStats.get(normalizedCode) || {
      best: null,
      supplierIds: new Set<string>(),
      notes: new Set<string>(),
    };
    if (row.supplier_id) current.supplierIds.add(String(row.supplier_id));
    const note = String(row.notes || "").trim();
    if (note) current.notes.add(note);
    if (!current.best || comparePriceRows(row, current.best) < 0) {
      current.best = row;
    }
    supplierStats.set(normalizedCode, current);
  }

  return input.rows.map((row) => {
    const normalizedCode = String(row.normalized_code || "");
    const stats = supplierStats.get(normalizedCode);
    const cheapestPrice = stats?.best?.buy_price == null ? null : Number(stats.best.buy_price);
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
      cheapest_supplier: String(stats?.best?.suppliers?.name || ""),
      cheapest_price: cheapestPrice,
      price_date: String(stats?.best?.valid_from || ""),
      sales_a: cheapestPrice == null ? null : Math.round(cheapestPrice * (1 + input.marginA) * 100) / 100,
      sales_b: cheapestPrice == null ? null : Math.round(cheapestPrice * (1 + input.marginB) * 100) / 100,
      supplier_count: stats?.supplierIds.size ?? 0,
      catalog_status: "In Catalog",
      notes: stats?.notes.size ? [...stats.notes].join(" | ") : null,
      has_notes: Boolean(stats?.notes.size),
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
  if (scope === "catalog" && brand.trim()) {
    return fetchCatalogOnlyMaster({
      search,
      brand,
      page,
      pageSize,
      marginA,
      marginB,
    });
  }

  const { data, error } = await supabaseClient.rpc("cloud_master_page", {
    input_search: search,
    input_brand: brand,
    input_page: page,
    input_page_size: pageSize,
    input_margin_a: marginA,
    input_margin_b: marginB,
    input_scope: scope,
  });

  if (error) {
    throw new Error(error.message || "Failed to load master rows");
  }

  return (data || []) as MasterRow[];
}

export async function fetchAllCloudMaster(params: Omit<MasterParams, "page" | "pageSize">): Promise<MasterRow[]> {
  if (params.scope === "catalog" && params.brand.trim()) {
    const pageSize = 500;
    let page = 1;
    const allRows: MasterRow[] = [];

    while (true) {
      const rows = await fetchCatalogOnlyMaster({
        search: params.search,
        brand: params.brand,
        page,
        pageSize,
        marginA: params.marginA ?? 0.1,
        marginB: params.marginB ?? 0.15,
      });
      allRows.push(...rows);
      if (rows.length < pageSize) break;
      page += 1;
    }

    return allRows.map((row) => ({
      ...row,
      total_count: allRows.length,
    }));
  }

  const pageSize = 1000;
  let page = 1;
  const allRows: MasterRow[] = [];

  while (true) {
    const rows = await fetchCloudMaster({
      ...params,
      page,
      pageSize,
    });
    allRows.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
  }

  return allRows;
}
