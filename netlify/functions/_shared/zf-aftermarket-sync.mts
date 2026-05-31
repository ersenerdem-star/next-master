import { normalizeCatalogDisplayCode, normalizeLifecycleStatus, sanitizeCatalogOemNumbers } from "./catalog-standardization.mts";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,tr;q=0.6",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const ORIGIN_CODES: Record<string, string> = {
  ARGENTINA: "AR",
  AUSTRALIA: "AU",
  AUSTRIA: "AT",
  BELGIUM: "BE",
  BOSNIAANDHERZEGOVINA: "BA",
  BRAZIL: "BR",
  BULGARIA: "BG",
  CANADA: "CA",
  CHINA: "CN",
  CROATIA: "HR",
  CZECHIA: "CZ",
  CZECHREPUBLIC: "CZ",
  DENMARK: "DK",
  EGYPT: "EG",
  ESTONIA: "EE",
  FINLAND: "FI",
  FRANCE: "FR",
  GERMANY: "DE",
  GREECE: "GR",
  HUNGARY: "HU",
  INDIA: "IN",
  INDONESIA: "ID",
  IRELAND: "IE",
  ISRAEL: "IL",
  ITALY: "IT",
  JAPAN: "JP",
  KOREA: "KR",
  LATVIA: "LV",
  LITHUANIA: "LT",
  LUXEMBOURG: "LU",
  MALAYSIA: "MY",
  MEXICO: "MX",
  NETHERLANDS: "NL",
  NORWAY: "NO",
  POLAND: "PL",
  PORTUGAL: "PT",
  ROMANIA: "RO",
  SERBIA: "RS",
  SINGAPORE: "SG",
  SLOVAKIA: "SK",
  SLOVENIA: "SI",
  SOUTHAFRICA: "ZA",
  SOUTHKOREA: "KR",
  SPAIN: "ES",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
  TAIWAN: "TW",
  THAILAND: "TH",
  TURKEY: "TR",
  UNITEDKINGDOM: "GB",
  UNITEDSTATES: "US",
  USA: "US",
  VIETNAM: "VN",
};

const KNOWN_MANUFACTURER_PATTERNS = [
  { label: "Mercedes-Benz", pattern: /\bMERCEDES(?:-BENZ)?\b/ },
  { label: "Volkswagen", pattern: /\b(?:VW|VOLKSWAGEN)\b/ },
  { label: "Audi", pattern: /\bAUDI\b/ },
  { label: "MAN", pattern: /\bMAN\b/ },
  { label: "Volvo", pattern: /\bVOLVO\b/ },
  { label: "DAF", pattern: /\bDAF\b/ },
  { label: "Scania", pattern: /\bSCANIA\b/ },
  { label: "Iveco", pattern: /\bIVECO\b/ },
  { label: "Renault", pattern: /\bRENAULT\b/ },
  { label: "Ford", pattern: /\bFORD\b/ },
  { label: "BMW", pattern: /\bBMW\b/ },
  { label: "Opel", pattern: /\bOPEL\b/ },
  { label: "Skoda", pattern: /\bSKODA\b/ },
  { label: "Nissan", pattern: /\bNISSAN\b/ },
  { label: "Chevrolet", pattern: /\bCHEVROLET\b/ },
  { label: "Vauxhall", pattern: /\bVAUXHALL\b/ },
  { label: "Cupra", pattern: /\bCUPRA\b/ },
  { label: "Ashok Leyland", pattern: /\bASHOK\s+LEYLAND\b/ },
  { label: "Land Rover", pattern: /\bLAND\s+ROVER\b/ },
  { label: "Toyota", pattern: /\bTOYOTA\b/ },
  { label: "Peugeot", pattern: /\bPEUGEOT\b/ },
  { label: "Citroen", pattern: /\bCITROE?N\b/ },
  { label: "Fiat", pattern: /\bFIAT\b/ },
];

const BRAND_CONFIGS = [
  {
    key: "zf",
    internalName: "ZF",
    officialFilter: "ZF",
    aliases: ["ZF"],
    emptyStateQueries: ["damper", "absorber", "gearbox", "valve", "filter", "pump", "module", "fork"],
  },
  {
    key: "lemforder",
    internalName: "Lemforder",
    officialFilter: "LEMFÖRDER",
    aliases: ["Lemforder", "Lemförder"],
    emptyStateQueries: ["LEMFORDER"],
  },
  { key: "sachs", internalName: "Sachs", officialFilter: "SACHS", aliases: ["Sachs"], emptyStateQueries: ["SACHS"] },
  { key: "trw", internalName: "TRW", officialFilter: "TRW", aliases: ["TRW"], emptyStateQueries: ["TRW"] },
  { key: "wabco", internalName: "Wabco", officialFilter: "WABCO", aliases: ["Wabco", "WABCO"], emptyStateQueries: ["WABCO"] },
  { key: "boge", internalName: "Boge", officialFilter: "BOGE", aliases: ["Boge", "BOGE"], emptyStateQueries: ["BOGE"] },
] as const;

export async function syncBrandCatalogFromZfAftermarket(input: {
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
  const detailConcurrency = Math.max(1, input.concurrency ?? 6);
  const searchPageSize = Math.max(20, input.pageSize ?? 250);
  const requestTimeoutMs = Math.max(5000, input.requestTimeoutMs ?? 30000);
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const target = await resolveTarget(input.supabaseUrl, headers, input.brandName);
  const supportsImageColumn = await detectCatalogImageColumn(input.supabaseUrl, headers);
  const existingRows = await fetchCatalogRows(input.supabaseUrl, headers, target);
  const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));
  const discoveryQueries = buildDiscoveryQueries(target, existingRows, input.seedPrefixes);
  const discoveredSearchMap = await crawlOfficialQueries({
    target,
    queries: discoveryQueries,
    searchPageSize,
    requestTimeoutMs,
  });

  const workMap = new Map<string, any>();
  for (const row of existingRows) {
    if (refreshExisting || shouldProcessRow(row)) {
      workMap.set(row.normalized_code, {
        target,
        existing: row,
        searchItem: discoveredSearchMap.get(row.normalized_code) || null,
        source: "existing",
      });
    }
  }
  for (const [normalizedCode, searchItem] of discoveredSearchMap.entries()) {
    if (existingByCode.has(normalizedCode)) continue;
    workMap.set(normalizedCode, {
      target,
      existing: null,
      searchItem,
      source: "search",
    });
  }

  const workItems = Array.from(workMap.values());
  const processedCodes = new Set(workItems.map((item) => item.searchItem?.normalized_code || item.existing?.normalized_code).filter(Boolean));
  const extraCodes = new Set<string>();
  const catalogPayload: Array<Record<string, unknown>> = [];
  const replacementPayload: Array<Record<string, unknown>> = [];
  const seenReplacementKeys = new Set<string>();
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let imageRows = 0;
  let weightRows = 0;
  let discontinuedRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool(workItems, detailConcurrency, async (item) => {
    try {
      const detail = await resolveOfficialDetail(target, item.searchItem?.product_code || item.existing?.product_code || "", searchPageSize, requestTimeoutMs);
      const merged = mergeCatalogRow({
        target,
        existing: item.existing,
        searchItem: item.searchItem,
        detail,
      });
      const changed = !item.existing || hasCatalogDelta(item.existing, merged);
      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.oem_no)) oemRows += 1;
      if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
      if (normalizeTextValue(merged.image_url)) imageRows += 1;
      if (merged.weight_kg != null && !Number.isNaN(Number(merged.weight_kg))) weightRows += 1;
      if (normalizeLifecycleStatus(merged.lifecycle_status) === "discontinued") discontinuedRows += 1;
      if (refreshExisting || changed || item.source === "search") {
        catalogPayload.push(merged);
      }

      if (detail.replacement_code) {
        const replacement = {
          organization_id: item.target.organization_id,
          brand_id: item.target.brand_id,
          old_code: normalizeCatalogDisplayCode(merged.product_code, item.target.internalName),
          new_code: normalizeCatalogDisplayCode(detail.replacement_code, item.target.internalName),
          original_number: null,
          reason: detail.replacement_reason || "Replacement from ZF Aftermarket official source.",
          is_active: true,
        };
        const replacementKey = `${replacement.organization_id}::${replacement.brand_id}::${normalizeCode(replacement.old_code)}::${normalizeCode(replacement.new_code)}`;
        if (!seenReplacementKeys.has(replacementKey)) {
          seenReplacementKeys.add(replacementKey);
          replacementPayload.push(replacement);
        }
      }

      for (const relatedCode of detail.related_codes) {
        const normalizedRelated = normalizeCode(relatedCode);
        if (!normalizedRelated || processedCodes.has(normalizedRelated)) continue;
        processedCodes.add(normalizedRelated);
        extraCodes.add(relatedCode);
      }
    } catch (error) {
      errorRows.push({
        product_code: item.searchItem?.product_code || item.existing?.product_code || "",
        normalized_code: item.searchItem?.normalized_code || item.existing?.normalized_code || "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const extraSearchItems = await resolveExtraCodes({
    target,
    extraCodes,
    existingByCode,
    processedCodes,
    searchPageSize,
    requestTimeoutMs,
  });

  if (extraSearchItems.length) {
    await runPool(extraSearchItems, detailConcurrency, async (item) => {
      try {
        const detail = await resolveOfficialDetail(target, item.searchItem.product_code, searchPageSize, requestTimeoutMs);
        const merged = mergeCatalogRow({
          target,
          existing: null,
          searchItem: item.searchItem,
          detail,
        });

        matchedRows += 1;
        changedRows += 1;
        if (normalizeTextValue(merged.oem_no)) oemRows += 1;
        if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
        if (normalizeTextValue(merged.image_url)) imageRows += 1;
        if (merged.weight_kg != null && !Number.isNaN(Number(merged.weight_kg))) weightRows += 1;
        if (normalizeLifecycleStatus(merged.lifecycle_status) === "discontinued") discontinuedRows += 1;
        catalogPayload.push(merged);

        if (detail.replacement_code) {
          const replacement = {
            organization_id: item.target.organization_id,
            brand_id: item.target.brand_id,
            old_code: normalizeCatalogDisplayCode(merged.product_code, item.target.internalName),
            new_code: normalizeCatalogDisplayCode(detail.replacement_code, item.target.internalName),
            original_number: null,
            reason: detail.replacement_reason || "Replacement from ZF Aftermarket official source.",
            is_active: true,
          };
          const replacementKey = `${replacement.organization_id}::${replacement.brand_id}::${normalizeCode(replacement.old_code)}::${normalizeCode(replacement.new_code)}`;
          if (!seenReplacementKeys.has(replacementKey)) {
            seenReplacementKeys.add(replacementKey);
            replacementPayload.push(replacement);
          }
        }
      } catch (error) {
        errorRows.push({
          product_code: item.searchItem.product_code,
          normalized_code: item.searchItem.normalized_code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  const batchSize = 250;
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

  const replacementDeduped = dedupeBy(replacementPayload, (row) => `${String(row.brand_id)}::${normalizeCode(String(row.old_code || ""))}`);
  const processedReplacementBatches = [];
  if (replacementDeduped.length) {
    for (let index = 0; index < replacementDeduped.length; index += batchSize) {
      const batch = replacementDeduped.slice(index, index + batchSize);
      const response = await fetch(`${input.supabaseUrl}/rest/v1/item_code_references?on_conflict=organization_id,brand_id,normalized_old_code`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(
          batch.map((row) => ({
            organization_id: row.organization_id,
            brand_id: row.brand_id,
            old_code: row.old_code,
            new_code: row.new_code,
            original_number: row.original_number,
            reason: row.reason,
            is_active: row.is_active,
            updated_at: new Date().toISOString(),
          })),
        ),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`item_code_references upsert failed: ${response.status} ${text}`);
      }
      processedReplacementBatches.push({ type: "code_reference", batch: index / batchSize + 1, rows: batch.length, status: response.status });
    }
  }

  return {
    targetBrandId: target.brand_id,
    targetBrandName: target.brand_name,
    organizationId: target.organization_id,
    existingRows: existingRows.length,
    listingPagesProcessed: discoveryQueries.length,
    listingLastPage: 0,
    listingUniqueRows: discoveredSearchMap.size,
    newRowsInListing: [...discoveredSearchMap.keys()].filter((code) => !existingByCode.has(code)).length,
    incompleteExistingRows: existingRows.filter((row) => shouldProcessRow(row)).length,
    candidateRows: workItems.length + extraSearchItems.length,
    resolvedRows: matchedRows,
    errorRows: errorRows.length,
    discontinuedRows,
    replacementRows: replacementDeduped.length,
    replacementFetchRows: extraSearchItems.length,
    supportsImageColumn,
    processedBatches,
    processedReplacementBatches,
    oemRows,
    vehicleRows,
    imageRows,
    hsRows: 0,
    weightRows,
  };
}

async function resolveTarget(supabaseUrl: string, headers: Record<string, string>, brandInput: string) {
  const requested = normalizeBrandKey(brandInput);
  const config =
    BRAND_CONFIGS.find((item) => [item.key, ...item.aliases.map((alias) => normalizeBrandKey(alias))].includes(requested)) || null;
  if (!config) throw new Error(`No ZF Aftermarket provider mapping found for ${brandInput}`);

  const brands = await fetchAll(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&order=name.asc`, headers);
  const rows = Array.isArray(brands) ? brands : [];
  const defaultOrganizationId = String(rows.find((row) => String(row.organization_id || "").trim())?.organization_id || "").trim();
  let brand = rows.find((row) => {
    const name = normalizeBrandKey(row.name || "");
    return [config.key, ...config.aliases.map((alias) => normalizeBrandKey(alias))].includes(name);
  });
  if ((!brand?.id || !brand?.organization_id) && defaultOrganizationId) {
    brand = await createBrandRow(supabaseUrl, headers, defaultOrganizationId, config.internalName);
  }
  if (!brand?.id || !brand?.organization_id) {
    throw new Error(`Target brand not found for ${config.internalName}`);
  }
  return {
    ...config,
    brand_id: String(brand.id).trim(),
    organization_id: String(brand.organization_id).trim(),
    brand_name: String(brand.name || config.internalName).trim() || config.internalName,
  };
}

async function fetchCatalogRows(supabaseUrl: string, headers: Record<string, string>, target: any) {
  const results = [];
  const pageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(target.brand_id)}&limit=${pageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!response.ok) throw new Error(`catalog_products fetch failed for ${target.internalName}: ${response.status} ${text}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || target.organization_id).trim(),
          brand_id: String(row.brand_id || target.brand_id).trim(),
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), target.internalName),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
          description: String(row.description || "").trim(),
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
          hs_code: String(row.hs_code || "").trim(),
          origin: String(row.origin || "").trim(),
          weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
          image_url: String(row.image_url || "").trim(),
          lifecycle_status: normalizeLifecycleStatus(row.lifecycle_status),
          lifecycle_note: String(row.lifecycle_note || "").trim(),
        }))
        .filter((row) => row.product_code && row.normalized_code),
    );
    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

function buildDiscoveryQueries(target: any, rows: any[], overrides: string[] | undefined) {
  const explicit = dedupeStrings(
    (Array.isArray(overrides) ? overrides : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (explicit.length) return explicit;

  const derived = dedupeStrings(
    rows
      .map((row) => row.normalized_code)
      .filter((value) => String(value || "").length >= 4)
      .map((value) => String(value).slice(0, 4)),
  );
  if (derived.length) return derived;
  return dedupeStrings((target.emptyStateQueries || []).map((value: string) => String(value || "").trim()).filter(Boolean));
}

async function crawlOfficialQueries({
  target,
  queries,
  searchPageSize,
  requestTimeoutMs,
}: {
  target: any;
  queries: string[];
  searchPageSize: number;
  requestTimeoutMs: number;
}) {
  const results = new Map<string, any>();
  await runPool(queries, 2, async (query) => {
    try {
      const items = await fetchAllSearchItems(target, query, searchPageSize, requestTimeoutMs);
      for (const item of items) {
        if (!item.normalized_code || results.has(item.normalized_code)) continue;
        results.set(item.normalized_code, item);
      }
    } catch {
      return;
    }
  });
  return results;
}

async function fetchAllSearchItems(target: any, term: string, searchPageSize: number, requestTimeoutMs: number) {
  const firstPage = await fetchSearchPage(target, term, 0, searchPageSize, requestTimeoutMs);
  const items = [...firstPage.items];
  const totalItems = Number(firstPage.totalItems || items.length) || items.length;
  for (let offset = firstPage.items.length; offset < totalItems; offset += searchPageSize) {
    const page = await fetchSearchPage(target, term, offset, searchPageSize, requestTimeoutMs);
    items.push(...page.items);
    if (!page.items.length) break;
  }
  return dedupeBy(items, (item) => item.normalized_code);
}

async function fetchSearchPage(target: any, term: string, offset: number, searchPageSize: number, requestTimeoutMs: number) {
  const url = new URL("https://aftermarket.zf.com/api/search");
  url.searchParams.set("term", term);
  url.searchParams.set("country", "TR");
  url.searchParams.set("expand", "extended,special");
  url.searchParams.set("ipp", String(searchPageSize));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("filters", `brandname=${target.officialFilter}`);
  url.searchParams.set("language", "en");

  const payload = await fetchJson(url.toString(), requestTimeoutMs);
  const productPayload = payload?.products;
  if (!productPayload) throw new Error(`ZF search payload missing for ${target.internalName} term ${term}`);
  const items = (productPayload.items || []).map((item: any) => normalizeSearchItem(target, item)).filter((item: any) => item.normalized_code);
  return {
    totalItems: Number(productPayload.pagination?.totalItems || items.length) || items.length,
    items,
  };
}

function normalizeSearchItem(target: any, item: any) {
  const productCode = normalizeCatalogDisplayCode(cleanText(item.productNumber || item.number || "").replace(/\+/g, " "), target.internalName);
  const normalizedCode = normalizeCode(productCode);
  const imageUrl = String(item.productImage?.images?.[0]?.src || "").trim();
  return {
    brand_name: target.internalName,
    product_code: productCode,
    normalized_code: normalizedCode,
    description: formatOfficialDescription(target, item.name || ""),
    source_url: String(item.moreDetails?.href || item.productDetailsPageHref || "").trim()
      ? `https://aftermarket.zf.com${String(item.moreDetails?.href || item.productDetailsPageHref || "").trim()}`
      : "",
    image_url: imageUrl,
    lifecycle_status: normalizeLifecycleStatus(item.status?.value || item.status?.key),
    lifecycle_note: buildLifecycleNoteFromStatus(item.status, null),
  };
}

async function resolveOfficialDetail(target: any, productCode: string, searchPageSize: number, requestTimeoutMs: number) {
  const candidates = dedupeStrings(buildArticleCandidates(target, productCode));
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const detailPayload = await fetchArticle(target, candidate, requestTimeoutMs);
      if (detailPayload?.details?.number) return normalizeDetailPayload(target, detailPayload);
    } catch (error) {
      lastError = error;
    }
  }

  const exactSearch = await fetchSearchPage(target, normalizeCode(productCode), 0, searchPageSize, requestTimeoutMs);
  const exactItem = exactSearch.items.find((item: any) => item.normalized_code === normalizeCode(productCode)) || exactSearch.items[0] || null;
  if (exactItem?.product_code) {
    for (const candidate of buildArticleCandidates(target, exactItem.product_code)) {
      try {
        const detailPayload = await fetchArticle(target, candidate, requestTimeoutMs);
        if (detailPayload?.details?.number) return normalizeDetailPayload(target, detailPayload);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error(`Official ZF article not found for ${productCode}`);
}

function buildArticleCandidates(target: any, productCode: string) {
  const raw = normalizeCatalogDisplayCode(cleanText(productCode).replace(/\+/g, " "), target.internalName);
  const compact = normalizeCode(productCode);
  const candidates = [raw, compact];
  if (compact && compact !== raw) candidates.push(normalizeCatalogDisplayCode(compact, target.internalName));
  return candidates.filter(Boolean);
}

async function fetchArticle(target: any, articleCode: string, requestTimeoutMs: number) {
  const url = new URL(`https://aftermarket.zf.com/api/articles/${encodeURIComponent(articleCode)}`);
  url.searchParams.set("expand", "specifications,extended");
  url.searchParams.set("country", "TR");
  url.searchParams.set("language", "en");
  return fetchJson(url.toString(), requestTimeoutMs, { accept404: true });
}

function normalizeDetailPayload(target: any, payload: any) {
  const details = payload?.details || {};
  const specifications = payload?.specifications?.content || {};
  const generalSpecifications = Array.isArray(specifications.generalSpecifications?.specifications)
    ? specifications.generalSpecifications.specifications
    : [];
  const referenceNumbers = Array.isArray(specifications.referenceNumbers?.referenceNumbers)
    ? specifications.referenceNumbers.referenceNumbers
    : [];
  const textModules = Array.isArray(details.textModules?.values) ? details.textModules.values : [];
  const detailNumber = normalizeCatalogDisplayCode(cleanText(details.number || ""), target.internalName);
  const oemNumbers = [];
  for (const referenceGroup of referenceNumbers) {
    const label = cleanText(referenceGroup.label || "");
    for (const value of referenceGroup.values || []) {
      const number = cleanText(value.text || value || "");
      if (!number) continue;
      oemNumbers.push(label ? `${label} ${number}` : number);
    }
  }

  const imageUrl = chooseBestImage(details.images || []);
  const specEntries = [];
  const specText = [];
  for (const spec of generalSpecifications) {
    const label = cleanText(spec.label || "");
    const values = Array.isArray(spec.values) ? spec.values.map((value: any) => cleanText(value.text || value)).filter(Boolean) : [];
    if (!values.length) continue;
    specEntries.push({ label, values });
    specText.push(`${label}: ${values.join(", ")}`);
  }
  const vehicle = dedupeStrings([
    ...extractVehicleTokens([...textModules, ...specText].join(" | ")),
    ...extractVehicleTokens(referenceNumbers.map((group) => cleanText(group.label || "")).join(" | ")),
  ]).join(", ");
  const status = details.status || {};
  const replacedByValues = Array.isArray(details.replacedBy?.values) ? details.replacedBy.values : [];
  const replacementCodeRaw = cleanText(replacedByValues[0]?.text || "");
  const replacementCode = replacementCodeRaw ? normalizeCatalogDisplayCode(replacementCodeRaw, target.internalName) : "";
  const relatedCodes = dedupeStrings([
    ...collectRelatedCodes(specifications.partsList?.parts || []),
    ...collectRelatedCodes(specifications.inPartsList?.parts || []),
    replacementCode,
  ]);
  const hsCode = extractSpecValue(specEntries, [
    /commodity\s*code/i,
    /customs\s*tariff/i,
    /tariff\s*(?:number|code)/i,
    /customs\s*code/i,
    /g[\s-]*tip/i,
  ]);
  const origin = normalizeOriginCode(
    extractSpecValue(specEntries, [
      /country\s*of\s*origin/i,
      /origin/i,
      /mense/i,
      /ulke/i,
    ]),
  );

  return {
    product_code: detailNumber,
    description: formatOfficialDescription(target, details.name || ""),
    source_url: detailNumber ? `https://aftermarket.zf.com/tr/catalog/products/${encodeURIComponent(detailNumber)}` : "",
    oem_no: sanitizeCatalogOemNumbers(dedupeStrings(oemNumbers).join(", ")),
    vehicle,
    hs_code: hsCode,
    origin,
    weight_kg: extractWeightKg(details),
    image_url: imageUrl,
    lifecycle_status: normalizeLifecycleStatus(status.value || status.key),
    lifecycle_note: buildLifecycleNoteFromStatus(status, replacementCode),
    replacement_code: replacementCode,
    replacement_reason: replacementCode ? `Replacement code: ${replacementCode}. ZF Aftermarket official source.` : "",
    related_codes: relatedCodes,
  };
}

function collectRelatedCodes(parts: any[]) {
  const values = [];
  for (const part of parts || []) {
    for (const value of part.values || []) {
      const text = cleanText(value.text || value || "");
      if (!text) continue;
      values.push(text);
    }
  }
  return values;
}

function chooseBestImage(images: any[]) {
  for (const image of images || []) {
    const src = String(image?.src || "").trim();
    if (src) return src;
  }
  return "";
}

function extractWeightKg(details: any) {
  const productTypeWeight = details.productTypes?.find((item: any) => item?.grossWeight || item?.netWeight);
  const first = cleanText(productTypeWeight?.grossWeight || productTypeWeight?.netWeight || "");
  if (first) {
    const parsed = parseWeight(first);
    if (parsed != null) return parsed;
  }
  return parseWeight(details.mainStage?.weight?.value || "");
}

function buildLifecycleNoteFromStatus(status: any, replacementCode: string | null) {
  const value = cleanText(status?.value || "");
  const key = Number(status?.key || 0);
  if (replacementCode) {
    return value ? `Replacement code: ${replacementCode}. Official status: ${value}.` : `Replacement code: ${replacementCode}.`;
  }
  if (key && key !== 1) {
    return value ? `Official status: ${value}.` : "Official status marks this product as unavailable.";
  }
  return "";
}

function mergeCatalogRow({ target, existing, searchItem, detail }: any) {
  const productCode = normalizeCatalogDisplayCode(detail.product_code || searchItem?.product_code || existing?.product_code || "", target.internalName);
  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: productCode,
    description: detail.description || searchItem?.description || existing?.description || "",
    oem_no: sanitizeCatalogOemNumbers(detail.oem_no || existing?.oem_no || ""),
    vehicle: detail.vehicle || existing?.vehicle || "",
    hs_code: detail.hs_code || existing?.hs_code || "",
    origin: detail.origin || existing?.origin || "",
    weight_kg: detail.weight_kg ?? existing?.weight_kg ?? null,
    image_url: detail.image_url || searchItem?.image_url || existing?.image_url || "",
    lifecycle_status: detail.lifecycle_status || searchItem?.lifecycle_status || existing?.lifecycle_status || "active",
    lifecycle_note: detail.lifecycle_note || searchItem?.lifecycle_note || existing?.lifecycle_note || "",
  };
}

async function resolveExtraCodes({
  target,
  extraCodes,
  existingByCode,
  processedCodes,
  searchPageSize,
  requestTimeoutMs,
}: {
  target: any;
  extraCodes: Set<string>;
  existingByCode: Map<string, any>;
  processedCodes: Set<string>;
  searchPageSize: number;
  requestTimeoutMs: number;
}) {
  const items = [];
  for (const code of extraCodes) {
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode || existingByCode.has(normalizedCode)) continue;
    try {
      const page = await fetchSearchPage(target, normalizedCode, 0, searchPageSize, requestTimeoutMs);
      const match = page.items.find((item: any) => item.normalized_code === normalizedCode) || page.items[0] || null;
      if (!match || processedCodes.has(match.normalized_code)) continue;
      processedCodes.add(match.normalized_code);
      items.push({ target, searchItem: match });
    } catch {
      continue;
    }
  }
  return items;
}

async function fetchJson(url: string, requestTimeoutMs: number, options: { accept404?: boolean } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (options.accept404 && response.status === 404) return payload;
    if (!response.ok) throw new Error(`${response.status} ${payload?.message || payload?.statusMessage || text}`.trim());
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAll(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Supabase fetch failed: ${response.status} ${text}`);
  return payload;
}

async function createBrandRow(supabaseUrl: string, headers: Record<string, string>, organizationId: string, brandName: string) {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([{ organization_id: organizationId, name: brandName }]),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`brand create failed for ${brandName}: ${response.status} ${text}`);
  const brand = Array.isArray(payload) ? payload[0] : payload;
  if (!brand?.id || !brand?.organization_id) throw new Error(`brand create returned invalid payload for ${brandName}`);
  return {
    id: String(brand.id).trim(),
    organization_id: String(brand.organization_id).trim(),
    name: String(brand.name || brandName).trim() || brandName,
  };
}

async function detectCatalogImageColumn(supabaseUrl: string, headers: Record<string, string>) {
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=image_url&limit=1`, { headers });
    const text = await response.text();
    if (response.ok) return true;
    if (String(text || "").toLowerCase().includes("image_url")) return false;
    throw new Error(`catalog_products image_url probe failed: ${response.status} ${text}`);
  } catch (error) {
    if (String(error || "").toLowerCase().includes("image_url")) return false;
    throw error;
  }
}

function shouldProcessRow(row: any) {
  if (!normalizeTextValue(row.oem_no)) return true;
  if (!normalizeTextValue(row.vehicle)) return true;
  if (!normalizeTextValue(row.hs_code)) return true;
  if (!normalizeTextValue(row.origin)) return true;
  if (!normalizeTextValue(row.image_url)) return true;
  if (row.weight_kg == null || Number.isNaN(Number(row.weight_kg))) return true;
  if (normalizeLifecycleStatus(row.lifecycle_status) === "discontinued" && !normalizeTextValue(row.lifecycle_note)) return true;
  return false;
}

function hasCatalogDelta(existing: any, next: any) {
  return (
    normalizeTextValue(existing.description) !== normalizeTextValue(next.description) ||
    normalizeTextValue(existing.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(existing.vehicle) !== normalizeTextValue(next.vehicle) ||
    normalizeTextValue(existing.hs_code) !== normalizeTextValue(next.hs_code) ||
    normalizeTextValue(existing.origin) !== normalizeTextValue(next.origin) ||
    Number(existing.weight_kg ?? null) !== Number(next.weight_kg ?? null) ||
    normalizeTextValue(existing.image_url) !== normalizeTextValue(next.image_url) ||
    normalizeTextValue(existing.lifecycle_status) !== normalizeTextValue(next.lifecycle_status) ||
    normalizeTextValue(existing.lifecycle_note) !== normalizeTextValue(next.lifecycle_note)
  );
}

async function runPool(items: any[], concurrencyLimit: number, worker: (item: any, index: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrencyLimit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function parseWeight(value: unknown) {
  const text = String(value || "").replace(",", ".").trim();
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractVehicleTokens(raw: string) {
  const text = cleanText(raw);
  if (!text) return [];
  const hits = [];
  const normalized = ` ${text.toUpperCase()} `;
  for (const entry of KNOWN_MANUFACTURER_PATTERNS) {
    const matchIndex = normalized.search(entry.pattern);
    if (matchIndex < 0) continue;
    hits.push({ label: entry.label, index: matchIndex });
  }
  return dedupeStrings(hits.sort((left, right) => left.index - right.index).map((item) => item.label));
}

function extractVehicleList(raw: string) {
  return extractVehicleTokens(raw).join(", ");
}

function extractSpecValue(entries: Array<{ label: string; values: string[] }>, patterns: RegExp[]) {
  for (const entry of entries) {
    if (!patterns.some((pattern) => pattern.test(entry.label))) continue;
    const value = entry.values.join(", ").trim();
    if (value) return value;
  }
  return "";
}

function normalizeOriginCode(value: unknown) {
  const raw = cleanText(value);
  if (!raw) return "";
  const compact = raw
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z]/g, "");
  if (ORIGIN_CODES[compact]) return ORIGIN_CODES[compact];
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2,3}$/.test(upper)) return upper;
  return raw;
}

function formatOfficialDescription(target: any, value: unknown) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  const stripped = stripBrandPrefix(cleaned, target);
  if (isMostlyUppercase(stripped)) return toTitleCase(stripped);
  if (stripped === stripped.toLowerCase()) return stripped.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
  return stripped;
}

function stripBrandPrefix(value: string, target: any) {
  const aliases = dedupeStrings([target?.internalName || "", ...(target?.aliases || []), target?.officialFilter || ""]);
  let result = value;
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/Ö/g, "[ÖO]").replace(/ö/g, "[öo]");
    result = result.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
  }
  return result;
}

function isMostlyUppercase(value: string) {
  const letters = value.match(/[A-Za-z]/g) || [];
  if (!letters.length) return false;
  const uppercase = letters.filter((letter) => letter === letter.toUpperCase()).length;
  return uppercase / letters.length >= 0.75;
}

function toTitleCase(value: string) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bZf\b/g, "ZF")
    .replace(/\bTrw\b/g, "TRW")
    .replace(/\bBoge\b/g, "Boge");
}

function normalizeBrandKey(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}


function cleanText(value: unknown) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeStrings(values: string[]) {
  return dedupeBy(values.map((value) => String(value || "").trim()).filter(Boolean), (value) => normalizeTextValue(value));
}

function normalizeTextValue(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function emptyToNull(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}
