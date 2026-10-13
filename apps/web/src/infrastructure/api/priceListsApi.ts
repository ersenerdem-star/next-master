import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";

export type PriceListSetting = {
  id: string;
  name: string;
  listType: "A" | "B";
  marginPercent: number | null;
  isManual: boolean;
};

export async function fetchPriceListSettings(): Promise<PriceListSetting[]> {
  const orgId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("customer_price_lists")
    .select("id,name,list_type,margin_percent,is_manual,is_active,updated_at")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .in("list_type", ["A", "B"])
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(error.message || "Failed to load price list settings");
  }

  const byType = new Map<string, PriceListSetting>();
  (data || []).forEach((row) => {
    const listType = String(row.list_type || "") as "A" | "B";
    if (!["A", "B"].includes(listType) || byType.has(listType)) return;
    byType.set(listType, {
      id: String(row.id),
      name: String(row.name || `${listType} Price List`),
      listType,
      marginPercent: row.margin_percent === null ? null : Number(row.margin_percent),
      isManual: Boolean(row.is_manual),
    });
  });

  return ["A", "B"]
    .map((type) => byType.get(type))
    .filter(Boolean) as PriceListSetting[];
}

async function ensurePriceList(listType: "A" | "B", options?: { isManual?: boolean; name?: string }) {
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
