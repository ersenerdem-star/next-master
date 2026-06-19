#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  normalizeCatalogDisplayCode,
  normalizeLifecycleStatus,
  sanitizeCatalogOemNumbers,
} from "../shared/catalog/catalog-standardization.mjs";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "donaldson-detail-fill");
const urlCachePath = path.join(outputDir, "donaldson-url-map.json");

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const [rawKey, rawValue] = token.slice(2).split("=", 2);
  if (rawValue != null) {
    args.set(rawKey, rawValue);
    continue;
  }
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(rawKey, next);
    index += 1;
  } else {
    args.set(rawKey, "true");
  }
}

const applyMode = args.has("apply");
const refreshExisting = args.has("refresh-existing");
const detailConcurrency = Math.max(1, Number.parseInt(args.get("concurrency") || "5", 10) || 5);
const batchSize = Math.max(1, Number.parseInt(args.get("batch-size") || "200", 10) || 200);
const sitemapConcurrency = Math.max(1, Number.parseInt(args.get("sitemap-concurrency") || "2", 10) || 2);
const requestTimeoutMs = Math.max(4000, Number.parseInt(args.get("request-timeout-ms") || "60000", 10) || 60000);
const sleepMs = Math.max(0, Number.parseInt(args.get("sleep-ms") || "25", 10) || 25);
const limitArg = args.get("limit");
const rowLimit = limitArg == null ? null : Math.max(1, Number.parseInt(limitArg, 10) || 0);

fs.mkdirSync(outputDir, { recursive: true });

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const matchedCsvPath = path.join(outputDir, `donaldson-detail-fill-${timestamp}.csv`);
  const errorsCsvPath = path.join(outputDir, `donaldson-detail-fill-errors-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `donaldson-detail-fill-summary-${timestamp}.json`);

  const target = await resolveDonaldsonTarget();
  const catalogRows = await fetchDonaldsonCatalogRows(target.brand_id);
  const selectedCatalogRows = rowLimit == null ? catalogRows : catalogRows.slice(0, rowLimit);
  const urlMap = await resolveDonaldsonProductUrls(selectedCatalogRows);

  const matched = [];
  const errors = [];
  const catalogPayload = [];
  const replacementPayload = [];
  const seenReplacementKeys = new Set();

  await runPool(selectedCatalogRows, detailConcurrency, async (row, index) => {
    const productUrl = urlMap.get(row.normalized_code) || "";
    if (!productUrl) {
      errors.push({
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        source_url: "",
        error: "Product URL not found in Donaldson sitemaps",
      });
      if ((index + 1) % 100 === 0 || index + 1 === selectedCatalogRows.length) {
        console.error(`Donaldson detail progress: ${index + 1}/${selectedCatalogRows.length}`);
      }
      return;
    }

    try {
      const page = await fetchDonaldsonProductPage(productUrl, row.product_code);
      const detail = extractDonaldsonDetail(page.html, page.sourceUrl);
      const merged = mergeCatalogRow(target, row, detail);
      const changed = hasCatalogDelta(row, merged);
      const replacementKey = detail.replacement_code
        ? `${target.organization_id}::${target.brand_id}::${normalizeCode(row.product_code)}`
        : "";

      matched.push({
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        source_url: page.sourceUrl,
        vehicle: merged.vehicle || "",
        oem_no: merged.oem_no || "",
        lifecycle_status: merged.lifecycle_status,
        lifecycle_note: merged.lifecycle_note || "",
        replacement_code: detail.replacement_code || "",
        alternate_codes: detail.alternate_parts.map((item) => item.code).join(" | "),
        alternate_notes: detail.alternate_parts.map((item) => item.note).filter(Boolean).join(" | "),
        changed: changed ? "yes" : "no",
      });

      if (refreshExisting || changed) {
        catalogPayload.push(merged);
      }

      if (detail.replacement_code && !seenReplacementKeys.has(replacementKey)) {
        seenReplacementKeys.add(replacementKey);
        replacementPayload.push({
          organization_id: target.organization_id,
          brand_id: target.brand_id,
          old_code: normalizeCatalogDisplayCode(row.product_code, target.name),
          new_code: normalizeCatalogDisplayCode(detail.replacement_code, target.name),
          original_number: null,
          reason: detail.replacement_reason,
          is_active: true,
        });
      }
    } catch (error) {
      errors.push({
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        source_url: productUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if ((index + 1) % 100 === 0 || index + 1 === selectedCatalogRows.length) {
      console.error(`Donaldson detail progress: ${index + 1}/${selectedCatalogRows.length}`);
    }
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  });

  writeCsv(
    matchedCsvPath,
    [
      "Product_Code",
      "Normalized_Code",
      "Source_URL",
      "Vehicle",
      "OEM_No",
      "Lifecycle_Status",
      "Lifecycle_Note",
      "Replacement_Code",
      "Alternate_Codes",
      "Alternate_Notes",
      "Changed",
    ],
    matched.map((row) => [
      row.product_code,
      row.normalized_code,
      row.source_url,
      row.vehicle,
      row.oem_no,
      row.lifecycle_status,
      row.lifecycle_note,
      row.replacement_code,
      row.alternate_codes,
      row.alternate_notes,
      row.changed,
    ]),
  );

  writeCsv(
    errorsCsvPath,
    ["Product_Code", "Normalized_Code", "Source_URL", "Error"],
    errors.map((row) => [row.product_code, row.normalized_code, row.source_url, row.error]),
  );

  const processedBatches = [];
  if (applyMode) {
    if (catalogPayload.length) {
      for (let index = 0; index < catalogPayload.length; index += batchSize) {
        const batch = catalogPayload.slice(index, index + batchSize);
        const result = await upsertCatalogBatch(
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
        );
        processedBatches.push({ type: "catalog", batch: index / batchSize + 1, rows: batch.length, result });
      }
    }

    if (replacementPayload.length) {
      for (let index = 0; index < replacementPayload.length; index += batchSize) {
        const batch = replacementPayload.slice(index, index + batchSize);
        const result = await upsertCodeReferenceBatch(
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
        );
        processedBatches.push({ type: "code_reference", batch: index / batchSize + 1, rows: batch.length, result });
      }
    }
  }

  const summary = {
    mode: applyMode ? "apply" : "plan",
    brand_name: target.name,
    brand_id: target.brand_id,
    organization_id: target.organization_id,
    selected_rows: selectedCatalogRows.length,
    sitemap_matched_urls: urlMap.size,
    detail_rows: matched.length,
    changed_rows: matched.filter((row) => row.changed === "yes").length,
    oem_rows: matched.filter((row) => String(row.oem_no || "").trim()).length,
    vehicle_rows: matched.filter((row) => String(row.vehicle || "").trim()).length,
    discontinued_rows: matched.filter((row) => String(row.lifecycle_status || "") === "discontinued").length,
    replacement_rows: replacementPayload.length,
    error_rows: errors.length,
    matched_csv: matchedCsvPath,
    errors_csv: errorsCsvPath,
    processed_batches: processedBatches,
    refresh_existing: refreshExisting,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function resolveDonaldsonTarget() {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=ilike.Donaldson&limit=1`,
    { headers },
  );
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`Donaldson brand lookup failed: ${response.status} ${text}`);
  }
  const brand = Array.isArray(rows) ? rows[0] : null;
  if (!brand?.id || !brand?.organization_id) {
    throw new Error("Donaldson brand target not found");
  }
  return {
    brand_id: String(brand.id),
    organization_id: String(brand.organization_id),
    name: String(brand.name || "Donaldson"),
  };
}

async function fetchDonaldsonCatalogRows(brandId) {
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
    if (!response.ok) {
      throw new Error(`catalog_products fetch failed: ${response.status} ${text}`);
    }
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

async function resolveDonaldsonProductUrls(rows) {
  const urlMap = new Map();
  const cached = readUrlCache();
  for (const row of rows) {
    const cachedUrl = cached[row.normalized_code];
    if (cachedUrl) {
      urlMap.set(row.normalized_code, cachedUrl);
    }
  }

  for (const row of rows) {
    const code = normalizeCatalogDisplayCode(row.product_code, "Donaldson");
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode || urlMap.has(normalizedCode)) continue;
    urlMap.set(normalizedCode, buildDonaldsonProductUrl(code, "en-tr"));
  }
  writeUrlCache(urlMap);
  return urlMap;
}

function extractDonaldsonDetail(html, sourceUrl) {
  const vehicleItems = extractUseCaseItems(html);
  const oemItems = extractOemItems(html);
  const alternateParts = extractAlternateParts(html);
  const lifecycle = extractLifecycle(html, alternateParts);

  return {
    source_url: sourceUrl,
    vehicle: vehicleItems.join("; "),
    oem_no: sanitizeCatalogOemNumbers(oemItems.join(", ")),
    lifecycle_status: normalizeLifecycleStatus(
      `${lifecycle.discontinued ? "discontinued" : "active"} ${lifecycle.note || ""} ${lifecycle.reason || ""}`,
    ),
    lifecycle_note: lifecycle.note,
    replacement_code: lifecycle.replacement_code,
    replacement_reason: lifecycle.reason,
    alternate_parts: alternateParts,
  };
}

function extractUseCaseItems(html) {
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

function simplifyUseCase(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  return cleaned
    .replace(/\s+(including|such as|like)\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOemItems(html) {
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

function extractAlternateParts(html) {
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

function extractLifecycle(html, alternateParts) {
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
    if (reason) {
      note = `${note} ${reason}`.trim();
    }
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

function mergeCatalogRow(target, existing, detail) {
  const nextLifecycleStatus =
    normalizeLifecycleStatus(
      `${detail.lifecycle_status || ""} ${detail.lifecycle_note || ""} ${detail.replacement_reason || ""}`,
    ) === "discontinued"
      ? "discontinued"
      : normalizeLifecycleStatus(existing.lifecycle_status);
  const nextLifecycleNote = detail.lifecycle_note || existing.lifecycle_note || "";
  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: normalizeCatalogDisplayCode(existing.product_code, target.name),
    oem_no: sanitizeCatalogOemNumbers(detail.oem_no || existing.oem_no || ""),
    vehicle: detail.vehicle || existing.vehicle || "",
    lifecycle_status: nextLifecycleStatus,
    lifecycle_note: nextLifecycleNote,
  };
}

function hasCatalogDelta(existing, next) {
  return (
    normalizeTextValue(existing.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(existing.vehicle) !== normalizeTextValue(next.vehicle) ||
    normalizeTextValue(existing.lifecycle_status) !== normalizeTextValue(next.lifecycle_status) ||
    normalizeTextValue(existing.lifecycle_note) !== normalizeTextValue(next.lifecycle_note)
  );
}

async function upsertCatalogBatch(payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
  }
  return { status: response.status };
}

async function upsertCodeReferenceBatch(payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/item_code_references?on_conflict=organization_id,brand_id,normalized_old_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`item_code_references upsert failed: ${response.status} ${text}`);
  }
  return { status: response.status };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDonaldsonProductPage(initialUrl, productCode) {
  const candidates = dedupeStrings([initialUrl, ...buildDonaldsonProductCandidates(productCode)]);
  let lastError = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const html = await fetchText(candidate);
      return { html, sourceUrl: candidate };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Donaldson product page fetch failed for ${productCode}`);
}

async function runPool(items, concurrencyLimit, worker) {
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

function writeCsv(filePath, headersRow, rows) {
  const lines = [headersRow, ...rows].map((row) => row.map((cell) => toCsvCell(cell)).join(","));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function toCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/["\n,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function deriveProductCodeFromDonaldsonUrl(url) {
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

function buildDonaldsonProductCandidates(productCode) {
  const code = normalizeCatalogDisplayCode(productCode, "Donaldson");
  if (!code) return [];
  return ["en-tr", "en-us"].map((locale) => buildDonaldsonProductUrl(code, locale));
}

function buildDonaldsonProductUrl(productCode, locale) {
  const code = normalizeCatalogDisplayCode(productCode, "Donaldson");
  return `https://shop.donaldson.com/store/${locale}/product/${encodeURIComponent(code)}`;
}

function readUrlCache() {
  try {
    const text = fs.readFileSync(urlCachePath, "utf8");
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeUrlCache(urlMap) {
  const current = readUrlCache();
  for (const [code, url] of urlMap.entries()) {
    current[code] = url;
  }
  fs.writeFileSync(urlCachePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function resolveDonaldsonRelativeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text, "https://shop.donaldson.com").toString();
  } catch {
    return "";
  }
}

function cleanText(value) {
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

function looksLikeUsefulPartNumber(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /[A-Z0-9]/i.test(text) && /[0-9]/.test(text) && text.length >= 4;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function normalizeTextValue(value) {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
