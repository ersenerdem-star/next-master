import { canonicalizeBrandName, normalizeBrandKey, normalizePartCode } from "../../domain/shared/normalize";
import { supabaseClient } from "./supabaseClient";

type RowLike = {
  brand?: string | null;
  product_code?: string | null;
};

function rowKey(brand: string, normalizedCode: string) {
  return `${normalizeBrandKey(brand)}|${normalizedCode}`;
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

async function fetchActiveCPriceLists(organizationId: string) {
  const { data, error } = await supabaseClient
    .from("customer_price_lists")
    .select("id,updated_at")
    .eq("organization_id", organizationId)
    .eq("list_type", "C")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message || "Failed to load active C price lists");
  }

  return (data || [])
    .map((row) => ({
      id: String(row.id || ""),
      updatedAt: String(row.updated_at || ""),
    }))
    .filter((row) => row.id);
}

export async function fetchCPriceMapForRows(rows: RowLike[]) {
  const organizationId = await getCurrentOrgId();
  const activeLists = await fetchActiveCPriceLists(organizationId);
  if (!activeLists.length || !rows.length) {
    return new Map<string, number>();
  }
  const activeListIds = activeLists.map((item) => item.id);
  const listPriority = new Map<string, number>();
  activeLists.forEach((item, index) => {
    listPriority.set(item.id, index);
  });

  const brandNames = Array.from(
    new Set(
      rows
        .map((row) => canonicalizeBrandName(String(row.brand || "")))
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

  const requestedBrands = new Set(brandNames.map((item) => normalizeBrandKey(item)));
  const brandIdToName = new Map<string, string>();
  const brandIds = (brandRows || [])
    .filter((row) => requestedBrands.has(normalizeBrandKey(String(row.name || ""))))
    .map((row) => {
      brandIdToName.set(String(row.id), String(row.name));
      return String(row.id);
    });

  if (!brandIds.length) {
    return new Map<string, number>();
  }

  const result = new Map<string, number>();
  const resultPriority = new Map<string, number>();
  const chunkSize = 500;

  for (let index = 0; index < normalizedCodes.length; index += chunkSize) {
    const codeChunk = normalizedCodes.slice(index, index + chunkSize);
    const { data, error } = await supabaseClient
      .from("customer_price_list_items")
      .select("price_list_id,brand_id,normalized_code,sell_price")
      .eq("organization_id", organizationId)
      .in("price_list_id", activeListIds)
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
      const key = rowKey(brandName, normalizedCode);
      const priority = listPriority.get(String(row.price_list_id || "")) ?? Number.MAX_SAFE_INTEGER;
      const currentPriority = resultPriority.get(key);
      if (currentPriority != null && currentPriority <= priority) return;
      result.set(key, sellPrice);
      resultPriority.set(key, priority);
    });
  }

  return result;
}

export function getCPriceForRow(priceMap: Map<string, number>, row: RowLike) {
  const brand = canonicalizeBrandName(String(row.brand || ""));
  const normalizedCode = normalizePartCode(String(row.product_code || ""));
  if (!brand || !normalizedCode) return null;
  const value = priceMap.get(rowKey(brand, normalizedCode));
  return typeof value === "number" ? value : null;
}
