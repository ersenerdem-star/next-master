import { canonicalizeInternalBrandName, normalizeBrandKey } from "./brand-standardization.mts";
import { normalizeCatalogDescription, normalizeCatalogDisplayCode } from "./catalog-standardization.mts";

const BOSCH_API_BASE_URL = "https://ps.emea.dxtservice.com/ps/api";
const BOSCH_LOCALE_PATH = "tr/TR";
const BOSCH_CATALOG_ID = "AA_WEBSITE_TR";
const BOSCH_PIM_COUNTRY = "tr";
const BOSCH_PIM_LANGUAGE = "tr_tr";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
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
  { label: "Nissan", pattern: /\bNISSAN\b/ },
  { label: "Toyota", pattern: /\bTOYOTA\b/ },
  { label: "Honda", pattern: /\bHONDA\b/ },
  { label: "Peugeot", pattern: /\bPEUGEOT\b/ },
  { label: "Citroen", pattern: /\bCITROEN\b/ },
  { label: "Fiat", pattern: /\bFIAT\b/ },
  { label: "Seat", pattern: /\bSEAT\b/ },
  { label: "Kia", pattern: /\bKIA\b/ },
  { label: "Mazda", pattern: /\bMAZDA\b/ },
  { label: "Suzuki", pattern: /\bSUZUKI\b/ },
  { label: "Subaru", pattern: /\bSUBARU\b/ },
  { label: "Porsche", pattern: /\bPORSCHE\b/ },
  { label: "Alfa Romeo", pattern: /\bALFA ROMEO\b/ },
  { label: "Vauxhall", pattern: /\bVAUXHALL\b/ },
  { label: "Saab", pattern: /\bSAAB\b/ },
  { label: "Jeep", pattern: /\bJEEP\b/ },
];

export async function syncBrandCatalogFromBoschAftermarket(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  requestTimeoutMs?: number;
}) {
  const refreshExisting = input.refreshExisting !== false;
  const concurrency = Math.max(1, input.concurrency ?? 5);
  const requestTimeoutMs = Math.max(5000, input.requestTimeoutMs ?? 30000);
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const target = await resolveBoschTarget(input.supabaseUrl, headers, input.brandName);
  const supportsImageColumn = await detectCatalogImageColumn(input.supabaseUrl, headers);
  const existingRows = await fetchBoschCatalogRows(input.supabaseUrl, headers, target);
  const workRows = existingRows.filter((row) => refreshExisting || shouldProcessRow(row));

  const catalogPayload: Array<Record<string, unknown>> = [];
  const replacementPayload: Array<Record<string, unknown>> = [];
  const seenReplacementKeys = new Set<string>();
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let imageRows = 0;
  let discontinuedRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool(workRows, concurrency, async (row) => {
    try {
      const resolved = await resolveBoschOfficialPayload(row, requestTimeoutMs);
      const vehicles = await fetchBoschVehicleMakers(resolved.productNumber, requestTimeoutMs).catch(() => []);
      const merged = mergeCatalogRow(target, row, resolved.searchItem, resolved.detail, vehicles);
      const changed = hasCatalogDelta(row, merged);

      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.oem_no)) oemRows += 1;
      if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
      if (normalizeTextValue(merged.image_url)) imageRows += 1;
      if (normalizeLifecycleStatus(merged.lifecycle_status) === "discontinued") discontinuedRows += 1;

      if (refreshExisting || changed) {
        catalogPayload.push(merged);
      }

      if (resolved.replacement_code) {
        const replacement = {
          organization_id: target.organization_id,
          brand_id: target.brand_id,
          old_code: formatBoschDisplayCode(merged.product_code),
          new_code: formatBoschDisplayCode(resolved.replacement_code),
          original_number: null,
          reason: resolved.replacement_reason || "Replacement code from Bosch Aftermarket official source.",
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
        product_code: row.product_code,
        normalized_code: row.normalized_code,
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

  const processedReplacementBatches = [];
  if (replacementPayload.length) {
    for (let index = 0; index < replacementPayload.length; index += batchSize) {
      const batch = replacementPayload.slice(index, index + batchSize);
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
    targetBrandName: target.name,
    organizationId: target.organization_id,
    existingRows: existingRows.length,
    listingPagesProcessed: 0,
    listingLastPage: 0,
    listingUniqueRows: existingRows.length,
    newRowsInListing: 0,
    incompleteExistingRows: existingRows.filter((row) => shouldProcessRow(row)).length,
    candidateRows: workRows.length,
    resolvedRows: matchedRows,
    errorRows: errorRows.length,
    discontinuedRows,
    replacementRows: replacementPayload.length,
    replacementFetchRows: 0,
    supportsImageColumn,
    processedBatches,
    processedReplacementBatches,
    oemRows,
    vehicleRows,
    imageRows,
    hsRows: 0,
    weightRows: 0,
  };
}

async function resolveBoschTarget(supabaseUrl: string, headers: Record<string, string>, brandInput: string) {
  const brandName = canonicalizeInternalBrandName(brandInput) || "Bosch";
  const brands = await fetchAll(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&order=name.asc`, headers);
  const rows = Array.isArray(brands) ? brands : [];
  const defaultOrganizationId = String(rows.find((row) => String(row.organization_id || "").trim())?.organization_id || "").trim();
  let brand =
    rows.find((row) => normalizeBrandKey(row.name || "") === normalizeBrandKey(brandName)) ||
    rows.find((row) => normalizeBrandKey(row.name || "").includes(normalizeBrandKey(brandName))) ||
    null;

  if ((!brand?.id || !brand?.organization_id) && defaultOrganizationId) {
    brand = await createBrandRow(supabaseUrl, headers, defaultOrganizationId, brandName);
  }
  if (!brand?.id || !brand?.organization_id) {
    throw new Error(`Target brand not found for ${brandName}`);
  }

  return {
    brand_id: String(brand.id).trim(),
    organization_id: String(brand.organization_id).trim(),
    name: String(brand.name || brandName).trim() || brandName,
  };
}

async function fetchBoschCatalogRows(supabaseUrl: string, headers: Record<string, string>, target: any) {
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
    if (!response.ok) throw new Error(`catalog_products fetch failed for Bosch: ${response.status} ${text}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || target.organization_id).trim(),
          brand_id: String(row.brand_id || target.brand_id).trim(),
          product_code: formatBoschDisplayCode(String(row.product_code || "").trim()),
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

async function resolveBoschOfficialPayload(row: any, requestTimeoutMs: number) {
  const candidates = buildBoschProductCandidates(row);
  for (const candidate of candidates) {
    const detail = await fetchBoschDetail(candidate, requestTimeoutMs, { accept404: true });
    if (detail?.productNumber) {
      const lifecycle = extractLifecycle(detail, candidate);
      return {
        productNumber: normalizeCode(detail.productNumber || candidate),
        searchItem: null,
        detail,
        replacement_code: lifecycle.replacement_code,
        replacement_reason: lifecycle.replacement_reason,
      };
    }
  }

  for (const term of candidates) {
    const searchItems = await fetchBoschSearchItems(term, requestTimeoutMs);
    const exact =
      searchItems.find((item) => item.normalized_code === row.normalized_code) ||
      searchItems.find((item) => normalizeCode(item.product_code) === row.normalized_code) ||
      searchItems[0] ||
      null;
    if (!exact?.productNumber) continue;
    const detail = await fetchBoschDetail(exact.productNumber, requestTimeoutMs, { accept404: false });
    const lifecycle = extractLifecycle(detail, exact.productNumber);
    return {
      productNumber: normalizeCode(exact.productNumber),
      searchItem: exact,
      detail,
      replacement_code: lifecycle.replacement_code,
      replacement_reason: lifecycle.replacement_reason,
    };
  }

  throw new Error(`Official Bosch product not found for ${row.product_code}`);
}

function buildBoschProductCandidates(row: any) {
  const rawValues = [
    String(row.product_code || "").trim(),
    String(row.normalized_code || "").trim(),
    String(row.product_code || "").replace(/\s+/g, ""),
  ];
  return dedupeStrings(
    rawValues
      .map((value) => normalizeCode(value))
      .filter((value) => value.length >= 8),
  );
}

async function fetchBoschSearchItems(term: string, requestTimeoutMs: number) {
  const url = new URL(`${BOSCH_API_BASE_URL}/${BOSCH_LOCALE_PATH}/search/${encodeURIComponent(term)}`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "12");
  url.searchParams.set("queryPIM", "true");
  url.searchParams.set("catalogId", BOSCH_CATALOG_ID);
  url.searchParams.set("pimCountry", BOSCH_PIM_COUNTRY);
  url.searchParams.set("pimLanguage", BOSCH_PIM_LANGUAGE);

  const payload = await fetchJson(url.toString(), requestTimeoutMs);
  const items = Array.isArray(payload?.products) ? payload.products : [];
  return items
    .map((item: any) => ({
      productNumber: normalizeCode(item.productNumber || ""),
      product_code: formatBoschDisplayCode(item.productNumber || ""),
      normalized_code: normalizeCode(item.productNumber || ""),
      description: normalizeCatalogDescription(cleanText(item.name || item.description || "")),
      image_url: normalizeImageUrl(item.image || ""),
    }))
    .filter((item: any) => item.productNumber);
}

async function fetchBoschDetail(productNumber: string, requestTimeoutMs: number, options: { accept404: boolean }) {
  const url = new URL(`${BOSCH_API_BASE_URL}/${BOSCH_LOCALE_PATH}/search-details/${encodeURIComponent(normalizeCode(productNumber))}`);
  url.searchParams.set("queryPIM", "true");
  url.searchParams.set("catalogId", BOSCH_CATALOG_ID);
  url.searchParams.set("pimCountry", BOSCH_PIM_COUNTRY);
  url.searchParams.set("pimLanguage", BOSCH_PIM_LANGUAGE);
  return fetchJson(url.toString(), requestTimeoutMs, options);
}

async function fetchBoschVehicleMakers(productNumber: string, requestTimeoutMs: number) {
  const url = `${BOSCH_API_BASE_URL}/${BOSCH_LOCALE_PATH}/usage-in-vehicles/${encodeURIComponent(normalizeCode(productNumber))}/makers`;
  const payload = await fetchJson(url, requestTimeoutMs, { accept404: true });
  const makers = Array.isArray(payload?.makers) ? payload.makers : [];
  return dedupeStrings(
    makers
      .map((maker: any) => normalizeVehicleMakerName(String(maker.displayName || "").trim()))
      .filter(Boolean),
  );
}

function mergeCatalogRow(target: any, existing: any, searchItem: any, detail: any, vehicles: string[]) {
  const lifecycle = extractLifecycle(detail, detail?.productNumber || searchItem?.productNumber || existing.normalized_code);
  const replacementNote = lifecycle.replacement_code
    ? `Replacement code: ${formatBoschDisplayCode(lifecycle.replacement_code)}.`
    : "";
  const lifecycleNote =
    lifecycle.note ||
    replacementNote ||
    existing.lifecycle_note ||
    "";

  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: formatBoschDisplayCode(existing.product_code || searchItem?.product_code || detail?.productNumber || existing.normalized_code),
    normalized_code: normalizeCode(existing.normalized_code || detail?.productNumber || searchItem?.productNumber || existing.product_code),
    description:
      normalizeCatalogDescription(cleanText(detail?.name || "")) ||
      normalizeCatalogDescription(cleanText(searchItem?.description || "")) ||
      existing.description ||
      "",
    oem_no: extractBoschOemNumbers(detail) || existing.oem_no || "",
    vehicle: vehicles.join(", ") || existing.vehicle || "",
    hs_code: existing.hs_code || "",
    origin: existing.origin || "",
    weight_kg: existing.weight_kg == null || Number.isNaN(Number(existing.weight_kg)) ? null : Number(existing.weight_kg),
    image_url: extractBoschImageUrl(detail) || searchItem?.image_url || existing.image_url || "",
    lifecycle_status: lifecycle.status,
    lifecycle_note: lifecycleNote.trim(),
  };
}

function extractBoschOemNumbers(detail: any) {
  const items = Array.isArray(detail?.oeNumbers) ? detail.oeNumbers : [];
  const codes = items
    .map((item: any) => {
      const values = Array.isArray(item?.columnData) ? item.columnData : [];
      return cleanText(values[1] || "");
    })
    .filter(looksLikeUsefulPartNumber);
  return dedupeStrings(codes).join(", ");
}

function extractBoschImageUrl(detail: any) {
  const items = Array.isArray(detail?.images) ? detail.images : [];
  for (const item of items) {
    const url = normalizeImageUrl(item?.url || "");
    if (url) return url;
  }
  return "";
}

function extractLifecycle(detail: any, currentProductNumber: string) {
  const statusLabel =
    extractSpecificationValue(detail?.specificationTabData, ["Makale durumu", "Article status"]) ||
    "";
  const replacementCode = extractReplacementCode(detail, currentProductNumber);
  const discontinued = isDiscontinuedStatus(statusLabel);
  let note = "";
  if (discontinued && replacementCode) {
    note = `Not in production according to Bosch. Replacement code: ${formatBoschDisplayCode(replacementCode)}.`;
  } else if (discontinued) {
    note = "Not in production according to Bosch.";
  } else if (replacementCode) {
    note = `Replacement code: ${formatBoschDisplayCode(replacementCode)}.`;
  }
  return {
    status: discontinued ? "discontinued" : "active",
    note,
    replacement_code: replacementCode,
    replacement_reason: replacementCode ? "Replacement code from Bosch Aftermarket official source." : "",
  };
}

function extractSpecificationValue(rows: any[], labels: string[]) {
  const normalizedLabels = labels.map((label) => normalizeLabel(label));
  const entries = Array.isArray(rows) ? rows : [];
  for (const entry of entries) {
    const values = Array.isArray(entry?.columnData) ? entry.columnData : [];
    const key = normalizeLabel(values[0] || "");
    if (!key || !normalizedLabels.includes(key)) continue;
    const value = cleanText(values[1] || "");
    if (value) return value;
  }
  return "";
}

function extractReplacementCode(detail: any, currentProductNumber: string) {
  const pools = [detail?.replacementsTabData, detail?.exchangesTabData, detail?.correspondingArticlesTabData];
  const currentNormalized = normalizeCode(currentProductNumber);
  for (const pool of pools) {
    const strings = collectStrings(pool);
    for (const value of strings) {
      const candidate = normalizeCode(value);
      if (!candidate || candidate === currentNormalized) continue;
      if (!looksLikeBoschProductNumber(candidate)) continue;
      return candidate;
    }
  }
  return "";
}

function collectStrings(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectStrings(item));
  }
  return [];
}

function normalizeVehicleMakerName(value: string) {
  const text = cleanText(value);
  if (!text) return "";
  const normalized = ` ${text.toUpperCase()} `;
  for (const entry of KNOWN_MANUFACTURER_PATTERNS) {
    if (entry.pattern.test(normalized)) return entry.label;
  }
  return text
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bLtd\.\b/g, "Ltd.")
    .trim();
}

async function fetchJson(url: string, requestTimeoutMs: number, options?: { accept404?: boolean }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      if (options?.accept404 && response.status === 404) return null;
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
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
  if (!normalizeTextValue(row.image_url)) return true;
  if (!normalizeTextValue(row.description)) return true;
  if (normalizeLifecycleStatus(row.lifecycle_status) === "discontinued" && !normalizeTextValue(row.lifecycle_note)) return true;
  return false;
}

function hasCatalogDelta(existing: any, next: any) {
  return (
    normalizeTextValue(existing.product_code) !== normalizeTextValue(next.product_code) ||
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

function formatBoschDisplayCode(value: unknown) {
  const compact = normalizeCode(value);
  if (compact.length === 10) {
    return `${compact.slice(0, 1)} ${compact.slice(1, 4)} ${compact.slice(4, 7)} ${compact.slice(7)}`;
  }
  return normalizeCatalogDisplayCode(String(value || ""));
}

function normalizeCode(value: unknown) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeTextValue(value: unknown) {
  return String(value || "").trim();
}

function normalizeLifecycleStatus(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return text === "discontinued" ? "discontinued" : "active";
}

function normalizeImageUrl(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  return text;
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

function normalizeLabel(value: unknown) {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
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

function emptyToNull(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function looksLikeUsefulPartNumber(value: string) {
  const text = String(value || "").trim();
  return Boolean(text) && /[0-9]/.test(text) && /[A-Z0-9]/i.test(text);
}

function looksLikeBoschProductNumber(value: string) {
  const compact = normalizeCode(value);
  return compact.length === 10 && /[0-9]/.test(compact);
}

function isDiscontinuedStatus(value: string) {
  const text = cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!text || text === "normal") return false;
  return /discontinued|obsolete|ended|withdrawn|kaldir|kalkti|uretimden|artik yok|artik uretilmiyor/.test(text);
}
