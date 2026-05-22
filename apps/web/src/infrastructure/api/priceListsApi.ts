import { normalizePartCode } from "../../domain/shared/normalize";
import { supabaseClient } from "./supabaseClient";

export type PriceListSetting = {
  id: string;
  name: string;
  listType: "A" | "B" | "C";
  marginPercent: number | null;
  isManual: boolean;
};

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
    throw new Error(error.message || "Failed to load current workspace");
  }
  const orgId = data?.organization_id as string | undefined;
  if (!orgId) {
    throw new Error("This user is not assigned to a workspace");
  }
  return orgId;
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
