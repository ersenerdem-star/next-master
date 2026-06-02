import { buildRestUrl, getJson, sendJson, serviceRoleHeaders } from "./http.mts";
import { buildPortalSnapshot } from "./portal-access.mts";
import { normalizeLifecycleStatus, sanitizeCatalogOemNumbers } from "./catalog-standardization.mts";

type PortalInviteRow = {
  id: string;
  organization_id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  customer_id: string | null;
  vendor_id: string | null;
  email: string;
  contact_name: string;
  status: "draft" | "invited" | "active" | "disabled";
  invite_token_hash?: string | null;
  access_can_view_account: boolean;
  access_can_view_invoices: boolean;
  access_can_view_payments: boolean;
  access_can_view_orders: boolean;
};

type CustomerRow = {
  id: string;
  display_name: string;
  company_name: string;
  currency: string;
  payment_terms: string;
  contract_nr: string;
  seller_company_profile_id: string | null;
  price_list_type: string;
  portal_c_price_mode: "standard" | "prefer_c_when_available" | null;
  price_list_margin_percent: number | null;
};

type CompanyProfileRow = {
  id?: string;
  company_name: string;
};

type PortalCatalogSearchItem = {
  code: string;
  brand: string;
  description: string;
  oem_no: string;
  vehicle: string;
  tariff: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  sell_price: number | null;
  currency: string;
  supplier_name: string;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
  replacement_code?: string | null;
  replacement_old_code?: string | null;
  replacement_reason?: string | null;
  replacement_warning?: string | null;
  recommendation_reason?: string | null;
  available_qty?: number | null;
};

type SearchCatalogBaseItem = {
  code: string;
  brand: string;
  brand_id: string;
  normalized_code: string;
  description: string;
  oem_no: string;
  vehicle: string;
  tariff: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  lifecycle_status: "active" | "discontinued" | null;
  lifecycle_note: string | null;
  replacement: {
    old_code: string;
    new_code: string;
    reason: string | null;
  } | null;
  recommendation_reason?: string | null;
  available_qty?: number | null;
};

type PortalCatalogSearchResponse = {
  items: PortalCatalogSearchItem[];
  recommendations: PortalCatalogSearchItem[];
};

type PortalPriceListRow = {
  product_code: string;
  brand: string;
  description: string;
  price_list_type: "A" | "B" | "C" | "Other";
  sales_price: number | null;
  price_date: string | null;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
};

type PortalOrderInputRow = {
  code: string;
  brand: string;
  qty: number;
};

type PreparedPortalLine = {
  lineId: string;
  requestedCode: string;
  resolvedCode: string;
  brand: string;
  description: string;
  qty: number;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  supplier_name: string;
  buy_price: number | null;
  sell_price: number | null;
  c_sell_price: number | null;
  price_date: string;
  notes: string;
  found: boolean;
  codeChanged: boolean;
  codeChangeWarning: string;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
  replacement_code?: string | null;
  replacement_old_code?: string | null;
  replacement_reason?: string | null;
  replacement_warning?: string | null;
  supplierOptions: Array<{
    supplier_id?: string | null;
    supplier_name: string;
    buy_price: number | null;
    price_date: string | null;
    sell_price: number | null;
    notes: string | null;
  }>;
  selectedSupplierKey: string;
};

type CustomerPricingContext = {
  organizationId: string;
  customer: CustomerRow;
  sellerCompany: string;
  currency: string;
  customerType: "A" | "B" | "C" | "Other";
  portalCPriceMode: "standard" | "prefer_c_when_available";
  effectiveMarginA: number;
  effectiveMarginB: number;
  cPriceListId: string;
};

const CUSTOMER_ORDER_SELECT =
  "id,display_name,company_name,currency,payment_terms,contract_nr,custom_fields,seller_company_profile_id,price_list_type,portal_c_price_mode,price_list_margin_percent";
const CUSTOMER_ORDER_SELECT_LEGACY =
  "id,display_name,company_name,currency,payment_terms,contract_nr,custom_fields,price_list_type";
const PORTAL_LOOKUP_CACHE_TTL_MS = 2 * 60 * 1000;
const PORTAL_PRICE_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const PORTAL_PRICE_LIST_MAX_ROWS = 100000;
const CUSTOMER_META_PREFIX = "[[NEXT_MASTER_META]]";

type PortalLookupCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const portalBrandMapCache = new Map<string, PortalLookupCacheEntry<{ byId: Map<string, string>; byName: Map<string, string> }>>();
const portalCustomerContextCache = new Map<string, PortalLookupCacheEntry<CustomerPricingContext>>();
const portalPriceListCache = new Map<
  string,
  PortalLookupCacheEntry<{
    priceListType: CustomerPricingContext["customerType"];
    pricingMode: CustomerPricingContext["portalCPriceMode"];
    currency: string;
    rows: PortalPriceListRow[];
  }>
>();
const DESCRIPTION_FAMILY_STOPWORDS = new Set([
  "and",
  "the",
  "with",
  "without",
  "for",
  "kit",
  "set",
  "repair",
  "service",
  "assy",
  "assembly",
  "complete",
  "rear",
  "front",
  "left",
  "right",
  "upper",
  "lower",
  "inner",
  "outer",
  "heavy",
  "duty",
  "truck",
  "vehicle",
  "part",
]);
const VEHICLE_MAKER_PATTERNS = [
  { label: "Mercedes-Benz", pattern: /\b(?:MERCEDES(?:-BENZ)?|MBB)\b/i },
  { label: "MAN", pattern: /\bMAN\b/i },
  { label: "Volvo", pattern: /\bVOLVO\b/i },
  { label: "DAF", pattern: /\bDAF\b/i },
  { label: "Scania", pattern: /\bSCANIA\b/i },
  { label: "Volkswagen", pattern: /\b(?:VW|VOLKSWAGEN)\b/i },
  { label: "Audi", pattern: /\bAUDI\b/i },
  { label: "Iveco", pattern: /\bIVECO\b/i },
  { label: "Renault", pattern: /\bRENAULT\b/i },
  { label: "Ford", pattern: /\bFORD\b/i },
  { label: "BMW", pattern: /\bBMW\b/i },
  { label: "Toyota", pattern: /\bTOYOTA\b/i },
  { label: "Nissan", pattern: /\bNISSAN\b/i },
  { label: "Peugeot", pattern: /\bPEUGEOT\b/i },
  { label: "Citroen", pattern: /\bCITROE?N\b/i },
  { label: "Opel", pattern: /\bOPEL\b/i },
  { label: "Skoda", pattern: /\bSKODA\b/i },
  { label: "Chevrolet", pattern: /\bCHEVROLET\b/i },
];

function portalAllowedBrandIds(invite: PortalInviteRow) {
  return [...new Set((Array.isArray(invite.allowed_brand_ids) ? invite.allowed_brand_ids : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function applyPortalBrandScope(params: Record<string, string>, invite: PortalInviteRow, selectedBrandId = "") {
  const allowedBrandIds = portalAllowedBrandIds(invite);
  const allowedSet = new Set(allowedBrandIds);
  if (selectedBrandId) {
    if (allowedSet.size && !allowedSet.has(selectedBrandId)) {
      throw new Error("Brand is outside this portal scope.");
    }
    params.brand_id = `eq.${selectedBrandId}`;
    return { allowedBrandIds, allowedSet };
  }
  if (allowedSet.size) {
    params.brand_id = `in.(${allowedBrandIds.join(",")})`;
  }
  return { allowedBrandIds, allowedSet };
}

function assertPortalRowsWithinBrandScope(invite: PortalInviteRow, brandMap: { byId: Map<string, string>; byName: Map<string, string> }, rows: PortalOrderInputRow[]) {
  const allowedBrandIds = portalAllowedBrandIds(invite);
  if (!allowedBrandIds.length) return;
  const allowedSet = new Set(allowedBrandIds);
  for (const row of rows) {
    const brandId = brandMap.byName.get(String(row.brand || "").trim().toLowerCase()) || "";
    if (!brandId || !allowedSet.has(brandId)) {
      throw new Error(`Brand is outside this portal scope: ${String(row.brand || "").trim() || "Unknown"}`);
    }
  }
}

function normalizePartCode(value: string) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeOriginalNumberSearch(value: string) {
  const normalized = normalizePartCode(value);
  if (!normalized) return "";
  const stripped = normalized.replace(/^[A-Z]{1,3}(?=\d{6,}$)/, "");
  return stripped || normalized;
}

function buildLooseOriginalNumberPattern(value: string, wildcard = "*") {
  const normalized = normalizeOriginalNumberSearch(value);
  if (!normalized) return "";
  return normalized.split("").join(wildcard);
}

function buildSeparatorInsensitivePattern(value: string, wildcard = "*") {
  const tokens = String(value || "")
    .toUpperCase()
    .match(/[A-Z0-9]+/g);
  if (!tokens?.length) return "";
  return tokens.join(wildcard);
}

function buildOriginalNumberVariants(value: string) {
  const variants = new Set<string>();
  const normalized = normalizePartCode(value);
  if (normalized) variants.add(normalized);
  const normalizedOriginal = normalizeOriginalNumberSearch(value);
  if (normalizedOriginal) variants.add(normalizedOriginal);
  const edgeStripped = normalized
    .replace(/^[A-Z]{1,4}(?=\d{6,}[A-Z]{0,4}$)/, "")
    .replace(/[A-Z]{1,4}$/, "");
  if (edgeStripped) variants.add(edgeStripped);
  for (const digitRun of normalized.match(/\d{6,}/g) || []) {
    variants.add(digitRun);
  }
  return [...variants];
}

function buildComparableOriginalNumberTokens(value: string) {
  const tokens = new Set<string>();
  for (const variant of buildOriginalNumberVariants(value)) {
    const normalized = normalizePartCode(variant);
    if (normalized.length >= 6) tokens.add(normalized);
    const stripped = normalized.replace(/^[A-Z]{1,4}(?=\d{6,}[A-Z]{0,4}$)/, "").replace(/[A-Z]{1,4}$/, "");
    if (stripped.length >= 6) tokens.add(stripped);
    for (const digitRun of normalized.match(/\d{6,}/g) || []) {
      if (digitRun.length >= 6) tokens.add(digitRun);
    }
  }
  return [...tokens];
}

function splitOriginalNumberCandidates(value: string) {
  const raw = String(value || "").replace(/\r/g, "\n").trim();
  if (!raw) return [];
  const pieces = raw
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return pieces.length ? pieces : [raw];
}

function matchesOriginalNumberSearch(haystack: string, needle: string) {
  const needleTokens = buildComparableOriginalNumberTokens(needle);
  if (!needleTokens.length) return false;
  const candidates = splitOriginalNumberCandidates(haystack);
  if (candidates.some((candidate) => buildComparableOriginalNumberTokens(candidate).some((token) => needleTokens.includes(token)))) {
    return true;
  }
  return buildComparableOriginalNumberTokens(haystack).some((token) => needleTokens.includes(token));
}

function buildCatalogRowDedupKey(row: Record<string, unknown>) {
  const brandId = String(row.brand_id || "").trim();
  const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || ""))).trim();
  if (brandId && normalizedCode) return `${brandId}::${normalizedCode}`;
  return String(row.id || row.product_code || "").trim();
}

function scoreCatalogRowCompleteness(row: Record<string, unknown>) {
  let score = 0;
  if (String(row.image_url || "").trim()) score += 4;
  if (String(row.oem_no || "").trim()) score += 3;
  if (String(row.vehicle || "").trim()) score += 3;
  if (String(row.description || "").trim()) score += 2;
  if (String(row.hs_code || "").trim()) score += 1;
  if (String(row.origin || "").trim()) score += 1;
  if (row.weight_kg != null && String(row.weight_kg).trim() !== "") score += 1;
  if (normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`) !== "discontinued") score += 1;
  return score;
}

function dedupeCatalogRows(rows: Array<Record<string, unknown>>) {
  const bestByKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = buildCatalogRowDedupKey(row);
    if (!key) continue;
    const current = bestByKey.get(key);
    if (!current || scoreCatalogRowCompleteness(row) > scoreCatalogRowCompleteness(current)) {
      bestByKey.set(key, row);
    }
  }
  return [...bestByKey.values()];
}

function supplementalSearchVariants(search: string) {
  const normalized = normalizePartCode(search);
  return buildOriginalNumberVariants(search).filter((variant) => variant.length >= 6 && variant !== normalized);
}

function buildOriginalNumberFamilyCore(search: string) {
  return normalizeOriginalNumberSearch(search);
}

function buildOriginalNumberFamilyTokens(search: string) {
  const tokens = new Set<string>();
  for (const variant of buildOriginalNumberVariants(search)) {
    const cleaned = variant.replace(/^[A-Z]{1,4}(?=\d{6,}[A-Z]{0,4}$)/, "").replace(/[A-Z]{1,4}$/, "");
    if (cleaned.length >= 6) tokens.add(cleaned);
    if (variant.length >= 6) tokens.add(variant);
    for (const digitRun of variant.match(/\d{6,}/g) || []) {
      tokens.add(digitRun);
    }
  }
  return [...tokens].filter((token) => token.length >= 6);
}

function buildOriginalNumberFamilyClauses(search: string) {
  const clauses = new Set<string>();
  for (const token of buildOriginalNumberFamilyTokens(search)) {
    clauses.add(`normalized_oem.eq.${token}`);
    clauses.add(`normalized_code.eq.${token}`);
    clauses.add(`normalized_code.like.${token}*`);
    clauses.add(`normalized_oem.like.${token}*`);
    if (token.length >= 8) {
      clauses.add(`normalized_oem.like.*${token}*`);
    }
    if (!/^\d+$/.test(token) || token.length >= 8) {
      clauses.add(`product_code.ilike.${token}*`);
    }
  }
  return [...clauses];
}

function collectCatalogComparableTokensFromRows(rows: Array<Record<string, unknown>>) {
  const tokens = new Set<string>();
  for (const row of rows) {
    for (const candidate of [
      String(row.product_code || ""),
      String(row.normalized_code || ""),
      String(row.oem_no || ""),
      String(row.normalized_oem || ""),
    ]) {
      for (const token of buildComparableOriginalNumberTokens(candidate)) {
        if (token.length >= 6) tokens.add(token);
      }
    }
  }
  return [...tokens].slice(0, 12);
}

function buildCatalogSeedExpansionClauses(tokens: string[]) {
  const clauses = new Set<string>();
  for (const token of tokens) {
    clauses.add(`normalized_code.eq.${token}`);
    clauses.add(`normalized_oem.eq.${token}`);
    clauses.add(`normalized_code.like.${token}*`);
    clauses.add(`normalized_oem.like.${token}*`);
    if (token.length >= 8) {
      clauses.add(`normalized_oem.like.*${token}*`);
    }
    if (!/^\d+$/.test(token) || token.length >= 8) {
      clauses.add(`product_code.ilike.${token}*`);
    }
  }
  return [...clauses];
}

function matchesCatalogSeedTokenRow(row: Record<string, unknown>, seedTokens: Set<string>) {
  if (!seedTokens.size) return false;
  return [
    String(row.product_code || ""),
    String(row.normalized_code || ""),
    String(row.oem_no || ""),
    String(row.normalized_oem || ""),
  ].some((candidate) => buildComparableOriginalNumberTokens(candidate).some((token) => seedTokens.has(token)));
}

function matchesCatalogFamilyRow(row: Record<string, unknown>, search: string) {
  const familyVariants = buildOriginalNumberFamilyTokens(search);
  if (!familyVariants.length) return false;
  const normalizedProductCode = normalizePartCode(String(row.product_code || ""));
  const normalizedCode = normalizePartCode(String(row.normalized_code || ""));
  const normalizedOem = normalizePartCode(String(row.normalized_oem || ""));
  return (
    matchesOriginalNumberSearch(String(row.oem_no || row.normalized_oem || ""), search) ||
    familyVariants.some(
      (variant) =>
        normalizedProductCode === variant ||
        normalizedCode === variant ||
        normalizedOem === variant ||
        buildComparableOriginalNumberTokens(String(row.product_code || "")).includes(variant) ||
        buildComparableOriginalNumberTokens(String(row.normalized_oem || row.oem_no || "")).includes(variant),
    )
  );
}

function matchesCatalogExactFamilyRow(row: Record<string, unknown>, search: string) {
  const familyVariants = new Set(buildOriginalNumberFamilyTokens(search));
  if (!familyVariants.size) return false;
  const normalizedProductCode = normalizePartCode(String(row.product_code || ""));
  const normalizedCode = normalizePartCode(String(row.normalized_code || ""));
  const normalizedOem = normalizePartCode(String(row.normalized_oem || ""));
  if (familyVariants.has(normalizedProductCode) || familyVariants.has(normalizedCode) || familyVariants.has(normalizedOem)) {
    return true;
  }
  return splitOriginalNumberCandidates(String(row.oem_no || "")).some((candidate) =>
    buildOriginalNumberVariants(candidate).some((variant) => familyVariants.has(variant)),
  );
}

function extractDescriptionFamilyTokens(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/\d/.test(token) && !DESCRIPTION_FAMILY_STOPWORDS.has(token))
    .slice(0, 6);
}

function resolveCatalogFamilyAnchor(rows: Array<Record<string, unknown>>) {
  const tokenLists = rows
    .map((row) => extractDescriptionFamilyTokens(String(row.description || "")))
    .filter((tokens) => tokens.length);
  if (!tokenLists.length) return [] as string[];
  const intersection = tokenLists.reduce<string[]>((current, tokens) => current.filter((token) => tokens.includes(token)), [...tokenLists[0]]);
  if (intersection.length) return intersection.slice(0, 3);
  return tokenLists[0].slice(0, 3);
}

function matchesCatalogDescriptionFamily(row: Record<string, unknown>, anchorTokens: string[]) {
  if (!anchorTokens.length) return true;
  const rowTokens = extractDescriptionFamilyTokens(String(row.description || ""));
  return rowTokens.some((token) => anchorTokens.includes(token));
}

function hasCatalogReplacementMatch(
  row: Record<string, unknown>,
  replacementRowsByKey: Map<string, { old_code: string; new_code: string; reason: string | null }>,
) {
  const brandId = String(row.brand_id || "");
  const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || "")));
  return replacementRowsByKey.has(`${brandId}::${normalizedCode}`);
}

function filterCatalogRowsBySearchRelevance(
  rows: Array<Record<string, unknown>>,
  search: string,
  replacementRowsByKey: Map<string, { old_code: string; new_code: string; reason: string | null }> = new Map(),
) {
  const deduped = dedupeCatalogRows(rows);
  if (!search || !shouldStrictlyFilterCodeSearch(search)) return deduped;
  const exactRows = deduped.filter((row) => matchesCatalogExactFamilyRow(row, search) || hasCatalogReplacementMatch(row, replacementRowsByKey));
  if (!exactRows.length) {
    return deduped.filter((row) => matchesCatalogExactFamilyRow(row, search) || hasCatalogReplacementMatch(row, replacementRowsByKey));
  }
  const seedTokens = new Set(collectCatalogComparableTokensFromRows(exactRows));
  const anchorTokens = resolveCatalogFamilyAnchor(exactRows);
  return deduped.filter((row) => {
    if (exactRows.includes(row)) return true;
    if (hasCatalogReplacementMatch(row, replacementRowsByKey)) return true;
    if (!matchesCatalogFamilyRow(row, search) && !matchesCatalogSeedTokenRow(row, seedTokens)) return false;
    return matchesCatalogDescriptionFamily(row, anchorTokens);
  });
}

type PortalSearchMode = "strict" | "loose";
const PORTAL_CODE_SEARCH_EXPANSION_THRESHOLD = 8;

function shouldRunLooseOriginalNumberSearch(search: string) {
  return normalizeOriginalNumberSearch(search).length >= 6;
}

function isLikelyPortalCodeSearch(search: string) {
  const value = String(search || "").trim();
  if (!value) return false;
  return /\d/.test(value) || /[-/+.()]/.test(value);
}

function shouldStrictlyFilterCodeSearch(search: string) {
  const normalizedOriginal = normalizeOriginalNumberSearch(search);
  return isLikelyPortalCodeSearch(search) && normalizedOriginal.length >= 6;
}

function buildPortalCatalogSearchOr(search: string, normalizedSearch: string, mode: PortalSearchMode) {
  const escaped = search.replace(/[%*(),]/g, " ").trim();
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  const normalizedSearchVariants = buildOriginalNumberVariants(search).filter((variant) => variant.length >= 6);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(search);
  const separatorInsensitivePattern = buildSeparatorInsensitivePattern(search);
  const clauses = new Set<string>();
  const isCodeSearch = isLikelyPortalCodeSearch(search);
  if (isCodeSearch) {
    if (normalizedSearch.length >= 3) {
      clauses.add(`normalized_code.eq.${normalizedSearch}`);
      clauses.add(`normalized_oem.eq.${normalizedSearch}`);
      clauses.add(`normalized_code.like.${normalizedSearch}*`);
      clauses.add(`normalized_oem.like.${normalizedSearch}*`);
      if (mode === "loose" && normalizedOriginalSearch.length >= 8) {
        clauses.add(`normalized_oem.like.*${normalizedOriginalSearch}*`);
      }
    }
    for (const variant of normalizedSearchVariants) {
      clauses.add(`normalized_code.eq.${variant}`);
      clauses.add(`normalized_oem.eq.${variant}`);
      clauses.add(`normalized_code.like.${variant}*`);
      clauses.add(`normalized_oem.like.${variant}*`);
      if (mode === "loose" && variant.length >= 8) {
        clauses.add(`normalized_oem.like.*${variant}*`);
      }
    }
    if (escaped && escaped.length <= 24 && (/[A-Z]/i.test(escaped) || normalizedOriginalSearch.length >= 8)) {
      clauses.add(`product_code.ilike.${escaped}*`);
    }
    if (separatorInsensitivePattern && separatorInsensitivePattern !== escaped.toUpperCase() && /[A-Z]/i.test(separatorInsensitivePattern)) {
      clauses.add(`product_code.ilike.${separatorInsensitivePattern}*`);
    }
    if (mode === "loose" && normalizedOriginalSearch.length >= 6) {
      clauses.add(`normalized_oem.like.*${normalizedOriginalSearch}*`);
    }
    return `(${[...clauses].join(",")})`;
  }
  if (escaped) {
    clauses.add(`product_code.ilike.*${escaped}*`);
    clauses.add(`oem_no.ilike.*${escaped}*`);
    clauses.add(`description.ilike.*${escaped}*`);
  }
  if (separatorInsensitivePattern && separatorInsensitivePattern !== escaped.toUpperCase()) {
    clauses.add(`product_code.ilike.*${separatorInsensitivePattern}*`);
    clauses.add(`oem_no.ilike.*${separatorInsensitivePattern}*`);
  }
  if (normalizedSearch.length >= 3) {
    clauses.add(`normalized_code.eq.${normalizedSearch}`);
    clauses.add(`normalized_oem.eq.${normalizedSearch}`);
    clauses.add(`normalized_code.like.${normalizedSearch}*`);
    clauses.add(`normalized_oem.like.${normalizedSearch}*`);
    if (normalizedSearch.length <= 8) {
      clauses.add(`product_code.ilike.*${normalizedSearch}*`);
      clauses.add(`oem_no.ilike.*${normalizedSearch}*`);
    }
  }
  if (mode === "loose" && looseOriginalPattern.length >= 6) {
    clauses.add(`oem_no.ilike.*${looseOriginalPattern}*`);
  }
  if (mode === "loose" && normalizedOriginalSearch.length >= 6) {
    clauses.add(`normalized_oem.like.*${normalizedOriginalSearch}*`);
  }
  return `(${[...clauses].join(",")})`;
}

function buildDiscontinuedWarning(resolvedCode: string, note?: string | null) {
  const code = String(resolvedCode || "").trim();
  const base = code ? `Production ended for ${code}.` : "Production ended for this item.";
  const detail = String(note || "").trim();
  return detail ? `${base} ${detail}` : base;
}

function buildReplacementWarning(oldCode: string, newCode: string, reason?: string | null) {
  const previousCode = String(oldCode || "").trim();
  const replacementCode = String(newCode || "").trim();
  const detail = String(reason || "").trim();
  const base =
    previousCode && replacementCode
      ? `Old Code ${previousCode} => New Code ${replacementCode}.`
      : replacementCode
        ? `Use New Code ${replacementCode}.`
        : "Replacement code available.";
  return detail ? `${base} ${detail}` : base;
}

function extractVehicleMakerTokens(value: string) {
  const matches = new Set<string>();
  const source = String(value || "");
  for (const entry of VEHICLE_MAKER_PATTERNS) {
    if (entry.pattern.test(source)) matches.add(entry.label);
  }
  return [...matches];
}

function countSharedTokens(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let count = 0;
  for (const token of left) {
    if (rightSet.has(token)) count += 1;
  }
  return count;
}

function mapCatalogRowsToBaseItems(
  rows: Array<Record<string, unknown>>,
  brandMap: { byId: Map<string, string>; byName: Map<string, string> },
  replacementRowsByKey: Map<string, { old_code: string; new_code: string; reason: string | null }> = new Map(),
): SearchCatalogBaseItem[] {
  return rows
    .map((row) => ({
      code: String(row.product_code || ""),
      brand: brandMap.byId.get(String(row.brand_id || "")) || "",
      brand_id: String(row.brand_id || ""),
      normalized_code: String(row.normalized_code || normalizePartCode(String(row.product_code || ""))),
      description: String(row.description || ""),
      oem_no: sanitizeCatalogOemNumbers(row.oem_no),
      vehicle: String(row.vehicle || ""),
      tariff: String(row.hs_code || ""),
      origin: String(row.origin || ""),
      weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
      image_url: String(row.image_url || ""),
      lifecycle_status: normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`),
      lifecycle_note: String(row.lifecycle_note || "").trim() || null,
      replacement:
        replacementRowsByKey.get(
          `${String(row.brand_id || "")}::${String(row.normalized_code || normalizePartCode(String(row.product_code || "")))}`
        ) || null,
      recommendation_reason: null,
      available_qty: null,
    }))
    .filter((item) => item.code && item.brand && item.normalized_code);
}

async function fetchPortalSearchStockMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  items: Array<{ brand: string; normalized_code: string }>,
) {
  const map = new Map<
    string,
    {
      available_qty: number;
      on_hand_qty: number;
      last_moved_at: string | null;
    }
  >();
  const codeKeys = [...new Set(items.map((item) => item.normalized_code).filter(Boolean))];
  if (!codeKeys.length) return map;

  const snapshotRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "warehouse_stock_snapshots", {
    select: "brand,product_code,product_code_key,available_qty,on_hand_qty,last_moved_at",
    organization_id: `eq.${organizationId}`,
    product_code_key: `in.(${codeKeys.join(",")})`,
    limit: String(Math.max(240, codeKeys.length * 12)),
  }).catch(() => []);

  for (const row of snapshotRows) {
    const brand = String(row.brand || "").trim().toLowerCase();
    const normalizedCode = normalizePartCode(String(row.product_code || row.product_code_key || ""));
    if (!brand || !normalizedCode) continue;
    const key = `${brand}::${normalizedCode}`;
    const current = map.get(key);
    const availableQty = Number(row.available_qty || 0) || 0;
    const onHandQty = Number(row.on_hand_qty || 0) || 0;
    const lastMovedAt = row.last_moved_at == null ? null : String(row.last_moved_at);
    if (!current) {
      map.set(key, {
        available_qty: availableQty,
        on_hand_qty: onHandQty,
        last_moved_at: lastMovedAt,
      });
      continue;
    }
    current.available_qty += availableQty;
    current.on_hand_qty += onHandQty;
    if (!current.last_moved_at || (lastMovedAt && lastMovedAt > current.last_moved_at)) {
      current.last_moved_at = lastMovedAt;
    }
  }

  return map;
}

async function hydratePortalCatalogItems(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  context: CustomerPricingContext,
  baseItems: SearchCatalogBaseItem[],
) {
  const previewByCode = new Map<
    string,
    {
      sell_price: number | null;
      supplier_name: string;
    }
  >();

  if (context.customerType === "C") {
    const cPriceMap = await fetchCPriceMap(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      context.cPriceListId,
      baseItems.map((item) => ({
        brand: item.brand,
        product_code: item.code,
      })),
    );
    for (const item of baseItems) {
      const key = `${item.brand.trim().toLowerCase()}::${item.normalized_code}`;
      previewByCode.set(key, {
        sell_price: cPriceMap.get(key) ?? null,
        supplier_name: "",
      });
    }
  } else {
    const marginPercent = context.customerType === "B" ? context.effectiveMarginB : context.effectiveMarginA;
    const bestOptionMap = await fetchPortalBestSupplierPreviewMap(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      baseItems
        .filter((item) => item.brand_id && item.normalized_code)
        .map((item) => ({
          brandId: item.brand_id,
          normalizedCode: item.normalized_code,
        })),
    );
    for (const item of baseItems) {
      const bestOption = bestOptionMap.get(`${item.brand_id}::${item.normalized_code}`);
      if (!bestOption) continue;
      previewByCode.set(`${item.brand.trim().toLowerCase()}::${item.normalized_code}`, {
        sell_price:
          bestOption.buy_price == null ? null : roundMoney(Number(bestOption.buy_price) * (1 + marginPercent / 100)),
        supplier_name: bestOption.supplier_name || "",
      });
    }
    if (prefersCPriceWhereAvailable(context)) {
      const cPriceMap = await fetchCPriceMap(
        supabaseUrl,
        serviceRoleKey,
        invite.organization_id,
        context.cPriceListId,
        baseItems.map((item) => ({
          brand: item.brand,
          product_code: item.code,
        })),
      );
      for (const item of baseItems) {
        const key = `${item.brand.trim().toLowerCase()}::${item.normalized_code}`;
        const existing = previewByCode.get(key);
        const cPrice = cPriceMap.get(key);
        if (cPrice == null) continue;
        previewByCode.set(key, {
          sell_price: cPrice,
          supplier_name: existing?.supplier_name || "",
        });
      }
    }
  }

  return baseItems.map((item) => {
    const preview = previewByCode.get(`${item.brand.trim().toLowerCase()}::${item.normalized_code}`);
    return {
      code: item.code,
      brand: item.brand,
      description: item.description,
      oem_no: item.oem_no,
      vehicle: item.vehicle,
      tariff: item.tariff,
      origin: item.origin,
      weight_kg: item.weight_kg,
      image_url: item.image_url,
      sell_price: preview?.sell_price ?? null,
      currency: context.currency,
      supplier_name: preview?.supplier_name || "",
      lifecycle_status: item.lifecycle_status,
      lifecycle_note: item.lifecycle_note,
      lifecycle_warning: item.lifecycle_status === "discontinued" ? buildDiscontinuedWarning(item.code, item.lifecycle_note) : null,
      replacement_code: item.replacement?.new_code || null,
      replacement_old_code: item.replacement?.old_code || null,
      replacement_reason: item.replacement?.reason || null,
      replacement_warning: item.replacement ? buildReplacementWarning(item.replacement.old_code, item.replacement.new_code || item.code, item.replacement.reason) : null,
      recommendation_reason: item.recommendation_reason || null,
      available_qty: item.available_qty == null ? null : Number(item.available_qty),
    } satisfies PortalCatalogSearchItem;
  });
}

async function fetchPortalCatalogRecommendations(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  search: string,
  brandMap: { byId: Map<string, string>; byName: Map<string, string> },
  baseItems: SearchCatalogBaseItem[],
  replacementRowsByKey: Map<string, { old_code: string; new_code: string; reason: string | null }>,
) {
  if (!search || !baseItems.length || !shouldStrictlyFilterCodeSearch(search)) return [] as SearchCatalogBaseItem[];

  const anchorRows = baseItems.slice(0, 6).map((item) => ({ description: item.description }));
  const anchorDescriptionTokens = resolveCatalogFamilyAnchor(anchorRows);
  if (!anchorDescriptionTokens.length) return [] as SearchCatalogBaseItem[];

  const anchorVehicleTokens = [...new Set(baseItems.slice(0, 6).flatMap((item) => extractVehicleMakerTokens(item.vehicle)))];
  const anchorBrandSet = new Set(baseItems.slice(0, 6).map((item) => item.brand.trim().toLowerCase()).filter(Boolean));
  const existingKeys = new Set(baseItems.map((item) => `${item.brand.trim().toLowerCase()}::${item.normalized_code}`));

  const candidateRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
    select: "product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,lifecycle_status,lifecycle_note",
    organization_id: `eq.${invite.organization_id}`,
    ...(portalAllowedBrandIds(invite).length ? { brand_id: `in.(${portalAllowedBrandIds(invite).join(",")})` } : {}),
    or: `(${anchorDescriptionTokens.slice(0, 3).map((token) => `description.ilike.*${token}*`).join(",")})`,
    order: "product_code.asc",
    limit: "120",
  }).catch(() => []);
  if (!candidateRows.length) return [] as SearchCatalogBaseItem[];

  const candidateBaseItems = mapCatalogRowsToBaseItems(candidateRows, brandMap, replacementRowsByKey);
  const stockMap = await fetchPortalSearchStockMap(supabaseUrl, serviceRoleKey, invite.organization_id, candidateBaseItems);

  return candidateBaseItems
    .filter((item) => item.lifecycle_status !== "discontinued")
    .filter((item) => !existingKeys.has(`${item.brand.trim().toLowerCase()}::${item.normalized_code}`))
    .map((item) => {
      const descriptionTokens = extractDescriptionFamilyTokens(item.description);
      const vehicleTokens = extractVehicleMakerTokens(item.vehicle);
      const descriptionMatches = countSharedTokens(descriptionTokens, anchorDescriptionTokens);
      const vehicleMatches = countSharedTokens(vehicleTokens, anchorVehicleTokens);
      const stockEntry = stockMap.get(`${item.brand.trim().toLowerCase()}::${item.normalized_code}`);
      const availableQty = stockEntry?.available_qty ?? 0;
      const score =
        descriptionMatches * 10 +
        vehicleMatches * 8 +
        (availableQty > 0 ? 20 : 0) +
        (!anchorBrandSet.has(item.brand.trim().toLowerCase()) ? 3 : 0) +
        (item.replacement ? 2 : 0);
      return {
        ...item,
        available_qty: availableQty > 0 ? roundMoney(availableQty) : null,
        recommendation_reason:
          availableQty > 0 && vehicleMatches > 0
            ? "In-stock related alternative for the same vehicle family."
            : availableQty > 0
              ? "In-stock related item from the same product family."
              : "Related item from the same product family.",
        __score: score,
        __descriptionMatches: descriptionMatches,
        __vehicleMatches: vehicleMatches,
      };
    })
    .filter((item) => item.__descriptionMatches > 0 && (anchorVehicleTokens.length === 0 || item.__vehicleMatches > 0 || (item.available_qty ?? 0) > 0))
    .sort((left, right) => right.__score - left.__score)
    .slice(0, 4)
    .map(({ __score: _score, __descriptionMatches: _descriptionMatches, __vehicleMatches: _vehicleMatches, ...item }) => item);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function parseEmbeddedCustomerMeta(raw: unknown) {
  const text = String(raw || "");
  const markerIndex = text.lastIndexOf(CUSTOMER_META_PREFIX);
  if (markerIndex < 0) return {} as Record<string, unknown>;
  const jsonText = text.slice(markerIndex + CUSTOMER_META_PREFIX.length).trim();
  try {
    return (JSON.parse(jsonText) as Record<string, unknown>) || {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

function getEmbeddedCustomerPriceListType(meta: Record<string, unknown>) {
  const value = String(meta.price_list_type || "").trim();
  if (value === "A" || value === "B" || value === "C" || value === "Other") return value;
  return "";
}

function normalizePortalCustomerType(value: string): CustomerPricingContext["customerType"] {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "a" || normalized === "a price list") return "A";
  if (normalized === "b" || normalized === "b price list") return "B";
  if (normalized === "c" || normalized === "c price list") return "C";
  if (normalized === "other" || normalized === "other margin") return "Other";
  return "A";
}

function computeSellFromBuy(buyPrice: number | null, context: CustomerPricingContext) {
  if (buyPrice == null) return null;
  if (context.customerType === "C") return null;
  const marginPercent = context.customerType === "B" ? context.effectiveMarginB : context.effectiveMarginA;
  return roundMoney(Number(buyPrice) * (1 + marginPercent / 100));
}

function prefersCPriceWhereAvailable(context: CustomerPricingContext) {
  return context.customerType !== "C" && context.portalCPriceMode === "prefer_c_when_available" && Boolean(context.cPriceListId);
}

function portalFallbackPriceType(context: CustomerPricingContext) {
  return context.customerType === "C" ? "C" : context.customerType;
}

function hasUsablePrice(value: unknown) {
  return value != null && Number(value) > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function chunkValues<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function rpcUrl(supabaseUrl: string, fn: string) {
  return new URL(`/rest/v1/rpc/${fn}`, supabaseUrl).toString();
}

async function fetchFirst<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  const rows = await getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
  });
  return rows[0] || null;
}

async function fetchAll<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  return getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
  });
}

async function callRpc<T>(supabaseUrl: string, serviceRoleKey: string, fn: string, payload: Record<string, unknown>) {
  return sendJson<T>(rpcUrl(supabaseUrl, fn), {
    method: "POST",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify(payload),
  });
}

async function fetchPortalCustomerForOrders(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
): Promise<CustomerRow | null> {
  const customerId = String(invite.customer_id || "").trim();
  if (!customerId) {
    throw new Error("Portal invite is missing its customer scope.");
  }
  const trySelect = async (select: string) =>
    await fetchFirst<CustomerRow>(supabaseUrl, serviceRoleKey, "customers", {
      select,
      organization_id: `eq.${invite.organization_id}`,
      id: `eq.${customerId}`,
      limit: "1",
    });

  try {
    return await trySelect(CUSTOMER_ORDER_SELECT);
  } catch (primaryError) {
    try {
      return await trySelect(CUSTOMER_ORDER_SELECT_LEGACY);
    } catch (legacyError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError || "");
      const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError || "");
      throw new Error(legacyMessage || primaryMessage || `Customer card not found for ${invite.party_name}`);
    }
  }
}

async function resolvePortalCustomer(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
): Promise<CustomerPricingContext> {
  if (invite.party_type !== "customer" || !invite.access_can_view_orders) {
    throw new Error("This portal cannot create sales orders");
  }
  if (!String(invite.customer_id || "").trim()) {
    throw new Error("This portal invite is missing its customer scope.");
  }

  const cacheKey = `${invite.organization_id}::${String(invite.customer_id || "").trim()}`;
  const cached = portalCustomerContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const customer = await fetchPortalCustomerForOrders(supabaseUrl, serviceRoleKey, invite);
  const customerMeta = parseEmbeddedCustomerMeta(customer?.custom_fields);

  if (!customer?.id) {
    throw new Error(`Customer card not found for ${invite.party_name}`);
  }

  const sellerCompanyProfileId = String(customer.seller_company_profile_id || customerMeta.seller_company_profile_id || "").trim();
  const portalCPriceMode =
    String(customer.portal_c_price_mode || customerMeta.portal_c_price_mode || "standard").trim().toLowerCase() ===
    "prefer_c_when_available"
      ? "prefer_c_when_available"
      : "standard";
  const marginOverrideRaw =
    customer.price_list_margin_percent == null ? customerMeta.price_list_margin_percent : customer.price_list_margin_percent;

  const companyProfile =
    (sellerCompanyProfileId
      ? await fetchFirst<CompanyProfileRow>(supabaseUrl, serviceRoleKey, "company_profiles", {
          select: "id,company_name",
          organization_id: `eq.${invite.organization_id}`,
          id: `eq.${sellerCompanyProfileId}`,
        }).catch(() => null)
      : null) ||
    (await fetchFirst<CompanyProfileRow>(supabaseUrl, serviceRoleKey, "company_profiles", {
      select: "id,company_name",
      organization_id: `eq.${invite.organization_id}`,
      order: "updated_at.desc",
    })) ||
    null;

  const priceLists = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customer_price_lists", {
    select: "id,list_type,margin_percent,is_active",
    organization_id: `eq.${invite.organization_id}`,
    is_active: "eq.true",
    order: "updated_at.desc",
  });

  const byType = new Map<string, Record<string, unknown>>();
  for (const row of priceLists) {
    const type = String(row.list_type || "");
    if (!type || byType.has(type)) continue;
    byType.set(type, row);
  }

  const defaultMarginA = byType.get("A")?.margin_percent == null ? 10 : Number(byType.get("A")?.margin_percent || 10);
  const defaultMarginB = byType.get("B")?.margin_percent == null ? 15 : Number(byType.get("B")?.margin_percent || 15);
  const priceListType = normalizePortalCustomerType(String(customer.price_list_type || getEmbeddedCustomerPriceListType(customerMeta) || "A"));
  const marginOverride = marginOverrideRaw == null ? null : Number(marginOverrideRaw);
  const effectiveMarginA = (priceListType === "A" || priceListType === "Other") && marginOverride != null ? marginOverride : defaultMarginA;
  const effectiveMarginB = priceListType === "B" && marginOverride != null ? marginOverride : defaultMarginB;
  const cPriceListId = String(byType.get("C")?.id || "");

  const context = {
    organizationId: invite.organization_id,
    customer,
    sellerCompany: String(companyProfile?.company_name || ""),
    currency: String(customer.currency || "EUR"),
    customerType: priceListType,
    portalCPriceMode,
    effectiveMarginA,
    effectiveMarginB,
    cPriceListId,
  };
  portalCustomerContextCache.set(cacheKey, {
    value: context,
    expiresAt: Date.now() + PORTAL_LOOKUP_CACHE_TTL_MS,
  });
  return context;
}

async function resolveBrandMap(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  const cached = portalBrandMapCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const brands = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "brands", {
    select: "id,name",
    organization_id: `eq.${organizationId}`,
    order: "name.asc",
  });
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const row of brands) {
    const id = String(row.id || "");
    const name = String(row.name || "").trim();
    if (!id || !name) continue;
    byId.set(id, name);
    byName.set(name.toLowerCase(), id);
  }
  const value = { byId, byName };
  portalBrandMapCache.set(organizationId, {
    value,
    expiresAt: Date.now() + PORTAL_LOOKUP_CACHE_TTL_MS,
  });
  return value;
}

export async function searchPortalCatalog(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  query: string,
  brand: string,
): Promise<PortalCatalogSearchResponse> {
  if (invite.party_type !== "customer" || !invite.access_can_view_orders) {
    throw new Error("This portal cannot search items");
  }
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, invite.organization_id);
  const search = String(query || "").trim();
  const normalizedSearch = normalizePartCode(search);
  const shouldConstrainCodeExpansion = shouldStrictlyFilterCodeSearch(search);
  const selectedBrandId = brand ? brandMap.byName.get(brand.trim().toLowerCase()) || "" : "";
  if (brand && !selectedBrandId) {
    throw new Error("Brand not found for portal search");
  }
  const params: Record<string, string> = {
    select: "product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,lifecycle_status,lifecycle_note",
    organization_id: `eq.${invite.organization_id}`,
    order: "product_code.asc",
    limit: "24",
  };

  const { allowedBrandIds } = applyPortalBrandScope(params, invite, selectedBrandId);
  if (search) {
    params.or = buildPortalCatalogSearchOr(search, normalizedSearch, "strict");
  }

  let rows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", params);
  const replacementRowsByKey = new Map<
    string,
    {
      old_code: string;
      new_code: string;
      reason: string | null;
    }
  >();

  if (search && normalizedSearch.length >= 3) {
    const referenceRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "item_code_references", {
      select: "brand_id,old_code,new_code,reason,normalized_new_code",
      organization_id: `eq.${invite.organization_id}`,
      is_active: "eq.true",
      normalized_old_code: `eq.${normalizedSearch}`,
      ...(selectedBrandId
        ? { brand_id: `eq.${selectedBrandId}` }
        : allowedBrandIds.length
          ? { brand_id: `in.(${allowedBrandIds.join(",")})` }
          : {}),
      limit: "200",
    }).catch(() => []);

    if (referenceRows.length) {
      const brandIds = [...new Set(referenceRows.map((row) => String(row.brand_id || "")).filter(Boolean))];
      const newCodes = [...new Set(referenceRows.map((row) => String(row.normalized_new_code || normalizePartCode(String(row.new_code || "")))).filter(Boolean))];
      for (const row of referenceRows) {
        const brandId = String(row.brand_id || "");
        const normalizedNewCode = String(row.normalized_new_code || normalizePartCode(String(row.new_code || "")));
        if (!brandId || !normalizedNewCode) continue;
        replacementRowsByKey.set(`${brandId}::${normalizedNewCode}`, {
          old_code: String(row.old_code || ""),
          new_code: String(row.new_code || ""),
          reason: String(row.reason || "").trim() || null,
        });
      }
      if (brandIds.length && newCodes.length) {
        const replacementCatalogRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
          select: "id,product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note",
          organization_id: `eq.${invite.organization_id}`,
          brand_id: `in.(${brandIds.join(",")})`,
          normalized_code: `in.(${newCodes.join(",")})`,
          order: "product_code.asc",
          limit: String(Math.max(120, newCodes.length * 4)),
        }).catch(() => []);
        if (replacementCatalogRows.length) {
          rows = dedupeCatalogRows([
            ...rows,
            ...replacementCatalogRows.filter((row) => {
              const brandId = String(row.brand_id || "");
              const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || "")));
              return replacementRowsByKey.has(`${brandId}::${normalizedCode}`);
            }),
          ]);
        }
      }
    }
  }
  if (
    search &&
    shouldRunLooseOriginalNumberSearch(search) &&
    rows.length < (shouldConstrainCodeExpansion ? PORTAL_CODE_SEARCH_EXPANSION_THRESHOLD : 24)
  ) {
    const familyCore = buildOriginalNumberFamilyCore(search);
    if (familyCore.length >= 6) {
      const familyRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
        select: "id,product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note",
        organization_id: `eq.${invite.organization_id}`,
        ...(selectedBrandId
          ? { brand_id: `eq.${selectedBrandId}` }
          : allowedBrandIds.length
            ? { brand_id: `in.(${allowedBrandIds.join(",")})` }
            : {}),
        or: `(${[
          `normalized_oem.like.*${familyCore}*`,
          `normalized_code.like.*${familyCore}*`,
          familyCore.length >= 8 && !/^\d+$/.test(familyCore) ? `product_code.ilike.${familyCore}*` : "",
        ]
          .filter(Boolean)
          .join(",")})`,
        order: "product_code.asc",
        limit: "160",
      }).catch(() => []);
      if (familyRows.length) {
        rows = dedupeCatalogRows([...rows, ...familyRows]).filter((row) => matchesCatalogFamilyRow(row, search));
      }
    }
  }
  if (
    search &&
    shouldRunLooseOriginalNumberSearch(search) &&
    rows.length < (shouldConstrainCodeExpansion ? PORTAL_CODE_SEARCH_EXPANSION_THRESHOLD : 24)
  ) {
    const familyClauses = buildOriginalNumberFamilyClauses(search);
    if (familyClauses.length) {
      const tokenRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
        select: "id,product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note",
        organization_id: `eq.${invite.organization_id}`,
        ...(selectedBrandId
          ? { brand_id: `eq.${selectedBrandId}` }
          : allowedBrandIds.length
            ? { brand_id: `in.(${allowedBrandIds.join(",")})` }
            : {}),
        or: `(${familyClauses.join(",")})`,
        order: "product_code.asc",
        limit: "220",
      }).catch(() => []);
      if (tokenRows.length) {
        rows = dedupeCatalogRows([...rows, ...tokenRows]).filter((row) => matchesCatalogFamilyRow(row, search));
      }
    }
  }
  if (search && isLikelyPortalCodeSearch(search)) {
    const variants = supplementalSearchVariants(search);
    if (variants.length) {
      const supplementalRows = (
        await Promise.all(
          variants.map((variant) =>
            fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
              select: "id,product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,lifecycle_status,lifecycle_note",
              organization_id: `eq.${invite.organization_id}`,
              ...(selectedBrandId
                ? { brand_id: `eq.${selectedBrandId}` }
                : allowedBrandIds.length
                  ? { brand_id: `in.(${allowedBrandIds.join(",")})` }
                  : {}),
              normalized_oem: `like.*${variant}*`,
              order: "product_code.asc",
              limit: "120",
            }).catch(() => []),
          ),
        )
      ).flat();
      if (supplementalRows.length) {
        rows = dedupeCatalogRows([...rows, ...supplementalRows]).filter(
          (row) => matchesCatalogFamilyRow(row, search) || variants.some((variant) => normalizePartCode(String(row.product_code || "")).includes(variant)),
        );
      }
    }
  }
  if (!rows.length && search && shouldRunLooseOriginalNumberSearch(search)) {
    rows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
      ...params,
      or: buildPortalCatalogSearchOr(search, normalizedSearch, "loose"),
    });
  }
  if (!rows.length && search && shouldRunLooseOriginalNumberSearch(search)) {
    const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
    const normalizedRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
      select: "id,product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,lifecycle_status,lifecycle_note",
      organization_id: `eq.${invite.organization_id}`,
      ...(selectedBrandId
        ? { brand_id: `eq.${selectedBrandId}` }
        : allowedBrandIds.length
          ? { brand_id: `in.(${allowedBrandIds.join(",")})` }
          : {}),
      normalized_oem: `like.*${normalizedOriginalSearch}*`,
      order: "product_code.asc",
      limit: "100",
    }).catch(() => []);
    rows = dedupeCatalogRows(
      normalizedRows.filter(
        (row) => matchesCatalogFamilyRow(row, search) || normalizePartCode(String(row.product_code || "")).includes(normalizedSearch),
      ),
    );
  }

  if (
    search &&
    shouldStrictlyFilterCodeSearch(search) &&
    rows.length > 0 &&
    rows.length < PORTAL_CODE_SEARCH_EXPANSION_THRESHOLD
  ) {
    const exactSeedRows = dedupeCatalogRows(rows).filter(
      (row) => matchesCatalogExactFamilyRow(row, search) || hasCatalogReplacementMatch(row, replacementRowsByKey),
    );
    const seedClauses = buildCatalogSeedExpansionClauses(collectCatalogComparableTokensFromRows(exactSeedRows));
    if (seedClauses.length) {
      const seedExpansionRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
        select: "id,product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note",
        organization_id: `eq.${invite.organization_id}`,
        ...(selectedBrandId
          ? { brand_id: `eq.${selectedBrandId}` }
          : allowedBrandIds.length
            ? { brand_id: `in.(${allowedBrandIds.join(",")})` }
            : {}),
        or: `(${seedClauses.join(",")})`,
        order: "product_code.asc",
        limit: "120",
      }).catch(() => []);
      if (seedExpansionRows.length) {
        rows = dedupeCatalogRows([...rows, ...seedExpansionRows]);
      }
    }
  }
  rows = filterCatalogRowsBySearchRelevance(rows, search, replacementRowsByKey);
  const baseItems = mapCatalogRowsToBaseItems(rows, brandMap, replacementRowsByKey);
  if (!baseItems.length) return { items: [], recommendations: [] };
  const context = await resolvePortalCustomer(supabaseUrl, serviceRoleKey, invite);
  const recommendationsBase = await fetchPortalCatalogRecommendations(
    supabaseUrl,
    serviceRoleKey,
    invite,
    search,
    brandMap,
    baseItems,
    replacementRowsByKey,
  );
  const [items, recommendations] = await Promise.all([
    hydratePortalCatalogItems(supabaseUrl, serviceRoleKey, invite, context, baseItems),
    hydratePortalCatalogItems(supabaseUrl, serviceRoleKey, invite, context, recommendationsBase),
  ]);
  return {
    items,
    recommendations,
  };
}

function mergeInputRows(rows: PortalOrderInputRow[]) {
  const grouped = new Map<string, PortalOrderInputRow>();
  for (const row of rows) {
    const code = String(row.code || "").trim();
    const brand = String(row.brand || "").trim();
    const qty = Math.max(1, Number(row.qty || 1) || 1);
    if (!code || !brand) continue;
    const key = `${brand.toLowerCase()}::${normalizePartCode(code)}`;
    const current = grouped.get(key);
    if (current) {
      current.qty += qty;
    } else {
      grouped.set(key, { code, brand, qty });
    }
  }
  return [...grouped.values()];
}

async function fetchCPriceMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  cPriceListId: string,
  rows: Array<{ brand: string; product_code: string }>,
) {
  const map = new Map<string, number>();
  if (!cPriceListId || !rows.length) return map;
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, organizationId);
  const brandIds = [...new Set(rows.map((row) => brandMap.byName.get(row.brand.trim().toLowerCase()) || "").filter(Boolean))];
  const normalizedCodes = [...new Set(rows.map((row) => normalizePartCode(row.product_code)).filter(Boolean))];
  if (!brandIds.length || !normalizedCodes.length) return map;

  const items = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customer_price_list_items", {
    select: "brand_id,normalized_code,sell_price",
    organization_id: `eq.${organizationId}`,
    price_list_id: `eq.${cPriceListId}`,
    brand_id: `in.(${brandIds.join(",")})`,
    normalized_code: `in.(${normalizedCodes.join(",")})`,
  });

  for (const row of items) {
    const brandName = brandMap.byId.get(String(row.brand_id || ""));
    const normalizedCode = String(row.normalized_code || "");
    if (!brandName || !normalizedCode) continue;
    map.set(`${brandName.toLowerCase()}::${normalizedCode}`, Number(row.sell_price || 0));
  }

  return map;
}

async function fetchCPriceEntryMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  cPriceListId: string,
  rows: Array<{ brand: string; product_code: string }>,
) {
  const map = new Map<string, { sell_price: number; price_date: string | null }>();
  if (!cPriceListId || !rows.length) return map;
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, organizationId);
  const brandIds = [...new Set(rows.map((row) => brandMap.byName.get(row.brand.trim().toLowerCase()) || "").filter(Boolean))];
  const normalizedCodes = [...new Set(rows.map((row) => normalizePartCode(row.product_code)).filter(Boolean))];
  if (!brandIds.length || !normalizedCodes.length) return map;

  const items = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customer_price_list_items", {
    select: "brand_id,normalized_code,sell_price,updated_at",
    organization_id: `eq.${organizationId}`,
    price_list_id: `eq.${cPriceListId}`,
    brand_id: `in.(${brandIds.join(",")})`,
    normalized_code: `in.(${normalizedCodes.join(",")})`,
    order: "updated_at.desc",
  });

  for (const row of items) {
    const brandName = brandMap.byId.get(String(row.brand_id || ""));
    const normalizedCode = String(row.normalized_code || "");
    if (!brandName || !normalizedCode || map.has(`${brandName.toLowerCase()}::${normalizedCode}`)) continue;
    map.set(`${brandName.toLowerCase()}::${normalizedCode}`, {
      sell_price: Number(row.sell_price || 0),
      price_date: row.updated_at == null ? null : String(row.updated_at).slice(0, 10),
    });
  }

  return map;
}

async function fetchPortalCatalogBrandRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  brandId: string,
  brandName: string,
  maxRows = PORTAL_PRICE_LIST_MAX_ROWS,
) {
  const rows: Array<{
    product_code: string;
    description: string | null;
    oem_no: string | null;
    hs_code: string | null;
    origin: string | null;
    weight_kg: number | null;
    lifecycle_status: "active" | "discontinued";
    lifecycle_note: string | null;
  }> = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const page = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
      select: "product_code,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note",
      organization_id: `eq.${organizationId}`,
      brand_id: `eq.${brandId}`,
      order: "product_code.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    rows.push(
      ...page.map((row) => ({
        product_code: String(row.product_code || ""),
        description: row.description == null ? null : String(row.description),
        oem_no: row.oem_no == null ? null : sanitizeCatalogOemNumbers(row.oem_no),
        hs_code: row.hs_code == null ? null : String(row.hs_code),
        origin: row.origin == null ? null : String(row.origin),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        lifecycle_status: normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`),
        lifecycle_note: String(row.lifecycle_note || "").trim() || null,
      })),
    );
    if (rows.length > maxRows) {
      throw new Error("This brand price list is too large to download right now.");
    }
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows
    .filter((row) => row.product_code)
    .map((row) => ({
      ...row,
      brand: brandName,
      normalized_code: normalizePartCode(row.product_code),
    }));
}

async function fetchPortalBestSupplierPriceMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  brandId: string,
  normalizedCodes: string[],
) {
  const bestByCode = new Map<string, number>();
  for (const chunk of chunkValues(normalizedCodes, 200)) {
    const supplierRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "supplier_prices", {
      select: "normalized_code,buy_price",
      organization_id: `eq.${organizationId}`,
      brand_id: `eq.${brandId}`,
      is_active: "eq.true",
      buy_price: "not.is.null",
      normalized_code: `in.(${chunk.join(",")})`,
      order: "buy_price.asc",
      limit: "5000",
    });
    for (const row of supplierRows) {
      const normalizedCode = String(row.normalized_code || "");
      const buyPrice = row.buy_price == null ? null : Number(row.buy_price);
      if (!normalizedCode || buyPrice == null || !Number.isFinite(buyPrice)) continue;
      const current = bestByCode.get(normalizedCode);
      if (current == null || buyPrice < current) {
        bestByCode.set(normalizedCode, buyPrice);
      }
    }
  }
  return bestByCode;
}

async function fetchPortalBestSupplierOptionMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  brandId: string,
  normalizedCodes: string[],
) {
  const bestByCode = new Map<
    string,
    {
      buy_price: number | null;
      supplier_name: string;
      price_date: string | null;
      notes: string | null;
    }
  >();
  for (const chunk of chunkValues(normalizedCodes, 200)) {
    const supplierRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "supplier_prices", {
      select: "normalized_code,buy_price,valid_from,notes,suppliers(name)",
      organization_id: `eq.${organizationId}`,
      brand_id: `eq.${brandId}`,
      is_active: "eq.true",
      buy_price: "not.is.null",
      normalized_code: `in.(${chunk.join(",")})`,
      order: "buy_price.asc",
      limit: "5000",
    });
    for (const row of supplierRows) {
      const normalizedCode = String(row.normalized_code || "");
      const buyPrice = row.buy_price == null ? null : Number(row.buy_price);
      if (!normalizedCode || buyPrice == null || !Number.isFinite(buyPrice)) continue;
      const current = bestByCode.get(normalizedCode);
      if (current && Number(current.buy_price ?? Number.MAX_SAFE_INTEGER) <= buyPrice) continue;
      bestByCode.set(normalizedCode, {
        buy_price: buyPrice,
        supplier_name: String(row.suppliers?.name || ""),
        price_date: row.valid_from == null ? null : String(row.valid_from),
        notes: row.notes == null ? null : String(row.notes),
      });
    }
  }
  return bestByCode;
}

async function fetchPortalBestSupplierPreviewMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  items: Array<{ brandId: string; normalizedCode: string }>,
) {
  const bestByKey = new Map<
    string,
    {
      buy_price: number | null;
      supplier_name: string;
      price_date: string | null;
      notes: string | null;
    }
  >();
  const brandIds = [...new Set(items.map((item) => item.brandId).filter(Boolean))];
  const normalizedCodes = [...new Set(items.map((item) => item.normalizedCode).filter(Boolean))];
  for (const brandChunk of chunkValues(brandIds, 50)) {
    for (const codeChunk of chunkValues(normalizedCodes, 200)) {
      const supplierRows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "supplier_prices", {
        select: "brand_id,normalized_code,buy_price,valid_from,notes,suppliers(name)",
        organization_id: `eq.${organizationId}`,
        brand_id: `in.(${brandChunk.join(",")})`,
        is_active: "eq.true",
        buy_price: "not.is.null",
        normalized_code: `in.(${codeChunk.join(",")})`,
        order: "buy_price.asc",
        limit: "5000",
      });
      for (const row of supplierRows) {
        const brandId = String(row.brand_id || "");
        const normalizedCode = String(row.normalized_code || "");
        const buyPrice = row.buy_price == null ? null : Number(row.buy_price);
        if (!brandId || !normalizedCode || buyPrice == null || !Number.isFinite(buyPrice)) continue;
        const key = `${brandId}::${normalizedCode}`;
        const current = bestByKey.get(key);
        if (current && Number(current.buy_price ?? Number.MAX_SAFE_INTEGER) <= buyPrice) continue;
        bestByKey.set(key, {
          buy_price: buyPrice,
          supplier_name: String(row.suppliers?.name || ""),
          price_date: row.valid_from == null ? null : String(row.valid_from),
          notes: row.notes == null ? null : String(row.notes),
        });
      }
    }
  }
  return bestByKey;
}

export async function buildPortalPriceListRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  brand: string,
): Promise<{
  priceListType: CustomerPricingContext["customerType"];
  pricingMode: CustomerPricingContext["portalCPriceMode"];
  currency: string;
  rows: PortalPriceListRow[];
}> {
  const context = await resolvePortalCustomer(supabaseUrl, serviceRoleKey, invite);
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, invite.organization_id);
  const brandId = brandMap.byName.get(String(brand || "").trim().toLowerCase()) || "";
  const brandName = brandMap.byId.get(brandId) || "";
  if (!brandId || !brandName) {
    throw new Error("Brand not found for portal price list");
  }
  const allowedBrandIds = portalAllowedBrandIds(invite);
  if (allowedBrandIds.length && !allowedBrandIds.includes(brandId)) {
    throw new Error("Brand is outside this portal scope.");
  }

  const cacheKey = [
    invite.organization_id,
    context.customer.id,
    brandId,
    context.customerType,
    context.portalCPriceMode,
    context.effectiveMarginA,
    context.effectiveMarginB,
    context.cPriceListId,
  ].join("::");
  const cached = portalPriceListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const catalogRows = await fetchPortalCatalogBrandRows(supabaseUrl, serviceRoleKey, invite.organization_id, brandId, brandName);
  if (!catalogRows.length) {
    const emptyResult = {
      priceListType: context.customerType,
      pricingMode: context.portalCPriceMode,
      currency: context.currency,
      rows: [],
    };
    portalPriceListCache.set(cacheKey, {
      value: emptyResult,
      expiresAt: Date.now() + PORTAL_PRICE_LIST_CACHE_TTL_MS,
    });
    return emptyResult;
  }

  let salesPriceByCode = new Map<string, number>();
  let priceDateByCode = new Map<string, string | null>();
  const priceTypeByCode = new Map<string, PortalPriceListRow["price_list_type"]>();
  if (context.customerType === "C") {
    const cPriceEntryMap = await fetchCPriceEntryMap(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      context.cPriceListId,
      catalogRows.map((row) => ({ brand: row.brand, product_code: row.product_code })),
    );
    for (const [key, value] of cPriceEntryMap.entries()) {
      salesPriceByCode.set(key, value.sell_price);
      priceDateByCode.set(key, value.price_date);
      priceTypeByCode.set(key, "C");
    }
  } else {
    const bestOptionMap = await fetchPortalBestSupplierOptionMap(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      brandId,
      [...new Set(catalogRows.map((row) => row.normalized_code).filter(Boolean))],
    );
    const marginPercent = context.customerType === "B" ? context.effectiveMarginB : context.effectiveMarginA;
    for (const [normalizedCode, bestOption] of bestOptionMap.entries()) {
      if (bestOption.buy_price == null) continue;
      salesPriceByCode.set(normalizedCode, roundMoney(Number(bestOption.buy_price) * (1 + marginPercent / 100)));
      priceDateByCode.set(normalizedCode, bestOption.price_date || null);
      priceTypeByCode.set(normalizedCode, portalFallbackPriceType(context));
    }
    if (prefersCPriceWhereAvailable(context)) {
      const cPriceEntryMap = await fetchCPriceEntryMap(
        supabaseUrl,
        serviceRoleKey,
        invite.organization_id,
        context.cPriceListId,
        catalogRows.map((row) => ({ brand: row.brand, product_code: row.product_code })),
      );
      for (const [key, value] of cPriceEntryMap.entries()) {
        salesPriceByCode.set(key, value.sell_price);
        priceDateByCode.set(key, value.price_date);
        priceTypeByCode.set(key, "C");
      }
    }
  }

  const result = {
    priceListType: context.customerType,
    pricingMode: context.portalCPriceMode,
    currency: context.currency,
    rows: catalogRows.map((row) => ({
      product_code: row.product_code,
      brand: row.brand,
      description: row.description || "",
      price_list_type: priceTypeByCode.get(row.normalized_code) ?? portalFallbackPriceType(context),
      sales_price: salesPriceByCode.get(row.normalized_code) ?? null,
      price_date: priceDateByCode.get(row.normalized_code) ?? null,
      lifecycle_status: row.lifecycle_status,
      lifecycle_note: row.lifecycle_note,
    })),
  };
  portalPriceListCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + PORTAL_PRICE_LIST_CACHE_TTL_MS,
  });
  return result;
}

async function resolvePortalCatalogSupplierData(
  supabaseUrl: string,
  serviceRoleKey: string,
  context: CustomerPricingContext,
  row: PortalOrderInputRow,
  codeToResolve: string,
) {
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, context.organizationId);
  const brandId = brandMap.byName.get(row.brand.trim().toLowerCase()) || "";
  const normalizedCode = normalizePartCode(codeToResolve);
  if (!brandId || !normalizedCode) {
    return {
      catalogMatch: null as Record<string, unknown> | null,
      supplierOptions: [] as Array<{
        supplier_id?: string | null;
        supplier_name: string;
        buy_price: number | null;
        price_date: string | null;
        sell_price: number | null;
        notes: string | null;
      }>,
    };
  }

  const [catalogExact, catalogOem, supplierExact, supplierOem] = await Promise.all([
    fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
      select: "product_code,description,oem_no,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      normalized_code: `eq.${normalizedCode}`,
    }),
    fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
      select: "product_code,description,oem_no,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      normalized_oem: `eq.${normalizedCode}`,
    }),
    fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "supplier_prices", {
      select: "supplier_id,brand_id,product_code,normalized_code,normalized_oem,description,oem_no,buy_price,valid_from,notes,suppliers(name)",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      is_active: "eq.true",
      normalized_code: `eq.${normalizedCode}`,
      order: "buy_price.asc",
      limit: "50",
    }),
    fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "supplier_prices", {
      select: "supplier_id,brand_id,product_code,normalized_code,normalized_oem,description,oem_no,buy_price,valid_from,notes,suppliers(name)",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      is_active: "eq.true",
      normalized_oem: `eq.${normalizedCode}`,
      order: "buy_price.asc",
      limit: "50",
    }),
  ]);

  const supplierMatchesRaw = [...(supplierExact || []), ...(supplierOem || [])].filter((item) => item.buy_price != null);
  const supplierMap = new Map<
    string,
    {
      supplier_id?: string | null;
      supplier_name: string;
      buy_price: number | null;
      price_date: string | null;
      sell_price: number | null;
      notes: string | null;
    }
  >();

  for (const item of supplierMatchesRaw) {
    const supplierId = item.supplier_id == null ? null : String(item.supplier_id);
    const supplierName = String(item.suppliers?.name || "");
    if (!supplierName) continue;
    const buyPrice = item.buy_price == null ? null : Number(item.buy_price);
    const key = `${supplierId || ""}::${supplierName}`;
    const current = supplierMap.get(key);
    if (!current || Number(buyPrice ?? Number.MAX_SAFE_INTEGER) < Number(current.buy_price ?? Number.MAX_SAFE_INTEGER)) {
      supplierMap.set(key, {
        supplier_id: supplierId,
        supplier_name: supplierName,
        buy_price: buyPrice,
        sell_price: computeSellFromBuy(buyPrice, context),
        price_date: item.valid_from == null ? null : String(item.valid_from),
        notes: item.notes == null ? null : String(item.notes),
      });
    }
  }

  return {
    catalogMatch: catalogExact || catalogOem || null,
    supplierOptions: [...supplierMap.values()].sort(
      (a, b) => Number(a.buy_price ?? Number.MAX_SAFE_INTEGER) - Number(b.buy_price ?? Number.MAX_SAFE_INTEGER),
    ),
  };
}

async function findPortalCodeReferenceMatch(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  brand: string,
  code: string,
) {
  const normalizedCode = normalizePartCode(code);
  if (!brand.trim() || !normalizedCode) return null;

  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, organizationId);
  const brandId = brandMap.byName.get(brand.trim().toLowerCase());
  if (!brandId) return null;

  const row = await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "item_code_references", {
    select: "id,old_code,new_code,reason,original_number",
    organization_id: `eq.${organizationId}`,
    brand_id: `eq.${brandId}`,
    is_active: "eq.true",
    normalized_old_code: `eq.${normalizedCode}`,
  });

  if (!row?.id) return null;
  return {
    id: String(row.id || ""),
    old_code: String(row.old_code || ""),
    new_code: String(row.new_code || ""),
    reason: String(row.reason || ""),
    original_number: String(row.original_number || ""),
  };
}

async function fetchSupplierOptions(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: PortalOrderInputRow,
  context: CustomerPricingContext,
) {
  const supplierCustomerType = context.customerType === "B" ? "B" : "A";
  const options = await callRpc<Array<Record<string, unknown>>>(supabaseUrl, serviceRoleKey, "cloud_quote_supplier_options", {
    input_code: row.code.trim(),
    input_brand: row.brand.trim(),
    input_customer_type: supplierCustomerType,
    input_margin_a: context.effectiveMarginA / 100,
    input_margin_b: context.effectiveMarginB / 100,
  });

  return (options || []).map((option) => {
    const buyPrice = option.buy_price == null ? null : Number(option.buy_price);
    const sellPrice =
      option.sell_price == null ? computeSellFromBuy(buyPrice, context) : Number(option.sell_price);
    return {
      supplier_id: option.supplier_id == null ? null : String(option.supplier_id),
      supplier_name: String(option.supplier_name || ""),
      buy_price: buyPrice,
      sell_price: sellPrice,
      price_date: String(option.price_date || ""),
      notes: String(option.notes || ""),
    };
  });
}

async function fetchBestSupplierOption(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: PortalOrderInputRow,
  context: CustomerPricingContext,
) {
  const first = (await fetchSupplierOptions(supabaseUrl, serviceRoleKey, row, context))[0];
  if (!first) return null;
  return {
    supplier_name: String(first.supplier_name || ""),
    buy_price: first.buy_price == null ? null : Number(first.buy_price),
    sell_price: first.sell_price == null ? null : Number(first.sell_price),
    price_date: String(first.price_date || ""),
    notes: String(first.notes || ""),
  };
}

async function resolvePreparedLine(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: PortalOrderInputRow,
  context: CustomerPricingContext,
): Promise<PreparedPortalLine> {
  const referenceMatch = await findPortalCodeReferenceMatch(
    supabaseUrl,
    serviceRoleKey,
    context.organizationId,
    row.brand,
    row.code,
  );
  const codeToResolve = referenceMatch?.new_code || row.code;
  const { catalogMatch, supplierOptions } = await resolvePortalCatalogSupplierData(
    supabaseUrl,
    serviceRoleKey,
    context,
    row,
    codeToResolve,
  );
  const fallbackSupplier = supplierOptions[0] || null;
  const resolvedCode = String(catalogMatch?.product_code || codeToResolve || row.code || "");
  const codeChanged = Boolean(referenceMatch) || normalizePartCode(resolvedCode) !== normalizePartCode(row.code);
  const buyPrice = fallbackSupplier?.buy_price ?? null;
  const computedSell =
    context.customerType === "C"
      ? null
      : fallbackSupplier?.sell_price ?? computeSellFromBuy(buyPrice, context);
  const lifecycleStatus = normalizeLifecycleStatus(`${String(catalogMatch?.lifecycle_status || "")} ${String(catalogMatch?.lifecycle_note || "")}`);
  const lifecycleNote = String(catalogMatch?.lifecycle_note || "").trim() || null;

  return {
    lineId: makeId("portal-line"),
    requestedCode: row.code,
    resolvedCode,
    brand: row.brand || "",
    description: String(catalogMatch?.description || ""),
    qty: row.qty,
    oem_no: sanitizeCatalogOemNumbers(catalogMatch?.oem_no),
    hs_code: String(catalogMatch?.hs_code || ""),
    origin: String(catalogMatch?.origin || ""),
    weight_kg: catalogMatch?.weight_kg == null ? null : Number(catalogMatch.weight_kg),
    image_url: String(catalogMatch?.image_url || ""),
    supplier_name: String(fallbackSupplier?.supplier_name || ""),
    buy_price: buyPrice,
    sell_price: computedSell,
    c_sell_price: null,
    price_date: String(fallbackSupplier?.price_date || ""),
    notes: String(fallbackSupplier?.notes || ""),
    found: Boolean(catalogMatch || fallbackSupplier?.supplier_name || buyPrice != null || computedSell != null),
    codeChanged,
    codeChangeWarning: referenceMatch
      ? `Old Code ${referenceMatch.old_code} => New Code ${referenceMatch.new_code}.${referenceMatch.reason ? ` ${referenceMatch.reason}` : ""}`
      : codeChanged
        ? `Old Code ${row.code} => New Code ${resolvedCode}`
        : "",
    lifecycle_status: lifecycleStatus,
    lifecycle_note: lifecycleNote,
    lifecycle_warning: lifecycleStatus === "discontinued" ? buildDiscontinuedWarning(resolvedCode, lifecycleNote) : null,
    replacement_code: referenceMatch?.new_code || null,
    replacement_old_code: referenceMatch?.old_code || null,
    replacement_reason: referenceMatch?.reason || null,
    replacement_warning: referenceMatch ? buildReplacementWarning(referenceMatch.old_code, referenceMatch.new_code || resolvedCode, referenceMatch.reason) : null,
    supplierOptions,
    selectedSupplierKey: supplierOptions[0] ? `${supplierOptions[0].supplier_name}-0` : "",
  };
}

export async function preparePortalOrderLines(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  rows: PortalOrderInputRow[],
) {
  const context = await resolvePortalCustomer(supabaseUrl, serviceRoleKey, invite);
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, invite.organization_id);
  assertPortalRowsWithinBrandScope(invite, brandMap, rows);
  const mergedRows = mergeInputRows(rows);
  const prepared: PreparedPortalLine[] = [];

  for (let index = 0; index < mergedRows.length; index += 10) {
    const chunk = mergedRows.slice(index, index + 10);
    const resolvedChunk = await Promise.all(chunk.map((row) => resolvePreparedLine(supabaseUrl, serviceRoleKey, row, context)));
    prepared.push(...resolvedChunk);
  }

  if ((context.customerType === "C" || prefersCPriceWhereAvailable(context)) && prepared.length) {
    const cPriceMap = await fetchCPriceMap(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      context.cPriceListId,
      prepared.map((row) => ({
        brand: row.brand,
        product_code: row.resolvedCode,
      })),
    );
    prepared.forEach((line) => {
      const value = cPriceMap.get(`${line.brand.trim().toLowerCase()}::${normalizePartCode(line.resolvedCode)}`);
      line.c_sell_price = value == null ? null : Number(value);
      if (value != null) {
        line.sell_price = Number(value);
      } else if (context.customerType === "C") {
        line.sell_price = null;
      }
    });
  }

  return {
    lines: prepared,
    pricingProfile: {
      currency: context.currency,
      payment_terms: context.customer.payment_terms || "",
      contract_nr: context.customer.contract_nr || "",
      price_list_type: context.customerType,
      portal_c_price_mode: context.portalCPriceMode,
    },
  };
}

export async function submitPortalSalesOrder(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  input: {
    orderId?: string;
    salesOrderNo?: string;
    mode: "draft" | "confirm";
    deliveryTerm?: string;
    paymentTerms?: string;
    packingDetails?: string;
    notes?: string;
    rows: PortalOrderInputRow[];
  },
) {
  const context = await resolvePortalCustomer(supabaseUrl, serviceRoleKey, invite);
  const prepared = await preparePortalOrderLines(supabaseUrl, serviceRoleKey, invite, input.rows);
  const lines = prepared.lines.filter((line) => line.qty > 0 && line.resolvedCode);
  if (!lines.length) throw new Error("No valid order lines found");

  const existing =
    input.orderId
      ? await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "sales_orders", {
          select: "id,sales_order_no,status,created_at,portal_submitted_at,portal_seen_at",
          organization_id: `eq.${invite.organization_id}`,
          id: `eq.${input.orderId}`,
          portal_invite_id: `eq.${invite.id}`,
        })
      : null;

  if (existing?.status === "confirmed") {
    throw new Error("Internally confirmed sales orders cannot be edited from portal");
  }

  const purchaseTotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.buy_price || 0) * line.qty, 0));
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.sell_price || 0) * line.qty, 0));
  const totalAmount = subtotal;
  const profitTotal = roundMoney(totalAmount - purchaseTotal);
  const marginPercent = totalAmount > 0 ? roundMoney((profitTotal / totalAmount) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const salesOrderNo =
    String(existing?.sales_order_no || input.salesOrderNo || "").trim() ||
    `PORTAL-${today.replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const payload = {
    id: String(existing?.id || input.orderId || makeId("so")),
    organization_id: invite.organization_id,
    sales_order_no: salesOrderNo,
    customer_id: context.customer.id,
    customer_name: context.customer.display_name || context.customer.company_name || invite.party_name,
    seller_company: context.sellerCompany,
    purchase_company: "",
    quote_date: today,
    currency: context.currency,
    customer_type: context.customerType,
    shipping_cost: 0,
    discount_amount: 0,
    supplier_mode: "Best price",
    preferred_supplier: "",
    seller_info: context.customer.contract_nr || "",
    buyer_info: "",
    delivery_term: String(input.deliveryTerm || ""),
    payment_terms: String(input.paymentTerms || context.customer.payment_terms || ""),
    packing_details: String(input.packingDetails || ""),
    notes: String(input.notes || ""),
    status: "draft",
    purchase_total: purchaseTotal,
    sales_total: totalAmount,
    profit_total: profitTotal,
    margin_percent: marginPercent,
    source_channel: "portal",
    portal_invite_id: invite.id,
    portal_submitted_at: input.mode === "confirm" ? nowIso() : existing?.portal_submitted_at || null,
    portal_seen_at: input.mode === "confirm" ? null : existing?.portal_seen_at || null,
    confirmed_at: null,
    lines,
    created_at: String(existing?.created_at || nowIso()),
    updated_at: nowIso(),
  };

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await sendJson<Array<Record<string, unknown>>>(
      `${buildRestUrl(supabaseUrl, "sales_orders", { on_conflict: "id", select: "id" })}`,
      {
        method: "POST",
        headers: {
          ...serviceRoleHeaders(serviceRoleKey),
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(payload),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("customer_id")) {
      throw error;
    }
    const { customer_id: _ignoredCustomerId, ...legacyPayload } = payload;
    rows = await sendJson<Array<Record<string, unknown>>>(
      `${buildRestUrl(supabaseUrl, "sales_orders", { on_conflict: "id", select: "id" })}`,
      {
        method: "POST",
        headers: {
          ...serviceRoleHeaders(serviceRoleKey),
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(legacyPayload),
      },
    );
  }

  const savedId = String(rows[0]?.id || payload.id);
  const snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
  return { orderId: savedId, snapshot };
}

export async function deletePortalSalesOrder(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  orderId: string,
) {
  const existing = await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "sales_orders", {
    select: "id,status,portal_submitted_at,portal_invite_id",
    organization_id: `eq.${invite.organization_id}`,
    id: `eq.${orderId}`,
    portal_invite_id: `eq.${invite.id}`,
  });

  if (!existing?.id) {
    throw new Error("Portal draft order not found");
  }
  if (String(existing.status || "").toLowerCase() !== "draft" || existing.portal_submitted_at) {
    throw new Error("Only unsubmitted draft portal orders can be deleted");
  }

  await sendJson<unknown>(buildRestUrl(supabaseUrl, "sales_orders", { id: `eq.${orderId}`, organization_id: `eq.${invite.organization_id}` }), {
    method: "DELETE",
    headers: serviceRoleHeaders(serviceRoleKey),
  });

  const snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
  return { orderId, snapshot };
}
