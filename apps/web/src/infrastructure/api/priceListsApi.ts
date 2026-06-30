import { normalizePartCode } from "../../domain/shared/normalize";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";

export type PriceListSetting = {
  id: string;
  name: string;
  listType: "A" | "B" | "C";
  marginPercent: number | null;
  isManual: boolean;
};

export type BrandMarginPriceSummary = {
  salesPrice: number | null;
  notes: string;
};

export type CustomerPriceListExportRow = {
  product_code: string;
  brand: string;
  description: string;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  price_list_type: "A" | "B";
  sales_price: number | null;
  price_date: string | null;
  notes: string;
};

type SupplierPriceSummaryRow = {
  normalized_code: string | null;
  supplier_id: string | null;
  buy_price: number | null;
  valid_from: string | null;
  updated_at: string | null;
  notes: string | null;
};

function chunkValues<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function compareSupplierPriceRows(a: SupplierPriceSummaryRow, b: SupplierPriceSummaryRow) {
  const priceDiff = Number(a.buy_price || 0) - Number(b.buy_price || 0);
  if (priceDiff !== 0) return priceDiff;
  const validFromDiff = String(b.valid_from || "").localeCompare(String(a.valid_from || ""));
  if (validFromDiff !== 0) return validFromDiff;
  return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

async function resolveBrandRow(organizationId: string, brandName: string) {
  const trimmed = brandName.trim();
  if (!trimmed) {
    throw new Error("Brand is required");
  }

  const { data, error } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .ilike("name", trimmed)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Brand lookup failed");
  }
  if (!data?.id) {
    throw new Error(`Brand not found: ${trimmed}`);
  }

  return { id: String(data.id), name: String(data.name || trimmed) };
}

export async function fetchPriceListSettings(): Promise<PriceListSetting[]> {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("customer_price_lists")
    .select("id,name,list_type,margin_percent,is_manual,is_active,updated_at")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .in("list_type", ["A", "B", "C"])
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(error.message || "Failed to load price list settings");
  }

  const byType = new Map<string, PriceListSetting>();
  (data || []).forEach((row) => {
    const listType = String(row.list_type || "") as "A" | "B" | "C";
    if (!["A", "B", "C"].includes(listType) || byType.has(listType)) return;
    byType.set(listType, {
      id: String(row.id),
      name: String(row.name || `${listType} Price List`),
      listType,
      marginPercent: row.margin_percent === null ? null : Number(row.margin_percent),
      isManual: Boolean(row.is_manual),
    });
  });

  return ["A", "B", "C"]
    .map((type) => byType.get(type))
    .filter(Boolean) as PriceListSetting[];
}

export async function fetchBrandMarginPriceSummaries(input: {
  brandName: string;
  rows: Array<{ product_code: string | null | undefined }>;
  marginPercent: number;
}) {
  const organizationId = await getCurrentOrgId();
  const brand = await resolveBrandRow(organizationId, input.brandName);
  const normalizedCodes = Array.from(
    new Set(
      input.rows
        .map((row) => normalizePartCode(String(row.product_code || "")))
        .filter(Boolean),
    ),
  );

  if (!normalizedCodes.length) {
    return new Map<string, BrandMarginPriceSummary>();
  }

  const bestPriceByCode = new Map<string, SupplierPriceSummaryRow>();
  const notesByCode = new Map<string, Set<string>>();

  for (const codeChunk of chunkValues(normalizedCodes, 500)) {
    const { data, error } = await supabaseClient
      .from("supplier_prices")
      .select("normalized_code,supplier_id,buy_price,valid_from,updated_at,notes")
      .eq("organization_id", organizationId)
      .eq("brand_id", brand.id)
      .eq("is_active", true)
      .not("buy_price", "is", null)
      .in("normalized_code", codeChunk);

    if (error) {
      throw new Error(error.message || "Failed to load supplier pricing");
    }

    for (const row of (data || []) as SupplierPriceSummaryRow[]) {
      const normalizedCode = String(row.normalized_code || "");
      if (!normalizedCode || row.buy_price == null) continue;

      const note = String(row.notes || "").trim();
      if (note) {
        const notes = notesByCode.get(normalizedCode) || new Set<string>();
        notes.add(note);
        notesByCode.set(normalizedCode, notes);
      }

      const current = bestPriceByCode.get(normalizedCode);
      if (!current || compareSupplierPriceRows(row, current) < 0) {
        bestPriceByCode.set(normalizedCode, row);
      }
    }
  }

  const output = new Map<string, BrandMarginPriceSummary>();
  for (const normalizedCode of normalizedCodes) {
    const best = bestPriceByCode.get(normalizedCode);
    const notes = notesByCode.get(normalizedCode);
    output.set(normalizedCode, {
      salesPrice: best?.buy_price == null ? null : roundMoney(Number(best.buy_price) * (1 + input.marginPercent)),
      notes: notes?.size ? [...notes].join(" | ") : "",
    });
  }

  return output;
}

export async function fetchCustomerPriceListExportRows(input: {
  brandId: string;
  priceListType: "A" | "B";
  marginPercent: number;
  pageSize?: number;
}) {
  const rows: CustomerPriceListExportRow[] = [];
  const pageSize = Math.min(Math.max(input.pageSize || 1000, 1), 1000);
  const maxPages = 200;
  let page = 1;

  while (page <= maxPages) {
    const { data, error } = await supabaseClient.rpc("cloud_customer_price_list_export_page_fast", {
      input_brand_id: input.brandId,
      input_price_list_type: input.priceListType,
      input_margin: input.marginPercent,
      input_page: page,
      input_page_size: pageSize,
    });

    if (error) {
      throw new Error(error.message || "Failed to load customer price list export");
    }

    const batch: CustomerPriceListExportRow[] = ((data || []) as Array<Record<string, unknown>>).map((row) => {
      const priceListType: CustomerPriceListExportRow["price_list_type"] = String(row.price_list_type || input.priceListType).toUpperCase() === "B" ? "B" : "A";
      return {
        product_code: String(row.product_code || ""),
        brand: String(row.brand || ""),
        description: String(row.description || ""),
        oem_no: String(row.oem_no || ""),
        hs_code: String(row.hs_code || ""),
        origin: String(row.origin || ""),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        price_list_type: priceListType,
        sales_price: row.sales_price == null ? null : Number(row.sales_price),
        price_date: row.price_date == null ? null : String(row.price_date),
        notes: String(row.notes || ""),
      };
    });

    rows.push(...batch.filter((row) => row.product_code));
    if (batch.length < pageSize) break;
    page += 1;
  }

  if (page > maxPages) {
    throw new Error("Customer price list export exceeded the safety page limit. Narrow the brand or use a smaller export scope.");
  }

  return rows;
}

async function ensurePriceList(listType: "A" | "B" | "C", options?: { isManual?: boolean; name?: string }) {
  const orgId = await getCurrentOrgId();
  const existing = await fetchPriceListSettings();
  const match = existing.find((item) => item.listType === listType);
  if (match) {
    return { orgId, listId: match.id, name: match.name };
  }

  const { data, error } = await supabaseClient
    .from("customer_price_lists")
    .insert({
      organization_id: orgId,
      name: options?.name || `${listType} Price List`,
      list_type: listType,
      margin_percent: null,
      is_manual: Boolean(options?.isManual),
      is_active: true,
    })
    .select("id,name")
    .single();

  if (error) {
    throw new Error(error.message || `Failed to create ${listType} price list`);
  }

  return { orgId, listId: String(data.id), name: String(data.name) };
}

export async function updateMarginPriceList(listType: "A" | "B", marginPercent: number) {
  const { listId } = await ensurePriceList(listType, { isManual: false, name: `${listType} Price List` });
  const { error } = await supabaseClient
    .from("customer_price_lists")
    .update({
      margin_percent: marginPercent,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listId);

  if (error) {
    throw new Error(error.message || `Failed to update ${listType} margin`);
  }
}

async function ensureBrand(orgId: string, brandName: string) {
  const trimmed = brandName.trim();
  if (!trimmed) {
    throw new Error("Brand is required");
  }

  const { data: existing, error: lookupError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", orgId)
    .ilike("name", trimmed)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    throw new Error(lookupError.message || "Brand lookup failed");
  }
  if (existing?.id) {
    return { id: String(existing.id), name: String(existing.name) };
  }

  const { data, error } = await supabaseClient
    .from("brands")
    .insert({
      organization_id: orgId,
      name: trimmed,
    })
    .select("id,name")
    .single();

  if (error) {
    throw new Error(error.message || `Failed to create brand: ${trimmed}`);
  }

  return { id: String(data.id), name: String(data.name) };
}

export async function importCPriceList(input: {
  brandName: string;
  mode: "replace" | "merge";
  rows: Array<{ product_code: string; sell_price: number }>;
}) {
  const { orgId, listId } = await ensurePriceList("C", { isManual: true, name: "C Price List" });
  const brand = await ensureBrand(orgId, input.brandName);

  if (input.mode === "replace") {
    const { error: deleteError } = await supabaseClient
      .from("customer_price_list_items")
      .delete()
      .eq("organization_id", orgId)
      .eq("price_list_id", listId)
      .eq("brand_id", brand.id);

    if (deleteError) {
      throw new Error(deleteError.message || "Failed to clear existing C price items");
    }
  }

  const dedupedByCode = new Map<
    string,
    {
      organization_id: string;
      price_list_id: string;
      brand_id: string;
      product_code: string;
      sell_price: number;
      currency: string;
    }
  >();

  input.rows.forEach((row) => {
    const productCode = String(row.product_code || "").trim();
    const normalizedCode = normalizePartCode(productCode);
    const sellPrice = Number(row.sell_price);
    if (!normalizedCode || !Number.isFinite(sellPrice)) return;
    dedupedByCode.set(normalizedCode, {
      organization_id: orgId,
      price_list_id: listId,
      brand_id: brand.id,
      product_code: productCode,
      sell_price: sellPrice,
      currency: "EUR",
    });
  });

  const normalized = [...dedupedByCode.values()];

  if (!normalized.length) {
    throw new Error("No valid C price rows found");
  }

  const chunkSize = 1000;
  for (let index = 0; index < normalized.length; index += chunkSize) {
    const chunk = normalized.slice(index, index + chunkSize);
    const { error } = await supabaseClient
      .from("customer_price_list_items")
      .upsert(chunk, {
        onConflict: "organization_id,price_list_id,brand_id,normalized_code",
        ignoreDuplicates: false,
      });

    if (error) {
      throw new Error(error.message || "Failed to import C price rows");
    }
  }

  return {
    importedCount: input.rows.length,
    uniqueCount: normalized.length,
    duplicateCount: Math.max(0, input.rows.length - normalized.length),
    brandName: brand.name,
  };
}
