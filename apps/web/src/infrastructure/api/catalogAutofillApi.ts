import { normalizeOriginalNumberSearch, splitOriginalNumberCandidates } from "../../domain/shared/normalize";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";

export type CatalogAutofillDraft = {
  description?: string | null;
  oem_no?: string | null;
  vehicle?: string | null;
  hs_code?: string | null;
  origin?: string | null;
  weight_kg?: number | null;
  lifecycle_status?: string | null;
  lifecycle_note?: string | null;
  market_segment?: string | null;
};

type CatalogAutofillRow = {
  id: string;
  description: string | null;
  oem_no: string | null;
  vehicle: string | null;
  hs_code: string | null;
  origin: string | null;
  weight_kg: number | null;
  lifecycle_status: string | null;
  lifecycle_note: string | null;
  market_segment: string | null;
  updated_at?: string | null;
};

const MAX_OEM_AUTOFILL_TOKENS = 8;
const MAX_OEM_AUTOFILL_CANDIDATES = 120;

function isBlankText(value: string | null | undefined) {
  return !String(value || "").trim();
}

function isBlankNumber(value: number | null | undefined) {
  return value == null || Number.isNaN(Number(value));
}

function extractComparableOemTokens(value: string | null | undefined) {
  return [
    ...new Set(
      splitOriginalNumberCandidates(String(value || ""))
        .map((token) => normalizeOriginalNumberSearch(token))
        .filter((token) => token.length >= 4),
    ),
  ];
}

function countSharedTokens(baseTokens: Set<string>, candidateOem: string | null | undefined) {
  let shared = 0;
  for (const token of extractComparableOemTokens(candidateOem)) {
    if (baseTokens.has(token)) shared += 1;
  }
  return shared;
}

function countFilledCandidateFields(row: CatalogAutofillRow) {
  let score = 0;
  if (!isBlankText(row.description)) score += 1;
  if (!isBlankText(row.vehicle)) score += 1;
  if (!isBlankText(row.hs_code)) score += 1;
  if (!isBlankText(row.origin)) score += 1;
  if (!isBlankNumber(row.weight_kg)) score += 1;
  if (!isBlankText(row.lifecycle_note)) score += 1;
  if (!isBlankText(row.market_segment)) score += 1;
  return score;
}

function compareCandidates(left: CatalogAutofillRow & { sharedOemCount: number }, right: CatalogAutofillRow & { sharedOemCount: number }) {
  if (right.sharedOemCount !== left.sharedOemCount) return right.sharedOemCount - left.sharedOemCount;
  const filledDelta = countFilledCandidateFields(right) - countFilledCandidateFields(left);
  if (filledDelta !== 0) return filledDelta;
  const rightUpdated = new Date(String(right.updated_at || "")).getTime() || 0;
  const leftUpdated = new Date(String(left.updated_at || "")).getTime() || 0;
  return rightUpdated - leftUpdated;
}

export function hasMissingCatalogAutofillFields(draft: CatalogAutofillDraft) {
  return (
    isBlankText(draft.description) ||
    isBlankText(draft.vehicle) ||
    isBlankText(draft.hs_code) ||
    isBlankText(draft.origin) ||
    isBlankNumber(draft.weight_kg) ||
    isBlankText(draft.lifecycle_note)
  );
}

export function mergeCatalogDraftWithSiblingHints<T extends CatalogAutofillDraft>(draft: T, hints: Partial<CatalogAutofillDraft> | null) {
  if (!hints) return draft;
  return {
    ...draft,
    description: isBlankText(draft.description) ? hints.description ?? draft.description ?? null : draft.description ?? null,
    vehicle: isBlankText(draft.vehicle) ? hints.vehicle ?? draft.vehicle ?? null : draft.vehicle ?? null,
    hs_code: isBlankText(draft.hs_code) ? hints.hs_code ?? draft.hs_code ?? null : draft.hs_code ?? null,
    origin: isBlankText(draft.origin) ? hints.origin ?? draft.origin ?? null : draft.origin ?? null,
    weight_kg: isBlankNumber(draft.weight_kg) ? hints.weight_kg ?? draft.weight_kg ?? null : draft.weight_kg ?? null,
    lifecycle_status: isBlankText(draft.lifecycle_status) ? hints.lifecycle_status ?? draft.lifecycle_status ?? null : draft.lifecycle_status ?? null,
    lifecycle_note: isBlankText(draft.lifecycle_note) ? hints.lifecycle_note ?? draft.lifecycle_note ?? null : draft.lifecycle_note ?? null,
    market_segment: isBlankText(draft.market_segment) ? hints.market_segment ?? draft.market_segment ?? null : draft.market_segment ?? null,
  } as T;
}

export async function fetchSiblingCatalogAutofillHints(input: {
  organizationId?: string;
  brandId: string;
  productId?: string;
  draft: CatalogAutofillDraft;
}) {
  const brandId = String(input.brandId || "").trim();
  if (!brandId || !hasMissingCatalogAutofillFields(input.draft)) return null;

  const oemTokens = extractComparableOemTokens(input.draft.oem_no);
  if (oemTokens.length < 2) return null;

  const organizationId = input.organizationId || (await getCurrentOrgId());
  const queryTokens = oemTokens.slice(0, MAX_OEM_AUTOFILL_TOKENS);
  const oemFilters = queryTokens.map((token) => `oem_no.ilike.%${token}%`).join(",");

  const query = supabaseClient
    .from("catalog_products")
    .select("id,description,oem_no,vehicle,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note,market_segment,updated_at")
    .eq("organization_id", organizationId)
    .eq("brand_id", brandId)
    .or(oemFilters)
    .limit(MAX_OEM_AUTOFILL_CANDIDATES);

  const filteredQuery = input.productId ? query.neq("id", input.productId) : query;
  const { data, error } = await filteredQuery;
  if (error) {
    console.warn("Catalog OEM autofill lookup failed; continuing without sibling hints.", error);
    return null;
  }

  const tokenSet = new Set(oemTokens);
  const bestMatch = ((data || []) as CatalogAutofillRow[])
    .map((row) => ({
      ...row,
      sharedOemCount: countSharedTokens(tokenSet, row.oem_no),
    }))
    .filter((row) => row.sharedOemCount >= 2)
    .sort(compareCandidates)[0];

  if (!bestMatch) return null;
  return {
    description: bestMatch.description,
    vehicle: bestMatch.vehicle,
    hs_code: bestMatch.hs_code,
    origin: bestMatch.origin,
    weight_kg: bestMatch.weight_kg,
    lifecycle_status: bestMatch.lifecycle_status,
    lifecycle_note: bestMatch.lifecycle_note,
    market_segment: bestMatch.market_segment,
  } satisfies Partial<CatalogAutofillDraft>;
}
