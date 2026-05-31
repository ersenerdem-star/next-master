import { syncBrandCatalogFromSpareto } from "./spareto-sync.mts";
import { syncBrandCatalogFromBoschAftermarket } from "./bosch-aftermarket-sync.mts";
import { syncBrandCatalogFromMann } from "./mann-sync.mts";
import { syncBrandCatalogFromDonaldson } from "./donaldson-sync.mts";
import { syncBrandCatalogFromZfAftermarket } from "./zf-aftermarket-sync.mts";
import { syncBrandCatalogFromMasterPower } from "./masterpower-sync.mts";
import { syncBrandCatalogFromValeoService } from "./valeo-sync.mts";
import { syncBrandCatalogFromBrembo } from "./brembo-sync.mts";
import { syncBrandCatalogFromSkfAutomotive } from "./skf-automotive-sync.mts";
import { canonicalizeInternalBrandName, normalizeBrandKey } from "./brand-standardization.mts";

export type CatalogSyncPreferredProvider =
  | "spareto"
  | "bosch_aftermarket"
  | "mann_official"
  | "donaldson_official"
  | "zf_aftermarket"
  | "masterpower_official"
  | "valeo_service"
  | "brembo_official"
  | "skf_automotive";

export type CatalogSyncSourceType = "marketplace" | "official";

export type CatalogSyncPlan = {
  brandName: string;
  preferredProviderKey: CatalogSyncPreferredProvider;
  preferredProviderLabel: string;
  preferredSourceType: CatalogSyncSourceType;
  preferredSourceUrl: string;
  executionProviderKey: CatalogSyncPreferredProvider;
  executionProviderLabel: string;
  executionSourceType: CatalogSyncSourceType;
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
  masterpower: {
    aliases: ["master power", "masterpower"],
    preferredProviderKey: "masterpower_official",
    preferredProviderLabel: "Master Power official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.masterpower.com.br/produtos",
  },
  valeo: {
    aliases: ["valeo"],
    preferredProviderKey: "valeo_service",
    preferredProviderLabel: "Valeo Service official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.valeoservice.us/en-us",
  },
  fte: {
    aliases: ["fte"],
    preferredProviderKey: "valeo_service",
    preferredProviderLabel: "Valeo Service official cross-reference catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.valeoservice.us/en-us",
  },
  swf: {
    aliases: ["swf"],
    preferredProviderKey: "valeo_service",
    preferredProviderLabel: "Valeo Service official cross-reference catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.valeoservice.us/en-us",
  },
  brembo: {
    aliases: ["brembo"],
    preferredProviderKey: "brembo_official",
    preferredProviderLabel: "Brembo Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.bremboparts.com/europe/en",
  },
  skf: {
    aliases: ["skf"],
    preferredProviderKey: "skf_automotive",
    preferredProviderLabel: "SKF Automotive official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://automotive.skf.com/eur/en/product-catalogue",
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

  return {
    brandName,
    preferredProviderKey: matchedConfig.preferredProviderKey,
    preferredProviderLabel: matchedConfig.preferredProviderLabel,
    preferredSourceType: matchedConfig.preferredSourceType,
    preferredSourceUrl: matchedConfig.preferredSourceUrl,
    executionProviderKey: matchedConfig.preferredProviderKey,
    executionProviderLabel: matchedConfig.preferredProviderLabel,
    executionSourceType: matchedConfig.preferredSourceType,
    fallbackUsed: false,
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
  seedPrefixes?: string[];
  lineIds?: number[];
}) {
  const plan = resolveCatalogSyncPlan(input.brandName);
  let result;
  let executionProviderKey = plan.executionProviderKey;
  let executionProviderLabel = plan.executionProviderLabel;
  let executionSourceType = plan.executionSourceType;
  let fallbackUsed = plan.fallbackUsed;

  if (plan.preferredProviderKey === "mann_official") {
    result = await syncBrandCatalogFromMann({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "bosch_aftermarket") {
    result = await syncBrandCatalogFromBoschAftermarket({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "donaldson_official") {
    result = await syncBrandCatalogFromDonaldson({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "zf_aftermarket") {
    result = await syncBrandCatalogFromZfAftermarket({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "masterpower_official") {
    result = await syncBrandCatalogFromMasterPower({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "valeo_service") {
    result = await syncBrandCatalogFromValeoService({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "brembo_official") {
    result = await syncBrandCatalogFromBrembo({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "skf_automotive") {
    result = await syncBrandCatalogFromSkfAutomotive({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else {
    result = await syncBrandCatalogFromSpareto({
      ...input,
      brandName: plan.brandName,
    });
  }

  return {
    ...result,
    syncBrandName: plan.brandName,
    preferredProviderKey: plan.preferredProviderKey,
    preferredProviderLabel: plan.preferredProviderLabel,
    preferredSourceType: plan.preferredSourceType,
    preferredSourceUrl: plan.preferredSourceUrl,
    executionProviderKey,
    executionProviderLabel,
    executionSourceType,
    fallbackUsed,
  };
}
