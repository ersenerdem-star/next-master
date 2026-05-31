import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, json, readJson, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { resolveCaller } from "./_shared/app-auth.mts";
import { normalizeLifecycleStatus, sanitizeCatalogOemNumbers } from "./_shared/catalog-standardization.mts";
import { canAccessCustomerOps, canAccessOperationsModules, isSuperadminRole } from "./_shared/roles.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const ALLOWED_RPCS = new Set([
  "admin_list_org_users",
  "bulk_import_catalog",
  "bulk_import_supplier_prices",
  "cloud_catalog_page",
  "cloud_master_page",
  "cloud_quote_supplier_options",
  "cloud_resolve_quote_line",
  "cloud_supplier_brand_summary",
  "cloud_supplier_price_page",
  "deactivate_supplier_prices_by_filter",
  "get_cloud_quote",
  "list_cloud_quotes",
  "list_cloud_suppliers",
  "touch_user_presence",
]);

const SUPERADMIN_RPCS = new Set([
  "admin_list_org_users",
  "bulk_import_catalog",
  "bulk_import_supplier_prices",
  "cloud_catalog_page",
  "cloud_supplier_brand_summary",
  "cloud_supplier_price_page",
  "deactivate_supplier_prices_by_filter",
  "list_cloud_suppliers",
]);

const OPERATIONS_RPCS = new Set([
  "cloud_master_page",
]);

const CUSTOMER_STAFF_RPCS = new Set([
  "cloud_quote_supplier_options",
  "cloud_resolve_quote_line",
  "get_cloud_quote",
  "list_cloud_quotes",
  "touch_user_presence",
]);

type CatalogSourceRow = {
  id?: string | null;
  product_code?: string | null;
  description?: string | null;
  oem_no?: string | null;
  vehicle?: string | null;
  hs_code?: string | null;
  origin?: string | null;
  weight_kg?: number | string | null;
  image_url?: string | null;
  brand_id?: string | null;
  normalized_code?: string | null;
  normalized_oem?: string | null;
  lifecycle_status?: string | null;
  lifecycle_note?: string | null;
};

type BrandMapCacheEntry = {
  byId: Map<string, string>;
  byName: Map<string, string>;
  expiresAt: number;
};

const BRAND_MAP_CACHE_TTL_MS = 2 * 60 * 1000;
const brandMapCache = new Map<string, BrandMapCacheEntry>();
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

function shouldRunLooseOriginalNumberSearch(search: string) {
  return normalizeOriginalNumberSearch(search).length >= 6;
}

function isLikelyCatalogCodeSearch(search: string) {
  const value = String(search || "").trim();
  if (!value) return false;
  return /\d/.test(value) || /[-/+.()]/.test(value);
}

function shouldStrictlyFilterCodeSearch(search: string) {
  const normalizedOriginal = normalizeOriginalNumberSearch(search);
  return isLikelyCatalogCodeSearch(search) && normalizedOriginal.length >= 6;
}

function buildCatalogSearchOr(search: string, normalizedSearch: string, mode: "strict" | "loose") {
  const escaped = search.replace(/[%*(),]/g, " ").trim();
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  const normalizedSearchVariants = buildOriginalNumberVariants(search).filter((variant) => variant.length >= 6);
  const clauses = new Set<string>();
  const isCodeSearch = isLikelyCatalogCodeSearch(search);

  if (isCodeSearch) {
    const strictVariants = [...new Set(
      [normalizedSearch, ...normalizedSearchVariants]
        .map((variant) => String(variant || "").trim())
        .filter((variant) => variant.length >= 3),
    )];
    for (const variant of strictVariants) {
      clauses.add(`normalized_code.eq.${variant}`);
      clauses.add(`normalized_oem.eq.${variant}`);
      clauses.add(`normalized_code.like.${variant}*`);
      clauses.add(`normalized_oem.like.${variant}*`);
      if (variant.length >= 8) {
        clauses.add(`normalized_oem.like.*${variant}*`);
      }
      if (variant.length <= 24) {
        clauses.add(`product_code.ilike.${variant}*`);
      }
    }
    if (mode === "loose" && normalizedOriginalSearch.length >= 6) {
      clauses.add(`normalized_oem.like.*${normalizedOriginalSearch}*`);
    }
    return `(${[...clauses].join(",")})`;
  }

  const looseOriginalPattern = buildLooseOriginalNumberPattern(search);
  const separatorInsensitivePattern = buildSeparatorInsensitivePattern(search);
  if (escaped) {
    clauses.add(`product_code.ilike.*${escaped}*`);
    clauses.add(`oem_no.ilike.*${escaped}*`);
    clauses.add(`description.ilike.*${escaped}*`);
    clauses.add(`vehicle.ilike.*${escaped}*`);
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

function buildCatalogRowDedupKey(row: CatalogSourceRow) {
  const brandId = String(row.brand_id || "").trim();
  const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || ""))).trim();
  if (brandId && normalizedCode) return `${brandId}::${normalizedCode}`;
  return String(row.id || row.product_code || "").trim();
}

function scoreCatalogRowCompleteness(row: CatalogSourceRow) {
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

function dedupeCatalogRows(rows: CatalogSourceRow[]) {
  const bestByKey = new Map<string, CatalogSourceRow>();
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

function collectCatalogComparableTokensFromRows(rows: CatalogSourceRow[]) {
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

function matchesCatalogSeedTokenRow(row: CatalogSourceRow, seedTokens: Set<string>) {
  if (!seedTokens.size) return false;
  return [
    String(row.product_code || ""),
    String(row.normalized_code || ""),
    String(row.oem_no || ""),
    String(row.normalized_oem || ""),
  ].some((candidate) => buildComparableOriginalNumberTokens(candidate).some((token) => seedTokens.has(token)));
}

function matchesCatalogFamilyRow(row: CatalogSourceRow, search: string) {
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

function matchesCatalogExactFamilyRow(row: CatalogSourceRow, search: string) {
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

function resolveCatalogFamilyAnchor(rows: CatalogSourceRow[]) {
  const tokenLists = rows
    .map((row) => extractDescriptionFamilyTokens(String(row.description || "")))
    .filter((tokens) => tokens.length);
  if (!tokenLists.length) return [] as string[];
  const intersection = tokenLists.reduce<string[]>((current, tokens) => current.filter((token) => tokens.includes(token)), [...tokenLists[0]]);
  if (intersection.length) return intersection.slice(0, 3);
  return tokenLists[0].slice(0, 3);
}

function matchesCatalogDescriptionFamily(row: CatalogSourceRow, anchorTokens: string[]) {
  if (!anchorTokens.length) return true;
  const rowTokens = extractDescriptionFamilyTokens(String(row.description || ""));
  return rowTokens.some((token) => anchorTokens.includes(token));
}

function hasCatalogReplacementMatch(
  row: CatalogSourceRow,
  replacementRowsByKey: Map<string, { old_code: string; new_code: string; reason: string | null }>,
) {
  const brandId = String(row.brand_id || "");
  const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || "")));
  return replacementRowsByKey.has(`${brandId}::${normalizedCode}`);
}

function filterCatalogRowsBySearchRelevance(
  rows: CatalogSourceRow[],
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

function parseContentRangeTotal(value: string | null, fallback: number) {
  if (!value) return fallback;
  const match = value.match(/\/(\d+|\*)$/);
  if (!match || match[1] === "*") return fallback;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : fallback;
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

async function fetchRestRowsWithCount<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  params: Record<string, string>,
) {
  const response = await fetch(buildRestUrl(supabaseUrl, table, params), {
    headers: {
      ...serviceRoleHeaders(serviceRoleKey),
      Prefer: "count=planned",
    },
  });
  const data = await readJson<Array<T> & { message?: string; error?: string; msg?: string }>(response);
  if (!response.ok) {
    throw new Error(sanitizeUserFacingError(data?.msg || data?.message || data?.error || "Catalog request failed"));
  }
  return {
    rows: (data ?? []) as T[],
    totalCount: parseContentRangeTotal(response.headers.get("content-range"), Array.isArray(data) ? data.length : 0),
  };
}

async function fetchBrandMaps(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  const cached = brandMapCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return { byId: cached.byId, byName: cached.byName };
  }
  const { rows } = await fetchRestRowsWithCount<{ id?: string | null; name?: string | null }>(
    supabaseUrl,
    serviceRoleKey,
    "brands",
    {
      select: "id,name",
      organization_id: `eq.${organizationId}`,
      order: "name.asc",
      limit: "1000",
    },
  );
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.id || "").trim();
    const name = String(row.name || "").trim();
    if (!id || !name) continue;
    byId.set(id, name);
    byName.set(normalizePartCode(name), id);
  }
  brandMapCache.set(organizationId, {
    byId,
    byName,
    expiresAt: Date.now() + BRAND_MAP_CACHE_TTL_MS,
  });
  return { byId, byName };
}

async function fetchCloudCatalogPageViaRest(
  supabaseUrl: string,
  serviceRoleKey: string,
  caller: { organizationId: string },
  args: Record<string, unknown>,
) {
  const search = String(args.input_search || "").trim();
  const brand = String(args.input_brand || "").trim();
  const page = Math.max(1, Number(args.input_page || 1) || 1);
  const pageSize = Math.min(250, Math.max(1, Number(args.input_page_size || 50) || 50));
  const offset = (page - 1) * pageSize;
  const normalizedSearch = normalizePartCode(search);
  const fetchLimit = search && shouldStrictlyFilterCodeSearch(search) ? Math.max(pageSize * 2, 80) : pageSize;
  const brandMaps = await fetchBrandMaps(supabaseUrl, serviceRoleKey, caller.organizationId);
  const selectedBrandId = brand ? brandMaps.byName.get(normalizePartCode(brand)) || "" : "";
  const select =
    "id,product_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note";
  const baseParams: Record<string, string> = {
    select,
    organization_id: `eq.${caller.organizationId}`,
    order: "product_code.asc",
    limit: String(fetchLimit),
    offset: String(offset),
  };
  if (selectedBrandId) baseParams.brand_id = `eq.${selectedBrandId}`;
  if (search) {
    baseParams.or = buildCatalogSearchOr(search, normalizedSearch, "strict");
  }

  let { rows, totalCount } = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", baseParams);
  const replacementRowsByKey = new Map<
    string,
    {
      old_code: string;
      new_code: string;
      reason: string | null;
    }
  >();
  if (search && normalizedSearch.length >= 3) {
    const referenceRows = await fetchRestRowsWithCount<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "item_code_references", {
      select: "brand_id,old_code,new_code,reason,normalized_new_code",
      organization_id: `eq.${caller.organizationId}`,
      is_active: "eq.true",
      normalized_old_code: `eq.${normalizedSearch}`,
      ...(selectedBrandId ? { brand_id: `eq.${selectedBrandId}` } : {}),
      limit: "200",
    }).catch(() => ({ rows: [] as Record<string, unknown>[], totalCount: 0 }));
    if (referenceRows.rows.length) {
      const brandIds = [...new Set(referenceRows.rows.map((row) => String(row.brand_id || "")).filter(Boolean))];
      const newCodes = [...new Set(referenceRows.rows.map((row) => String(row.normalized_new_code || normalizePartCode(String(row.new_code || "")))).filter(Boolean))];
      for (const row of referenceRows.rows) {
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
        const replacementCatalogRows = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", {
          select,
          organization_id: `eq.${caller.organizationId}`,
          brand_id: `in.(${brandIds.join(",")})`,
          normalized_code: `in.(${newCodes.join(",")})`,
          order: "product_code.asc",
          limit: String(Math.max(120, newCodes.length * 4)),
        }).catch(() => ({ rows: [] as CatalogSourceRow[], totalCount: 0 }));
        if (replacementCatalogRows.rows.length) {
          rows = dedupeCatalogRows([
            ...rows,
            ...replacementCatalogRows.rows.filter((row) => {
              const brandId = String(row.brand_id || "");
              const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || "")));
              return replacementRowsByKey.has(`${brandId}::${normalizedCode}`);
            }),
          ]);
          totalCount = Math.max(totalCount, rows.length);
        }
      }
    }
  }
  if (search && shouldRunLooseOriginalNumberSearch(search) && rows.length < pageSize) {
    const familyClauses = buildOriginalNumberFamilyClauses(search);
    if (familyClauses.length) {
      const familySweepRows = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", {
        select,
        organization_id: `eq.${caller.organizationId}`,
        ...(selectedBrandId ? { brand_id: `eq.${selectedBrandId}` } : {}),
        or: `(${familyClauses.join(",")})`,
        order: "product_code.asc",
        limit: String(Math.min(160, Math.max(pageSize * 3, 80))),
      }).catch(() => ({ rows: [] as CatalogSourceRow[], totalCount: 0 }));
      if (familySweepRows.rows.length) {
        const merged = dedupeCatalogRows([...rows, ...familySweepRows.rows]).filter((row) => matchesCatalogFamilyRow(row, search));
        totalCount = merged.length;
        rows = merged.slice(offset, offset + pageSize);
      }
    }
  }
  if (!rows.length && search && shouldRunLooseOriginalNumberSearch(search)) {
    ({ rows, totalCount } = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", {
      ...baseParams,
      or: buildCatalogSearchOr(search, normalizedSearch, "loose"),
    }));
  }

  if (!rows.length && search && shouldRunLooseOriginalNumberSearch(search)) {
    const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
    const fallbackBase: Record<string, string> = {
      select,
      organization_id: `eq.${caller.organizationId}`,
      order: "product_code.asc",
      limit: "120",
    };
    if (selectedBrandId) fallbackBase.brand_id = `eq.${selectedBrandId}`;
    const fallbackByNormalized = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", {
      ...fallbackBase,
      normalized_oem: `like.*${normalizedOriginalSearch}*`,
    }).catch(() => ({ rows: [] as CatalogSourceRow[], totalCount: 0 }));

    const filtered = dedupeCatalogRows(fallbackByNormalized.rows).filter(
      (row) => matchesCatalogFamilyRow(row, search) || normalizePartCode(String(row.product_code || "")).includes(normalizedSearch),
    );
    totalCount = filtered.length;
    rows = filtered.slice(offset, offset + pageSize);
  }

  if (search && shouldStrictlyFilterCodeSearch(search)) {
    const exactSeedRows = dedupeCatalogRows(rows).filter(
      (row) => matchesCatalogExactFamilyRow(row, search) || hasCatalogReplacementMatch(row, replacementRowsByKey),
    );
    const seedClauses = buildCatalogSeedExpansionClauses(collectCatalogComparableTokensFromRows(exactSeedRows));
    if (seedClauses.length) {
      const seedExpansionRows = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", {
        select,
        organization_id: `eq.${caller.organizationId}`,
        ...(selectedBrandId ? { brand_id: `eq.${selectedBrandId}` } : {}),
        or: `(${seedClauses.join(",")})`,
        order: "product_code.asc",
        limit: "120",
      }).catch(() => ({ rows: [] as CatalogSourceRow[], totalCount: 0 }));
      if (seedExpansionRows.rows.length) {
        rows = dedupeCatalogRows([...rows, ...seedExpansionRows.rows]);
      }
    }
  }

  const filteredByRelevance = filterCatalogRowsBySearchRelevance(rows, search, replacementRowsByKey);
  totalCount = filteredByRelevance.length;
  rows = filteredByRelevance.slice(offset, offset + pageSize);

  return rows.map((row) => ({
    total_count: totalCount,
    product_id: String(row.id || ""),
    product_code: String(row.product_code || ""),
    brand: brandMaps.byId.get(String(row.brand_id || "")) || "",
    image_url: String(row.image_url || ""),
    description: String(row.description || ""),
    oem_no: sanitizeCatalogOemNumbers(row.oem_no),
    vehicle: String(row.vehicle || ""),
    hs_code: String(row.hs_code || ""),
    origin: String(row.origin || ""),
    weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
    lifecycle_status: normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`),
    lifecycle_note: String(row.lifecycle_note || ""),
    replacement_old_code:
      replacementRowsByKey.get(`${String(row.brand_id || "")}::${String(row.normalized_code || normalizePartCode(String(row.product_code || "")))}`)?.old_code || "",
    replacement_code:
      replacementRowsByKey.get(`${String(row.brand_id || "")}::${String(row.normalized_code || normalizePartCode(String(row.product_code || "")))}`)?.new_code || "",
    replacement_reason:
      replacementRowsByKey.get(`${String(row.brand_id || "")}::${String(row.normalized_code || normalizePartCode(String(row.product_code || "")))}`)?.reason || "",
    replacement_warning: (() => {
      const reference = replacementRowsByKey.get(
        `${String(row.brand_id || "")}::${String(row.normalized_code || normalizePartCode(String(row.product_code || "")))}`
      );
      return reference ? buildReplacementWarning(reference.old_code, reference.new_code || String(row.product_code || ""), reference.reason) : "";
    })(),
  }));
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || "").trim();
    const args = body?.args && typeof body.args === "object" ? body.args : {};

    if (!ALLOWED_RPCS.has(name)) {
      return json({ error: "RPC is not allowed through app gateway" }, 403);
    }

    if (SUPERADMIN_RPCS.has(name) && !isSuperadminRole(caller.role)) {
      return json({ error: "Superadmin access required" }, 403);
    }

    if (OPERATIONS_RPCS.has(name) && !canAccessOperationsModules(caller.role)) {
      return json({ error: "This area is not enabled for your user. Ask superadmin to open the required permission." }, 403);
    }

    if (CUSTOMER_STAFF_RPCS.has(name) && !canAccessCustomerOps(caller.role)) {
      return json({ error: "Staff access required" }, 403);
    }

    if (name === "cloud_catalog_page") {
      const data = await fetchCloudCatalogPageViaRest(supabaseUrl, serviceRoleKey, caller, args);
      return json({ ok: true, data });
    }

    const data = await sendJson<unknown>(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: String(req.headers.get("authorization") || ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    return json({ ok: true, data });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "The request could not be completed right now.") }, 400);
  }
};

export const config: Config = {
  path: "/api/app-rpc",
  method: "POST",
};
