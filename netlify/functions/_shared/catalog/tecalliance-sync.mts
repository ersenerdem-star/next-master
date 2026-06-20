import {
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  normalizeCatalogEan,
  normalizeCatalogOrigin,
  normalizeLifecycleStatus,
  isCatalogPlaceholderDescription,
  pickCatalogDescription,
  sanitizeCatalogOemNumbers,
} from "./catalog-standardization.mts";
import { normalizeCatalogMarketSegment } from "./catalog-segments.mts";

const TECALLIANCE_API_URL = "https://webservice.tecalliance.services/pegasus-3-0/services/TecdocToCatDLB.jsonEndpoint";
const DEFAULT_DISCOVERY_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const defaultRequestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
  origin: "https://web.tecalliance.net",
  referer: "https://web.tecalliance.net/",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

type SyncBrandTarget = {
  brandId: string;
  organizationId: string;
  name: string;
};

type CatalogRow = {
  organization_id: string;
  brand_id: string;
  product_code: string;
  normalized_code: string;
  description: string;
  ean: string;
  oem_no: string;
  vehicle: string;
  vehicle_model: string;
  market_segment: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
};

type SupplierSeedRow = {
  product_code: string;
  normalized_code: string;
};

type TecAllianceApiCriteria = {
  criteriaDescription?: string;
  criteriaAbbrDescription?: string;
  criteriaUnitDescription?: string;
  formattedValue?: string;
  rawValue?: string;
  immediateDisplay?: boolean;
};

type TecAllianceApiGenericArticle = {
  genericArticleId?: number;
  genericArticleDescription?: string;
};

type TecAllianceApiImage = {
  imageURL50?: string;
  imageURL100?: string;
  imageURL200?: string;
  imageURL400?: string;
  imageURL800?: string;
  imageURL1600?: string;
  imageURL3200?: string;
};

type TecAllianceApiOemNumber = {
  articleNumber?: string;
};

type TecAllianceApiText = {
  informationTypeDescription?: string;
  text?: string;
};

type TecAllianceApiBarcodeValue = string | number | Record<string, unknown>;

type TecAllianceApiMisc = {
  articleStatusDescription?: string;
};

type TecAllianceApiArticle = {
  articleNumber?: string;
  mfrName?: string;
  misc?: TecAllianceApiMisc;
  genericArticles?: TecAllianceApiGenericArticle[];
  articleText?: TecAllianceApiText[];
  tradeNumbers?: string[];
  gtinNumbers?: TecAllianceApiBarcodeValue[];
  eanNumbers?: TecAllianceApiBarcodeValue[];
  gtins?: TecAllianceApiBarcodeValue[];
  eans?: TecAllianceApiBarcodeValue[];
  oemNumbers?: TecAllianceApiOemNumber[];
  articleCriteria?: TecAllianceApiCriteria[];
  articleLogisticsCriteria?: TecAllianceApiCriteria[];
  images?: TecAllianceApiImage[];
};

type TecAllianceArticleSearchResponse = {
  totalMatchingArticles?: number;
  maxAllowedPage?: number;
  articles?: TecAllianceApiArticle[];
};

type DiscoveryLeaf = {
  prefix: string;
  totalMatchingArticles: number;
  maxAllowedPage: number;
};

type TecAllianceResolvedItem = {
  product_code: string;
  description: string;
  ean: string;
  oem_no: string;
  vehicle: string;
  vehicle_model: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  market_segment: string;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
};

export type TecAllianceSyncConfig = {
  providerLabel: string;
  providerId: number;
  dataSupplierId: number;
  manufacturerNames?: string[];
  discoveryAlphabet?: string[];
  filterQueries?: string[];
  requestHeaders?: Record<string, string>;
};

export async function syncBrandCatalogFromTecAllianceBrand(
  input: {
    supabaseUrl: string;
    serviceRoleKey: string;
    brandName: string;
    refreshExisting?: boolean;
    concurrency?: number;
    pageSize?: number;
    requestTimeoutMs?: number;
    seedPrefixes?: string[];
    maxPages?: number;
    expandPrefixes?: boolean;
    skipDiscovery?: boolean;
    candidateLimit?: number;
    includeBlankDiscoveryRoot?: boolean;
  },
  config: TecAllianceSyncConfig,
) {
  const refreshExisting = input.refreshExisting !== false;
  const concurrency = Math.max(1, input.concurrency ?? 4);
  const requestTimeoutMs = Math.max(5000, input.requestTimeoutMs ?? 30000);
  const perPage = Math.max(25, Math.min(100, input.pageSize ?? 100));
  const leafThreshold = Math.max(250, perPage * 8);
  const maxPages = Number.isFinite(input.maxPages ?? NaN) && Number(input.maxPages) > 0 ? Math.floor(Number(input.maxPages)) : undefined;
  const expandPrefixes = input.expandPrefixes !== false;
  const includeBlankDiscoveryRoot = input.includeBlankDiscoveryRoot !== false;
  const discoveryAlphabet = dedupeStrings((config.discoveryAlphabet || DEFAULT_DISCOVERY_ALPHABET).map((value) => normalizeSearchPrefix(value)).filter(Boolean));
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const target = await resolveOrCreateTargetBrand(input.supabaseUrl, headers, input.brandName);
  const supportsImageColumn = await detectCatalogImageColumn(input.supabaseUrl, headers);
  const supportsEanColumn = await detectCatalogEanColumn(input.supabaseUrl, headers);
  const supportsVehicleModelColumn = await detectCatalogVehicleModelColumn(input.supabaseUrl, headers);
  const supportsMarketSegmentColumn = await detectCatalogMarketSegmentColumn(input.supabaseUrl, headers);
  const existingRows = await fetchCatalogRows(input.supabaseUrl, headers, target);
  const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));
  const supplierSeedRows = await fetchSupplierPriceSeedRows(input.supabaseUrl, headers, target);

  const explicitSeedPrefixes = dedupeStrings((input.seedPrefixes || []).map((value) => normalizeSearchPrefix(value)).filter(Boolean));
  const exactSeedTerms = dedupeStrings([
    ...existingRows.map((row) => row.product_code),
    ...supplierSeedRows.map((row) => row.product_code),
  ]);

  const discovery = input.skipDiscovery
    ? {
        rootPrefixes: includeBlankDiscoveryRoot ? [""] : explicitSeedPrefixes.length ? explicitSeedPrefixes : discoveryAlphabet,
        leafSummaries: [],
        articlesByCode: new Map<string, TecAllianceApiArticle>(),
        requests: 0,
      }
    : await crawlTecAllianceCatalog(
        {
          rootPrefixes: includeBlankDiscoveryRoot ? [""] : explicitSeedPrefixes.length ? explicitSeedPrefixes : discoveryAlphabet,
          expansionAlphabet: discoveryAlphabet,
          perPage,
          leafThreshold,
          requestTimeoutMs,
          maxPages,
          expandPrefixes,
        },
        config,
        target.name,
      );

  const workMap = new Map<string, { existing: CatalogRow | null; article: TecAllianceApiArticle | null; searchTerm: string | null }>();

  for (const row of existingRows) {
    if (refreshExisting || shouldProcessRow(row)) {
      workMap.set(row.normalized_code, {
        existing: row,
        article: discovery.articlesByCode.get(row.normalized_code) || null,
        searchTerm: row.product_code,
      });
    }
  }

  for (const article of discovery.articlesByCode.values()) {
    const productCode = normalizeCatalogDisplayCode(article.articleNumber || "", target.name);
    const normalizedCode = normalizeCode(productCode);
    if (!productCode || !normalizedCode) continue;
    if (existingByCode.has(normalizedCode) && !refreshExisting && !shouldProcessRow(existingByCode.get(normalizedCode)!)) continue;
    workMap.set(normalizedCode, {
      existing: existingByCode.get(normalizedCode) || null,
      article,
      searchTerm: productCode,
    });
  }

  for (const term of exactSeedTerms) {
    const normalizedCode = normalizeCode(term);
    if (!normalizedCode || workMap.has(normalizedCode)) continue;
    workMap.set(normalizedCode, {
      existing: existingByCode.get(normalizedCode) || null,
      article: null,
      searchTerm: term,
    });
  }

  const candidateLimit = Number.isFinite(input.candidateLimit ?? NaN) && Number(input.candidateLimit) > 0 ? Math.floor(Number(input.candidateLimit)) : null;
  const candidateRowsBeforeLimit = workMap.size;
  const truncatedByCandidateLimit = Boolean(candidateLimit && candidateRowsBeforeLimit > candidateLimit);
  if (candidateLimit && workMap.size > candidateLimit) {
    const limited = new Map<string, { existing: CatalogRow | null; article: TecAllianceApiArticle | null; searchTerm: string | null }>();
    for (const [code, item] of workMap.entries()) {
      limited.set(code, item);
      if (limited.size >= candidateLimit) break;
    }
    workMap.clear();
    for (const [code, item] of limited.entries()) {
      workMap.set(code, item);
    }
  }

  const catalogPayload: CatalogRow[] = [];
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let imageRows = 0;
  let hsRows = 0;
  let weightRows = 0;
  let discontinuedRows = 0;

  await runPool([...workMap.values()], concurrency, async (item) => {
    try {
      const productCode = item.searchTerm || item.existing?.product_code || "";
      const article =
        item.article || (productCode ? await searchTecAllianceExactArticle(productCode, perPage, requestTimeoutMs, config, target.name) : null);
      if (!article) {
        throw new Error(`Official ${config.providerLabel} product not found for ${productCode || item.existing?.normalized_code || "unknown code"}`);
      }

      const resolved = resolveTecAllianceArticle(article, item.existing, target.name);
      const merged = buildMergedCatalogRow(target, item.existing, resolved);
      const changed = !item.existing || hasCatalogDelta(item.existing, merged);

      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.oem_no)) oemRows += 1;
      if (normalizeTextValue(merged.vehicle) || normalizeTextValue(merged.vehicle_model)) vehicleRows += 1;
      if (normalizeTextValue(merged.image_url)) imageRows += 1;
      if (normalizeTextValue(merged.hs_code)) hsRows += 1;
      if (merged.weight_kg != null) weightRows += 1;
      if (normalizeLifecycleStatus(merged.lifecycle_status) === "discontinued") discontinuedRows += 1;

    if (!item.existing || refreshExisting || changed) {
      catalogPayload.push(merged);
    }
  } catch (error) {
      const productCode = item.searchTerm || item.existing?.product_code || "";
      errorRows.push({
        product_code: productCode,
        normalized_code: normalizeCode(productCode || item.existing?.normalized_code || ""),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const processedBatches = [];
  const batchSize = 200;
  if (catalogPayload.length) {
    for (let index = 0; index < catalogPayload.length; index += batchSize) {
      const batch = catalogPayload.slice(index, index + batchSize);
      const response = await fetch(`${input.supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(
          batch.map((row) => ({
            organization_id: row.organization_id,
            brand_id: row.brand_id,
            product_code: row.product_code,
            description: emptyToNull(row.description),
            ...(supportsEanColumn ? { ean: emptyToNull(row.ean) } : {}),
            oem_no: emptyToNull(row.oem_no),
            vehicle: emptyToNull(row.vehicle),
            ...(supportsVehicleModelColumn ? { vehicle_model: emptyToNull(row.vehicle_model) } : {}),
            ...(supportsMarketSegmentColumn ? { market_segment: emptyToNull(row.market_segment) } : {}),
            hs_code: emptyToNull(row.hs_code),
            origin: emptyToNull(row.origin),
            weight_kg: row.weight_kg == null || Number.isNaN(Number(row.weight_kg)) ? null : Number(row.weight_kg),
            ...(supportsImageColumn ? { image_url: emptyToNull(row.image_url) } : {}),
            lifecycle_status: emptyToNull(row.lifecycle_status) || "active",
            lifecycle_note: emptyToNull(row.lifecycle_note),
            updated_at: new Date().toISOString(),
          })),
        ),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
      }
      processedBatches.push({ type: "catalog", batch: index / batchSize + 1, rows: batch.length, status: response.status });
    }
  }

  return {
    targetBrandId: target.brandId,
    targetBrandName: target.name,
    organizationId: target.organizationId,
    existingRows: existingRows.length,
    supplierSeedRows: supplierSeedRows.length,
    discoveryRoots: explicitSeedPrefixes.length ? explicitSeedPrefixes : discoveryAlphabet,
    discoveryLeafCount: discovery.leafSummaries.length,
    discoveryLeafSummaries: discovery.leafSummaries,
    discoveryRequests: discovery.requests,
    listingUniqueRows: discovery.articlesByCode.size,
    newRowsInListing: [...discovery.articlesByCode.keys()].filter((code) => !existingByCode.has(code)).length,
    incompleteExistingRows: existingRows.filter((row) => shouldProcessRow(row)).length,
    candidateRowsBeforeLimit,
    candidateRows: workMap.size,
    truncatedByCandidateLimit,
    resolvedRows: matchedRows,
    errorRows: errorRows.length,
    discontinuedRows,
    replacementRows: 0,
    replacementFetchRows: 0,
    supportsImageColumn,
    processedBatches,
    processedReplacementBatches: [],
    oemRows,
    vehicleRows,
    imageRows,
    hsRows,
    weightRows,
    errors: errorRows,
  };
}

async function crawlTecAllianceCatalog(
  input: {
    rootPrefixes: string[];
    expansionAlphabet: string[];
    perPage: number;
    leafThreshold: number;
    requestTimeoutMs: number;
    maxPages?: number;
    expandPrefixes?: boolean;
  },
  config: TecAllianceSyncConfig,
  brandName: string,
) {
  const rootPrefixes = [];
  const seen = new Set<string>();
  for (const value of input.rootPrefixes) {
    const raw = String(value || "").trim();
    const prefix = raw === "" ? "" : normalizeSearchPrefix(value);
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    rootPrefixes.push(prefix);
  }
  const queue = [...rootPrefixes];
  const leafSummaries: DiscoveryLeaf[] = [];
  const articlesByCode = new Map<string, TecAllianceApiArticle>();
  let requests = 0;

  while (queue.length) {
    const prefix = queue.shift()!;
    const firstPage = await fetchTecAllianceArticlesPage(prefix, 1, input.perPage, input.requestTimeoutMs, config);
    requests += 1;
    const totalMatchingArticles = Math.max(0, Number(firstPage.totalMatchingArticles || 0));
    const maxAllowedPage = Math.max(1, Number(firstPage.maxAllowedPage || 1));

    if (!totalMatchingArticles) {
      leafSummaries.push({ prefix, totalMatchingArticles: 0, maxAllowedPage: 0 });
      continue;
    }

    if (input.expandPrefixes !== false && shouldExpandPrefix(prefix, totalMatchingArticles, maxAllowedPage, input.leafThreshold)) {
      for (const child of input.expansionAlphabet) {
        queue.push(`${prefix}${child}`);
      }
      continue;
    }

    leafSummaries.push({ prefix, totalMatchingArticles, maxAllowedPage });
    consumeTecAllianceArticles(articlesByCode, firstPage.articles || [], config, brandName);

    const pageLimit = input.maxPages && input.maxPages > 0 ? Math.min(maxAllowedPage, input.maxPages) : maxAllowedPage;
    for (let page = 2; page <= pageLimit; page += 1) {
      const nextPage = await fetchTecAllianceArticlesPage(prefix, page, input.perPage, input.requestTimeoutMs, config);
      requests += 1;
      consumeTecAllianceArticles(articlesByCode, nextPage.articles || [], config, brandName);
    }
  }

  return {
    rootPrefixes,
    leafSummaries,
    articlesByCode,
    requests,
  };
}

function shouldExpandPrefix(prefix: string, totalMatchingArticles: number, maxAllowedPage: number, leafThreshold: number) {
  if (prefix.length >= 4) return false;
  return totalMatchingArticles > leafThreshold || maxAllowedPage > 10;
}

function consumeTecAllianceArticles(
  target: Map<string, TecAllianceApiArticle>,
  articles: TecAllianceApiArticle[],
  config: TecAllianceSyncConfig,
  brandName: string,
) {
  const allowedManufacturers = buildAllowedManufacturerMatchers(config);

  for (const article of articles) {
    const productCode = normalizeCatalogDisplayCode(article.articleNumber || "", brandName);
    const normalizedCode = normalizeCode(productCode);
    const supplierName = normalizeTextValue(article.mfrName || "");
    if (!productCode || !normalizedCode) continue;
    if (allowedManufacturers.size && supplierName && !matchesAllowedManufacturer(supplierName, allowedManufacturers)) continue;
    target.set(normalizedCode, article);
  }
}

function buildAllowedManufacturerMatchers(config: TecAllianceSyncConfig) {
  const exact = new Set(
    (config.manufacturerNames || [config.providerLabel])
      .map((value) => normalizeTextValue(value).toUpperCase())
      .filter(Boolean),
  );
  const compact = new Set(
    [...exact]
      .map((value) => normalizeManufacturerMatcherValue(value))
      .filter(Boolean),
  );
  return { exact, compact };
}

function matchesAllowedManufacturer(
  supplierName: string,
  allowed: { exact: Set<string>; compact: Set<string> },
) {
  const normalized = normalizeTextValue(supplierName).toUpperCase();
  const compact = normalizeManufacturerMatcherValue(normalized);
  if (!compact) return false;
  if (allowed.exact.has(normalized) || allowed.compact.has(compact)) return true;
  for (const candidate of allowed.compact) {
    if (!candidate) continue;
    if (compact.includes(candidate) || candidate.includes(compact)) return true;
  }
  return false;
}

function normalizeManufacturerMatcherValue(value: string) {
  return normalizeTextValue(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

async function searchTecAllianceExactArticle(
  productCode: string,
  perPage: number,
  requestTimeoutMs: number,
  config: TecAllianceSyncConfig,
  brandName: string,
) {
  const target = normalizeCode(productCode);
  const searchTerms = buildTecAllianceExactSearchTerms(productCode, brandName);

  for (const term of searchTerms) {
    const response = await requestTecAllianceArticles(
      {
        searchQuery: term,
        page: 1,
        perPage: Math.max(10, Math.min(50, perPage)),
        requestTimeoutMs,
        searchMatchType: "prefix_or_suffix",
      },
      config,
    );
    const exact = (response.articles || []).find((article) => normalizeCode(article.articleNumber || "") === target);
    if (exact) return exact;
  }

  return null;
}

function buildTecAllianceExactSearchTerms(productCode: string, brandName: string) {
  const display = normalizeCatalogDisplayCode(productCode, brandName);
  const compact = normalizeCode(display);
  return dedupeStrings([
    display,
    compact,
    display.replace(/\s+/g, ""),
    display.replace(/\//g, " "),
    display.replace(/-/g, " "),
  ]).filter((value) => normalizeCode(value).length >= 3);
}

async function fetchTecAllianceArticlesPage(
  prefix: string,
  page: number,
  perPage: number,
  requestTimeoutMs: number,
  config: TecAllianceSyncConfig,
) {
  return requestTecAllianceArticles(
    {
      searchQuery: prefix,
      page,
      perPage,
      requestTimeoutMs,
      searchMatchType: "prefix",
    },
    config,
  );
}

async function requestTecAllianceArticles(
  input: {
    searchQuery: string;
    page: number;
    perPage: number;
    requestTimeoutMs: number;
    searchMatchType: "prefix" | "prefix_or_suffix";
  },
  config: TecAllianceSyncConfig,
) {
  const payload = {
    getArticles: {
      applyDqmRules: true,
      articleCountry: "GB",
      provider: config.providerId,
      lang: "en",
      searchQuery: input.searchQuery,
      searchMatchType: input.searchMatchType,
      searchType: 10,
      page: input.page,
      perPage: input.perPage,
      sort: [
        { field: "score", direction: "desc" },
        { field: "mfrName", direction: "asc" },
        { field: "linkageSortNum", direction: "asc" },
      ],
      filterQueries: config.filterQueries || ["(dataSupplierId NOT IN (4978,4982))"],
      dataSupplierIds: [config.dataSupplierId],
      genericArticleIds: [],
      includeAll: false,
      includeLinkages: false,
      linkagesPerPage: 0,
      includeGenericArticles: true,
      includeArticleCriteria: true,
      includeMisc: true,
      includeImages: true,
      includePDFs: false,
      includeLinks: false,
      includeArticleText: true,
      includeOEMNumbers: true,
      includeReplacedByArticles: true,
      includeReplacesArticles: true,
      includeComparableNumbers: false,
      includeGTINs: true,
      includeTradeNumbers: true,
      includePrices: false,
      includePartsListArticles: false,
      includeAccessoryArticles: false,
      includeArticleLogisticsCriteria: true,
      includeDataSupplierFacets: false,
      includeGenericArticleFacets: false,
      includeCriteriaFacets: false,
    },
  };

  return fetchTecAllianceJson<TecAllianceArticleSearchResponse>(TECALLIANCE_API_URL, payload, input.requestTimeoutMs, config.requestHeaders);
}

function resolveTecAllianceArticle(article: TecAllianceApiArticle, current: CatalogRow | null, brandName: string): TecAllianceResolvedItem {
  const productCode = normalizeCatalogDisplayCode(article.articleNumber || current?.product_code || "", brandName);
  const criteria = article.articleCriteria || [];
  const logisticsCriteria = article.articleLogisticsCriteria || [];
  const genericDescription = normalizeCatalogDescription(article.genericArticles?.[0]?.genericArticleDescription || "");
  const articleText = extractTecAllianceArticleText(article.articleText || []);
  const description =
    pickCatalogDescription(
      [
        articleText,
        genericDescription,
        current?.description || "",
        article.genericArticles?.[0]?.genericArticleDescription || "",
      ],
      productCode,
    ) || "";
  const lifecycleDescription = normalizeTextValue(article.misc?.articleStatusDescription || "");
  const lifecycleStatus = normalizeLifecycleStatus(lifecycleDescription || current?.lifecycle_status || "active");

  return {
    product_code: productCode,
    description,
    ean: extractTecAllianceEan(article, criteria, logisticsCriteria, current?.ean || ""),
    oem_no: extractTecAllianceOemNumbers(article.oemNumbers || []),
    vehicle: current?.vehicle || "",
    vehicle_model: extractTecAllianceVehicleModel(article, criteria, logisticsCriteria, current?.vehicle_model || current?.vehicle || ""),
    market_segment: extractTecAllianceMarketSegment(article, criteria, logisticsCriteria, current?.market_segment || ""),
    hs_code: current?.hs_code || "",
    origin: normalizeCatalogOrigin(current?.origin || ""),
    weight_kg: extractTecAllianceWeightKg(criteria, logisticsCriteria, current?.weight_kg ?? null),
    image_url: extractTecAllianceImageUrl(article.images || []) || current?.image_url || "",
    lifecycle_status: lifecycleStatus,
    lifecycle_note: lifecycleStatus === "discontinued" ? lifecycleDescription || current?.lifecycle_note || null : null,
  };
}

function extractTecAllianceArticleText(items: TecAllianceApiText[]) {
  const values = items
    .map((item) => normalizeTextValue(item.text || ""))
    .filter((value) => Boolean(value) && !isCatalogPlaceholderDescription(value, ""))
    .map((value) => normalizeCatalogDescription(value));
  return values[0] || "";
}

function extractTecAllianceOemNumbers(items: TecAllianceApiOemNumber[]) {
  const values = items.map((item) => normalizeTextValue(item.articleNumber || "")).filter(Boolean);
  return limitCatalogOemLength(sanitizeCatalogOemNumbers(values.join(", ")));
}

function extractTecAllianceVehicleModel(
  article: TecAllianceApiArticle,
  criteria: TecAllianceApiCriteria[],
  logisticsCriteria: TecAllianceApiCriteria[],
  fallback: string,
) {
  const candidateValues = [
    ...(article.articleText || []).map((item) => normalizeTextValue(item.text || "")),
    ...criteria.map((entry) => normalizeTextValue(entry.formattedValue || entry.rawValue || "")),
    ...logisticsCriteria.map((entry) => normalizeTextValue(entry.formattedValue || entry.rawValue || "")),
  ].filter(Boolean);
  const selected =
    candidateValues.find((value) => /(?:^|\b)(vehicle model|model|series|vehicle type|type)(?:\b|$)/i.test(value)) ||
    candidateValues.find((value) => /[A-Za-z].*\d/.test(value)) ||
    "";
  return normalizeTextValue(selected || fallback);
}

function extractTecAllianceMarketSegment(
  article: TecAllianceApiArticle,
  criteria: TecAllianceApiCriteria[],
  logisticsCriteria: TecAllianceApiCriteria[],
  fallback: string,
) {
  const candidateValues = [
    ...(article.genericArticles || []).map((item) => normalizeTextValue(item.genericArticleDescription || "")),
    ...(article.articleText || []).map((item) => normalizeTextValue(item.text || "")),
    ...criteria.map((entry) => normalizeTextValue(entry.criteriaDescription || entry.criteriaAbbrDescription || entry.formattedValue || entry.rawValue || "")),
    ...logisticsCriteria.map((entry) => normalizeTextValue(entry.criteriaDescription || entry.criteriaAbbrDescription || entry.formattedValue || entry.rawValue || "")),
  ].filter(Boolean);

  const selected =
    candidateValues.find((value) => normalizeCatalogMarketSegment(value)) ||
    candidateValues.find((value) => /(?:^|\b)(pc|cv|lcv|motorcycle|engines|engine|universal|marine|industrial|agriculture|truck|bus|passenger car|passenger vehicle|pkw|lkw|commercial|light commercial)(?:\b|$)/i.test(value)) ||
    "";

  return normalizeCatalogMarketSegment(selected || fallback) || normalizeCatalogMarketSegment(fallback) || "";
}

function extractTecAllianceEan(
  article: TecAllianceApiArticle,
  criteria: TecAllianceApiCriteria[],
  logisticsCriteria: TecAllianceApiCriteria[],
  fallback: string,
) {
  const directValues = [
    ...extractTecAllianceBarcodeValues(article.gtinNumbers || []),
    ...extractTecAllianceBarcodeValues(article.eanNumbers || []),
    ...extractTecAllianceBarcodeValues(article.gtins || []),
    ...extractTecAllianceBarcodeValues(article.eans || []),
  ];
  const criteriaValue = [...criteria, ...logisticsCriteria]
    .filter((entry) => /(?:^|\b)(ean|gtin|barcode)(?:\b|$)/i.test(normalizeTextValue(entry.criteriaDescription || entry.criteriaAbbrDescription || "")))
    .map((entry) => normalizeCatalogEan(entry.formattedValue || entry.rawValue || ""))
    .find(Boolean);
  return directValues.find(Boolean) || criteriaValue || normalizeCatalogEan(fallback);
}

function extractTecAllianceBarcodeValues(items: TecAllianceApiBarcodeValue[]) {
  const values = items
    .flatMap((item) => {
      if (item == null) return [];
      if (typeof item === "string" || typeof item === "number") return [String(item)];
      return [
        item.gtin,
        item.gtinNumber,
        item.ean,
        item.eanNumber,
        item.number,
        item.value,
        item.formattedValue,
        item.rawValue,
      ].map((value) => String(value || ""));
    })
    .map((value) => normalizeCatalogEan(value))
    .filter(Boolean);
  return dedupeStrings(values);
}

function extractTecAllianceImageUrl(images: TecAllianceApiImage[]) {
  const image = images[0] || {};
  return (
    normalizeTextValue(image.imageURL1600 || "") ||
    normalizeTextValue(image.imageURL800 || "") ||
    normalizeTextValue(image.imageURL400 || "") ||
    normalizeTextValue(image.imageURL200 || "") ||
    ""
  );
}

function extractTecAllianceWeightKg(criteria: TecAllianceApiCriteria[], logisticsCriteria: TecAllianceApiCriteria[], fallback: number | null) {
  const item = [...criteria, ...logisticsCriteria].find((entry) => /net weight/i.test(normalizeTextValue(entry.criteriaDescription || entry.criteriaAbbrDescription || "")));
  if (!item) return fallback;

  const raw = normalizeTextValue(item.formattedValue || item.rawValue || "").replace(",", ".");
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric)) return fallback;
  const unit = normalizeTextValue(item.criteriaUnitDescription || "").toLowerCase();
  if (unit === "g") return Number((numeric / 1000).toFixed(3));
  if (unit === "kg") return Number(numeric.toFixed(3));
  return fallback;
}

function buildMergedCatalogRow(target: SyncBrandTarget, current: CatalogRow | null, resolved: TecAllianceResolvedItem): CatalogRow {
  const displayCode = normalizeCatalogDisplayCode(resolved.product_code, target.name);
  return {
    organization_id: target.organizationId,
    brand_id: target.brandId,
    product_code: displayCode,
    normalized_code: normalizeCode(displayCode),
    description: pickCatalogDescription([resolved.description, current?.description], displayCode) || "",
    ean: resolved.ean || current?.ean || "",
    oem_no: resolved.oem_no || current?.oem_no || "",
    vehicle: resolved.vehicle || current?.vehicle || "",
    vehicle_model: resolved.vehicle_model || current?.vehicle_model || current?.vehicle || "",
    market_segment: normalizeCatalogMarketSegment(resolved.market_segment || current?.market_segment || "") || "",
    hs_code: resolved.hs_code || current?.hs_code || "",
    origin: normalizeCatalogOrigin(resolved.origin || current?.origin || ""),
    weight_kg: resolved.weight_kg ?? current?.weight_kg ?? null,
    image_url: resolved.image_url || current?.image_url || "",
    lifecycle_status: normalizeLifecycleStatus(resolved.lifecycle_status || current?.lifecycle_status || "active"),
    lifecycle_note: resolved.lifecycle_note || current?.lifecycle_note || null,
  };
}

function hasCatalogDelta(current: CatalogRow, next: CatalogRow) {
  return (
    normalizeTextValue(current.product_code) !== normalizeTextValue(next.product_code) ||
    normalizeTextValue(current.description) !== normalizeTextValue(next.description) ||
    normalizeTextValue(current.ean) !== normalizeTextValue(next.ean) ||
    normalizeTextValue(current.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(current.vehicle) !== normalizeTextValue(next.vehicle) ||
    normalizeTextValue(current.vehicle_model) !== normalizeTextValue(next.vehicle_model) ||
    normalizeTextValue(current.market_segment) !== normalizeTextValue(next.market_segment) ||
    normalizeTextValue(current.hs_code) !== normalizeTextValue(next.hs_code) ||
    normalizeTextValue(current.origin) !== normalizeTextValue(next.origin) ||
    normalizeTextValue(current.image_url) !== normalizeTextValue(next.image_url) ||
    (current.weight_kg ?? null) !== (next.weight_kg ?? null) ||
    normalizeLifecycleStatus(current.lifecycle_status) !== normalizeLifecycleStatus(next.lifecycle_status) ||
    normalizeTextValue(current.lifecycle_note || "") !== normalizeTextValue(next.lifecycle_note || "")
  );
}

function shouldProcessRow(row: CatalogRow) {
  return (
    !normalizeTextValue(row.description) ||
    isCatalogPlaceholderDescription(row.description, row.normalized_code || row.product_code) ||
    !normalizeTextValue(row.ean) ||
    !normalizeTextValue(row.oem_no) ||
    !normalizeTextValue(row.image_url) ||
    !normalizeTextValue(row.market_segment) ||
    row.weight_kg == null
  );
}

async function fetchTecAllianceJson<T>(
  url: string,
  payload: unknown,
  requestTimeoutMs: number,
  headerOverrides?: Record<string, string>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...defaultRequestHeaders,
        ...(headerOverrides || {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`TecAlliance request failed ${response.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveOrCreateTargetBrand(supabaseUrl: string, headers: Record<string, string>, brandName: string): Promise<SyncBrandTarget> {
  const existingBrands = await fetchAll<Record<string, unknown>>(supabaseUrl, headers, "/rest/v1/brands?select=id,name,organization_id&order=name.asc");
  const exact =
    existingBrands.find((row) => normalizeCode(String(row.name || "")) === normalizeCode(brandName)) ||
    existingBrands.find((row) => normalizeCode(String(row.name || "")).includes(normalizeCode(brandName))) ||
    null;

  if (exact?.id && exact?.organization_id) {
    return {
      brandId: String(exact.id),
      organizationId: String(exact.organization_id),
      name: String(exact.name || brandName).trim() || brandName,
    };
  }

  const seedOrgId = String(existingBrands[0]?.organization_id || "").trim();
  if (!seedOrgId) throw new Error("Could not resolve organization_id from brands table");

  const response = await fetch(`${supabaseUrl}/rest/v1/brands`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      organization_id: seedOrgId,
      name: brandName.trim(),
    }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Brand create failed: ${response.status} ${JSON.stringify(data)}`);
  const created = Array.isArray(data) ? data[0] : data;
  if (!created?.id) throw new Error(`Brand create returned no id: ${JSON.stringify(data)}`);

  return {
    brandId: String(created.id),
    organizationId: seedOrgId,
    name: brandName.trim(),
  };
}

async function detectCatalogImageColumn(supabaseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=image_url&limit=1`, { headers });
  if (response.ok) return true;
  const text = await response.text();
  return !/column .*image_url/i.test(text);
}

async function detectCatalogEanColumn(supabaseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=ean&limit=1`, { headers });
  if (response.ok) return true;
  const text = await response.text();
  return !/column .*ean/i.test(text);
}

async function detectCatalogVehicleModelColumn(supabaseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=vehicle_model&limit=1`, { headers });
  if (response.ok) return true;
  const text = await response.text();
  return !/column .*vehicle_model/i.test(text);
}

async function detectCatalogMarketSegmentColumn(supabaseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=market_segment&limit=1`, { headers });
  if (response.ok) return true;
  const text = await response.text();
  return !/column .*market_segment/i.test(text);
}

async function fetchCatalogRows(supabaseUrl: string, headers: Record<string, string>, target: SyncBrandTarget) {
  const results: CatalogRow[] = [];
  const pageLimit = 1000;
  let offset = 0;
  const supportsEanColumn = await detectCatalogEanColumn(supabaseUrl, headers);
  const supportsVehicleModelColumn = await detectCatalogVehicleModelColumn(supabaseUrl, headers);
  const supportsMarketSegmentColumn = await detectCatalogMarketSegmentColumn(supabaseUrl, headers);
  const selectColumns = [
    "organization_id",
    "brand_id",
    "product_code",
    "normalized_code",
    "description",
    ...(supportsEanColumn ? ["ean"] : []),
    "oem_no",
    "vehicle",
    ...(supportsVehicleModelColumn ? ["vehicle_model"] : []),
    ...(supportsMarketSegmentColumn ? ["market_segment"] : []),
    "hs_code",
    "origin",
    "weight_kg",
    "image_url",
    "lifecycle_status",
    "lifecycle_note",
  ].join(",");

  while (true) {
    const rows = await fetchAll<Record<string, unknown>>(
      supabaseUrl,
      headers,
      `/rest/v1/catalog_products?select=${selectColumns}&brand_id=eq.${encodeURIComponent(target.brandId)}&limit=${pageLimit}&offset=${offset}`,
    );
    if (!rows.length) break;

    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || target.organizationId),
          brand_id: String(row.brand_id || target.brandId),
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), target.name),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
          description: String(row.description || "").trim(),
          ean: normalizeCatalogEan(String(row.ean || "").trim()),
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
          vehicle_model: String(row.vehicle_model || "").trim(),
          market_segment: String(row.market_segment || "").trim(),
          hs_code: String(row.hs_code || "").trim(),
          origin: String(row.origin || "").trim(),
          weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
          image_url: String(row.image_url || "").trim(),
          lifecycle_status: normalizeLifecycleStatus(row.lifecycle_status),
          lifecycle_note: String(row.lifecycle_note || "").trim() || null,
        }))
        .filter((row) => row.product_code && row.normalized_code),
    );

    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }

  return dedupeBy(results, (row) => row.normalized_code);
}

async function fetchSupplierPriceSeedRows(supabaseUrl: string, headers: Record<string, string>, target: SyncBrandTarget) {
  const results: SupplierSeedRow[] = [];
  const pageLimit = 1000;
  let offset = 0;

  while (true) {
    const rows = await fetchAll<Record<string, unknown>>(
      supabaseUrl,
      headers,
      `/rest/v1/supplier_prices?select=product_code,normalized_code&brand_id=eq.${encodeURIComponent(target.brandId)}&is_active=eq.true&limit=${pageLimit}&offset=${offset}`,
    );
    if (!rows.length) break;

    results.push(
      ...rows
        .map((row) => ({
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), target.name),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
        }))
        .filter((row) => row.product_code && row.normalized_code),
    );

    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }

  return dedupeBy(results, (row) => row.normalized_code);
}

async function fetchAll<T>(supabaseUrl: string, headers: Record<string, string>, path: string) {
  const response = await fetch(`${supabaseUrl}${path}`, { headers });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${text}`);
  return rows as T[];
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

function normalizeCode(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTextValue(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSearchPrefix(value: unknown) {
  return String(value || "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .trim();
}

function emptyToNull(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function dedupeBy<T>(rows: T[], keyFn: (row: T) => string) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = keyFn(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function limitCatalogOemLength(value: string, maxLength = 1500) {
  const text = normalizeTextValue(value);
  if (!text || text.length <= maxLength) return text;

  const tokens = text
    .split(",")
    .map((part) => normalizeTextValue(part))
    .filter(Boolean);
  const kept: string[] = [];

  for (const token of tokens) {
    const next = kept.length ? `${kept.join(", ")}, ${token}` : token;
    if (next.length > maxLength) break;
    kept.push(token);
  }

  return kept.join(", ");
}
