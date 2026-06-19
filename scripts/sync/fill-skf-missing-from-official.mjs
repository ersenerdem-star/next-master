#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCatalogPlaceholderDescription,
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  normalizeCatalogEan,
  normalizeCatalogOrigin,
  normalizeLifecycleStatus,
  pickCatalogDescription,
  sanitizeCatalogOemNumbers,
} from "../shared/catalog/catalog-standardization.mjs";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";
import { normalizeCatalogMarketSegment } from "../../netlify/functions/_shared/catalog/catalog-segments.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const outputDir = path.join(repoRoot, "docs", "skf-official-fill");

const SKF_SEARCH_BASE_URL = "https://search.automotive.skf.com/prod/search-automotive/rest";
const SKF_DETAILS_SEARCHER = "apps/automotive/searchers/details";
const SKF_VEHICLES_SEARCHER = "apps/automotive/searchers/vehicles";
const SKF_IMAGE_BASE_URL = "https://automotive.skf.com/azure/images/products/m";

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

const limit = Math.max(1, Number.parseInt(args.get("limit") || "200", 10) || 200);
const offset = Math.max(0, Number.parseInt(args.get("offset") || "0", 10) || 0);
const concurrency = Math.max(1, Number.parseInt(args.get("concurrency") || "6", 10) || 6);
const requestTimeoutMs = Math.max(5000, Number.parseInt(args.get("timeout-ms") || "20000", 10) || 20000);
const importMode = args.has("import");
const prefixes = String(args.get("seed-prefixes") || "VKBA")
  .split(",")
  .map((value) => normalizeCode(value))
  .filter(Boolean);

const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

fs.mkdirSync(outputDir, { recursive: true });

const restHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const htmlRequestHeaders = {
  ...requestHeaders,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function main() {
  const target = await resolveTargetBrand("SKF");
  const supportsImageColumn = await detectColumn("image_url");
  const supportsEanColumn = await detectColumn("ean");
  const supportsMarketSegmentColumn = await detectColumn("market_segment");
  const rows = await fetchExistingCatalogRows(target.brand_id, { supportsEanColumn, supportsMarketSegmentColumn });
  const candidates = rows
    .filter((row) => prefixes.some((prefix) => row.normalized_code.startsWith(prefix)))
    .filter((row) => shouldProcessRow(row, supportsEanColumn, supportsMarketSegmentColumn))
    .sort(comparePriority)
    .slice(offset, offset + limit);

  const updates = [];
  const errors = [];

  await runPool(candidates, concurrency, async (row, index) => {
    try {
      const resolved = await resolveSkfRow(row, requestTimeoutMs);
      updates.push(buildMergedCatalogRow(target, row, resolved, supportsMarketSegmentColumn));
    } catch (error) {
      errors.push({
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
        console.error(`SKF official fill progress: ${index + 1}/${candidates.length}`);
      }
    }
  });

  const uniqueUpdates = dedupeBy(updates, (row) => row.next?.normalized_code || row.current?.normalized_code || "");
  const changedRows = uniqueUpdates.filter((row) => hasCatalogDelta(row.current, row.next, supportsEanColumn, supportsMarketSegmentColumn));
  const processedBatches = [];

  if (importMode && changedRows.length) {
    const batchSize = 200;
    for (let index = 0; index < changedRows.length; index += batchSize) {
      const batch = changedRows.slice(index, index + batchSize);
      const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
        method: "POST",
        headers: {
          ...restHeaders,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(
          batch.map(({ next }) => ({
            organization_id: next.organization_id,
            brand_id: next.brand_id,
            product_code: next.product_code,
            description: emptyToNull(next.description),
            ...(supportsEanColumn ? { ean: emptyToNull(next.ean) } : {}),
            oem_no: emptyToNull(next.oem_no),
            vehicle: emptyToNull(next.vehicle),
            ...(supportsMarketSegmentColumn ? { market_segment: emptyToNull(next.market_segment) } : {}),
            hs_code: emptyToNull(next.hs_code),
            origin: emptyToNull(next.origin),
            weight_kg: next.weight_kg == null || Number.isNaN(Number(next.weight_kg)) ? null : Number(next.weight_kg),
            image_url: emptyToNull(next.image_url),
            lifecycle_status: emptyToNull(next.lifecycle_status) || "active",
            lifecycle_note: emptyToNull(next.lifecycle_note),
            updated_at: new Date().toISOString(),
          })),
        ),
      });
      if (!response.ok) {
        throw new Error(`catalog_products upsert failed: ${response.status} ${await response.text()}`);
      }
      processedBatches.push({ batch: index / batchSize + 1, rows: batch.length, status: response.status });
    }
  }

  const summary = {
    brand_name: "SKF",
    brand_id: target.brand_id,
    organization_id: target.organization_id,
    prefixes,
    supports_ean_column: supportsEanColumn,
    supports_market_segment_column: supportsMarketSegmentColumn,
    supports_image_column: supportsImageColumn,
    candidate_rows: candidates.length,
    resolved_rows: uniqueUpdates.length,
    changed_rows: changedRows.length,
    error_rows: errors.length,
    processed_batches: processedBatches,
  };
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(outputDir, `skf-official-fill-summary-${timestamp}.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        ...summary,
        summary_path: summaryPath,
        changed_sample: changedRows.slice(0, 5).map(({ current, next }) => ({
          product_code: current.product_code,
          current: summarizeRow(current),
          next: summarizeRow(next),
        })),
        unchanged_sample: uniqueUpdates
          .filter((row) => !hasCatalogDelta(row.current, row.next, supportsEanColumn, supportsMarketSegmentColumn))
          .slice(0, 5)
          .map(({ current, next }) => ({
            product_code: current.product_code,
            current: summarizeRow(current),
            next: summarizeRow(next),
          })),
        error_sample: errors.slice(0, 10),
      },
      null,
      2,
    ),
  );
}

async function resolveTargetBrand(brandName) {
  const rows = await fetchAll(`/rest/v1/brands?select=id,name,organization_id&name=ilike.${encodeURIComponent(brandName)}`);
  const target =
    rows.find((row) => normalizeCode(row.name) === normalizeCode(brandName)) ||
    rows.find((row) => normalizeCode(row.name).includes(normalizeCode(brandName))) ||
    null;
  if (!target?.id || !target?.organization_id) throw new Error(`Brand not found: ${brandName}`);
  return {
    brand_id: String(target.id),
    organization_id: String(target.organization_id),
    name: String(target.name || brandName).trim() || brandName,
  };
}

async function detectColumn(columnName) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=${columnName}&limit=1`, {
    headers: restHeaders,
  });
  if (response.ok) return true;
  const text = await response.text();
  return !new RegExp(`column .*${columnName}`, "i").test(text);
}

async function fetchExistingCatalogRows(brandId, { supportsEanColumn, supportsMarketSegmentColumn }) {
  const results = [];
  const pageLimit = 1000;
  let restOffset = 0;
  const selectColumns = [
    "organization_id",
    "brand_id",
    "product_code",
    "normalized_code",
    "description",
    ...(supportsEanColumn ? ["ean"] : []),
    "oem_no",
    "vehicle",
    ...(supportsMarketSegmentColumn ? ["market_segment"] : []),
    "hs_code",
    "origin",
    "weight_kg",
    "image_url",
    "lifecycle_status",
    "lifecycle_note",
  ].join(",");

  while (true) {
    const rows = await fetchAll(
      `/rest/v1/catalog_products?select=${selectColumns}&brand_id=eq.${encodeURIComponent(brandId)}&limit=${pageLimit}&offset=${restOffset}`,
    );
    if (!rows.length) break;
    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || "").trim(),
          brand_id: String(row.brand_id || brandId).trim(),
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), "SKF"),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
          description: String(row.description || "").trim(),
          ean: normalizeCatalogEan(String(row.ean || "").trim()),
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
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
    restOffset += pageLimit;
  }

  return dedupeBy(results, (row) => row.normalized_code);
}

async function resolveSkfRow(current, requestTimeoutMs) {
  const productCode = current.product_code;
  if (!productCode) throw new Error("Missing SKF product code");

  const [detail, vehicles, productPageHtml] = await Promise.all([
    fetchSkfDetail(productCode, requestTimeoutMs),
    fetchSkfVehicles(productCode, requestTimeoutMs),
    fetchSkfProductPage(productCode, requestTimeoutMs).catch(() => ""),
  ]);

  const articleInformation = Array.isArray(detail?.article_information) ? detail.article_information : [];
  const officialPage = parseSkfOfficialProductPage(productPageHtml, productCode);
  const lifecycleStatus = normalizeLifecycleStatus(detail?.status || current.lifecycle_status || "active");
  const lifecycleNote =
    lifecycleStatus === "discontinued" ? normalizeTextValue(detail?.status || current.lifecycle_note || "") || null : null;

  return {
    product_code: productCode,
    description: pickCatalogDescription(
      [
        officialPage.description,
        detail?.fb1 || "",
        detail?.fb2 || "",
        detail?.type || "",
        detail?.sub_category || "",
        detail?.category || "",
        current.description || "",
        detail?.title || "",
      ],
      productCode,
    ),
    ean: normalizeCatalogEan(officialPage.ean || current.ean || ""),
    oem_no: extractSkfOemNumbers(detail),
    vehicle: extractSkfVehicleLabel(vehicles),
    market_segment: extractSkfMarketSegment(detail, current.market_segment || ""),
    hs_code: extractArticleInfoValue(articleInformation, [/customs tariff/i, /\bhs code\b/i, /\bcommodity code\b/i, /\btariff/i]) || "",
    origin:
      normalizeCatalogOrigin(extractArticleInfoValue(articleInformation, [/country of origin/i, /^origin$/i, /made in/i]) || "") ||
      normalizeOriginValue(extractArticleInfoValue(articleInformation, [/country of origin/i, /^origin$/i, /made in/i]) || ""),
    weight_kg: parseWeightValue(extractArticleInfoValue(articleInformation, [/^weight$/i, /net weight/i, /gross weight/i])),
    image_url: buildSkfImageUrl(detail?.main_image || detail?.photo?.[0] || detail?.picture?.[0] || ""),
    lifecycle_status: lifecycleStatus,
    lifecycle_note: lifecycleNote,
  };
}

function buildMergedCatalogRow(target, current, resolved, supportsMarketSegmentColumn) {
  const displayCode = normalizeCatalogDisplayCode(resolved.product_code, target.name);
  return {
    current,
    next: {
      organization_id: target.organization_id,
      brand_id: target.brand_id,
      product_code: displayCode,
      normalized_code: normalizeCode(displayCode),
      description: pickCatalogDescription([resolved.description, current.description], displayCode) || "",
      ean: resolved.ean || current.ean || "",
      oem_no: resolved.oem_no || current.oem_no || "",
      vehicle: resolved.vehicle || current.vehicle || "",
      market_segment: supportsMarketSegmentColumn ? normalizeCatalogMarketSegment(resolved.market_segment || current.market_segment || "") || "" : "",
      hs_code: resolved.hs_code || current.hs_code || "",
      origin: normalizeCatalogOrigin(resolved.origin || current.origin || "") || resolved.origin || current.origin || "",
      weight_kg: resolved.weight_kg ?? current.weight_kg ?? null,
      image_url: resolved.image_url || current.image_url || "",
      lifecycle_status: normalizeLifecycleStatus(resolved.lifecycle_status || current.lifecycle_status || "active"),
      lifecycle_note: resolved.lifecycle_note || current.lifecycle_note || null,
    },
  };
}

async function fetchSkfDetail(productCode, requestTimeoutMs) {
  const query = `productid=${encodeURIComponent(productCode)}&language=en&region=eur`;
  const payload = await fetchJson(`${SKF_SEARCH_BASE_URL}/${SKF_DETAILS_SEARCHER}?${query}`, requestTimeoutMs);
  const documents = Array.isArray(payload?.part_documents?.documents) ? payload.part_documents.documents : [];
  return documents[0] || null;
}

async function fetchSkfVehicles(productCode, requestTimeoutMs) {
  const query = `productid=${encodeURIComponent(productCode)}&language=en&region=eur`;
  return await fetchJson(`${SKF_SEARCH_BASE_URL}/${SKF_VEHICLES_SEARCHER}?${query}`, requestTimeoutMs);
}

async function fetchSkfProductPage(productCode, requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`https://automotive.skf.com/eur/en/product-catalogue/${encodeURIComponent(productCode)}`, {
      headers: htmlRequestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`SKF product page request failed ${response.status} for ${productCode}`);
    return await response.text();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchJson(url, requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function shouldProcessRow(row, supportsEanColumn, supportsMarketSegmentColumn) {
  return (
    !normalizeTextValue(row.description) ||
    isCatalogPlaceholderDescription(row.description, row.normalized_code || row.product_code) ||
    (supportsEanColumn && !normalizeCatalogEan(row.ean || "")) ||
    !normalizeTextValue(row.oem_no) ||
    !normalizeTextValue(row.vehicle) ||
    (supportsMarketSegmentColumn && !normalizeTextValue(row.market_segment)) ||
    !normalizeTextValue(row.image_url) ||
    !normalizeTextValue(row.hs_code) ||
    !normalizeTextValue(row.origin) ||
    row.weight_kg == null
  );
}

function comparePriority(left, right) {
  return priorityScore(right) - priorityScore(left);
}

function priorityScore(row) {
  let score = 0;
  if (!normalizeCatalogEan(row.ean || "")) score += 8;
  if (!normalizeTextValue(row.vehicle)) score += 7;
  if (!normalizeTextValue(row.oem_no)) score += 6;
  if (!normalizeTextValue(row.image_url)) score += 5;
  if (!normalizeTextValue(row.hs_code)) score += 4;
  if (!normalizeTextValue(row.origin)) score += 3;
  if (row.weight_kg == null) score += 2;
  if (!normalizeTextValue(row.description) || isCatalogPlaceholderDescription(row.description, row.normalized_code || row.product_code)) score += 1;
  return score;
}

function extractSkfOemNumbers(detail) {
  const values = (Array.isArray(detail?.oenumbers) ? detail.oenumbers : [])
    .map((entry) => normalizeTextValue(entry?.oenumber || ""))
    .filter(Boolean);
  return sanitizeCatalogOemNumbers(values.join(", "));
}

function extractSkfVehicleLabel(vehiclesPayload) {
  const facets = Array.isArray(vehiclesPayload?.facets) ? vehiclesPayload.facets : [];
  const manufacturerFacet = facets.find((entry) => normalizeTextValue(entry?.id).toLowerCase() === "manufacturer");
  const facetManufacturers = (manufacturerFacet?.filters || [])
    .map((entry) => normalizeVehicleManufacturer(entry?.displayName || ""))
    .filter(Boolean);
  const documents = Array.isArray(vehiclesPayload?.documentList?.documents) ? vehiclesPayload.documentList.documents : [];
  const docManufacturers = documents.map((entry) => normalizeVehicleManufacturer(entry?.manufacturer || "")).filter(Boolean);
  return dedupeStrings([...facetManufacturers, ...docManufacturers]).join(", ");
}

function extractSkfMarketSegment(detail, fallback) {
  const values = Array.isArray(detail?.vehicle_type) ? detail.vehicle_type : [];
  for (const value of values) {
    const normalized = normalizeCatalogMarketSegment(value);
    if (normalized) return normalized;
  }
  return normalizeCatalogMarketSegment(fallback) || "";
}

function normalizeVehicleManufacturer(value) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  return normalizeCatalogDescription(text.toLowerCase() === text ? text.replace(/^\w/, (letter) => letter.toUpperCase()) : text);
}

function extractArticleInfoValue(articleInformation, patterns) {
  for (const entry of articleInformation) {
    const key = normalizeTextValue(entry?.key || "");
    if (!key) continue;
    if (patterns.some((pattern) => pattern.test(key))) {
      return normalizeTextValue(entry?.value || "");
    }
  }
  return "";
}

function parseWeightValue(value) {
  const text = normalizeTextValue(value);
  if (!text) return null;
  const match = text.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOriginValue(value) {
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

function buildSkfImageUrl(value) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/placeholder-image\.svg/i.test(text)) return "";
  const imagePath = text
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${SKF_IMAGE_BASE_URL}/${imagePath}`;
}

function parseSkfOfficialProductPage(html, productCode) {
  const productSchemaMatch = html.match(
    /<script[^>]+type="application\/ld\+json"[^>]*>\s*(\{.*?"@type":"Product".*?\})\s*<\/script>/is,
  );
  if (!productSchemaMatch) {
    return { description: "", ean: extractPossibleSkfPageEan(html, productCode) };
  }
  try {
    const payload = JSON.parse(productSchemaMatch[1]);
    return {
      description: normalizeCatalogDescription(String(payload.description || "").trim()),
      ean: extractPossibleSkfPageEan(html, productCode),
    };
  } catch {
    return { description: "", ean: extractPossibleSkfPageEan(html, productCode) };
  }
}

function extractPossibleSkfPageEan(html, productCode) {
  const exactCodePattern = productCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const adjacentMatch = html.match(new RegExp(`${exactCodePattern}[\\s\\S]{0,800}?\\b(\\d{8,14})\\b`, "i"));
  if (adjacentMatch?.[1]) return normalizeCatalogEan(adjacentMatch[1]);
  const labeledMatch = html.match(/\bEAN\b[\s:<>-]{0,20}(\d{8,14})\b/i);
  if (labeledMatch?.[1]) return normalizeCatalogEan(labeledMatch[1]);
  return "";
}

function hasCatalogDelta(current, next, supportsEanColumn, supportsMarketSegmentColumn) {
  return (
    normalizeTextValue(current.product_code) !== normalizeTextValue(next.product_code) ||
    normalizeTextValue(current.description) !== normalizeTextValue(next.description) ||
    (supportsEanColumn && normalizeCatalogEan(current.ean || "") !== normalizeCatalogEan(next.ean || "")) ||
    normalizeTextValue(current.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(current.vehicle) !== normalizeTextValue(next.vehicle) ||
    (supportsMarketSegmentColumn && normalizeTextValue(current.market_segment) !== normalizeTextValue(next.market_segment)) ||
    normalizeTextValue(current.hs_code) !== normalizeTextValue(next.hs_code) ||
    normalizeTextValue(current.origin) !== normalizeTextValue(next.origin) ||
    normalizeTextValue(current.image_url) !== normalizeTextValue(next.image_url) ||
    (current.weight_kg ?? null) !== (next.weight_kg ?? null) ||
    normalizeLifecycleStatus(current.lifecycle_status) !== normalizeLifecycleStatus(next.lifecycle_status) ||
    normalizeTextValue(current.lifecycle_note || "") !== normalizeTextValue(next.lifecycle_note || "")
  );
}

async function fetchAll(restPath) {
  const response = await fetch(`${supabaseUrl}${restPath}`, { headers: restHeaders });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${text}`);
  return Array.isArray(rows) ? rows : [];
}

async function runPool(items, concurrencyLimit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrencyLimit, items.length || 1) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

function dedupeBy(items, iteratee) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = iteratee(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeStrings(items) {
  return [...new Set(items.map((value) => normalizeTextValue(value)).filter(Boolean))];
}

function normalizeCode(value) {
  return normalizeTextValue(value).replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function normalizeTextValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function emptyToNull(value) {
  const text = normalizeTextValue(value);
  return text || null;
}

function summarizeRow(row) {
  return {
    description: row.description,
    ean: row.ean,
    oem_no: row.oem_no,
    vehicle: row.vehicle,
    market_segment: row.market_segment,
    hs_code: row.hs_code,
    origin: row.origin,
    weight_kg: row.weight_kg,
    image_url: row.image_url,
    lifecycle_status: row.lifecycle_status,
    lifecycle_note: row.lifecycle_note,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
