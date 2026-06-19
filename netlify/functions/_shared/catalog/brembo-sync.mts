import {
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  normalizeLifecycleStatus,
  sanitizeCatalogOemNumbers,
} from "./catalog-standardization.mts";

const BREMBO_HOME_URL = "https://www.bremboparts.com/europe/en";
const BREMBO_SEARCH_SUGGESTIONS_URL = `${BREMBO_HOME_URL}/catalogue/search/getsearchcodesuggestions`;
const BREMBO_SEARCH_CODE_URL = `${BREMBO_HOME_URL}/catalogue/search/searchcode`;
const BREMBO_PRODUCT_IMAGES_URL = `${BREMBO_HOME_URL}/catalogue/getproductimages`;
const BREMBO_PRODUCT_REFERENCES_URL = `${BREMBO_HOME_URL}/catalogue/getproductmanufacturerreferences`;
const BREMBO_PRODUCT_APPLICATION_BRANDS_URL = `${BREMBO_HOME_URL}/catalogue/getproductapplicationbrands`;
const BREMBO_PRODUCT_APPLICATIONS_URL = `${BREMBO_HOME_URL}/catalogue/getproductapplications`;
const BREMBO_DEFAULT_SUGGESTION_CAP = 20;

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

type BremboSessionContext = {
  token: string;
  cookieHeader: string;
};

type BremboSearchItem = {
  product_code: string;
  normalized_code: string;
  product_type: string;
  product_sub_type: string;
  detail_path: string;
  detail_url: string;
};

type BremboProductImage = {
  bremboCode?: string;
  imageCode?: string;
  imageUrl?: string;
  imageZoomUrl?: string;
  type?: string;
};

type BremboManufacturerReference = {
  code?: string;
  brandsName?: string;
};

type BremboApplicationBrand = {
  brandName?: string;
  brandCode?: string;
};

type BremboApplicationItem = {
  brandName?: string;
  brandCode?: string;
  modelName?: string;
  modelCode?: string;
  typeName?: string;
  typeCode?: string;
  modelYear?: string;
};

type BremboResolvedItem = {
  product_code: string;
  detail_url: string;
  description: string;
  oem_no: string;
  vehicle: string;
  image_url: string;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
};

export async function syncBrandCatalogFromBrembo(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  requestTimeoutMs?: number;
  seedPrefixes?: string[];
}) {
  const refreshExisting = input.refreshExisting !== false;
  const concurrency = Math.max(1, input.concurrency ?? 4);
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
      ? buildBremboSeedPrefixesFromExistingRows(existingRows)
      : buildDefaultBremboSeedPrefixes();
  const seedPrefixSet = new Set(seedPrefixes.map((value) => normalizeBremboPrefix(value)));
  const session = await createBremboSessionContext(requestTimeoutMs);
  const discoveredSearchMap = await crawlBremboPrefixes(session, seedPrefixes, requestTimeoutMs);

  const workMap = new Map<string, { existing: CatalogRow | null; searchItem: BremboSearchItem | null; source: "existing" | "search" }>();
  for (const row of existingRows) {
    const scoped = !seedPrefixSet.size || [...seedPrefixSet].some((prefix) => row.normalized_code.startsWith(prefix));
    if (!scoped) continue;
    if (refreshExisting || shouldProcessRow(row)) {
      workMap.set(row.normalized_code, {
        existing: row,
        searchItem: discoveredSearchMap.get(row.normalized_code) || null,
        source: "existing",
      });
    }
  }
  for (const searchItem of discoveredSearchMap.values()) {
    if (existingByCode.has(searchItem.normalized_code)) continue;
    workMap.set(searchItem.normalized_code, {
      existing: null,
      searchItem,
      source: "search",
    });
  }

  const catalogPayload: CatalogRow[] = [];
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let imageRows = 0;
  let discontinuedRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool([...workMap.values()], concurrency, async (item) => {
    try {
      const resolved = await resolveBremboItem(session, item.existing, item.searchItem, requestTimeoutMs);
      const merged = buildMergedCatalogRow(target, item.existing, resolved);
      const changed = !item.existing || hasCatalogDelta(item.existing, merged);

      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.oem_no)) oemRows += 1;
      if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
      if (normalizeTextValue(merged.image_url)) imageRows += 1;
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

  return {
    targetBrandId: target.brandId,
    targetBrandName: target.name,
    organizationId: target.organizationId,
    existingRows: existingRows.length,
    listingPagesProcessed: seedPrefixes.length,
    listingLastPage: 0,
    seedPrefixesProcessed: seedPrefixes,
    listingUniqueRows: discoveredSearchMap.size,
    newRowsInListing: [...discoveredSearchMap.keys()].filter((code) => !existingByCode.has(code)).length,
    incompleteExistingRows: existingRows.filter((row) => shouldProcessRow(row)).length,
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
    hsRows: 0,
    weightRows: 0,
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
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim()),
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

async function createBremboSessionContext(requestTimeoutMs: number): Promise<BremboSessionContext> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(BREMBO_HOME_URL, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Brembo session bootstrap failed: ${response.status}`);
    const html = await response.text();
    const token = firstMatch(html, /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i);
    const cookieHeader = extractCookieHeader(response);
    if (!token) throw new Error("Brembo session bootstrap missing RequestVerificationToken");
    if (!cookieHeader) throw new Error("Brembo session bootstrap missing cookies");
    return { token, cookieHeader };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function crawlBremboPrefixes(session: BremboSessionContext, seedPrefixes: string[], requestTimeoutMs: number) {
  const queue = [...seedPrefixes];
  const seenPrefixes = new Set<string>();
  const items = new Map<string, BremboSearchItem>();
  let processedPrefixes = 0;

  while (queue.length) {
    const prefix = normalizeTextValue(queue.shift() || "");
    if (!prefix) continue;
    const prefixKey = normalizeBremboPrefix(prefix);
    if (!prefixKey || seenPrefixes.has(prefixKey)) continue;
    seenPrefixes.add(prefixKey);
    processedPrefixes += 1;

    const suggestions = await fetchBremboSuggestions(session, prefix, requestTimeoutMs);
    for (const suggestion of suggestions) {
      items.set(suggestion.normalized_code, suggestion);
    }

    if (processedPrefixes === 1 || processedPrefixes % 25 === 0) {
      console.error(
        `[Brembo sync] prefixes=${processedPrefixes} queue=${queue.length} results=${items.size} current="${prefix}" suggestions=${suggestions.length}`,
      );
    }

    if (shouldExpandBremboPrefix(prefix, suggestions.length)) {
      for (const nextPrefix of buildBremboExpansionPrefixes(prefix)) {
        const nextKey = normalizeBremboPrefix(nextPrefix);
        if (nextKey && !seenPrefixes.has(nextKey)) queue.push(nextPrefix);
      }
    }
  }

  return items;
}

async function fetchBremboSuggestions(session: BremboSessionContext, prefix: string, requestTimeoutMs: number) {
  const data = await postBremboJson<any[]>(
    session,
    BREMBO_SEARCH_SUGGESTIONS_URL,
    { codePrefix: prefix },
    BREMBO_HOME_URL,
    requestTimeoutMs,
  );
  return dedupeBy(
    (Array.isArray(data) ? data : [])
      .map((row) => ({
        product_code: normalizeCatalogDisplayCode(String(row?.bremboCode || row?.code || "").trim()),
        normalized_code: normalizeCode(row?.bremboCode || row?.code || ""),
        product_type: normalizeTextValue(row?.productType || ""),
        product_sub_type: normalizeTextValue(row?.productSubType || ""),
        detail_path: normalizeTextValue(row?.url || ""),
        detail_url: asAbsoluteBremboUrl(row?.url || ""),
      }))
      .filter((row) => row.product_code && row.normalized_code && row.detail_url),
    (row) => row.normalized_code,
  );
}

async function resolveBremboItem(
  session: BremboSessionContext,
  current: CatalogRow | null,
  searchItem: BremboSearchItem | null,
  requestTimeoutMs: number,
): Promise<BremboResolvedItem> {
  const currentCode = normalizeCatalogDisplayCode(current?.product_code || "");
  let resolvedSearchItem = searchItem;
  if (!resolvedSearchItem) {
    const searchResult = await postBremboJson<{ url?: string }>(
      session,
      BREMBO_SEARCH_CODE_URL,
      { code: currentCode },
      BREMBO_HOME_URL,
      requestTimeoutMs,
    );
    const detailPath = normalizeTextValue(searchResult?.url || "");
    if (!detailPath) throw new Error(`No official Brembo detail URL found for ${currentCode}`);
    resolvedSearchItem = {
      product_code: currentCode,
      normalized_code: normalizeCode(currentCode),
      product_type: "",
      product_sub_type: "",
      detail_path: detailPath,
      detail_url: asAbsoluteBremboUrl(detailPath),
    };
  }

  const detailHtml = await fetchText(resolvedSearchItem.detail_url, requestTimeoutMs);
  const [images, references, applicationBrands, applicationPreview] = await Promise.all([
    fetchBremboProductImages(session, resolvedSearchItem.product_code, resolvedSearchItem.detail_url, requestTimeoutMs).catch(() => []),
    fetchBremboManufacturerReferences(session, resolvedSearchItem.product_code, resolvedSearchItem.detail_url, requestTimeoutMs).catch(() => []),
    fetchBremboApplicationBrands(session, resolvedSearchItem.product_code, resolvedSearchItem.detail_url, requestTimeoutMs).catch(() => []),
    fetchBremboApplicationPreview(session, resolvedSearchItem.product_code, resolvedSearchItem.detail_url, requestTimeoutMs).catch(() => []),
  ]);

  const description = extractBremboDescription(detailHtml, resolvedSearchItem.product_code, resolvedSearchItem.product_type, resolvedSearchItem.product_sub_type);
  const imageUrl =
    extractBremboImageUrl(images) ||
    extractBremboImageUrlFromHtml(detailHtml) ||
    "";
  const oemNo = sanitizeCatalogOemNumbers(references.map((entry) => normalizeTextValue(entry.code || "")).filter(Boolean).join(", "));
  const vehicle = extractBremboVehicleLabel(applicationBrands, applicationPreview);
  const lifecycleSignal = extractBremboLifecycleSignal(detailHtml);

  return {
    product_code: resolvedSearchItem.product_code,
    detail_url: resolvedSearchItem.detail_url,
    description,
    oem_no: oemNo,
    vehicle,
    image_url: imageUrl,
    lifecycle_status: normalizeLifecycleStatus(lifecycleSignal),
    lifecycle_note: lifecycleSignal || null,
  };
}

async function fetchBremboProductImages(session: BremboSessionContext, bremboCode: string, referrerUrl: string, requestTimeoutMs: number) {
  const data = await postBremboJson<BremboProductImage[]>(
    session,
    BREMBO_PRODUCT_IMAGES_URL,
    { bremboCodes: bremboCode },
    referrerUrl,
    requestTimeoutMs,
  );
  return Array.isArray(data) ? data : [];
}

async function fetchBremboManufacturerReferences(
  session: BremboSessionContext,
  bremboCode: string,
  referrerUrl: string,
  requestTimeoutMs: number,
) {
  const data = await postBremboJson<BremboManufacturerReference[]>(
    session,
    BREMBO_PRODUCT_REFERENCES_URL,
    { bremboCode },
    referrerUrl,
    requestTimeoutMs,
  );
  return Array.isArray(data) ? data : [];
}

async function fetchBremboApplicationBrands(
  session: BremboSessionContext,
  bremboCode: string,
  referrerUrl: string,
  requestTimeoutMs: number,
) {
  const data = await postBremboJson<BremboApplicationBrand[]>(
    session,
    BREMBO_PRODUCT_APPLICATION_BRANDS_URL,
    { bremboCode },
    referrerUrl,
    requestTimeoutMs,
  );
  return Array.isArray(data) ? data : [];
}

async function fetchBremboApplicationPreview(
  session: BremboSessionContext,
  bremboCode: string,
  referrerUrl: string,
  requestTimeoutMs: number,
) {
  const brands = await fetchBremboApplicationBrands(session, bremboCode, referrerUrl, requestTimeoutMs);
  if (!brands.length) return [];
  const primaryBrand = brands.find((entry) => normalizeTextValue(entry.brandCode)) || null;
  if (!primaryBrand?.brandCode) return [];
  const data = await postBremboJson<{ applicationItems?: BremboApplicationItem[] }>(
    session,
    BREMBO_PRODUCT_APPLICATIONS_URL,
    {
      bremboCode,
      brandCode: primaryBrand.brandCode,
      page: 1,
    },
    referrerUrl,
    requestTimeoutMs,
  );
  return Array.isArray(data?.applicationItems) ? data.applicationItems : [];
}

async function postBremboJson<T>(
  session: BremboSessionContext,
  url: string,
  payload: Record<string, unknown>,
  referrerUrl: string,
  requestTimeoutMs: number,
  allowRetry = true,
): Promise<T> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...requestHeaders,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        RequestVerificationToken: session.token,
        Cookie: session.cookieHeader,
        Referer: referrerUrl,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      if (allowRetry && response.status === 404) {
        const nextSession = await createBremboSessionContext(requestTimeoutMs);
        session.token = nextSession.token;
        session.cookieHeader = nextSession.cookieHeader;
        return postBremboJson<T>(session, url, payload, referrerUrl, requestTimeoutMs, false);
      }
      throw new Error(`Brembo request failed ${response.status} for ${url}`);
    }
    return text ? (JSON.parse(text) as T) : ([] as unknown as T);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildMergedCatalogRow(target: SyncBrandTarget, current: CatalogRow | null, resolved: BremboResolvedItem): CatalogRow {
  const displayCode = normalizeCatalogDisplayCode(resolved.product_code);
  const nextLifecycleStatus = normalizeLifecycleStatus(resolved.lifecycle_status || current?.lifecycle_status || "active");
  const nextLifecycleNote = normalizeTextValue(resolved.lifecycle_note || current?.lifecycle_note || "") || null;
  return {
    organization_id: target.organizationId,
    brand_id: target.brandId,
    product_code: displayCode,
    normalized_code: normalizeCode(displayCode),
    description: normalizeCatalogDescription(resolved.description || current?.description || ""),
    oem_no: resolved.oem_no || current?.oem_no || "",
    vehicle: resolved.vehicle || current?.vehicle || "",
    hs_code: current?.hs_code || "",
    origin: current?.origin || "",
    weight_kg: current?.weight_kg ?? null,
    image_url: resolved.image_url || current?.image_url || "",
    lifecycle_status: nextLifecycleStatus,
    lifecycle_note: nextLifecycleNote,
  };
}

function extractBremboDescription(detailHtml: string, productCode: string, productType: string, productSubType: string) {
  const heading = decodeHtml(stripTags(firstMatch(detailHtml, /<h1[^>]*class="main-title"[^>]*>([\s\S]*?)<\/h1>/i))).replace(/\s+/g, " ").trim();
  if (heading) {
    const withoutCode = heading.replace(new RegExp(escapeRegExp(productCode), "ig"), "").replace(/\s+/g, " ").trim();
    if (withoutCode) return normalizeCatalogDescription(withoutCode);
  }

  const title = decodeHtml(firstMatch(detailHtml, /<title>([^<]+)<\/title>/i)).replace(/\s+/g, " ").trim();
  if (title) {
    const normalizedTitle = title
      .replace(/^Brembo\s+/i, "")
      .replace(new RegExp(escapeRegExp(productCode), "ig"), "")
      .replace(/\s+/g, " ")
      .trim();
    if (normalizedTitle) return normalizeCatalogDescription(normalizedTitle);
  }

  return normalizeCatalogDescription([productType, productSubType].filter(Boolean).join(" ").trim() || productCode);
}

function extractBremboImageUrl(images: BremboProductImage[]) {
  const preferred =
    images.find((entry) => normalizeTextValue(entry.type).toUpperCase() === "PRODUCT_1") ||
    images.find((entry) => normalizeTextValue(entry.type).toUpperCase().startsWith("PRODUCT_")) ||
    images[0] ||
    null;
  if (!preferred) return "";
  return asAbsoluteBremboUrl(preferred.imageZoomUrl || preferred.imageUrl || "");
}

function extractBremboImageUrlFromHtml(detailHtml: string) {
  const firstProductImage =
    firstMatch(detailHtml, /<img[^>]+src="([^"]*\/media\/product\/images\/1920-1920-[^"]+)"/i) ||
    firstMatch(detailHtml, /<img[^>]+src="([^"]*\/media\/product\/images\/365-243-[^"]+)"/i) ||
    "";
  return asAbsoluteBremboUrl(firstProductImage);
}

function extractBremboVehicleLabel(brands: BremboApplicationBrand[], applications: BremboApplicationItem[]) {
  const rawValues = [
    ...brands.map((entry) => normalizeTextValue(entry.brandName || "")),
    ...applications.map((entry) => normalizeTextValue(entry.brandName || "")),
  ].filter(Boolean);
  if (!rawValues.length) return "";
  const normalized = rawValues
    .map((value) => {
      const upper = value.toUpperCase();
      const known = KNOWN_MANUFACTURER_PATTERNS.find((entry) => entry.pattern.test(upper));
      return known?.label || normalizeCatalogDescription(value.toLowerCase() === value ? value.replace(/^\w/, (letter) => letter.toUpperCase()) : value);
    })
    .filter(Boolean);
  return dedupeStrings(normalized).join(", ");
}

function extractBremboLifecycleSignal(detailHtml: string) {
  const text = decodeHtml(stripTags(detailHtml)).replace(/\s+/g, " ").trim();
  const match = text.match(
    /(no longer available|no longer deliverable|not in production|production ended|production end|production stopped|superseded|superceded|obsolete|discontinued|replacement only)/i,
  );
  return normalizeTextValue(match?.[0] || "");
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
    normalizeLifecycleStatus(row.lifecycle_status) === "active"
  );
}

function buildDefaultBremboSeedPrefixes() {
  return [
    "08.",
    "09.",
    "14.",
    "A 00",
    "M 00",
    "P 00",
    "S 00",
    "T 00",
    "X 00",
  ];
}

function buildBremboSeedPrefixesFromExistingRows(rows: CatalogRow[]) {
  const prefixes = rows
    .map((row) => {
      const displayCode = normalizeCatalogDisplayCode(row.product_code);
      const numericMatch = displayCode.match(/^([0-9]{2}\.[A-Z0-9]?)/);
      if (numericMatch?.[1]) return numericMatch[1];
      const alphaMatch = displayCode.match(/^([A-Z])\s*([0-9]{2})/);
      if (alphaMatch) return `${alphaMatch[1]} ${alphaMatch[2]}`;
      return displayCode.slice(0, 3);
    })
    .map((value) => normalizeTextValue(value))
    .filter((value) => value.length >= 3);
  return dedupeStrings(prefixes).slice(0, 240);
}

function buildBremboExpansionPrefixes(prefix: string) {
  if (/^\d{2}\.$/.test(prefix)) {
    return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${prefix}${letter}`);
  }
  if (/^[A-Z]\s\d{2}$/.test(prefix)) {
    return Array.from({ length: 10 }, (_unused, index) => `${prefix} ${index}`);
  }
  return Array.from({ length: 10 }, (_unused, index) => `${prefix}${index}`);
}

function shouldExpandBremboPrefix(prefix: string, suggestionCount: number) {
  const normalized = normalizeBremboPrefix(prefix);
  if (normalized.length >= 7) return false;
  if (suggestionCount >= BREMBO_DEFAULT_SUGGESTION_CAP) return true;
  if (suggestionCount === 0 && (/^\d{2}\.$/.test(prefix) || /^[A-Z]\s\d$/.test(prefix))) return true;
  return false;
}

function normalizeBremboPrefix(value: string) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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

async function fetchText(url: string, requestTimeoutMs: number) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed ${response.status} for ${url}`);
    return await response.text();
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

function extractCookieHeader(response: Response) {
  const headerBag = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = typeof headerBag.getSetCookie === "function" ? headerBag.getSetCookie() : [];
  const fallbackCookie = response.headers.get("set-cookie");
  const cookies = (rawCookies.length ? rawCookies : fallbackCookie ? [fallbackCookie] : [])
    .map((value) => String(value || "").split(";")[0].trim())
    .filter(Boolean);
  return cookies.join("; ");
}

function asAbsoluteBremboUrl(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `https://www.bremboparts.com${text.startsWith("/") ? text : `/${text}`}`;
}

function firstMatch(value: string, pattern: RegExp) {
  const match = value.match(pattern);
  return match?.[1] || "";
}

function stripTags(value: string) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&ccedil;/gi, "ç")
    .replace(/&Ccedil;/g, "Ç")
    .replace(/&atilde;/gi, "ã")
    .replace(/&Atilde;/g, "Ã")
    .replace(/&aacute;/gi, "á")
    .replace(/&Aacute;/g, "Á")
    .replace(/&eacute;/gi, "é")
    .replace(/&Eacute;/g, "É")
    .replace(/&ecirc;/gi, "ê")
    .replace(/&Ecirc;/g, "Ê")
    .replace(/&iacute;/gi, "í")
    .replace(/&Iacute;/g, "Í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&Oacute;/g, "Ó")
    .replace(/&ocirc;/gi, "ô")
    .replace(/&Ocirc;/g, "Ô")
    .replace(/&uacute;/gi, "ú")
    .replace(/&Uacute;/g, "Ú")
    .replace(/&ordm;/gi, "º")
    .replace(/&ndash;/gi, "-")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function escapeRegExp(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
