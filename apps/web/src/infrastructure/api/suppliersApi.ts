import { supabaseClient } from "./supabaseClient";
import type { SupplierBrandSummaryRow, SupplierPriceRow, SupplierSummary } from "../../types/suppliers";
import { buildLooseOriginalNumberPattern, normalizeOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";

function buildSupplierSearchOr(search: string, normalizedSearch: string) {
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(search);
  const clauses = [
    `product_code.ilike.%${search}%`,
    `description.ilike.%${search}%`,
    `oem_no.ilike.%${search}%`,
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

export async function fetchCloudSuppliers(): Promise<SupplierSummary[]> {
  const { data, error } = await supabaseClient.rpc("list_cloud_suppliers");

  if (error) {
    throw new Error(error.message || "Failed to load suppliers");
  }

  return (data || []) as SupplierSummary[];
}

export async function fetchCloudSupplierBrandSummary(inputSupplierId: string | null): Promise<SupplierBrandSummaryRow[]> {
  const { data, error } = await supabaseClient.rpc("cloud_supplier_brand_summary", {
    input_supplier_id: inputSupplierId,
  });

  if (error) {
    throw new Error(error.message || "Failed to load supplier brand summary");
  }

  return (data || []) as SupplierBrandSummaryRow[];
}

export async function fetchCloudSupplierBrandSummaryAll(inputSuppliers?: SupplierSummary[]): Promise<SupplierBrandSummaryRow[]> {
  const suppliers = inputSuppliers?.length ? inputSuppliers : await fetchCloudSuppliers();
  const batches = await Promise.allSettled(
    suppliers.map((supplier) => fetchCloudSupplierBrandSummary(supplier.supplier_id)),
  );
  const rows = batches.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  return rows.sort((a, b) => a.supplier_name.localeCompare(b.supplier_name) || b.part_count - a.part_count || a.brand.localeCompare(b.brand));
}

type SupplierPriceParams = {
  supplierId: string;
  search: string;
  freshness: string;
  page?: number;
  pageSize?: number;
};

export async function fetchCloudSupplierPrices({
  supplierId,
  search,
  freshness,
  page = 1,
  pageSize = 50,
}: SupplierPriceParams): Promise<SupplierPriceRow[]> {
  const { data, error } = await supabaseClient.rpc("cloud_supplier_price_page", {
    input_supplier_id: supplierId,
    input_search: search,
    input_page: page,
    input_page_size: pageSize,
    input_freshness: freshness,
  });

  if (error) {
    throw new Error(error.message || "Failed to load supplier prices");
  }

  return (data || []) as SupplierPriceRow[];
}

export async function deleteSupplierBrandSummaryRow(input: { supplierId: string; brand: string }) {
  const { data, error } = await supabaseClient.rpc("deactivate_supplier_prices_by_filter", {
    input_supplier_id: input.supplierId,
    input_brand: input.brand,
    input_price_date: null,
    input_search: "",
  });

  if (error) {
    throw new Error(error.message || "Supplier brand delete failed");
  }

  return Number(data || 0);
}

export async function fetchSupplierExportRows(input: { supplierId: string; brandName: string; search?: string }) {
  if (!input.supplierId) {
    throw new Error("Supplier is required for supplier export");
  }
  const brandName = input.brandName.trim();
  if (!brandName) {
    throw new Error("Brand is required for supplier export");
  }

  const { data: brandRow, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .ilike("name", brandName)
    .limit(1)
    .maybeSingle();

  if (brandError) {
    throw new Error(brandError.message || "Brand lookup failed");
  }
  if (!brandRow?.id) {
    throw new Error(`Brand not found: ${brandName}`);
  }

  const allRows: SupplierPriceRow[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const search = input.search?.trim();
    const normalizedSearch = normalizePartCode(search || "");
    let query = supabaseClient
      .from("supplier_prices")
      .select("id,product_code,description,oem_no,buy_price,currency,valid_from,moq,lead_time_days,notes")
      .eq("supplier_id", input.supplierId)
      .eq("brand_id", brandRow.id)
      .eq("is_active", true)
      .order("product_code", { ascending: true })
      .range(from, from + pageSize - 1);

    if (search) {
      query = query.or(buildSupplierSearchOr(search, normalizedSearch));
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message || "Supplier export load failed");
    }

    const batch = (data || []).map((row) => ({
      total_count: 0,
      price_id: row.id as string,
      product_code: row.product_code as string,
      brand: brandRow.name as string,
      description: (row.description as string | null) || "",
      oem_no: (row.oem_no as string | null) || "",
      buy_price: (row.buy_price as number | null) ?? null,
      currency: (row.currency as string | null) || "EUR",
      price_date: (row.valid_from as string | null) || "",
      moq: (row.moq as number | null) ?? null,
      lead_time_days: (row.lead_time_days as number | null) ?? null,
      notes: (row.notes as string | null) || "",
      freshness: null,
    })) as SupplierPriceRow[];

    allRows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}
