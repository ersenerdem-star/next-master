import { syncBrandCatalogFromSpareto } from "./spareto-sync.mts";
import { canonicalizeInternalBrandName, normalizeBrandKey } from "./brand-standardization.mts";

export type CatalogSyncPreferredProvider =
  | "spareto"
  | "bosch_aftermarket"
  | "mann_official"
  | "donaldson_official"
  | "zf_aftermarket";

export type CatalogSyncSourceType = "marketplace" | "official";

export type CatalogSyncPlan = {
  brandName: string;
  preferredProviderKey: CatalogSyncPreferredProvider;
  preferredProviderLabel: string;
  preferredSourceType: CatalogSyncSourceType;
  preferredSourceUrl: string;
  executionProviderKey: "spareto";
  executionProviderLabel: string;
  executionSourceType: "marketplace";
  fallbackUsed: boolean;
};

type BrandSourceConfig = {
  aliases?: string[];
  preferredProviderKey: CatalogSyncPreferredProvider;
  preferredProviderLabel: string;
  preferredSourceType: CatalogSyncSourceType;
  preferredSourceUrl: string;
};

const BRAND_SOURCE_CONFIGS: Record<string, BrandSourceConfig> = {
  bosch: {
    aliases: ["bosch"],
    preferredProviderKey: "bosch_aftermarket",
    preferredProviderLabel: "Bosch Aftermarket official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.boschaftermarket.com/tr/tr/urunler/product-search.html",
  },
  mann: {
    aliases: ["mann", "mann-filter"],
    preferredProviderKey: "mann_official",
    preferredProviderLabel: "MANN-FILTER official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.mann-filter.com/uk-en/catalogue",
  },
  donaldson: {
    aliases: ["donaldson"],
    preferredProviderKey: "donaldson_official",
    preferredProviderLabel: "Donaldson official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://shop.donaldson.com/store/en-tr/product",
  },
  zf: {
    aliases: ["zf", "lemforder", "lemförder", "sachs", "trw", "wabco", "boge"],
    preferredProviderKey: "zf_aftermarket",
    preferredProviderLabel: "ZF Aftermarket official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://aftermarket.zf.com/en/catalog/?country=TR",
  },
};

export function resolveCatalogSyncPlan(inputBrandName: string): CatalogSyncPlan {
  const brandName = canonicalizeInternalBrandName(inputBrandName);
  const normalized = normalizeBrandKey(brandName);

  let matchedConfig: BrandSourceConfig | null = null;
  for (const config of Object.values(BRAND_SOURCE_CONFIGS)) {
    if ((config.aliases || []).some((alias) => normalizeBrandKey(alias) === normalized)) {
      matchedConfig = config;
      break;
    }
  }

  if (!matchedConfig) {
    return {
      brandName,
      preferredProviderKey: "spareto",
      preferredProviderLabel: "Spareto catalog",
      preferredSourceType: "marketplace",
      preferredSourceUrl: "https://spareto.com",
      executionProviderKey: "spareto",
      executionProviderLabel: "Spareto catalog",
      executionSourceType: "marketplace",
      fallbackUsed: false,
    };
  }

  const fallbackUsed = matchedConfig.preferredProviderKey !== "spareto";
  return {
    brandName,
    preferredProviderKey: matchedConfig.preferredProviderKey,
    preferredProviderLabel: matchedConfig.preferredProviderLabel,
    preferredSourceType: matchedConfig.preferredSourceType,
    preferredSourceUrl: matchedConfig.preferredSourceUrl,
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog",
    executionSourceType: "marketplace",
    fallbackUsed,
  };
}

export async function syncBrandCatalog(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
}) {
  const plan = resolveCatalogSyncPlan(input.brandName);
  const result = await syncBrandCatalogFromSpareto({
    ...input,
    brandName: plan.brandName,
  });

  return {
    ...result,
    syncBrandName: plan.brandName,
    preferredProviderKey: plan.preferredProviderKey,
    preferredProviderLabel: plan.preferredProviderLabel,
    preferredSourceType: plan.preferredSourceType,
    preferredSourceUrl: plan.preferredSourceUrl,
    executionProviderKey: plan.executionProviderKey,
    executionProviderLabel: plan.executionProviderLabel,
    executionSourceType: plan.executionSourceType,
    fallbackUsed: plan.fallbackUsed,
  };
}
