import { normalizeCatalogDisplayCode } from "./catalog-standardization.mts";

const MASTERPOWER_PRODUCTS_URL = "https://www.masterpower.com.br/produtos";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

type SyncBrandTarget = {
  brandId: string;
  organizationId: string;
  name: string;
};

type MasterPowerListingItem = {
  product_code: string;
  description: string;
  image_url: string;
  detail_url: string;
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

export async function syncBrandCatalogFromMasterPower(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  requestTimeoutMs?: number;
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
  const listing = await crawlMasterPowerListing(requestTimeoutMs);

  const catalogPayload: Array<Record<string, unknown>> = [];
  let matchedRows = 0;
  let changedRows = 0;
  let vehicleRows = 0;
  let imageRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool(listing.items, concurrency, async (item) => {
    try {
      const detail = await fetchMasterPowerDetail(item, requestTimeoutMs);
      const normalizedCode = normalizeCode(item.product_code);
      const current = existingByCode.get(normalizedCode) || null;
      const merged = buildMergedCatalogRow(target, current, item, detail);
      const changed = !current || hasCatalogDelta(current, merged);

      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
      if (normalizeTextValue(merged.image_url)) imageRows += 1;

      if (!current || refreshExisting || changed) {
        catalogPayload.push(merged);
      }
    } catch (error) {
      errorRows.push({
        product_code: item.product_code,
        normalized_code: normalizeCode(item.product_code),
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

  const newRowsInListing = listing.items.filter((row) => !existingByCode.has(normalizeCode(row.product_code))).length;
  const incompleteExistingRows = existingRows.filter((row) => shouldProcessRow(row)).length;

  return {
    targetBrandId: target.brandId,
    targetBrandName: target.name,
    organizationId: target.organizationId,
    existingRows: existingRows.length,
    listingPagesProcessed: listing.pagesProcessed,
    listingLastPage: listing.lastPage,
    listingUniqueRows: listing.items.length,
    newRowsInListing,
    incompleteExistingRows,
    candidateRows: listing.items.length,
    resolvedRows: matchedRows,
    errorRows: errorRows.length,
    discontinuedRows: 0,
    replacementRows: 0,
    replacementFetchRows: 0,
    supportsImageColumn,
    processedBatches,
    processedReplacementBatches: [],
    oemRows: 0,
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

async function crawlMasterPowerListing(requestTimeoutMs: number) {
  const items = new Map<string, MasterPowerListingItem>();
  const firstHtml = await fetchText(MASTERPOWER_PRODUCTS_URL, requestTimeoutMs);
  const firstPageItems = extractListingItems(firstHtml);
  for (const item of firstPageItems) items.set(normalizeCode(item.product_code), item);
  const lastPage = resolveLastPage(firstHtml);
  let pagesProcessed = 1;

  for (let page = 2; page <= lastPage; page += 1) {
    const html = await fetchText(`${MASTERPOWER_PRODUCTS_URL}?page=${page}`, requestTimeoutMs);
    const pageItems = extractListingItems(html);
    for (const item of pageItems) items.set(normalizeCode(item.product_code), item);
    pagesProcessed += 1;
  }

  return {
    items: [...items.values()],
    pagesProcessed,
    lastPage,
  };
}

function resolveLastPage(html: string) {
  const pageMatches = [...html.matchAll(/href="https:\/\/www\.masterpower\.com\.br\/produtos\?page=(\d+)"/g)];
  const pages = pageMatches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, ...pages);
}

function extractListingItems(html: string) {
  const items: MasterPowerListingItem[] = [];
  const cardPattern =
    /<img[^>]+data-src="([^"]+)"[^>]+alt="([^"]+)"[\s\S]*?<a href="(https:\/\/www\.masterpower\.com\.br\/produto\/[^"]+)"/g;
  for (const match of html.matchAll(cardPattern)) {
    const imageUrl = String(match[1] || "").trim();
    const title = decodeHtml(stripTags(String(match[2] || "")));
    const detailUrl = String(match[3] || "").trim();
    const codeMatch = title.match(/^([0-9]{5,})\s*-\s*(.+)$/);
    const productCode = codeMatch?.[1] || deriveCodeFromMasterPowerUrl(detailUrl) || "";
    const description = (codeMatch?.[2] || title).trim();
    if (!productCode || !detailUrl) continue;
    items.push({
      product_code: productCode,
      description,
      image_url: imageUrl,
      detail_url: detailUrl,
    });
  }
  return dedupeBy(items, (item) => normalizeCode(item.product_code));
}

async function fetchMasterPowerDetail(item: MasterPowerListingItem, requestTimeoutMs: number) {
  const html = await fetchText(item.detail_url, requestTimeoutMs);
  const heading = decodeHtml(stripTags(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || item.description)).replace(/\s+/g, " ").trim();
  const headingMatch = heading.match(/^([0-9]{5,})\s*-\s*(.+)$/);
  const description = (headingMatch?.[2] || item.description || heading).trim();
  const imageUrl = firstMatch(html, /<img[^>]+src="(https:\/\/www\.masterpower\.com\.br\/storage\/[^"]+)"/i) || item.image_url || "";
  const applicationsHtml = firstMatch(html, /<section class="product-table">([\s\S]*?)<\/section>/i) || "";
  const vehicles = extractMasterPowerVehicles(applicationsHtml, item.product_code);
  return {
    description,
    image_url: imageUrl.trim(),
    vehicle: vehicles.join(" | ").trim(),
  };
}

function extractMasterPowerVehicles(applicationsHtml: string, productCode: string) {
  const rows = [...applicationsHtml.matchAll(/<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi)];
  const vehicleEntries: string[] = [];
  for (const rowMatch of rows) {
    const cells = [...rowMatch[1].matchAll(/<td[\s\S]*?>([\s\S]*?)<\/td>/gi)].map((cell) =>
      decodeHtml(stripTags(cell[1])).replace(/\s+/g, " ").trim(),
    );
    if (cells.length < 3) continue;
    const codeCell = cells[0] || "";
    if (!normalizeCode(codeCell).includes(normalizeCode(productCode))) continue;
    const application = cells[1] || "";
    const motor = cells[2] || "";
    const value = [application, motor].filter(Boolean).join(" | ").trim();
    if (value) vehicleEntries.push(value);
  }
  return [...new Set(vehicleEntries)];
}

function buildMergedCatalogRow(target: SyncBrandTarget, current: CatalogRow | null, listingItem: MasterPowerListingItem, detail: { description: string; image_url: string; vehicle: string }) {
  const productCode = normalizeCatalogDisplayCode(listingItem.product_code, target.name);
  return {
    organization_id: target.organizationId,
    brand_id: target.brandId,
    product_code: productCode,
    normalized_code: normalizeCode(productCode),
    description: detail.description || current?.description || listingItem.description || "",
    oem_no: current?.oem_no || "",
    vehicle: detail.vehicle || current?.vehicle || "",
    hs_code: current?.hs_code || "",
    origin: current?.origin || "",
    weight_kg: current?.weight_kg ?? null,
    image_url: detail.image_url || listingItem.image_url || current?.image_url || "",
    lifecycle_status: current?.lifecycle_status || "active",
    lifecycle_note: current?.lifecycle_note || null,
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
  return !normalizeTextValue(row.description) || !normalizeTextValue(row.vehicle) || !normalizeTextValue(row.image_url);
}

function normalizeLifecycleStatus(value: unknown): "active" | "discontinued" {
  return String(value || "").trim().toLowerCase() === "discontinued" ? "discontinued" : "active";
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

function deriveCodeFromMasterPowerUrl(url: string) {
  const match = String(url || "").match(/\/produto\/([0-9]{5,})-/i);
  return match?.[1] || "";
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
