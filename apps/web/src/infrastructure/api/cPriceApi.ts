import { normalizePartCode } from "../../domain/shared/normalize";
import { supabaseClient } from "./supabaseClient";

type RowLike = {
  brand?: string | null;
  product_code?: string | null;
};

function rowKey(brand: string, normalizedCode: string) {
  return `${brand.trim().toLowerCase()}|${normalizedCode}`;
}

async function getCurrentOrgId() {
  const { data: authData, error: authError } = await supabaseClient.auth.getUser();
  if (authError) {
    throw new Error(authError.message || "Failed to read current user");
  }
  const userId = authData.user?.id;
  if (!userId) {
    throw new Error("No authenticated user found");
  }

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("organization_id")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Organization lookup failed");
  }

  const organizationId = String(data?.organization_id || "");
  if (!organizationId) {
    throw new Error("No organization found for current user");
  }

  return organizationId;
}

async function fetchActiveCPriceListId() {
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("customer_price_lists")
    .select("id,name")
    .eq("organization_id", organizationId)
    .eq("list_type", "C")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load active C price list");
  }

  return (data?.id as string | undefined) || "";
}

export async function fetchCPriceMapForRows(rows: RowLike[]) {
  const activeListId = await fetchActiveCPriceListId();
  const organizationId = await getCurrentOrgId();
  if (!activeListId || !rows.length) {
    return new Map<string, number>();
  }

  const brandNames = Array.from(
    new Set(
      rows
        .map((row) => String(row.brand || "").trim())
        .filter(Boolean),
    ),
  );
  const normalizedCodes = Array.from(
    new Set(
      rows
        .map((row) => normalizePartCode(String(row.product_code || "")))
        .filter(Boolean),
    ),
  );

  if (!brandNames.length || !normalizedCodes.length) {
    return new Map<string, number>();
  }

  const { data: brandRows, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId);

  if (brandError) {
    throw new Error(brandError.message || "Failed to load brands for C prices");
  }

  const requestedBrands = new Set(brandNames.map((item) => item.trim().toLowerCase()));
  const brandIdToName = new Map<string, string>();
  const brandIds = (brandRows || [])
    .filter((row) => requestedBrands.has(String(row.name || "").trim().toLowerCase()))
    .map((row) => {
      brandIdToName.set(String(row.id), String(row.name));
      return String(row.id);
    });

  if (!brandIds.length) {
    return new Map<string, number>();
  }

  const result = new Map<string, number>();
  const chunkSize = 500;

  for (let index = 0; index < normalizedCodes.length; index += chunkSize) {
    const codeChunk = normalizedCodes.slice(index, index + chunkSize);
    const { data, error } = await supabaseClient
      .from("customer_price_list_items")
      .select("brand_id,normalized_code,sell_price")
      .eq("organization_id", organizationId)
      .eq("price_list_id", activeListId)
      .in("brand_id", brandIds)
      .in("normalized_code", codeChunk);

    if (error) {
      throw new Error(error.message || "Failed to load C price items");
    }

    (data || []).forEach((row) => {
      const brandName = brandIdToName.get(String(row.brand_id));
      const normalizedCode = String(row.normalized_code || "");
      const sellPrice = Number(row.sell_price || 0);
      if (!brandName || !normalizedCode || !Number.isFinite(sellPrice)) return;
      result.set(rowKey(brandName, normalizedCode), sellPrice);
    });
  }

  return result;
}

export function getCPriceForRow(priceMap: Map<string, number>, row: RowLike) {
  const brand = String(row.brand || "").trim();
  const normalizedCode = normalizePartCode(String(row.product_code || ""));
  if (!brand || !normalizedCode) return null;
  const value = priceMap.get(rowKey(brand, normalizedCode));
  return typeof value === "number" ? value : null;
}
