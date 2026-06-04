export async function syncBrandCatalogFromMeyleOfficial(_input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
  seedPrefixes?: string[];
}) {
  throw new Error(
    "MEYLE official parts catalog is registered for this brand, but the public catalog entry point does not currently expose an automated server-side search/detail sync path. No marketplace fallback is used for MEYLE.",
  );
}
