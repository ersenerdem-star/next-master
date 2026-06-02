import { callAppRpc } from "./appRpcApi";
import { supabaseClient } from "./supabaseClient";
import type { SupplierBrandSummaryRow, SupplierPriceRow, SupplierSummary } from "../../types/suppliers";
import { buildLooseOriginalNumberPattern, normalizeOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";

type SupplierSearchMode = "strict" | "loose";

function shouldRunLooseOriginalNumberSearch(search: string) {
  return normalizeOriginalNumberSearch(search).length >= 6;
}

function buildSupplierSearchOr(search: string, normalizedSearch: string, mode: SupplierSearchMode) {
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(search);
  const clauses = [
    `product_code.ilike.%${search}%`,
    `description.ilike.%${search}%`,
    `oem_no.ilike.%${search}%`,
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

export async function fetchCloudSuppliers(): Promise<SupplierSummary[]> {
  const data = await callAppRpc<SupplierSummary[]>("list_cloud_suppliers");
  return (data || []) as SupplierSummary[];
}

export async function fetchCloudSupplierBrandSummary(inputSupplierId: string | null): Promise<SupplierBrandSummaryRow[]> {
  const data = await callAppRpc<SupplierBrandSummaryRow[]>("cloud_supplier_brand_summary", {
    input_supplier_id: inputSupplierId,
  });

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
  const data = await callAppRpc<SupplierPriceRow[]>("cloud_supplier_price_page", {
    input_supplier_id: supplierId,
    input_search: search,
    input_page: page,
    input_page_size: pageSize,
    input_freshness: freshness,
  });

  return (data || []) as SupplierPriceRow[];
}

export async function fetchCloudSupplierPricesAcrossSuppliers(input: {
  suppliers: SupplierSummary[];
  search: string;
  freshness: string;
  pageSizePerSupplier?: number;
}): Promise<SupplierPriceRow[]> {
  const search = input.search.trim();
  if (!search) {
    throw new Error("Search is required when All suppliers is selected");
  }

  const activeSuppliers = (input.suppliers || []).filter((supplier) => supplier.is_active);
  const pageSizePerSupplier = Math.min(Math.max(input.pageSizePerSupplier || 10, 1), 50);
  const normalizedSearch = normalizePartCode(search) || search;

  const results = await Promise.allSettled(
    activeSuppliers.map(async (supplier) => {
      const rows = await fetchCloudSupplierPrices({
        supplierId: supplier.supplier_id,
        search,
        freshness: input.freshness,
        page: 1,
        pageSize: pageSizePerSupplier,
      });
      return { supplier, rows };
    }),
  );

  const merged: SupplierPriceRow[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { supplier, rows } = result.value;
    if (rows.length) {
      merged.push(
        ...rows.map((row) => ({
          ...row,
          supplier_name: supplier.name,
          is_placeholder: false,
        })),
      );
      continue;
    }
    if (input.freshness === "all") {
      merged.push({
        total_count: 0,
        price_id: `missing-${supplier.supplier_id}-${normalizedSearch}`,
        supplier_name: supplier.name,
        product_code: search,
        brand: null,
        description: null,
        oem_no: null,
        buy_price: null,
        currency: null,
        price_date: null,
        moq: null,
        lead_time_days: null,
        notes: null,
        freshness: "no price",
        is_placeholder: true,
      });
    }
  }

  merged.sort((left, right) => {
    const leftRank = left.buy_price == null ? 1 : 0;
    const rightRank = right.buy_price == null ? 1 : 0;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const supplierCompare = String(left.supplier_name || "").localeCompare(String(right.supplier_name || ""));
    if (supplierCompare !== 0) return supplierCompare;
    const priceCompare = Number(left.buy_price ?? Number.MAX_SAFE_INTEGER) - Number(right.buy_price ?? Number.MAX_SAFE_INTEGER);
    if (priceCompare !== 0) return priceCompare;
    return String(left.product_code || "").localeCompare(String(right.product_code || ""));
  });

  const totalCount = merged.length;
  return merged.map((row) => ({
    ...row,
    total_count: totalCount,
  }));
}

export async function deleteSupplierBrandSummaryRow(input: { supplierId: string; brand: string }) {
  const data = await callAppRpc<number>("deactivate_supplier_prices_by_filter", {
    input_supplier_id: input.supplierId,
    input_brand: input.brand,
    input_price_date: null,
    input_search: "",
  });

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
    const buildQuery = (mode: SupplierSearchMode) => {
      let query = supabaseClient
        .from("supplier_prices")
        .select("id,product_code,description,oem_no,buy_price,currency,valid_from,moq,lead_time_days,notes")
        .eq("supplier_id", input.supplierId)
        .eq("brand_id", brandRow.id)
        .eq("is_active", true)
        .order("product_code", { ascending: true })
        .range(from, from + pageSize - 1);

      if (search) {
        query = query.or(buildSupplierSearchOr(search, normalizedSearch, mode));
      }

      return query;
    };

    let { data, error } = await buildQuery("strict");
    if (!error && search && shouldRunLooseOriginalNumberSearch(search) && !(data || []).length) {
      ({ data, error } = await buildQuery("loose"));
    }
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
