import {
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  normalizeLifecycleStatus,
  sanitizeCatalogOemNumbers,
} from "./catalog-standardization.mts";

const MEYLE_PUBLIC_CATALOG_URL = "https://www.meyle.com/en/parts-catalog";
const MEYLE_IFRAME_LOGIN_URL = "https://web2.carparts-cat.com/loginh.aspx?SID=348004";
const MEYLE_IFRAME_BASE_URL = "https://web2.carparts-cat.com";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
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
  oem_no: string;
  vehicle: string;
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

type MeyleSessionContext = {
  homeSearchUrl: string;
};

type MeyleSearchItem = {
  product_code: string;
  normalized_code: string;
  description: string;
  image_url: string;
  detail_url: string;
};

type MeyleResolvedItem = {
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

export async function syncBrandCatalogFromMeyleOfficial(input: {
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
  const supplierSeedRows = await fetchSupplierPriceSeedRows(input.supabaseUrl, headers, target);
  const requestedSeedTerms = dedupeStrings((input.seedPrefixes || []).map((value) => normalizeSearchTerm(value)).filter(Boolean));
  const seedTerms = dedupeStrings([
    ...requestedSeedTerms,
    ...existingRows.map((row) => row.product_code),
    ...supplierSeedRows.map((row) => row.product_code),
  ]);

  if (!seedTerms.length) {
    return {
      targetBrandId: target.brandId,
      targetBrandName: target.name,
      organizationId: target.organizationId,
      existingRows: existingRows.length,
      supplierSeedRows: supplierSeedRows.length,
      listingPagesProcessed: 0,
      seedTermsProcessed: [],
      listingUniqueRows: 0,
      newRowsInListing: 0,
      incompleteExistingRows: existingRows.filter((row) => shouldProcessRow(row)).length,
      candidateRows: 0,
      resolvedRows: 0,
      errorRows: 0,
      discontinuedRows: 0,
      replacementRows: 0,
      replacementFetchRows: 0,
      supportsImageColumn,
      processedBatches: [],
      processedReplacementBatches: [],
      oemRows: 0,
      vehicleRows: 0,
      imageRows: 0,
      hsRows: 0,
      weightRows: 0,
      note:
        "MEYLE official sync is exact-code/search-term based. No existing Meyle catalog rows, supplier price seeds, or explicit seed terms were available for discovery.",
    };
  }

  const session = await createMeyleSessionContext(requestTimeoutMs);
  const discovered = await crawlMeyleSearchTerms(session, seedTerms, requestTimeoutMs);

  const workMap = new Map<string, { existing: CatalogRow | null; searchItem: MeyleSearchItem | null }>();
  for (const row of existingRows) {
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
  let discontinuedRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool([...workMap.values()], concurrency, async (item) => {
    try {
      const resolved = await resolveMeyleItem(session, item.existing, item.searchItem, requestTimeoutMs);
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
    supplierSeedRows: supplierSeedRows.length,
    listingPagesProcessed: discovered.pagesProcessed,
    seedTermsProcessed: discovered.processedTerms,
    listingUniqueRows: discovered.itemsByCode.size,
    newRowsInListing: [...discovered.itemsByCode.values()].filter((row) => !existingByCode.has(row.normalized_code)).length,
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

async function createMeyleSessionContext(requestTimeoutMs: number): Promise<MeyleSessionContext> {
  const html = await fetchText(MEYLE_IFRAME_LOGIN_URL, requestTimeoutMs);
  const homeSearchPathMatch = html.match(/id="home_imgBtn_art_direkt"[\s\S]*?url="([^"]+)"/i);
  const sideSearchPathMatch = html.match(/id="tp_articlesearch_articleSearch_imgBtn"[\s\S]*?url="([^"]+)"/i);
  const rawPath = decodeHtml(homeSearchPathMatch?.[1] || sideSearchPathMatch?.[1] || "").trim();
  if (!rawPath) {
    throw new Error("Unable to extract MEYLE official direct-search URL from iframe shell");
  }
  return {
    homeSearchUrl: absolutizeMeyleUrl(rawPath),
  };
}

async function crawlMeyleSearchTerms(session: MeyleSessionContext, searchTerms: string[], requestTimeoutMs: number) {
  const itemsByCode = new Map<string, MeyleSearchItem>();
  const processedTerms: string[] = [];
  let pagesProcessed = 0;

  for (const rawTerm of searchTerms) {
    const term = normalizeSearchTerm(rawTerm);
    if (!term) continue;
    if (normalizeCode(term).length < 3) continue;
    const html = await fetchText(buildMeyleSearchUrl(session, term), requestTimeoutMs);
    const items = extractMeyleSearchItems(html);
    for (const item of items) {
      if (!item.normalized_code) continue;
      itemsByCode.set(item.normalized_code, item);
    }
    processedTerms.push(term);
    pagesProcessed += 1;
  }

  return {
    itemsByCode,
    pagesProcessed,
    processedTerms,
  };
}

function buildMeyleSearchUrl(session: MeyleSessionContext, term: string) {
  const url = new URL(session.homeSearchUrl);
  url.searchParams.set("1116", term);
  url.searchParams.set("home_txt_art_direkt", term);
  return url.toString();
}

export function extractMeyleSearchItems(html: string) {
  const items: MeyleSearchItem[] = [];
  const partLinkPattern = /<a title="Part Number"[^>]+href="([^"]+)"[^>]*><nobr>([^<]+)<\/nobr><\/a>/gi;

  for (const match of html.matchAll(partLinkPattern)) {
    const detailPath = decodeHtml(match[1] || "").trim();
    const productCode = normalizeCatalogDisplayCode(decodeHtml(match[2] || "").trim(), "Meyle");
    const normalizedCode = normalizeCode(productCode);
    if (!detailPath || !productCode || !normalizedCode) continue;

    const before = html.slice(0, match.index || 0);
    const nearby = html.slice(Math.max(0, (match.index || 0) - 1200), Math.min(html.length, (match.index || 0) + 3500));
    const description = extractLastGenArtDescription(before);
    const imageUrl = decodeHtml(nearby.match(/<img[^>]+class="articleThumbNail"[^>]+src="([^"]+)"/i)?.[1] || "").trim();

    items.push({
      product_code: productCode,
      normalized_code: normalizedCode,
      description: normalizeCatalogDescription(description || ""),
      image_url: absolutizeMeyleMediaUrl(imageUrl),
      detail_url: absolutizeMeyleUrl(detailPath),
    });
  }

  return dedupeBy(items, (item) => item.normalized_code);
}

function extractLastGenArtDescription(html: string) {
  const matches = [...html.matchAll(/<tr[^>]+row_type="genart"[\s\S]*?<td[^>]*colspan="8"[^>]*><span>([^<]+)<\/span>/gi)];
  const last = matches[matches.length - 1];
  return normalizeTextValue(decodeHtml(last?.[1] || ""));
}

async function resolveMeyleItem(
  session: MeyleSessionContext,
  current: CatalogRow | null,
  searchItem: MeyleSearchItem | null,
  requestTimeoutMs: number,
): Promise<MeyleResolvedItem> {
  const productCode = searchItem?.product_code || current?.product_code || "";
  if (!productCode) throw new Error("MEYLE item has no product code");

  const resolvedSearchItem = searchItem || (await searchMeyleExactItem(session, productCode, requestTimeoutMs));
  if (!resolvedSearchItem) {
    throw new Error(`Official MEYLE product not found for ${productCode}`);
  }

  const detailHtml = await fetchText(resolvedSearchItem.detail_url, requestTimeoutMs);
  return extractMeyleResolvedItem(detailHtml, resolvedSearchItem, current);
}

async function searchMeyleExactItem(session: MeyleSessionContext, productCode: string, requestTimeoutMs: number) {
  const target = normalizeCode(productCode);
  const variants = buildMeyleSearchVariants(productCode);
  for (const variant of variants) {
    const html = await fetchText(buildMeyleSearchUrl(session, variant), requestTimeoutMs);
    const items = extractMeyleSearchItems(html);
    const exact = items.find((item) => item.normalized_code === target);
    if (exact) return exact;
  }
  return null;
}

function buildMeyleSearchVariants(productCode: string) {
  const display = normalizeCatalogDisplayCode(productCode, "Meyle");
  const compact = normalizeCode(display);
  const hyphenTight = display.replace(/\s*-\s*/g, "-");
  return dedupeStrings([
    normalizeSearchTerm(productCode),
    normalizeSearchTerm(display),
    normalizeSearchTerm(hyphenTight),
    compact.length >= 3 ? compact : "",
  ]).filter((value) => normalizeCode(value).length >= 3);
}

export function extractMeyleResolvedItem(html: string, searchItem: MeyleSearchItem, current: CatalogRow | null): MeyleResolvedItem {
  const mainInfoTable = html.match(/<table id="ad_tbl_main_allg_info"[\s\S]*?<\/table>/i)?.[0] || "";
  const partsDescription = extractNamedRowValue(mainInfoTable, "Parts Description");
  const partsState = extractNamedRowValue(mainInfoTable, "Parts state");
  const detailTitle = extractMeyleDetailTitle(html);
  const oemBlock = html.match(/<table id="ad_tbl_oenr"[\s\S]*?<\/table>/i)?.[0] || "";
  const imageBlock = html.match(/<div id="panelToExtend_Bilder"[\s\S]*?<\/div>\s*<\/div>/i)?.[0] || "";

  const lifecycleStatus = normalizeLifecycleStatus(partsState || current?.lifecycle_status || "active");
  const lifecycleNote = lifecycleStatus === "discontinued" ? normalizeTextValue(partsState || current?.lifecycle_note || "") || null : null;

  return {
    product_code: normalizeCatalogDisplayCode(
      extractNamedRowValue(mainInfoTable, "Part Number") || searchItem.product_code || current?.product_code || "",
      "Meyle",
    ),
    description: chooseMeyleDescription(searchItem.description, detailTitle, current?.description || "", partsDescription),
    oem_no: extractMeyleOemNumbers(oemBlock),
    vehicle: current?.vehicle || "",
    hs_code: current?.hs_code || "",
    origin: current?.origin || "",
    weight_kg: current?.weight_kg ?? null,
    image_url: extractMeyleDetailImage(imageBlock) || searchItem.image_url || current?.image_url || "",
    lifecycle_status: lifecycleStatus,
    lifecycle_note: lifecycleNote,
  };
}

function extractMeyleDetailTitle(html: string) {
  const title = decodeHtml(html.match(/id="ad_pkw_6"[\s\S]*?<span>([^<]+)<\/span>/i)?.[1] || "").trim();
  if (!title) return "";
  return normalizeCatalogDescription(title.replace(/^MEYLE\s*-\s*/i, "").trim());
}

function chooseMeyleDescription(...candidates: string[]) {
  for (const candidate of candidates) {
    const text = normalizeCatalogDescription(candidate);
    if (!text) continue;
    if (/^MEYLE(?:-ORIGINAL)?\b/i.test(text)) continue;
    return text;
  }
  return normalizeCatalogDescription(candidates.find(Boolean) || "");
}

function extractNamedRowValue(tableHtml: string, label: string) {
  if (!tableHtml) return "";
  const escapedLabel = escapeRegExp(label);
  const rowPattern = new RegExp(
    `<tr class="ad_artlist_row">[\\s\\S]*?<td[^>]*><span>${escapedLabel}<\\/span><\\/td><td[^>]*>([\\s\\S]*?)<\\/td>[\\s\\S]*?<\\/tr>`,
    "i",
  );
  const match = tableHtml.match(rowPattern);
  return normalizeTextValue(stripHtml(match?.[1] || ""));
}

function extractMeyleOemNumbers(oemBlock: string) {
  const values = [...oemBlock.matchAll(/<a class="ad_reference_nr[^"]*"[^>]*><span>([^<]+)<\/span><\/a>/gi)]
    .map((match) => normalizeTextValue(decodeHtml(match[1] || "")))
    .filter(Boolean);
  return sanitizeCatalogOemNumbers(values.join(", "));
}

function extractMeyleDetailImage(imageBlock: string) {
  const value = decodeHtml(imageBlock.match(/<img[^>]+src="([^"]+ImageData\/ArtBild[^"]+)"/i)?.[1] || "").trim();
  return absolutizeMeyleMediaUrl(value);
}

function buildMergedCatalogRow(target: SyncBrandTarget, current: CatalogRow | null, resolved: MeyleResolvedItem): CatalogRow {
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
    !normalizeTextValue(row.image_url) ||
    normalizeLifecycleStatus(row.lifecycle_status) === "active"
  );
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

function absolutizeMeyleUrl(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return new URL(text, MEYLE_IFRAME_BASE_URL).toString();
}

function absolutizeMeyleMediaUrl(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith("//")) return `https:${text}`;
  return new URL(text, MEYLE_IFRAME_BASE_URL).toString();
}

function normalizeCode(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTextValue(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSearchTerm(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
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

function stripHtml(value: string) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "));
}

function decodeHtml(value: string) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
