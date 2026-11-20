import { canonicalizePriceBrandName, canonicalizePriceProductCode, normalizeBrandKey, normalizePartCode, splitOriginalNumberCandidates } from "../domain/shared/normalize";

export type SalesOrderOeCandidate = {
  product_id: string;
  product_code: string;
  brand: string;
  description: string | null;
  vehicle: string | null;
  oem_no: string;
  has_more: boolean;
};

/**
 * Only present products explicitly associated with the entered OE number.
 * Search results can also contain partial codes, descriptions, and other
 * numbers; those must never be silently used as a priced product.
 */
export function selectExactOeCandidates<T extends { product_id: string; product_code: string; brand: string; oem_no: string }>(
  rows: T[],
  oeNumber: string,
): T[] {
  const target = normalizePartCode(oeNumber);
  if (!target) return [];
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.product_id || !row.product_code || !row.brand || seen.has(row.product_id)) return false;
    const matches = splitOriginalNumberCandidates(row.oem_no).some((number) => normalizePartCode(number) === target);
    if (matches) seen.add(row.product_id);
    return matches;
  });
}

/** The price resolver has no product-id input, so duplicate SKU/brand rows
 * cannot safely be resolved to a specific catalog record. */
export function hasAmbiguousSku<T extends { product_id: string; product_code: string; brand: string }>(rows: T[], candidate: T): boolean {
  const brand = normalizeBrandKey(canonicalizePriceBrandName(candidate.brand, candidate.product_code));
  const sku = canonicalizePriceProductCode(candidate.product_code, candidate.brand);
  return rows.some((row) => row.product_id !== candidate.product_id &&
    normalizeBrandKey(canonicalizePriceBrandName(row.brand, row.product_code)) === brand &&
    canonicalizePriceProductCode(row.product_code, row.brand) === sku);
}
