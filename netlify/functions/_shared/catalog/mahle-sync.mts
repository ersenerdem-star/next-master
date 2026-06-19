import { resolveTecAllianceBrandEntry } from "./tecalliance-brand-registry.mts";
import { syncBrandCatalogFromTecAllianceBrand } from "./tecalliance-sync.mts";

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
  const entry = resolveTecAllianceBrandEntry("Mahle");
  if (!entry) {
    throw new Error("Mahle TecAlliance registry entry is missing.");
  }
  return syncBrandCatalogFromTecAllianceBrand(
    {
      ...input,
      seedPrefixes: input.seedPrefixes?.length ? input.seedPrefixes : entry.seedPrefixes || ["K"],
    },
    entry.sync,
  );
}
