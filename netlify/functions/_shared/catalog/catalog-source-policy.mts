export const CATALOG_SOURCE_POLICY_VERSION = "2026-06-19";

export type CatalogAuthorityKey =
  | "official_provider"
  | "tecalliance_official_session"
  | "martex_public_tecdoc"
  | "wilmink_browser_assisted"
  | "spareto_exact_detail"
  | "manual_review";

export type CatalogAuthorityKind = "official" | "tecalliance" | "public_helper" | "marketplace" | "manual";
export type CatalogAuthorityAccess = "live_api" | "browser_assisted" | "public_html" | "completion_only" | "manual";
export type CatalogAuthorityUsage = "primary" | "enrichment" | "completion" | "manual";

export type CatalogFieldKey =
  | "brand"
  | "description"
  | "oem_no"
  | "vehicle"
  | "vehicle_model"
  | "market_segment"
  | "engine_code"
  | "lifecycle_status"
  | "lifecycle_note"
  | "replacement_code"
  | "hs_code"
  | "origin"
  | "weight_kg"
  | "image_url"
  | "ean";

export type CatalogAuthorityDescriptor = {
  key: CatalogAuthorityKey;
  label: string;
  kind: CatalogAuthorityKind;
  access: CatalogAuthorityAccess;
  allowedUsage: CatalogAuthorityUsage;
  note: string;
};

export type CatalogFieldSourcePriority = {
  field: CatalogFieldKey;
  priority: CatalogAuthorityKey[];
  note: string;
};

export type CatalogExecutionProfile =
  | "official_first"
  | "official_tecalliance_primary"
  | "official_blocked_browser_capture"
  | "temporary_marketplace_fallback"
  | "marketplace_only";

export type CatalogBrandSourcePolicy = {
  version: string;
  providerKey: string;
  brandName: string;
  primaryAuthority: CatalogAuthorityDescriptor;
  executionProfile: CatalogExecutionProfile;
  helperSources: CatalogAuthorityDescriptor[];
  completionSources: CatalogAuthorityDescriptor[];
  fieldPriority: CatalogFieldSourcePriority[];
  operationalNotes: string[];
};

const AUTHORITY_MAP: Record<CatalogAuthorityKey, CatalogAuthorityDescriptor> = {
  official_provider: {
    key: "official_provider",
    label: "Official brand catalog",
    kind: "official",
    access: "live_api",
    allowedUsage: "primary",
    note: "Primary authority whenever the brand exposes a stable public or authenticated catalog flow.",
  },
  tecalliance_official_session: {
    key: "tecalliance_official_session",
    label: "TecAlliance-backed official session",
    kind: "tecalliance",
    access: "live_api",
    allowedUsage: "enrichment",
    note: "Trusted technical backbone for OEM, article, vehicle, tariff, weight, and related product metadata when an official brand session runs on TecAlliance.",
  },
  martex_public_tecdoc: {
    key: "martex_public_tecdoc",
    label: "Martex public TecDoc helper",
    kind: "public_helper",
    access: "public_html",
    allowedUsage: "enrichment",
    note: "Public helper source confirmed for OEM tables, vehicle fitment, EAN, images, and TecDoc-shaped article details.",
  },
  wilmink_browser_assisted: {
    key: "wilmink_browser_assisted",
    label: "Wilmink browser-assisted helper",
    kind: "public_helper",
    access: "browser_assisted",
    allowedUsage: "enrichment",
    note: "Useful for manufacturer, model, and vehicle taxonomy in browser context, but direct raw API calls are protected.",
  },
  spareto_exact_detail: {
    key: "spareto_exact_detail",
    label: "Spareto exact-detail fallback",
    kind: "marketplace",
    access: "completion_only",
    allowedUsage: "completion",
    note: "Completion-only fallback for missing fields. Do not treat as the main authority when an official source exists.",
  },
  manual_review: {
    key: "manual_review",
    label: "Manual review",
    kind: "manual",
    access: "manual",
    allowedUsage: "manual",
    note: "Last resort when live sources disagree or cannot supply a stable value.",
  },
};

function authority(key: CatalogAuthorityKey) {
  return AUTHORITY_MAP[key];
}

function dedupePriority(values: CatalogAuthorityKey[]) {
  return [...new Set(values)];
}

function fieldPolicy(field: CatalogFieldKey, priority: CatalogAuthorityKey[], note: string): CatalogFieldSourcePriority {
  return {
    field,
    priority: dedupePriority(priority),
    note,
  };
}

function buildDefaultFieldPriority(primary: CatalogAuthorityKey, includeTecAllianceSecondary = true): CatalogFieldSourcePriority[] {
  const tec = includeTecAllianceSecondary ? (["tecalliance_official_session"] as CatalogAuthorityKey[]) : [];

  return [
    fieldPolicy(
      "brand",
      [primary, ...tec, "manual_review"],
      "Brand identity is a top-level authority field and should stay aligned to the official or TecAlliance source family.",
    ),
    fieldPolicy(
      "description",
      [primary, ...tec, "wilmink_browser_assisted", "spareto_exact_detail", "manual_review"],
      "Descriptions should stay official first. Browser-assisted helpers can normalize generic naming, but marketplace text stays tertiary.",
    ),
    fieldPolicy(
      "oem_no",
      [primary, ...tec, "martex_public_tecdoc", "spareto_exact_detail", "manual_review"],
      "OEM cross references should prefer official or TecAlliance data, then public TecDoc helper tables.",
    ),
    fieldPolicy(
      "vehicle",
      [primary, ...tec, "martex_public_tecdoc", "wilmink_browser_assisted", "spareto_exact_detail", "manual_review"],
      "Vehicle fitment should be sourced from official or TecAlliance paths first, then public helper fitment tables.",
    ),
    fieldPolicy(
      "vehicle_model",
      [primary, ...tec, "martex_public_tecdoc", "wilmink_browser_assisted", "manual_review"],
      "Vehicle model and type data should stay on technical sources; avoid marketplace-only model naming when a better source exists.",
    ),
    fieldPolicy(
      "market_segment",
      [primary, ...tec, "martex_public_tecdoc", "wilmink_browser_assisted", "spareto_exact_detail", "manual_review"],
      "Market segment should be normalized into PC, CV, LCV, Motorcycle, Engines, Universal, Marine, Industrial, or Agriculture and kept consistent for warehouse and portal filters.",
    ),
    fieldPolicy(
      "engine_code",
      [primary, ...tec, "martex_public_tecdoc", "wilmink_browser_assisted", "manual_review"],
      "Engine code values should come from fitment-focused technical catalogs, not marketplace prose.",
    ),
    fieldPolicy(
      "lifecycle_status",
      [primary, ...tec, "spareto_exact_detail", "manual_review"],
      "Lifecycle state such as continued or no longer available must stay on official or TecAlliance authority whenever possible.",
    ),
    fieldPolicy(
      "lifecycle_note",
      [primary, ...tec, "spareto_exact_detail", "manual_review"],
      "Lifecycle notes should preserve official wording for no longer available, discontinued, or similar commercial states.",
    ),
    fieldPolicy(
      "replacement_code",
      [primary, ...tec, "martex_public_tecdoc", "spareto_exact_detail", "manual_review"],
      "Supersedes and replacement links are high-value technical fields and should prefer official or TecAlliance authority before fallback helpers.",
    ),
    fieldPolicy(
      "hs_code",
      [primary, ...tec, "spareto_exact_detail", "manual_review"],
      "Tariff code should remain on official or TecAlliance authority unless explicitly filled by manual review.",
    ),
    fieldPolicy(
      "origin",
      [primary, ...tec, "spareto_exact_detail", "manual_review"],
      "Origin should stay standardized and technical; marketplace values are fallback only.",
    ),
    fieldPolicy(
      "weight_kg",
      [primary, ...tec, "spareto_exact_detail", "manual_review"],
      "Weight should prefer logistics-capable technical sources. Marketplace values are secondary completion only.",
    ),
    fieldPolicy(
      "image_url",
      [primary, ...tec, "martex_public_tecdoc", "spareto_exact_detail", "manual_review"],
      "Images can fall back to public helper sources when the official catalog does not expose a stable URL.",
    ),
    fieldPolicy(
      "ean",
      [primary, ...tec, "martex_public_tecdoc", "spareto_exact_detail", "manual_review"],
      "EAN is mandatory for warehouse-scannable rows; technical helpers may backfill it, but completion should not stop without it.",
    ),
  ];
}

function buildMarketplaceOnlyFieldPriority(): CatalogFieldSourcePriority[] {
  return [
    fieldPolicy("brand", ["spareto_exact_detail", "manual_review"], "Brand identity is provisional until a stronger official source exists."),
    fieldPolicy("description", ["spareto_exact_detail", "manual_review"], "No official source is configured yet, so marketplace detail is temporary."),
    fieldPolicy("oem_no", ["spareto_exact_detail", "manual_review"], "OEM should be revisited when an official or TecAlliance source is added."),
    fieldPolicy("vehicle", ["spareto_exact_detail", "manual_review"], "Vehicle data is provisional until a stronger technical source exists."),
    fieldPolicy("vehicle_model", ["spareto_exact_detail", "manual_review"], "Vehicle model data is provisional until a stronger technical source exists."),
    fieldPolicy("market_segment", ["spareto_exact_detail", "manual_review"], "Market segment is provisional until a stronger technical source exists."),
    fieldPolicy("engine_code", ["spareto_exact_detail", "manual_review"], "Engine code data is provisional until a stronger technical source exists."),
    fieldPolicy(
      "lifecycle_status",
      ["spareto_exact_detail", "manual_review"],
      "Lifecycle state is provisional until a stronger technical source exists.",
    ),
    fieldPolicy(
      "lifecycle_note",
      ["spareto_exact_detail", "manual_review"],
      "Lifecycle notes are provisional until a stronger technical source exists.",
    ),
    fieldPolicy(
      "replacement_code",
      ["spareto_exact_detail", "manual_review"],
      "Replacement links are provisional until a stronger technical source exists.",
    ),
    fieldPolicy("hs_code", ["spareto_exact_detail", "manual_review"], "HS code is provisional until a stronger technical source exists."),
    fieldPolicy("origin", ["spareto_exact_detail", "manual_review"], "Origin is provisional until a stronger technical source exists."),
    fieldPolicy("weight_kg", ["spareto_exact_detail", "manual_review"], "Weight is provisional until a stronger technical source exists."),
    fieldPolicy("image_url", ["spareto_exact_detail", "manual_review"], "Image fallback is acceptable, but should be upgraded when a better source exists."),
    fieldPolicy("ean", ["spareto_exact_detail", "manual_review"], "EAN is provisional until a stronger technical source exists, but incomplete rows must keep flowing until it is filled."),
  ];
}

function buildTecAlliancePrimaryFieldPriority(brandName: string): CatalogFieldSourcePriority[] {
  return [
    fieldPolicy(
      "brand",
      ["tecalliance_official_session", "official_provider", "manual_review"],
      `${brandName} brand identity should stay tied to the TecAlliance-backed official session.`,
    ),
    fieldPolicy(
      "description",
      ["tecalliance_official_session", "official_provider", "wilmink_browser_assisted", "spareto_exact_detail", "manual_review"],
      `${brandName} uses an official TecAlliance session as the primary description source.`,
    ),
    fieldPolicy(
      "oem_no",
      ["tecalliance_official_session", "official_provider", "martex_public_tecdoc", "spareto_exact_detail", "manual_review"],
      `${brandName} OEM coverage should be treated as TecAlliance-backed technical authority first.`,
    ),
    fieldPolicy(
      "vehicle",
      ["tecalliance_official_session", "official_provider", "martex_public_tecdoc", "wilmink_browser_assisted", "manual_review"],
      `${brandName} vehicle coverage should converge on TecAlliance first, then public fitment helpers when needed.`,
    ),
    fieldPolicy(
      "vehicle_model",
      ["tecalliance_official_session", "official_provider", "martex_public_tecdoc", "wilmink_browser_assisted", "manual_review"],
      `${brandName} vehicle model and type are expected from TecAlliance-style linkage data first.`,
    ),
    fieldPolicy(
      "engine_code",
      ["tecalliance_official_session", "official_provider", "martex_public_tecdoc", "wilmink_browser_assisted", "manual_review"],
      `${brandName} engine code should remain on technical sources only.`,
    ),
    fieldPolicy(
      "lifecycle_status",
      ["tecalliance_official_session", "official_provider", "spareto_exact_detail", "manual_review"],
      `${brandName} lifecycle state should remain technical-first, especially for continued or no-longer-available decisions.`,
    ),
    fieldPolicy(
      "lifecycle_note",
      ["tecalliance_official_session", "official_provider", "spareto_exact_detail", "manual_review"],
      `${brandName} lifecycle notes should preserve official or TecAlliance wording.`,
    ),
    fieldPolicy(
      "replacement_code",
      ["tecalliance_official_session", "official_provider", "martex_public_tecdoc", "manual_review"],
      `${brandName} supersedes and replacement links should stay on TecAlliance-grade authority first.`,
    ),
    fieldPolicy(
      "hs_code",
      ["tecalliance_official_session", "official_provider", "manual_review"],
      `Tariff codes should stay TecAlliance or manual-reviewed for ${brandName}.`,
    ),
    fieldPolicy(
      "origin",
      ["tecalliance_official_session", "official_provider", "manual_review"],
      `Origin should stay on official/TecAlliance authority for ${brandName}.`,
    ),
    fieldPolicy(
      "weight_kg",
      ["tecalliance_official_session", "official_provider", "spareto_exact_detail", "manual_review"],
      `${brandName} logistics criteria already supply weight well; marketplace use is last-mile only.`,
    ),
    fieldPolicy(
      "image_url",
      ["tecalliance_official_session", "official_provider", "martex_public_tecdoc", "spareto_exact_detail", "manual_review"],
      `${brandName} images should prefer TecAlliance-hosted media, then public helper mirrors.`,
    ),
    fieldPolicy(
      "ean",
      ["tecalliance_official_session", "official_provider", "martex_public_tecdoc", "manual_review"],
      `EAN is mandatory technical inventory data for ${brandName} and should stay technical-first.`,
    ),
  ];
}

type PolicyProfile = {
  executionProfile: CatalogExecutionProfile;
  primaryAuthorityKey: CatalogAuthorityKey;
  helperSourceKeys: CatalogAuthorityKey[];
  completionSourceKeys: CatalogAuthorityKey[];
  fieldPriority: CatalogFieldSourcePriority[];
  operationalNotes: string[];
};

function buildPolicyProfile(providerKey: string, brandName: string): PolicyProfile {
  if (providerKey.startsWith("tecalliance_") || providerKey.includes("_tecalliance")) {
    return {
      executionProfile: "official_tecalliance_primary",
      primaryAuthorityKey: "tecalliance_official_session",
      helperSourceKeys: ["official_provider", "martex_public_tecdoc", "wilmink_browser_assisted"],
      completionSourceKeys: ["spareto_exact_detail"],
      fieldPriority: buildTecAlliancePrimaryFieldPriority(brandName),
      operationalNotes: [
        "TecAlliance is the primary technical backbone for this provider, not a loose fallback.",
        "When vehicle, tariff, or origin gaps remain, fill them from other technical helpers before allowing marketplace completion to dominate.",
        "EAN is mandatory for warehouse scanning; rows without EAN stay incomplete until a technical helper resolves them.",
      ],
    };
  }

  if (providerKey === "hengst_connect") {
    return {
      executionProfile: "official_blocked_browser_capture",
      primaryAuthorityKey: "official_provider",
      helperSourceKeys: ["tecalliance_official_session", "martex_public_tecdoc", "wilmink_browser_assisted"],
      completionSourceKeys: ["spareto_exact_detail"],
      fieldPriority: buildDefaultFieldPriority("official_provider"),
      operationalNotes: [
        "Server-side automation is currently blocked. Browser-assisted capture is required until the official source opens a stable access path.",
        "Use the visible title code such as 'E340H D247' as product_code, not the numeric internal item number.",
      ],
    };
  }

  if (
    [
      "ate_official",
      "dayco_official",
      "schaeffler_aftermarket",
      "knorr_bremse_aftermarket",
      "wabco_customercentre",
      "hepu_official",
      "nissens_official",
      "nrf_official",
      "masterturbo_official",
      "federal_mogul_aftermarket",
    ].includes(providerKey)
  ) {
    return {
      executionProfile: "temporary_marketplace_fallback",
      primaryAuthorityKey: "official_provider",
      helperSourceKeys: ["tecalliance_official_session", "martex_public_tecdoc", "wilmink_browser_assisted"],
      completionSourceKeys: ["spareto_exact_detail"],
      fieldPriority: buildDefaultFieldPriority("official_provider"),
      operationalNotes: [
        "Official source remains the authority target even when the current executable flow still relies on Spareto for initial fill.",
        "A brand is not considered fully healthy until technical fields are rechecked against official or TecAlliance-grade sources.",
      ],
    };
  }

  if (providerKey === "hella_official") {
    return {
      executionProfile: "official_blocked_browser_capture",
      primaryAuthorityKey: "official_provider",
      helperSourceKeys: ["tecalliance_official_session", "martex_public_tecdoc", "wilmink_browser_assisted"],
      completionSourceKeys: ["spareto_exact_detail"],
      fieldPriority: buildDefaultFieldPriority("official_provider"),
      operationalNotes: [
        "HELLA official bulk shop access is currently WAF/captcha-blocked for server-side automation.",
        "When a direct HELLA product page is available in a browser session, treat its article number, EAN, description, and image as official browser-assisted evidence.",
        "Spareto remains a temporary bulk fallback and must not be treated as the final authority for warehouse-critical EAN coverage.",
      ],
    };
  }

  if (providerKey === "spareto") {
    return {
      executionProfile: "marketplace_only",
      primaryAuthorityKey: "spareto_exact_detail",
      helperSourceKeys: [],
      completionSourceKeys: [],
      fieldPriority: buildMarketplaceOnlyFieldPriority(),
      operationalNotes: [
        "This is a stopgap profile for brands without a mapped official source.",
        "Promote the brand to an official-first plan as soon as a stable authority source is identified.",
      ],
    };
  }

  return {
    executionProfile: "official_first",
    primaryAuthorityKey: "official_provider",
    helperSourceKeys: ["tecalliance_official_session", "martex_public_tecdoc", "wilmink_browser_assisted"],
    completionSourceKeys: ["spareto_exact_detail"],
    fieldPriority: buildDefaultFieldPriority("official_provider"),
    operationalNotes: [
      "Official source is the primary authority for initial sync and resync.",
      "Spareto remains a completion path only; it should not overwrite stronger technical fields unless the official source is silent.",
    ],
  };
}

export function createCatalogSourcePolicy(input: { providerKey: string; brandName: string }): CatalogBrandSourcePolicy {
  const profile = buildPolicyProfile(input.providerKey, input.brandName);
  return {
    version: CATALOG_SOURCE_POLICY_VERSION,
    providerKey: input.providerKey,
    brandName: input.brandName,
    primaryAuthority: authority(profile.primaryAuthorityKey),
    executionProfile: profile.executionProfile,
    helperSources: profile.helperSourceKeys.map(authority),
    completionSources: profile.completionSourceKeys.map(authority),
    fieldPriority: profile.fieldPriority,
    operationalNotes: profile.operationalNotes,
  };
}
