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
import { syncBrandCatalogFromSkfAutomotive } from "./skf-automotive-sync.mts";
import { syncBrandCatalogFromTecAllianceBrand } from "./tecalliance-sync.mts";
import { listTecAllianceBrandEntries, resolveTecAllianceBrandEntry } from "./tecalliance-brand-registry.mts";
import { canonicalizeInternalBrandName, normalizeBrandKey } from "./brand-standardization.mts";
import {
  CATALOG_SOURCE_POLICY_VERSION,
  createCatalogSourcePolicy,
  type CatalogBrandSourcePolicy,
} from "./catalog-source-policy.mts";

type KnownCatalogSyncPreferredProvider =
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
  | "skf_automotive"
  | "federal_mogul_aftermarket";

export type CatalogSyncPreferredProvider = KnownCatalogSyncPreferredProvider | `tecalliance_${string}`;

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
  mandatoryTechnicalFields: string[];
  sourcePolicyVersion: string;
  sourcePolicy: CatalogBrandSourcePolicy;
};

export const DEFAULT_CATALOG_SYNC_BATCH_SEQUENCE = [1, 50, 100, 500, 1000, 2000, 3000] as const;

export type CatalogSyncBatchPassSummary = {
  candidateLimit: number;
  candidateRows: number;
  resolvedRows: number;
  errorRows: number;
  fallbackUsed: boolean;
  sourceCompletionRows: number;
  completedPass: boolean;
};

type BrandSourceConfig = {
  aliases?: string[];
  managedBrandNames?: string[];
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
    managedBrandNames: ["Bosch"],
    preferredProviderKey: "bosch_aftermarket",
    preferredProviderLabel: "Bosch Aftermarket official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.boschaftermarket.com/tr/tr/urunler/product-search.html",
    completionProviders: ["spareto"],
  },
  ate: {
    aliases: ["ate"],
    managedBrandNames: ["ATE"],
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
    managedBrandNames: ["Mann"],
    preferredProviderKey: "mann_official",
    preferredProviderLabel: "MANN-FILTER official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.mann-filter.com/uk-en/catalogue",
  },
  donaldson: {
    aliases: ["donaldson"],
    managedBrandNames: ["Donaldson"],
    preferredProviderKey: "donaldson_official",
    preferredProviderLabel: "Donaldson official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://shop.donaldson.com/store/en-tr/product",
  },
  dayco: {
    aliases: ["dayco"],
    managedBrandNames: ["Dayco"],
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
    managedBrandNames: ["FAG", "INA", "LuK", "Vitesco"],
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
    managedBrandNames: ["Knorr-Bremse"],
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
    managedBrandNames: ["ZF", "Lemforder", "Sachs", "TRW", "Boge"],
    preferredProviderKey: "zf_aftermarket",
    preferredProviderLabel: "ZF Aftermarket official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://aftermarket.zf.com/en/catalog/?country=AE",
    completionProviders: ["spareto"],
  },
  wabco: {
    aliases: ["wabco"],
    managedBrandNames: ["WABCO"],
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
    managedBrandNames: ["Master Power"],
    preferredProviderKey: "masterpower_official",
    preferredProviderLabel: "Master Power official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.masterpower.com.br/produtos",
  },
  holset: {
    aliases: ["holset"],
    managedBrandNames: ["Holset"],
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
    managedBrandNames: ["BorgWarner"],
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
    managedBrandNames: ["Garrett"],
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
    managedBrandNames: ["KKK"],
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
    managedBrandNames: ["Schwitzer"],
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
    managedBrandNames: ["IHI"],
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
    managedBrandNames: ["Mitsubishi Turbochargers"],
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
    managedBrandNames: ["Valeo"],
    preferredProviderKey: "valeo_service",
    preferredProviderLabel: "Valeo Service official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.valeoservice.us/en-us",
  },
  fte: {
    aliases: ["fte"],
    managedBrandNames: ["FTE"],
    preferredProviderKey: "valeo_service",
    preferredProviderLabel: "Valeo Service official cross-reference catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.valeoservice.us/en-us",
  },
  swf: {
    aliases: ["swf"],
    managedBrandNames: ["SWF"],
    preferredProviderKey: "valeo_service",
    preferredProviderLabel: "Valeo Service official cross-reference catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.valeoservice.us/en-us",
  },
  brembo: {
    aliases: ["brembo"],
    managedBrandNames: ["Brembo"],
    preferredProviderKey: "brembo_official",
    preferredProviderLabel: "Brembo Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.bremboparts.com/europe/en",
  },
  hepu: {
    aliases: ["hepu"],
    managedBrandNames: ["HEPU"],
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
    managedBrandNames: ["Hella"],
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
    managedBrandNames: ["Hengst"],
    preferredProviderKey: "hengst_connect",
    preferredProviderLabel: "Hengst.Connect official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.hengstconnect.com/en/",
  },
  meyle: {
    aliases: ["meyle"],
    managedBrandNames: ["Meyle"],
    preferredProviderKey: "meyle_official",
    preferredProviderLabel: "MEYLE official parts catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.meyle.com/en/parts-catalog",
  },
  skf: {
    aliases: ["skf"],
    managedBrandNames: ["SKF"],
    preferredProviderKey: "skf_automotive",
    preferredProviderLabel: "SKF Automotive official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://automotive.skf.com/eur/en/product-catalogue",
  },
  nissens: {
    aliases: ["nissens"],
    managedBrandNames: ["Nissens"],
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
    managedBrandNames: ["NRF"],
    preferredProviderKey: "nrf_official",
    preferredProviderLabel: "NRF official product portal",
    preferredSourceType: "official",
    preferredSourceUrl: "https://webshop.nrf.eu",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto exact-detail fallback",
    executionSourceType: "marketplace",
  },
  payen: {
    aliases: ["payen"],
    managedBrandNames: ["Payen"],
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
    managedBrandNames: ["Beral"],
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
    managedBrandNames: ["Jurid"],
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
    managedBrandNames: ["Goetze"],
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
    managedBrandNames: ["Glyco"],
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
    managedBrandNames: ["Nural"],
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
    managedBrandNames: ["Ferodo"],
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
    managedBrandNames: ["Champion"],
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
    managedBrandNames: ["Beru"],
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
    managedBrandNames: ["AE"],
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
    managedBrandNames: ["FP Diesel"],
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
    managedBrandNames: ["Monroe"],
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
    managedBrandNames: ["Moog"],
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
    managedBrandNames: ["Walker"],
    preferredProviderKey: "federal_mogul_aftermarket",
    preferredProviderLabel: "DRiV Parts official catalog",
    preferredSourceType: "official",
    preferredSourceUrl: "https://www.drivparts.com/en-eu/",
    executionProviderKey: "spareto",
    executionProviderLabel: "Spareto catalog fallback",
    executionSourceType: "marketplace",
  },
};

export function listCatalogSyncManagedBrands() {
  const values = Object.entries(BRAND_SOURCE_CONFIGS).flatMap(([configKey, config]) => {
    const names = (config.managedBrandNames?.length ? config.managedBrandNames : [configKey]).map((value) =>
      canonicalizeInternalBrandName(value),
    );
    return names.filter(Boolean);
  });
  const tecallianceValues = listTecAllianceBrandEntries().flatMap((entry) => entry.managedBrandNames.map((value) => canonicalizeInternalBrandName(value)));
  return [...new Set([...values, ...tecallianceValues])].sort((left, right) => left.localeCompare(right, "en"));
}

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
    const tecallianceEntry = resolveTecAllianceBrandEntry(brandName);
    if (tecallianceEntry) {
      matchedConfig = {
        aliases: tecallianceEntry.aliases,
        managedBrandNames: tecallianceEntry.managedBrandNames,
        preferredProviderKey: tecallianceEntry.preferredProviderKey,
        preferredProviderLabel: tecallianceEntry.preferredProviderLabel,
        preferredSourceType: "official",
        preferredSourceUrl: tecallianceEntry.preferredSourceUrl,
      };
    }
  }

  if (!matchedConfig) {
    const sourcePolicy = createCatalogSourcePolicy({
      providerKey: "spareto",
      brandName,
    });
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
      mandatoryTechnicalFields: ["ean"],
      sourcePolicyVersion: CATALOG_SOURCE_POLICY_VERSION,
      sourcePolicy,
    };
  }

  const completionProviders =
    matchedConfig.completionProviders || (matchedConfig.preferredProviderKey !== "spareto" ? (["spareto"] as CatalogSyncCompletionProvider[]) : []);

  const sourcePolicy = createCatalogSourcePolicy({
    providerKey: matchedConfig.preferredProviderKey,
    brandName,
  });

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
    mandatoryTechnicalFields: ["ean"],
    sourcePolicyVersion: CATALOG_SOURCE_POLICY_VERSION,
    sourcePolicy,
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
  expandPrefixes?: boolean;
  skipDiscovery?: boolean;
  candidateLimit?: number;
  seedPrefixes?: string[];
  lineIds?: number[];
  sparetoFallbackLimit?: number;
}) {
  const plan = resolveCatalogSyncPlan(input.brandName);
  const tecallianceEntry = resolveTecAllianceBrandEntry(plan.brandName);
  const tecallianceSeedPrefixes =
    input.seedPrefixes?.length
      ? input.seedPrefixes
      : tecallianceEntry?.seedPrefixes?.length
        ? tecallianceEntry.seedPrefixes
        : undefined;
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
  } else if (tecallianceEntry && plan.preferredProviderKey === tecallianceEntry.preferredProviderKey) {
    result = await syncBrandCatalogFromTecAllianceBrand(
      {
        ...input,
        brandName: plan.brandName,
        seedPrefixes: tecallianceSeedPrefixes,
        maxPages: input.maxPages,
        expandPrefixes: input.expandPrefixes,
        skipDiscovery: input.skipDiscovery,
        candidateLimit: input.candidateLimit,
        includeBlankDiscoveryRoot: true,
      },
      tecallianceEntry.sync,
    );
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
    mandatoryTechnicalFields: plan.mandatoryTechnicalFields,
    sourcePolicyVersion: plan.sourcePolicyVersion,
    sourcePolicy: plan.sourcePolicy,
    sourceCompletion,
    sparetoHelperFallback: sparetoCompletion,
  };
}

export async function syncBrandCatalogWithProgressiveBatches(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
  maxPages?: number;
  expandPrefixes?: boolean;
  skipDiscovery?: boolean;
  candidateLimit?: number;
  seedPrefixes?: string[];
  lineIds?: number[];
  sparetoFallbackLimit?: number;
  batchSequence?: readonly number[];
}) {
  const batchSequence = (input.batchSequence && input.batchSequence.length > 0 ? input.batchSequence : DEFAULT_CATALOG_SYNC_BATCH_SEQUENCE)
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  let finalResult: Awaited<ReturnType<typeof syncBrandCatalog>> | null = null;
  const batchProgression: CatalogSyncBatchPassSummary[] = [];

  for (const candidateLimit of batchSequence) {
    finalResult = await syncBrandCatalog({
      ...input,
      candidateLimit,
      sparetoFallbackLimit: input.sparetoFallbackLimit ?? candidateLimit,
    });

    const candidateRows = Number(finalResult?.candidateRowsBeforeLimit ?? finalResult?.candidateRows ?? 0);
    const resolvedRows = Number(finalResult?.resolvedRows ?? 0);
    const errorRows = Number(finalResult?.errorRows ?? 0);
    const sourceCompletionRows = Array.isArray(finalResult?.sourceCompletion)
      ? finalResult.sourceCompletion.reduce((sum, item) => sum + Number(item?.updatedRows || 0), 0)
      : 0;
    const completedPass = resolvedRows < candidateLimit || candidateRows <= candidateLimit;

    batchProgression.push({
      candidateLimit,
      candidateRows,
      resolvedRows,
      errorRows,
      fallbackUsed: Boolean(finalResult?.fallbackUsed),
      sourceCompletionRows,
      completedPass,
    });

    if (completedPass) break;
  }

  if (!finalResult) {
    throw new Error("Brand catalog sync did not produce a result");
  }

  return {
    ...finalResult,
    syncBatchSequence: batchSequence,
    syncBatchProgression: batchProgression,
    syncBatchStrategy: "progressive",
  };
}
