import { completeMissingCatalogFieldsFromSpareto, syncBrandCatalogFromSpareto } from "./spareto-sync.mts";
import { syncBrandCatalogFromBoschAftermarket } from "./bosch-aftermarket-sync.mts";
import { syncBrandCatalogFromMann } from "./mann-sync.mts";
import { syncBrandCatalogFromDonaldson } from "./donaldson-sync.mts";
import { syncBrandCatalogFromZfAftermarket } from "./zf-aftermarket-sync.mts";
import { syncBrandCatalogFromMasterPower } from "./masterpower-sync.mts";
import { syncBrandCatalogFromValeoService } from "./valeo-sync.mts";
import { syncBrandCatalogFromBrembo } from "./brembo-sync.mts";
import { syncBrandCatalogFromHengstConnect } from "./hengst-sync.mts";
import { syncBrandCatalogFromMeyleOfficial } from "./meyle-sync.mts";
import { syncBrandCatalogFromMahleTecAlliance } from "./mahle-sync.mts";
import { syncBrandCatalogFromSkfAutomotive } from "./skf-automotive-sync.mts";
import { canonicalizeInternalBrandName, normalizeBrandKey } from "./brand-standardization.mts";

export type CatalogSyncPreferredProvider =
  | "spareto"
  | "bosch_aftermarket"
  | "ate_official"
  | "mann_official"
  | "donaldson_official"
  | "dayco_official"
  | "zf_aftermarket"
  | "schaeffler_aftermarket"
  | "knorr_bremse_aftermarket"
  | "wabco_customercentre"
  | "hepu_official"
  | "hella_official"
  | "nissens_official"
  | "nrf_official"
  | "masterpower_official"
  | "masterturbo_official"
  | "valeo_service"
  | "brembo_official"
  | "hengst_connect"
  | "meyle_official"
  | "mahle_tecalliance"
  | "skf_automotive"
  | "federal_mogul_aftermarket";

export type CatalogSyncCompletionProvider = "spareto";

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
  completionProviders: CatalogSyncCompletionProvider[];
  mandatorySourceCompletion: boolean;
};

type BrandSourceConfig = {
  aliases?: string[];
  preferredProviderKey: CatalogSyncPreferredProvider;
  preferredProviderLabel: string;
  preferredSourceType: CatalogSyncSourceType;
  preferredSourceUrl: string;
  executionProviderKey?: CatalogSyncPreferredProvider;
  executionProviderLabel?: string;
  executionSourceType?: CatalogSyncSourceType;
  completionProviders?: CatalogSyncCompletionProvider[];
};

const BRAND_SOURCE_CONFIGS: Record<string, BrandSourceConfig> = {
  bosch: {
    aliases: ["bosch"],
    preferredProviderKey: "bosch_aftermarket",
    preferredProviderLabel: "Bosch Aftermarket official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.boschaftermarket.com/tr/tr/urunler/product-search.html",
  },
  ate: {
    aliases: ["ate"],
    preferredProviderKey: "ate_official",
    preferredProviderLabel: "ATE official online catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.ate-brakes.com/catalogues/online-catalogues/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
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
  dayco: {
    aliases: ["dayco"],
    preferredProviderKey: "dayco_official",
    preferredProviderLabel: "Dayco official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.dayco.com/emea-en/catalog/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  schaeffler: {
    aliases: ["fag", "ina", "luk", "vitesco"],
    preferredProviderKey: "schaeffler_aftermarket",
    preferredProviderLabel: "Schaeffler Vehicle Lifetime Solutions official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://vehiclelifetimesolutions.schaeffler.com/en/catalog",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  knorrbremse: {
    aliases: ["knorr-bremse", "knorr bremse"],
    preferredProviderKey: "knorr_bremse_aftermarket",
    preferredProviderLabel: "Knorr-Bremse TruckServices official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://mytruckservices.knorr-bremse.com/UK/en_GB/GBP/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  zf: {
    aliases: ["zf", "lemforder", "lemförder", "sachs", "trw", "boge"],
    preferredProviderKey: "zf_aftermarket",
    preferredProviderLabel: "ZF Aftermarket official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://aftermarket.zf.com/en/catalog/?country=AE",
  },
  wabco: {
    aliases: ["wabco"],
    preferredProviderKey: "wabco_customercentre",
    preferredProviderLabel: "WABCO Customer Centre official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.wabco-customercentre.com/catalog/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  masterpower: {
    aliases: ["master power", "masterpower"],
    preferredProviderKey: "masterpower_official",
    preferredProviderLabel: "Master Power official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.masterpower.com.br/produtos",
  },
  holset: {
    aliases: ["holset"],
    preferredProviderKey: "masterturbo_official",
    preferredProviderLabel: "MasterTurbo TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/masterturbo/en/home",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  borgwarner: {
    aliases: ["borgwarner", "borgwagner", "borg warner"],
    preferredProviderKey: "masterturbo_official",
    preferredProviderLabel: "MasterTurbo TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/masterturbo/en/home",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  garrett: {
    aliases: ["garrett"],
    preferredProviderKey: "masterturbo_official",
    preferredProviderLabel: "MasterTurbo TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/masterturbo/en/home",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  kkk: {
    aliases: ["kkk"],
    preferredProviderKey: "masterturbo_official",
    preferredProviderLabel: "MasterTurbo TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/masterturbo/en/home",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  schwitzer: {
    aliases: ["schwitzer"],
    preferredProviderKey: "masterturbo_official",
    preferredProviderLabel: "MasterTurbo TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/masterturbo/en/home",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  ihi: {
    aliases: ["ihi"],
    preferredProviderKey: "masterturbo_official",
    preferredProviderLabel: "MasterTurbo TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/masterturbo/en/home",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  mitsubishiTurbochargers: {
    aliases: ["mitsubishi turbocharger", "mitsubishi turbochargers"],
    preferredProviderKey: "masterturbo_official",
    preferredProviderLabel: "MasterTurbo TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/masterturbo/en/home",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
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
  hepu: {
    aliases: ["hepu"],
    preferredProviderKey: "hepu_official",
    preferredProviderLabel: "HEPU official online catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.hepu.de/en/online-katalog.php",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  hella: {
    aliases: ["hella"],
    preferredProviderKey: "hella_official",
    preferredProviderLabel: "HELLA official online shop",
    preferredSourceType: "official",
    preferredSourceUrl: "https://shop.hella.com/hbvnlshop/hbvnl/en_NL/UNIVERSAL/4054/na/2/1A3%20002%20850-001/index.xhtml",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  hengst: {
    aliases: ["hengst"],
    preferredProviderKey: "hengst_connect",
    preferredProviderLabel: "Hengst.Connect official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.hengstconnect.com/en/",
  },
  meyle: {
    aliases: ["meyle"],
    preferredProviderKey: "meyle_official",
    preferredProviderLabel: "MEYLE official parts catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.meyle.com/en/parts-catalog",
  },
  mahle: {
    aliases: ["mahle"],
    preferredProviderKey: "mahle_tecalliance",
    preferredProviderLabel: "Mahle TecAlliance official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=AE&sessionArticleCountry=AE",
  },
  skf: {
    aliases: ["skf"],
    preferredProviderKey: "skf_automotive",
    preferredProviderLabel: "SKF Automotive official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://automotive.skf.com/eur/en/product-catalogue",
  },
  nissens: {
    aliases: ["nissens"],
    preferredProviderKey: "nissens_official",
    preferredProviderLabel: "Nissens Customer Portal official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://catalogue.nissens.com/FrontPage",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  nrf: {
    aliases: ["nrf"],
    preferredProviderKey: "nrf_official",
    preferredProviderLabel: "NRF official product portal",
    preferredSourceType: "official",
    preferredSourceUrl: "https://webshop.nrf.eu//12003.html",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  payen: {
    aliases: ["payen"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  beral: {
    aliases: ["beral"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  jurid: {
    aliases: ["jurid", "jurid parts"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  goetze: {
    aliases: ["goetze"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  glyco: {
    aliases: ["glyco"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  nural: {
    aliases: ["nural", "nural parts", "nüral"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  ferodo: {
    aliases: ["ferodo"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  champion: {
    aliases: ["champion"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  beru: {
    aliases: ["beru"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "Federal Mogul Aftermarket official brand page",
    preferredSourceType: "official",
    preferredSourceUrl: "https://aftermarket.federalmogulpowertrain.com.tr/beru/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  ae: {
    aliases: ["ae", "ae parts"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  fpdiesel: {
    aliases: ["fp diesel", "fp-diesel", "fpdiesel"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  monroe: {
    aliases: ["monroe"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  moog: {
    aliases: ["moog"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
  walker: {
    aliases: ["walker"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
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
      completionProviders: [],
      mandatorySourceCompletion: false,
    };
  }

  const completionProviders =
    matchedConfig.completionProviders || (matchedConfig.preferredProviderKey !== "spareto" ? (["spareto"] as CatalogSyncCompletionProvider[]) : []);

  return {
    brandName,
    preferredProviderKey: matchedConfig.preferredProviderKey,
    preferredProviderLabel: matchedConfig.preferredProviderLabel,
    preferredSourceType: matchedConfig.preferredSourceType,
    preferredSourceUrl: matchedConfig.preferredSourceUrl,
    executionProviderKey: matchedConfig.executionProviderKey || matchedConfig.preferredProviderKey,
    executionProviderLabel: matchedConfig.executionProviderLabel || matchedConfig.preferredProviderLabel,
    executionSourceType: matchedConfig.executionSourceType || matchedConfig.preferredSourceType,
    fallbackUsed:
      (matchedConfig.executionProviderKey || matchedConfig.preferredProviderKey) !== matchedConfig.preferredProviderKey ||
      (matchedConfig.executionSourceType || matchedConfig.preferredSourceType) !== matchedConfig.preferredSourceType,
    completionProviders,
    mandatorySourceCompletion: completionProviders.length > 0,
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
  maxPages?: number;
  candidateLimit?: number;
  seedPrefixes?: string[];
  lineIds?: number[];
  sparetoFallbackLimit?: number;
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
  } else if (plan.preferredProviderKey === "hengst_connect") {
    result = await syncBrandCatalogFromHengstConnect({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "meyle_official") {
    result = await syncBrandCatalogFromMeyleOfficial({
      ...input,
      brandName: plan.brandName,
    });
    executionProviderKey = plan.preferredProviderKey;
    executionProviderLabel = plan.preferredProviderLabel;
    executionSourceType = plan.preferredSourceType;
    fallbackUsed = false;
  } else if (plan.preferredProviderKey === "mahle_tecalliance") {
    result = await syncBrandCatalogFromMahleTecAlliance({
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

  const shouldApplySparetoCompletion = plan.completionProviders.includes("spareto");
  const sparetoCompletion =
    shouldApplySparetoCompletion && result?.targetBrandId && result?.organizationId
      ? await completeMissingCatalogFieldsFromSpareto({
          supabaseUrl: input.supabaseUrl,
          serviceRoleKey: input.serviceRoleKey,
          brandName: plan.brandName,
          targetBrandId: result.targetBrandId,
          organizationId: result.organizationId,
          concurrency: Math.max(2, Math.min(input.concurrency ?? 6, 6)),
          requestTimeoutMs: input.requestTimeoutMs,
          limit: input.sparetoFallbackLimit ?? 500,
        })
      : null;

  const sourceCompletion = [
    sparetoCompletion
      ? {
          providerKey: "spareto",
          providerLabel: "Spareto exact-detail completion",
          sourceType: "marketplace",
          mandatory: plan.mandatorySourceCompletion,
          candidateRows: sparetoCompletion.candidateRows,
          matchedRows: sparetoCompletion.matchedRows,
          unmatchedRows: sparetoCompletion.unmatchedRows,
          updatedRows: sparetoCompletion.updatedRows,
          errorRows: sparetoCompletion.errorRows,
        }
      : null,
  ].filter(Boolean);

  return {
    ...result,
    syncMode: plan.mandatorySourceCompletion ? "source_pipeline" : "single_source",
    syncBrandName: plan.brandName,
    preferredProviderKey: plan.preferredProviderKey,
    preferredProviderLabel: plan.preferredProviderLabel,
    preferredSourceType: plan.preferredSourceType,
    preferredSourceUrl: plan.preferredSourceUrl,
    executionProviderKey,
    executionProviderLabel,
    executionSourceType,
    fallbackUsed,
    completionProviders: plan.completionProviders,
    mandatorySourceCompletion: plan.mandatorySourceCompletion,
    sourceCompletion,
    sparetoHelperFallback: sparetoCompletion,
  };
}
