import { callAppAdminRecords } from "./appAdminRecordsApi";

export type PriceListSetting = {
  id: string;
  name: string;
  listType: "A" | "B";
  marginPercent: number | null;
  isManual: boolean;
};

export async function fetchPriceListSettings(): Promise<PriceListSetting[]> {
  const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
    resource: "priceListSettings",
    action: "list",
  });
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

export async function updateMarginPriceList(listType: "A" | "B", marginPercent: number) {
  await callAppAdminRecords({
    resource: "priceListSettings",
    action: "upsert",
    payload: { listType, marginPercent, isManual: false, name: `${listType} Price List` },
  });
}
