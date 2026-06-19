import { canonicalizeInternalBrandName, normalizeBrandKey } from "./brand-standardization.mts";
import type { TecAllianceSyncConfig } from "./tecalliance-sync.mts";

export type TecAllianceBrandRegistryEntry = {
  key: string;
  aliases: string[];
  managedBrandNames: string[];
  preferredProviderKey: `tecalliance_${string}`;
  preferredProviderLabel: string;
  preferredSourceUrl: string;
  seedPrefixes?: string[];
  sync: TecAllianceSyncConfig;
};

const TECALLIANCE_BRAND_REGISTRY: TecAllianceBrandRegistryEntry[] = [
  {
    key: "mahle",
    aliases: ["mahle"],
    managedBrandNames: ["Mahle"],
    preferredProviderKey: "tecalliance_mahle",
    preferredProviderLabel: "Mahle TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    seedPrefixes: ["K"],
    sync: {
      providerLabel: "Mahle",
      providerId: 22620,
      dataSupplierId: 287,
      manufacturerNames: ["MAHLE"],
    },
  },
  {
    key: "knecht",
    aliases: ["knecht"],
    managedBrandNames: ["Knecht"],
    preferredProviderKey: "tecalliance_knecht",
    preferredProviderLabel: "Knecht TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Knecht",
      providerId: 22620,
      dataSupplierId: 34,
      manufacturerNames: ["KNECHT"],
    },
  },
  {
    key: "clevite",
    aliases: ["clevite"],
    managedBrandNames: ["Clevite"],
    preferredProviderKey: "tecalliance_clevite",
    preferredProviderLabel: "Clevite TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Clevite",
      providerId: 22620,
      dataSupplierId: 4508,
      manufacturerNames: ["CLEVITE"],
    },
  },
  {
    key: "purolatorindia",
    aliases: ["purolator india", "purolatorindia"],
    managedBrandNames: ["Purolator India"],
    preferredProviderKey: "tecalliance_purolator_india",
    preferredProviderLabel: "Purolator India TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Purolator India",
      providerId: 22620,
      dataSupplierId: 4640,
      manufacturerNames: ["Purolator India"],
    },
  },
  {
    key: "metalleve",
    aliases: ["metal leve", "metalleve"],
    managedBrandNames: ["Metal Leve"],
    preferredProviderKey: "tecalliance_metal_leve",
    preferredProviderLabel: "Metal Leve TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Metal Leve",
      providerId: 22620,
      dataSupplierId: 4677,
      manufacturerNames: ["METAL LEVE"],
    },
  },
  {
    key: "izumi",
    aliases: ["izumi"],
    managedBrandNames: ["Izumi"],
    preferredProviderKey: "tecalliance_izumi",
    preferredProviderLabel: "Izumi TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/mahle-catalog/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Izumi",
      providerId: 22620,
      dataSupplierId: 5254,
      manufacturerNames: ["IZUMI"],
    },
  },
  {
    key: "barumtires",
    aliases: ["barum", "barum tires", "barumtires"],
    managedBrandNames: ["Barum Tires"],
    preferredProviderKey: "tecalliance_barum_tires",
    preferredProviderLabel: "Barum Tires TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Barum Tires",
      providerId: 22166,
      dataSupplierId: 5307,
      manufacturerNames: ["BARUM Tires"],
    },
  },
  {
    key: "continental",
    aliases: ["continental"],
    managedBrandNames: ["Continental"],
    preferredProviderKey: "tecalliance_continental",
    preferredProviderLabel: "Continental TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Continental",
      providerId: 22166,
      dataSupplierId: 4434,
      manufacturerNames: ["CONTINENTAL"],
    },
  },
  {
    key: "continentalctam",
    aliases: ["continental ctam", "continentalctam"],
    managedBrandNames: ["Continental CTAM"],
    preferredProviderKey: "tecalliance_continental_ctam",
    preferredProviderLabel: "Continental CTAM TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Continental CTAM",
      providerId: 22166,
      dataSupplierId: 31,
      manufacturerNames: ["CONTINENTAL CTAM"],
    },
  },
  {
    key: "continentaltires",
    aliases: ["continental tires", "continentaltires"],
    managedBrandNames: ["Continental Tires"],
    preferredProviderKey: "tecalliance_continental_tires",
    preferredProviderLabel: "Continental Tires TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Continental Tires",
      providerId: 22166,
      dataSupplierId: 6982,
      manufacturerNames: ["CONTINENTAL Tires"],
    },
  },
  {
    key: "contitechairspring",
    aliases: ["contitech", "contitech air spring", "contitechairspring"],
    managedBrandNames: ["ContiTech Air Spring"],
    preferredProviderKey: "tecalliance_contitech_air_spring",
    preferredProviderLabel: "ContiTech Air Spring TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "ContiTech Air Spring",
      providerId: 22166,
      dataSupplierId: 6020,
      manufacturerNames: ["CONTITECH AIR SPRING"],
    },
  },
  {
    key: "galfer",
    aliases: ["galfer"],
    managedBrandNames: ["Galfer"],
    preferredProviderKey: "tecalliance_galfer",
    preferredProviderLabel: "Galfer TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Galfer",
      providerId: 22166,
      dataSupplierId: 500,
      manufacturerNames: ["GALFER"],
    },
  },
  {
    key: "generaltire",
    aliases: ["general tire", "generaltire"],
    managedBrandNames: ["General Tire"],
    preferredProviderKey: "tecalliance_general_tire",
    preferredProviderLabel: "General Tire TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "General Tire",
      providerId: 22166,
      dataSupplierId: 5308,
      manufacturerNames: ["GENERAL TIRE"],
    },
  },
  {
    key: "matador",
    aliases: ["matador"],
    managedBrandNames: ["Matador"],
    preferredProviderKey: "tecalliance_matador",
    preferredProviderLabel: "Matador TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Matador",
      providerId: 22166,
      dataSupplierId: 5309,
      manufacturerNames: ["MATADOR"],
    },
  },
  {
    key: "phoenix",
    aliases: ["phoenix"],
    managedBrandNames: ["Phoenix"],
    preferredProviderKey: "tecalliance_phoenix",
    preferredProviderLabel: "Phoenix TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Phoenix",
      providerId: 22166,
      dataSupplierId: 6004,
      manufacturerNames: ["PHOENIX"],
    },
  },
  {
    key: "primeride",
    aliases: ["prime ride", "prime-ride", "primeride"],
    managedBrandNames: ["Prime-Ride"],
    preferredProviderKey: "tecalliance_prime_ride",
    preferredProviderLabel: "Prime-Ride TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Prime-Ride",
      providerId: 22166,
      dataSupplierId: 6005,
      manufacturerNames: ["PRIME-RIDE"],
    },
  },
  {
    key: "uniroyal",
    aliases: ["uniroyal"],
    managedBrandNames: ["Uniroyal"],
    preferredProviderKey: "tecalliance_uniroyal",
    preferredProviderLabel: "Uniroyal TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "Uniroyal",
      providerId: 22166,
      dataSupplierId: 5306,
      manufacturerNames: ["UNIROYAL"],
    },
  },
  {
    key: "vdocontinental",
    aliases: ["vdo", "vdo continental", "vdo/continental", "vdocontinental"],
    managedBrandNames: ["VDO/Continental"],
    preferredProviderKey: "tecalliance_vdo_continental",
    preferredProviderLabel: "VDO/Continental TecAlliance official catalog",
    preferredSourceUrl: "https://web.tecalliance.net/continental/en/home?sessionTargetCountry=GB&sessionArticleCountry=GB",
    sync: {
      providerLabel: "VDO/Continental",
      providerId: 22166,
      dataSupplierId: 83,
      manufacturerNames: ["VDO/CONTINENTAL"],
    },
  },
];

export function resolveTecAllianceBrandEntry(inputBrandName: string) {
  const brandName = canonicalizeInternalBrandName(inputBrandName);
  const normalized = normalizeBrandKey(brandName);
  return (
    TECALLIANCE_BRAND_REGISTRY.find((entry) => entry.aliases.some((alias) => normalizeBrandKey(alias) === normalized)) || null
  );
}

export function listTecAllianceBrandEntries() {
  return [...TECALLIANCE_BRAND_REGISTRY];
}
