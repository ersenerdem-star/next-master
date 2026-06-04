export async function syncBrandCatalogFromMahleTecAlliance(_input: {
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
    "Mahle official source is routed to the TecAlliance catalog at https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB, but an automated official search/detail sync has not been implemented yet. Do not fall back to Spareto for primary catalog creation.",
  );
}
