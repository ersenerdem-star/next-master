import type { BrandOption } from "../../types/brand";
import { callAppAdminRecords } from "./appAdminRecordsApi";

let brandsCache: BrandOption[] | null = null;
let brandsCachePromise: Promise<BrandOption[]> | null = null;

export function clearCloudBrandsCache() {
  brandsCache = null;
  brandsCachePromise = null;
}

export async function fetchCloudBrands(): Promise<BrandOption[]> {
  if (brandsCache) return brandsCache;
  if (brandsCachePromise) return brandsCachePromise;

  brandsCachePromise = (async () => {
    const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
      resource: "brands",
      action: "list",
    });
    const rows = (data || []).map((row) => ({
      id: String(row.id || ""),
      name: String(row.name || ""),
    }));
    brandsCache = rows;
    brandsCachePromise = null;
    return rows;
  })().catch((error) => {
    brandsCachePromise = null;
    throw error;
  });

  return brandsCachePromise;
}
