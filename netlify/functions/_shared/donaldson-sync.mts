import { normalizeCatalogDisplayCode } from "./catalog-standardization.mts";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

export async function syncBrandCatalogFromDonaldson(input: {
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

  const target = await resolveDonaldsonTarget(input.supabaseUrl, headers);
  const catalogRows = await fetchDonaldsonCatalogRows(input.supabaseUrl, headers, target.brand_id);
  const urlMap = await resolveDonaldsonProductUrls(catalogRows, requestTimeoutMs);

  const catalogPayload: Array<Record<string, unknown>> = [];
  const replacementPayload: Array<Record<string, unknown>> = [];
  const seenReplacementKeys = new Set<string>();
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let discontinuedRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool(catalogRows, concurrency, async (row) => {
    const productUrl = urlMap.get(row.normalized_code) || "";
    if (!productUrl) {
      errorRows.push({
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        error: "Product URL not found in Donaldson sitemaps",
      });
      return;
    }

    try {
      const html = await fetchText(productUrl, requestTimeoutMs);
      const detail = extractDonaldsonDetail(html, productUrl);
      const merged = mergeCatalogRow(target, row, detail);
      const changed = hasCatalogDelta(row, merged);

      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.oem_no)) oemRows += 1;
      if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
      if (String(merged.lifecycle_status || "") === "discontinued") discontinuedRows += 1;

      if (refreshExisting || changed) {
        catalogPayload.push(merged);
      }

      if (detail.replacement_code) {
        const replacement = {
          organization_id: target.organization_id,
          brand_id: target.brand_id,
          old_code: normalizeCatalogDisplayCode(row.product_code, target.name),
          new_code: normalizeCatalogDisplayCode(detail.replacement_code, target.name),
          original_number: null,
          reason: detail.replacement_reason,
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
            oem_no: emptyToNull(row.oem_no),
            vehicle: emptyToNull(row.vehicle),
            lifecycle_status: row.lifecycle_status,
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
    existingRows: catalogRows.length,
    listingPagesProcessed: 0,
    listingLastPage: 0,
    listingUniqueRows: catalogRows.length,
    newRowsInListing: 0,
    incompleteExistingRows: catalogRows.filter((row) => shouldProcessRow(row)).length,
    candidateRows: catalogRows.length,
    resolvedRows: matchedRows,
    errorRows: errorRows.length,
    discontinuedRows,
    replacementRows: replacementPayload.length,
    replacementFetchRows: 0,
    supportsImageColumn: false,
    processedBatches,
    processedReplacementBatches,
    oemRows,
    vehicleRows,
    imageRows: 0,
    hsRows: 0,
    weightRows: 0,
  };
}

async function resolveDonaldsonTarget(supabaseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=ilike.Donaldson&limit=1`, { headers });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Donaldson brand lookup failed: ${response.status} ${text}`);
  const brand = Array.isArray(rows) ? rows[0] : null;
  if (!brand?.id || !brand?.organization_id) throw new Error("Donaldson brand target not found");
  return {
    brand_id: String(brand.id),
    organization_id: String(brand.organization_id),
    name: String(brand.name || "Donaldson"),
  };
}

async function fetchDonaldsonCatalogRows(supabaseUrl: string, headers: Record<string, string>, brandId: string) {
  const results = [];
  const pageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,oem_no,vehicle,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(brandId)}&limit=${pageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!response.ok) throw new Error(`catalog_products fetch failed: ${response.status} ${text}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || "").trim(),
          brand_id: String(row.brand_id || brandId).trim(),
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), "Donaldson"),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
          lifecycle_status: String(row.lifecycle_status || "active").trim().toLowerCase() || "active",
          lifecycle_note: String(row.lifecycle_note || "").trim(),
        }))
        .filter((row) => row.product_code && row.normalized_code),
    );
    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function resolveDonaldsonProductUrls(rows: any[], requestTimeoutMs: number) {
  const urlMap = new Map<string, string>();
  const targets = rows.map((row) => row.normalized_code).filter(Boolean);
  const targetSet = new Set(targets);
  const sitemapIndexXml = await fetchText("https://shop.donaldson.com/sitemaps/siteindex.xml", requestTimeoutMs);
  const sitemapUrls = [...sitemapIndexXml.matchAll(/<loc>(https:\/\/shop\.donaldson\.com\/sitemaps\/productSitemap[^<]+\.xml)<\/loc>/gi)].map((match) => match[1]);

  await runPool(sitemapUrls, 2, async (sitemapUrl) => {
    if (urlMap.size >= rows.length) return;
    try {
      const xml = await fetchText(sitemapUrl, requestTimeoutMs);
      for (const match of xml.matchAll(/<loc>(https:\/\/shop\.donaldson\.com\/store\/en-us\/product\/[^<]+)<\/loc>/gi)) {
        const url = match[1];
        const productCode = deriveProductCodeFromDonaldsonUrl(url);
        const normalizedCode = normalizeCode(productCode);
        if (!normalizedCode || !targetSet.has(normalizedCode) || urlMap.has(normalizedCode)) continue;
        urlMap.set(normalizedCode, url);
      }
    } catch {
      return;
    }
  });

  return urlMap;
}

function extractDonaldsonDetail(html: string, sourceUrl: string) {
  const vehicleItems = extractUseCaseItems(html);
  const oemItems = extractOemItems(html);
  const alternateParts = extractAlternateParts(html);
  const lifecycle = extractLifecycle(html, alternateParts);

  return {
    source_url: sourceUrl,
    vehicle: vehicleItems.join("; "),
    oem_no: oemItems.join(", "),
    lifecycle_status: lifecycle.discontinued ? "discontinued" : "active",
    lifecycle_note: lifecycle.note,
    replacement_code: lifecycle.replacement_code,
    replacement_reason: lifecycle.reason,
  };
}

function extractUseCaseItems(html: string) {
  const blockMatch = html.match(/Use Cases\s*\/\s*Applications<\/b>\s*<\/h2>\s*<p><ul>([\s\S]*?)<\/ul><\/p>/i);
  const section = blockMatch?.[1] || "";
  if (!section) return [];
  const values = [];
  for (const match of section.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    const raw = cleanText(match[1]);
    const simplified = simplifyUseCase(raw);
    if (simplified) values.push(simplified);
  }
  return dedupeStrings(values);
}

function simplifyUseCase(value: string) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  return cleaned.replace(/\s+(including|such as|like)\s+.*$/i, "").replace(/\s+/g, " ").trim();
}

function extractOemItems(html: string) {
  const values = [];
  const sectionMatch = html.match(/<section class="ListCrossReferenceDetailPageComp[\s\S]*?<\/section>/i);
  const section = sectionMatch?.[0] || "";
  if (section) {
    for (const row of section.matchAll(/<tr[^>]*>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      const value = cleanText(row[1]);
      if (looksLikeUsefulPartNumber(value)) values.push(value);
    }
  }
  const inlineJsonMatches = [
    ...html.matchAll(/"manufacturePartNumber"\s*:\s*"([^"]+)"/gi),
    ...html.matchAll(/manufacturePartNumber['"]?\s*:\s*['"]([^'"]+)['"]/gi),
  ];
  for (const match of inlineJsonMatches) {
    const value = cleanText(match[1]);
    if (looksLikeUsefulPartNumber(value)) values.push(value);
  }
  return dedupeStrings(values);
}

function extractAlternateParts(html: string) {
  const sectionMatch = html.match(/<div id="alternateBody"[\s\S]*?<\/section>/i);
  const section = sectionMatch?.[0] || "";
  if (!section) return [];

  const items = [];
  for (const chunk of section.split(/<div class="item"/gi).slice(1)) {
    const codeMatch = chunk.match(/<pre class="preAlternate"><h5>([^<]+)<\/h5><\/pre>/i);
    const urlMatch = chunk.match(/data-url="([^"]+)"/i);
    const noteTitleMatch = chunk.match(/<div class="noteSection"[\s\S]*?<span[^>]*title="([^"]*)"/i);
    const noteBodyMatch = chunk.match(/<div class="noteSection"[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);

    const code = normalizeCatalogDisplayCode(cleanText(codeMatch?.[1] || ""), "Donaldson");
    if (!code) continue;
    items.push({
      code,
      url: resolveDonaldsonRelativeUrl(urlMatch?.[1] || ""),
      note: cleanText(noteTitleMatch?.[1] || noteBodyMatch?.[1] || ""),
    });
  }
  return dedupeBy(items, (item) => normalizeCode(item.code));
}

function extractLifecycle(html: string, alternateParts: Array<{ code: string; url: string; note: string }>) {
  const text = cleanText(html);
  const discontinued =
    /no longer deliverable by the manufacturer/i.test(text) ||
    /not in production/i.test(text) ||
    /production ended/i.test(text) ||
    /\bdiscontinued\b/i.test(text) ||
    /\bobsolete\b/i.test(text) ||
    /no longer available/i.test(text);

  let replacementCode = "";
  let reason = "";
  const explicitReplacementMatch =
    html.match(/Product has been replaced by:\s*[\s\S]{0,500}?<a[^>]*>([^<]+)<\/a>/i) ||
    html.match(/Product has been replaced by:\s*([A-Z0-9-]+)/i) ||
    html.match(/Replacement(?:\s+part|\s+code)?\s*:\s*([A-Z0-9-]+)/i);

  if (explicitReplacementMatch?.[1]) {
    replacementCode = normalizeCatalogDisplayCode(cleanText(explicitReplacementMatch[1]), "Donaldson");
    reason = "Replacement code from Donaldson source.";
  }

  if (!replacementCode && discontinued && alternateParts.length > 0) {
    replacementCode = normalizeCatalogDisplayCode(alternateParts[0].code, "Donaldson");
    reason = alternateParts[0].note
      ? `Alternate part suggested by Donaldson source. ${alternateParts[0].note}`
      : "Alternate part suggested by Donaldson source.";
  }

  let note = "";
  if (replacementCode) {
    note = `Replacement code: ${replacementCode}.`;
    if (reason) note = `${note} ${reason}`.trim();
  } else if (discontinued) {
    note = "Not in production according to Donaldson source.";
  }

  return {
    discontinued: discontinued || Boolean(replacementCode && /no longer|not in production|production ended|obsolete/i.test(text)),
    replacement_code: replacementCode,
    reason: reason || (replacementCode ? "Replacement from Donaldson source." : ""),
    note: note.trim(),
  };
}

function mergeCatalogRow(target: { organization_id: string; brand_id: string; name: string }, existing: any, detail: any) {
  const nextLifecycleStatus =
    detail.lifecycle_status === "discontinued"
      ? "discontinued"
      : String(existing.lifecycle_status || "active").trim().toLowerCase() || "active";
  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: normalizeCatalogDisplayCode(existing.product_code, target.name),
    oem_no: detail.oem_no || existing.oem_no || "",
    vehicle: detail.vehicle || existing.vehicle || "",
    lifecycle_status: nextLifecycleStatus,
    lifecycle_note: detail.lifecycle_note || existing.lifecycle_note || "",
  };
}

function hasCatalogDelta(existing: any, next: any) {
  return (
    normalizeTextValue(existing.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(existing.vehicle) !== normalizeTextValue(next.vehicle) ||
    normalizeTextValue(existing.lifecycle_status) !== normalizeTextValue(next.lifecycle_status) ||
    normalizeTextValue(existing.lifecycle_note) !== normalizeTextValue(next.lifecycle_note)
  );
}

async function fetchText(url: string, requestTimeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
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

function deriveProductCodeFromDonaldsonUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    const productIndex = parts.findIndex((part) => part === "product");
    if (productIndex < 0) return "";
    return decodeURIComponent(parts[productIndex + 1] || "");
  } catch {
    return "";
  }
}

function resolveDonaldsonRelativeUrl(value: string) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text, "https://shop.donaldson.com").toString();
  } catch {
    return "";
  }
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeUsefulPartNumber(value: string) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /[A-Z0-9]/i.test(text) && /[0-9]/.test(text) && text.length >= 4;
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
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeCode(value: unknown) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function emptyToNull(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function normalizeTextValue(value: unknown) {
  return String(value || "").trim();
}

function shouldProcessRow(row: any) {
  if (!normalizeTextValue(row.oem_no)) return true;
  if (!normalizeTextValue(row.vehicle)) return true;
  if (String(row.lifecycle_status || "active").trim().toLowerCase() === "discontinued" && !normalizeTextValue(row.lifecycle_note)) return true;
  return false;
}
