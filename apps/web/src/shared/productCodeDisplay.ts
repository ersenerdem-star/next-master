import { canonicalizeBrandName, normalizeBrandKey, normalizePartCode } from "../domain/shared/normalize";

const BRAND_AWARE_PRODUCT_CODE_BRANDS = new Set([
  "bosch",
  "hella",
  "hengst",
  "knorr",
  "knorrbremse",
  "lemforder",
  "mahle",
  "mann",
  "mannfilter",
  "sachs",
  "wabco",
]);

export function formatBrandAwareProductCode(productCode: string, brandName = ""): string {
  const raw = String(productCode || "").trim();
  if (!raw) return "";

  const brandKey = normalizeBrandKey(canonicalizeBrandName(brandName));
  if (BRAND_AWARE_PRODUCT_CODE_BRANDS.has(brandKey)) {
    return normalizePartCode(raw);
  }

  return raw;
}
