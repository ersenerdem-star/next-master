import { syncBrandCatalogFromMahleTecAlliance as syncCatalogMahleTecAlliance } from "./catalog/mahle-sync.mts";

export async function syncBrandCatalogFromMahleTecAlliance(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
  seedPrefixes?: string[];
}) {
  return syncCatalogMahleTecAlliance(input);
}
