import {
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  normalizeLifecycleStatus,
  sanitizeCatalogOemNumbers,
} from "./catalog-standardization.mts";

const SKF_SEARCH_BASE_URL = "https://search.automotive.skf.com/prod/search-automotive/rest";
const SKF_PARTS_SEARCHER = "apps/automotive/searchers/parts";
const SKF_DETAILS_SEARCHER = "apps/automotive/searchers/details";
const SKF_VEHICLES_SEARCHER = "apps/automotive/searchers/vehicles";
const SKF_IMAGE_BASE_URL = "https://automotive.skf.com/azure/images/products/m";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const KNOWN_MANUFACTURER_PATTERNS = [
  { label: "Mercedes-Benz", pattern: /\bMERCEDES(?:-BENZ)?\b/ },
  { label: "Volkswagen", pattern: /\b(?:VW|VOLKSWAGEN)\b/ },
  { label: "Audi", pattern: /\bAUDI\b/ },
  { label: "BMW", pattern: /\bBMW\b/ },
  { label: "Ford", pattern: /\bFORD\b/ },
  { label: "Toyota", pattern: /\bTOYOTA\b/ },
  { label: "Honda", pattern: /\bHONDA\b/ },
  { label: "Nissan", pattern: /\bNISSAN\b/ },
  { label: "Renault", pattern: /\bRENAULT\b/ },
  { label: "Peugeot", pattern: /\bPEUGEOT\b/ },
  { label: "Citroen", pattern: /\bCITROE?N\b/ },
  { label: "Opel", pattern: /\bOPEL\b/ },
  { label: "Fiat", pattern: /\bFIAT\b/ },
  { label: "Alfa Romeo", pattern: /\bALFA ROMEO\b/ },
  { label: "Jeep", pattern: /\bJEEP\b/ },
  { label: "Dodge", pattern: /\bDODGE\b/ },
  { label: "Chrysler", pattern: /\bCHRYSLER\b/ },
  { label: "Mazda", pattern: /\bMAZDA\b/ },
  { label: "Mitsubishi", pattern: /\bMITSUBISHI\b/ },
  { label: "Suzuki", pattern: /\bSUZUKI\b/ },
  { label: "Subaru", pattern: /\bSUBARU\b/ },
  { label: "Hyundai", pattern: /\bHYUNDAI\b/ },
  { label: "Kia", pattern: /\bKIA\b/ },
  { label: "Volvo", pattern: /\bVOLVO\b/ },
  { label: "MAN", pattern: /\bMAN\b/ },
  { label: "DAF", pattern: /\bDAF\b/ },
  { label: "Scania", pattern: /\bSCANIA\b/ },
  { label: "Iveco", pattern: /\bIVECO\b/ },
];

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
  oem_no: string;
  vehicle: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
};

type SkfSearchItem = {
  product_code: string;
  normalized_code: string;
  title: string;
  type: string;
  main_image: string;
  status: string;
};

type SkfArticleInfo = {
  key?: string;
  value?: string;
};

type SkfOeNumber = {
  manufacturer?: string;
  oenumber?: string;
};

type SkfDetailDocument = {
  product_id?: string;
  title?: string;
  type?: string;
  sub_category?: string;
  category?: string;
  status?: string;
  main_image?: string;
  photo?: string[];
  picture?: string[];
  article_information?: SkfArticleInfo[];
  oenumbers?: SkfOeNumber[];
  replacedBy?: string[] | string;
};

type SkfVehiclesDocument = {
  manufacturer?: string;
  model?: string;
  submodel?: string;
};

type SkfFacetFilter = {
  displayName?: string;
  query?: string;
};

type SkfFacet = {
  id?: string;
  filters?: SkfFacetFilter[];
};

type SkfResolvedItem = {
  product_code: string;
  description: string;
  oem_no: string;
  vehicle: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
};

export async function syncBrandCatalogFromSkfAutomotive(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
  seedPrefixes?: string[];
}) {
  const refreshExisting = input.refreshExisting !== false;
  const concurrency = Math.max(1, input.concurrency ?? 4);
  const pageSize = Math.min(200, Math.max(24, input.pageSize ?? 96));
  const requestTimeoutMs = Math.max(5000, input.requestTimeoutMs ?? 30000);
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const target = await resolveOrCreateTargetBrand(input.supabaseUrl, headers, input.brandName);
  const supportsImageColumn = await detectCatalogImageColumn(input.supabaseUrl, headers);
  const existingRows = await fetchCatalogRows(input.supabaseUrl, headers, target);
  const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));
  const requestedSeedPrefixes = dedupeStrings((input.seedPrefixes || []).map((value) => normalizeTextValue(value)).filter(Boolean));
  const seedPrefixes = requestedSeedPrefixes.length
    ? requestedSeedPrefixes
    : existingRows.length
      ? buildSkfSeedPrefixesFromExistingRows(existingRows)
      : buildDefaultSkfSeedPrefixes();
  const discovered = await crawlSkfPrefixes(seedPrefixes, pageSize, requestTimeoutMs);
  const seedPrefixSet = new Set(seedPrefixes.map((value) => normalizeCode(value)));

  const workMap = new Map<string, { existing: CatalogRow | null; searchItem: SkfSearchItem | null }>();
  for (const row of existingRows) {
    const scoped = !seedPrefixSet.size || [...seedPrefixSet].some((prefix) => row.normalized_code.startsWith(prefix));
    if (!scoped) continue;
    if (refreshExisting || shouldProcessRow(row)) {
      workMap.set(row.normalized_code, {
        existing: row,
        searchItem: discovered.itemsByCode.get(row.normalized_code) || null,
      });
    }
  }
  for (const item of discovered.itemsByCode.values()) {
    if (existingByCode.has(item.normalized_code)) continue;
    workMap.set(item.normalized_code, {
      existing: null,
      searchItem: item,
    });
  }

  const catalogPayload: CatalogRow[] = [];
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let imageRows = 0;
  let hsRows = 0;
  let weightRows = 0;
  let discontinuedRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool([...workMap.values()], concurrency, async (item) => {
    try {
      const resolved = await resolveSkfItem(item.existing, item.searchItem, requestTimeoutMs);
      const merged = buildMergedCatalogRow(target, item.existing, resolved);
      const changed = !item.existing || hasCatalogDelta(item.existing, merged);

      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.oem_no)) oemRows += 1;
      if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
      if (normalizeTextValue(merged.image_url)) imageRows += 1;
      if (normalizeTextValue(merged.hs_code)) hsRows += 1;
      if (merged.weight_kg != null) weightRows += 1;
      if (normalizeLifecycleStatus(merged.lifecycle_status) === "discontinued") discontinuedRows += 1;

      if (!item.existing || refreshExisting || changed) {
        catalogPayload.push(merged);
      }
    } catch (error) {
      const productCode = item.searchItem?.product_code || item.existing?.product_code || "";
      errorRows.push({
        product_code: productCode,
        normalized_code: normalizeCode(productCode),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const batchSize = 200;
  const processedBatches = [];
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
            oem_no: emptyToNull(row.oem_no),
            vehicle: emptyToNull(row.vehicle),
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

  const newRowsInListing = [...discovered.itemsByCode.values()].filter((row) => !existingByCode.has(row.normalized_code)).length;
  const incompleteExistingRows = existingRows.filter((row) => shouldProcessRow(row)).length;

  return {
    targetBrandId: target.brandId,
    targetBrandName: target.name,
    organizationId: target.organizationId,
    existingRows: existingRows.length,
    listingPagesProcessed: discovered.pagesProcessed,
    listingUniqueRows: discovered.itemsByCode.size,
    newRowsInListing,
    incompleteExistingRows,
    candidateRows: workMap.size,
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
  };
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

async function fetchCatalogRows(supabaseUrl: string, headers: Record<string, string>, target: SyncBrandTarget) {
  const results: CatalogRow[] = [];
  const pageLimit = 1000;
  let offset = 0;
  while (true) {
    const rows = await fetchAll<Record<string, unknown>>(
      supabaseUrl,
      headers,
      `/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(target.brandId)}&limit=${pageLimit}&offset=${offset}`,
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
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
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

async function crawlSkfPrefixes(prefixes: string[], pageSize: number, requestTimeoutMs: number) {
  const itemsByCode = new Map<string, SkfSearchItem>();
  let pagesProcessed = 0;
  for (const prefix of prefixes) {
    let nextQuery = `q=${encodeURIComponent(prefix)}&region=eur&language=en&hits=${pageSize}`;
    let pageCount = 0;
    while (nextQuery && pageCount < 25) {
      const page = await fetchSkfPartsPage(nextQuery, requestTimeoutMs);
      const documents = Array.isArray(page?.documentList?.documents) ? page.documentList.documents : [];
      for (const entry of documents) {
        const productCode = normalizeTextValue(entry?.product_id || "");
        const normalizedCode = normalizeCode(productCode);
        if (!productCode || !normalizedCode) continue;
        itemsByCode.set(normalizedCode, {
          product_code: productCode,
          normalized_code: normalizedCode,
          title: normalizeTextValue(entry?.title || ""),
          type: normalizeTextValue(entry?.type || ""),
          main_image: normalizeTextValue(entry?.main_image || ""),
          status: normalizeTextValue(entry?.status || ""),
        });
      }
      pagesProcessed += 1;
      pageCount += 1;
      const candidateNextQuery = normalizeTextValue(page?.documentList?.pagination?.nextPage?.query || "");
      if (!candidateNextQuery || candidateNextQuery === nextQuery) break;
      nextQuery = candidateNextQuery;
    }
  }
  return {
    itemsByCode,
    pagesProcessed,
  };
}

async function fetchSkfPartsPage(query: string, requestTimeoutMs: number) {
  return await fetchJson(`${SKF_SEARCH_BASE_URL}/${SKF_PARTS_SEARCHER}?${query}`, requestTimeoutMs);
}

async function fetchSkfDetail(productCode: string, requestTimeoutMs: number): Promise<SkfDetailDocument | null> {
  const query = `productid=${encodeURIComponent(productCode)}&language=en&region=eur`;
  const payload = await fetchJson(`${SKF_SEARCH_BASE_URL}/${SKF_DETAILS_SEARCHER}?${query}`, requestTimeoutMs);
  const documents = Array.isArray(payload?.part_documents?.documents) ? payload.part_documents.documents : [];
  return (documents[0] as SkfDetailDocument | undefined) || null;
}

async function fetchSkfVehicles(productCode: string, requestTimeoutMs: number) {
  const query = `productid=${encodeURIComponent(productCode)}&language=en&region=eur`;
  return await fetchJson(`${SKF_SEARCH_BASE_URL}/${SKF_VEHICLES_SEARCHER}?${query}`, requestTimeoutMs);
}

async function resolveSkfItem(current: CatalogRow | null, searchItem: SkfSearchItem | null, requestTimeoutMs: number): Promise<SkfResolvedItem> {
  const productCode = searchItem?.product_code || current?.product_code || "";
  if (!productCode) throw new Error("SKF item has no product code");

  const [detail, vehicles] = await Promise.all([
    fetchSkfDetail(productCode, requestTimeoutMs),
    fetchSkfVehicles(productCode, requestTimeoutMs),
  ]);

  const articleInformation = Array.isArray(detail?.article_information) ? detail.article_information : [];
  const lifecycleStatus = normalizeLifecycleStatus(detail?.status || current?.lifecycle_status || "active");
  const lifecycleNote = lifecycleStatus === "discontinued" ? normalizeTextValue(detail?.status || current?.lifecycle_note || "") || null : null;

  return {
    product_code: productCode,
    description: extractSkfDescription(detail, searchItem, current),
    oem_no: extractSkfOemNumbers(detail),
    vehicle: extractSkfVehicleLabel(vehicles),
    hs_code: extractArticleInfoValue(articleInformation, [/customs tariff/i, /\bhs code\b/i, /\bcommodity code\b/i, /\btariff/i]) || "",
    origin: normalizeOriginValue(extractArticleInfoValue(articleInformation, [/country of origin/i, /^origin$/i, /made in/i]) || ""),
    weight_kg: parseWeightValue(extractArticleInfoValue(articleInformation, [/^weight$/i, /net weight/i, /gross weight/i])),
    image_url: buildSkfImageUrl(detail?.main_image || detail?.photo?.[0] || detail?.picture?.[0] || searchItem?.main_image || ""),
    lifecycle_status: lifecycleStatus,
    lifecycle_note: lifecycleNote,
  };
}

function buildMergedCatalogRow(target: SyncBrandTarget, current: CatalogRow | null, resolved: SkfResolvedItem): CatalogRow {
  const displayCode = normalizeCatalogDisplayCode(resolved.product_code, target.name);
  return {
    organization_id: target.organizationId,
    brand_id: target.brandId,
    product_code: displayCode,
    normalized_code: normalizeCode(displayCode),
    description: normalizeCatalogDescription(resolved.description || current?.description || displayCode),
    oem_no: resolved.oem_no || current?.oem_no || "",
    vehicle: resolved.vehicle || current?.vehicle || "",
    hs_code: resolved.hs_code || current?.hs_code || "",
    origin: resolved.origin || current?.origin || "",
    weight_kg: resolved.weight_kg ?? current?.weight_kg ?? null,
    image_url: resolved.image_url || current?.image_url || "",
    lifecycle_status: normalizeLifecycleStatus(resolved.lifecycle_status || current?.lifecycle_status || "active"),
    lifecycle_note: resolved.lifecycle_note || current?.lifecycle_note || null,
  };
}

function extractSkfDescription(detail: SkfDetailDocument | null, searchItem: SkfSearchItem | null, current: CatalogRow | null) {
  return (
    normalizeCatalogDescription(detail?.type || "") ||
    normalizeCatalogDescription(searchItem?.type || "") ||
    normalizeCatalogDescription(detail?.sub_category || "") ||
    normalizeCatalogDescription(current?.description || "") ||
    normalizeCatalogDescription(searchItem?.title || "") ||
    normalizeCatalogDescription(detail?.title || "")
  );
}

function extractSkfOemNumbers(detail: SkfDetailDocument | null) {
  const values = (Array.isArray(detail?.oenumbers) ? detail.oenumbers : [])
    .map((entry) => normalizeTextValue(entry?.oenumber || ""))
    .filter(Boolean);
  return sanitizeCatalogOemNumbers(values.join(", "));
}

function extractSkfVehicleLabel(vehiclesPayload: Record<string, unknown>) {
  const facets = Array.isArray(vehiclesPayload?.facets) ? (vehiclesPayload.facets as SkfFacet[]) : [];
  const manufacturerFacet = facets.find((entry) => normalizeTextValue(entry.id).toLowerCase() === "manufacturer");
  const facetManufacturers = (manufacturerFacet?.filters || [])
    .map((entry) => normalizeVehicleManufacturer(entry.displayName || ""))
    .filter(Boolean);

  const documents = Array.isArray(vehiclesPayload?.documentList?.documents)
    ? (vehiclesPayload.documentList.documents as SkfVehiclesDocument[])
    : [];
  const docManufacturers = documents
    .map((entry) => normalizeVehicleManufacturer(entry.manufacturer || ""))
    .filter(Boolean);

  return dedupeStrings([...facetManufacturers, ...docManufacturers]).join(", ");
}

function normalizeVehicleManufacturer(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  const upper = text.toUpperCase();
  const known = KNOWN_MANUFACTURER_PATTERNS.find((entry) => entry.pattern.test(upper));
  if (known) return known.label;
  return normalizeCatalogDescription(text.toLowerCase() === text ? text.replace(/^\w/, (letter) => letter.toUpperCase()) : text);
}

function extractArticleInfoValue(articleInformation: SkfArticleInfo[], patterns: RegExp[]) {
  for (const entry of articleInformation) {
    const key = normalizeTextValue(entry?.key || "");
    if (!key) continue;
    if (patterns.some((pattern) => pattern.test(key))) {
      return normalizeTextValue(entry?.value || "");
    }
  }
  return "";
}

function parseWeightValue(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return null;
  const match = text.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOriginValue(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  const upper = text.toUpperCase();
  if (upper === "SWEDEN") return "SE";
  if (upper === "GERMANY") return "DE";
  if (upper === "ITALY") return "IT";
  if (upper === "FRANCE") return "FR";
  if (upper === "SPAIN") return "ES";
  if (upper === "POLAND") return "PL";
  if (upper === "CHINA") return "CN";
  if (upper === "TURKEY") return "TR";
  if (upper === "ROMANIA") return "RO";
  if (upper === "INDIA") return "IN";
  return text.length <= 3 ? upper : text;
}

function buildSkfImageUrl(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/placeholder-image\.svg/i.test(text)) return "";
  const path = text
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${SKF_IMAGE_BASE_URL}/${path}`;
}

function hasCatalogDelta(current: CatalogRow, next: CatalogRow) {
  return (
    normalizeTextValue(current.product_code) !== normalizeTextValue(next.product_code) ||
    normalizeTextValue(current.description) !== normalizeTextValue(next.description) ||
    normalizeTextValue(current.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(current.vehicle) !== normalizeTextValue(next.vehicle) ||
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
    !normalizeTextValue(row.oem_no) ||
    !normalizeTextValue(row.vehicle) ||
    !normalizeTextValue(row.image_url) ||
    !normalizeTextValue(row.hs_code) ||
    !normalizeTextValue(row.origin) ||
    row.weight_kg == null ||
    normalizeLifecycleStatus(row.lifecycle_status) === "active"
  );
}

function buildDefaultSkfSeedPrefixes() {
  return ["VKA", "VKB", "VKC", "VKD", "VKE", "VKF", "VKG", "VKH", "VKJ", "VKL", "VKM", "VKN", "VKP", "VKR", "VKT", "VKX", "BR", "MV", "TM"];
}

function buildSkfSeedPrefixesFromExistingRows(rows: CatalogRow[]) {
  const prefixes = rows
    .map((row) => {
      const code = normalizeCode(row.product_code);
      const alphaPrefix = code.match(/^[A-Z]{2,4}/)?.[0];
      if (alphaPrefix) return alphaPrefix;
      return code.slice(0, 3);
    })
    .map((value) => normalizeTextValue(value))
    .filter((value) => value.length >= 2);
  return dedupeStrings(prefixes).slice(0, 180);
}

async function fetchJson(url: string, requestTimeoutMs: number) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed ${response.status} for ${url}`);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeoutHandle);
  }
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
