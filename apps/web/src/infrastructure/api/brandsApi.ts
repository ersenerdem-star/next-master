import { supabaseClient } from "./supabaseClient";
import type { BrandOption } from "../../types/brand";

let brandsCache: BrandOption[] | null = null;
let brandsCachePromise: Promise<BrandOption[]> | null = null;

export async function fetchCloudBrands(): Promise<BrandOption[]> {
  if (brandsCache) return brandsCache;
  if (brandsCachePromise) return brandsCachePromise;

  brandsCachePromise = (async () => {
    const { data, error } = await supabaseClient
      .from("brands")
      .select("id,name")
      .order("name", { ascending: true });

      if (error) throw new Error(error.message || "Failed to load brands");
      const rows = (data || []).map((row) => ({
        id: row.id as string,
        name: row.name as string,
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
