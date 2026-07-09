import { normalizeBrandKey, normalizeBrandName } from "../domain/shared/normalize";

// Canonical import-resolution aliases. This does not create brands; it only
// maps known imported text to existing master-data names before validation.
const BRAND_ALIAS_BY_KEY: Record<string, string> = {
  lemfoerder: "Lemforder",
};

export type BrandResolutionOption = {
  value?: string;
  label?: string;
  name?: string;
};

export type BrandResolutionResult = {
  input: string;
  normalizedInput: string;
  resolvedName: string;
  canonicalName: string;
  found: boolean;
};

export function resolveBrandAlias(value: string): string {
  const normalized = normalizeBrandName(value);
  if (!normalized) return "";
  return BRAND_ALIAS_BY_KEY[normalizeBrandKey(normalized)] || normalized;
}

export function buildBrandResolutionLookup(brands: BrandResolutionOption[]): Map<string, string> {
  const lookup = new Map<string, string>();
  brands.forEach((brand) => {
    const canonicalName = normalizeBrandName(brand.value || brand.label || brand.name || "");
    const canonicalKey = normalizeBrandKey(canonicalName);
    if (canonicalKey && !lookup.has(canonicalKey)) {
      lookup.set(canonicalKey, canonicalName);
    }

    Object.entries(BRAND_ALIAS_BY_KEY).forEach(([aliasKey, aliasTarget]) => {
      if (normalizeBrandKey(aliasTarget) === canonicalKey && !lookup.has(aliasKey)) {
        lookup.set(aliasKey, canonicalName);
      }
    });
  });
  return lookup;
}

export function resolveCanonicalBrandName(value: string, brandLookup: Map<string, string>): BrandResolutionResult {
  const normalizedInput = normalizeBrandName(value);
  const resolvedName = resolveBrandAlias(normalizedInput);
  const canonicalName = brandLookup.get(normalizeBrandKey(resolvedName)) || brandLookup.get(normalizeBrandKey(normalizedInput)) || "";
  return {
    input: value,
    normalizedInput,
    resolvedName,
    canonicalName,
    found: Boolean(canonicalName),
  };
}
