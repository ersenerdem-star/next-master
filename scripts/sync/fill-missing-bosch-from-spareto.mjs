#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeCatalogEan } from "../shared/catalog/catalog-standardization.mjs";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const defaultInputCsvPath = path.join(
  repoRoot,
  "docs",
  "bosch-official-description-fill",
  "bosch-official-description-fill-errors-2026-06-04T16-01-29-737Z.csv",
);
const outputDir = path.join(repoRoot, "docs", "spareto-bosch-fill");
const defaultCacheCsvPath = path.join(
  repoRoot,
  "docs",
  "spareto-brand-imports",
  "spareto-bosch-import-2026-05-25T11-44-51-783Z.csv",
);

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

const offset = Number.parseInt(args.get("offset") || "0", 10) || 0;
const limitArg = args.get("limit");
const limit = limitArg == null ? null : Number.parseInt(limitArg, 10) || null;
const importMode = args.has("import");
const sleepMs = Number.parseInt(args.get("sleep-ms") || "150", 10) || 150;
const batchSize = Number.parseInt(args.get("batch-size") || "200", 10) || 200;
const requestTimeoutMs = Number.parseInt(args.get("request-timeout-ms") || "20000", 10) || 20000;
const inputCsvPath = path.resolve(args.get("input") || defaultInputCsvPath);
const cacheCsvPath = path.resolve(args.get("cache-input") || defaultCacheCsvPath);

const supabaseUrl = importMode ? resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "") : String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceRoleKey = importMode ? resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY") : String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

if (importMode && (!supabaseUrl || !serviceRoleKey)) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --import mode");
}

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
  const allRows = parseCsv(fs.readFileSync(inputCsvPath, "utf8"))
    .map((row) => ({
      brand: "Bosch",
      product_code: String(row.Product_Code || row.product_code || "").trim(),
      normalized_code: normalizeCode(row.Product_Code || row.product_code || row.Normalized_Code || row.normalized_code || ""),
    }))
    .filter((row) => row.product_code && row.normalized_code);

  const supportsEanColumn = importMode ? await detectCatalogEanColumn() : false;
  const dedupedRows = dedupeBy(allRows, (row) => row.normalized_code);
  const initialSelectedRows = dedupedRows.slice(offset, limit == null ? undefined : offset + limit);
  let selectedRows = initialSelectedRows;
  let target = null;
  let livePlaceholderCount = null;
  let liveSkippedCount = 0;
  const sparetoCache = loadSparetoCache(cacheCsvPath);
  let cachedMatchCount = 0;
  let liveMatchCount = 0;

  if (importMode) {
    target = await resolveBoschTarget();
    const livePlaceholderCodes = await fetchLivePlaceholderCodes(target, initialSelectedRows.map((row) => row.normalized_code));
    selectedRows = initialSelectedRows.filter((row) => livePlaceholderCodes.has(row.normalized_code));
    livePlaceholderCount = selectedRows.length;
    liveSkippedCount = initialSelectedRows.length - selectedRows.length;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const matchedCsvPath = path.join(outputDir, `spareto-bosch-fill-matched-${timestamp}.csv`);
  const unmatchedCsvPath = path.join(outputDir, `spareto-bosch-fill-unmatched-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `spareto-bosch-fill-summary-${timestamp}.json`);

  const matched = [];
  const unmatched = [];
  const errors = [];

  for (let index = 0; index < selectedRows.length; index += 1) {
    const row = selectedRows[index];
    try {
      const cached = sparetoCache.get(row.normalized_code);
      const result = cached || (await resolveBoschFromSpareto(row.product_code, row.normalized_code));
      if (result) {
        if (cached) {
          cachedMatchCount += 1;
        } else {
          liveMatchCount += 1;
        }
        matched.push(result);
      } else {
        unmatched.push({
          brand: row.brand,
          product_code: row.product_code,
          normalized_code: row.normalized_code,
          reason: "No exact Spareto Bosch match",
        });
      }
    } catch (error) {
      errors.push({
        brand: row.brand,
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (sleepMs > 0 && index < selectedRows.length - 1) {
      await sleep(sleepMs);
    }
  }

  writeCsv(
    matchedCsvPath,
    [
      "Product_Code",
      "Brand",
      "Product_Name",
      "EAN",
      "OEM_No",
      "HS_Code",
      "Origin",
      "Weight_kg",
      "Source_URL",
      "Matched_Spareto_Code",
    ],
    matched.map((row) => [
      row.product_code,
      row.brand,
      row.description,
      row.ean,
      row.oem_no,
      row.hs_code,
      row.origin,
      row.weight_kg == null ? "" : String(row.weight_kg),
      row.source_url,
      row.matched_spareto_code,
    ]),
  );

  writeCsv(
    unmatchedCsvPath,
    ["Brand", "Product_Code", "Normalized_Code", "Reason"],
    [
      ...unmatched.map((row) => [row.brand, row.product_code, row.normalized_code, row.reason]),
      ...errors.map((row) => [row.brand, row.product_code, row.normalized_code, row.error]),
    ],
  );

  const processedBatches = [];
  if (importMode && matched.length) {
    const payload = matched.map((row) => ({
      organization_id: target.organization_id,
      brand_id: target.brand_id,
      product_code: row.product_code,
      description: emptyToNull(row.description),
      oem_no: emptyToNull(row.oem_no),
      hs_code: emptyToNull(row.hs_code),
      origin: emptyToNull(row.origin),
      weight_kg: row.weight_kg == null || Number.isNaN(row.weight_kg) ? null : row.weight_kg,
      updated_at: new Date().toISOString(),
      ...(supportsEanColumn ? { ean: emptyToNull(row.ean) } : {}),
    }));

    for (let index = 0; index < payload.length; index += batchSize) {
      const batch = payload.slice(index, index + batchSize);
      const result = await upsertCatalogBatch(batch);
      processedBatches.push({
        batch: index / batchSize + 1,
        rows: batch.length,
        result,
      });
    }
  }

  const summary = {
    mode: importMode ? "import" : "plan",
    source_file: inputCsvPath,
    selected_rows: selectedRows.length,
    initial_selected_rows: initialSelectedRows.length,
    live_placeholder_rows: livePlaceholderCount,
    live_skipped_rows: liveSkippedCount,
    cache_file: cacheCsvPath,
    cached_match_rows: cachedMatchCount,
    live_match_rows: liveMatchCount,
    offset,
    limit,
    matched_rows: matched.length,
    unmatched_rows: unmatched.length,
    error_rows: errors.length,
    supports_ean_column: supportsEanColumn,
    matched_csv: matchedCsvPath,
    unmatched_csv: unmatchedCsvPath,
    processed_batches: processedBatches,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(execFileSync("npx", ["netlify", "env:get", name], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

async function resolveBoschFromSpareto(productCode, normalizedCode) {
  const searchUrl = `https://spareto.com/products?keywords=${encodeURIComponent(productCode)}`;
  const searchHtml = await fetchText(searchUrl);
  if (searchHtml.includes("Nothing Matches your Search")) {
    return null;
  }

  const cards = extractSearchCards(searchHtml);
  const exactDirect = cards.find(
    (card) =>
      normalizeText(card.brand) === "BOSCH" &&
      normalizeCode(card.item_id) === normalizedCode &&
      card.item_list_id === "search_results_direct",
  );
  const exactAny = cards.find(
    (card) => normalizeText(card.brand) === "BOSCH" && normalizeCode(card.item_id) === normalizedCode,
  );
  const match = exactDirect || exactAny;
  if (!match?.href) {
    return null;
  }

  const sourceUrl = new URL(match.href, "https://spareto.com").toString();
  const detailHtml = await fetchText(sourceUrl);
  const detail = extractDetailProperties(detailHtml);
  const description = deriveSparetoDescription({
    productCode,
    normalizedCode,
    description: detail.product_name || match.item_name || "",
    sourceUrl,
  });

  return {
    brand: "Bosch",
    product_code: productCode,
    description,
    ean: detail.ean || "",
    oem_no: detail.trade_numbers || "",
    hs_code: detail.customs_code || "",
    origin: detail.country_of_origin || "",
    weight_kg: detail.weight_kg,
    source_url: sourceUrl,
    matched_spareto_code: match.item_id,
  };
}

function loadSparetoCache(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  const cache = new Map();
  for (const row of rows) {
    const normalizedCode = normalizeCode(row.Normalized_Code || row.Product_Code || row.product_code || "");
    if (!normalizedCode) continue;
    const productCode = String(row.Product_Code || row.product_code || normalizedCode).trim();
    const sourceUrl = String(row.Source_URL || row.source_url || "").trim();
    const description = deriveSparetoDescription({
      productCode,
      normalizedCode,
      description: row.Product_Name || row.product_name || row.Description || row.description || "",
      sourceUrl,
    });
    const oemNo = String(row.OEM_No || row.oem_no || "").trim();
    const hsCode = String(row.HS_Code || row.hs_code || "").trim();
    const origin = String(row.Origin || row.origin || "").trim();
    const weightKg = parseWeight(row.Weight_kg || row.weight_kg || "");
    const ean = normalizeCatalogEan(row.EAN || row.ean || "");
    if (!description && !ean && !oemNo && !hsCode && !origin && weightKg == null) continue;
    cache.set(normalizedCode, {
      brand: "Bosch",
      product_code: productCode,
      description,
      ean,
      oem_no: oemNo,
      hs_code: hsCode,
      origin,
      weight_kg: weightKg,
      source_url: sourceUrl,
      matched_spareto_code: productCode,
    });
  }
  return cache;
}

function deriveSparetoDescription({ productCode, normalizedCode, description, sourceUrl }) {
  const cleanDescription = cleanText(description);
  if (cleanDescription && normalizeCode(cleanDescription) !== normalizedCode && normalizeCode(cleanDescription) !== normalizeCode(productCode)) {
    return cleanDescription;
  }
  const slugMatch = String(sourceUrl || "").match(/\/products\/([^/]+)\//i);
  const rawSlug = slugMatch ? slugMatch[1] : "";
  const descriptionFromSlug = rawSlug
    .split("-")
    .filter((part) => part && normalizeText(part) !== "BOSCH")
    .join(" ")
    .trim();
  return descriptionFromSlug ? toTitleCase(descriptionFromSlug) : "";
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part.length <= 2 && /[A-Z0-9]/i.test(part) ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`))
    .join(" ");
}

function extractSearchCards(html) {
  const cards = [];
  const cardRegex =
    /<div class='card bg-transparent card-product mt-4'[\s\S]*?data-variant-card-gtm-item-value='([^']+)'[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g;
  for (const match of html.matchAll(cardRegex)) {
    const gtmValue = decodeHtml(match[1]);
    const href = match[2];
    try {
      const data = JSON.parse(gtmValue);
      cards.push({
        item_id: String(data.item_id || "").trim(),
        item_name: String(data.item_name || "").trim(),
        brand: String(data.item_brand || "").trim(),
        item_list_id: String(data.item_list_id || "").trim(),
        href,
      });
    } catch {
      continue;
    }
  }
  return cards;
}

function extractDetailProperties(html) {
  return {
    product_name:
      capture(html, /<p class='m-0 name'>([\s\S]*?)<\/p>/i) ||
      capture(html, /<meta property="og:title" content="([^"]+)"/i) ||
      "",
    trade_numbers: captureTableValue(html, "Trade Numbers"),
    customs_code: captureTableValue(html, "Customs Code"),
    country_of_origin: captureTableValue(html, "Country of Origin"),
    ean: extractSparetoEan(html),
    weight_kg: parseWeight(
      capture(
        html,
        /translation missing: en\.spree\.shared\.variant_item\.weight[\s\S]*?<td>\s*([\d.,]+)\s*Kg\s*<\/td>/i,
      ),
    ),
  };
}

function extractSparetoEan(html) {
  const direct =
    captureTableValue(html, "EAN") ||
    captureTableValue(html, "GTIN") ||
    captureTableValue(html, "Barcode") ||
    capture(html, /(?:EAN|GTIN|Barcode)[^0-9]{0,40}(\d{8,14})/i);
  return normalizeCatalogEan(direct);
}

function captureTableValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return capture(html, new RegExp(`<td>${escaped}<\\/td>\\s*<td>([\\s\\S]*?)<\\/td>`, "i"));
}

function capture(html, regex) {
  const match = html.match(regex);
  return match ? cleanText(match[1]) : "";
}

function cleanText(value) {
  return decodeHtml(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new Error(`Request timeout after ${requestTimeoutMs}ms for ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function resolveBoschTarget() {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands?select=id,organization_id&name=ilike.Bosch&limit=1`, {
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brand lookup failed: ${response.status} ${text}`);
  }
  const rows = await response.json();
  const brand = Array.isArray(rows) ? rows[0] : null;
  if (!brand?.id || !brand?.organization_id) {
    throw new Error("Bosch brand target not found");
  }
  return {
    brand_id: brand.id,
    organization_id: brand.organization_id,
  };
}

async function fetchLivePlaceholderCodes(target, normalizedCodes) {
  const placeholderCodes = new Set();
  const uniqueCodes = [...new Set(normalizedCodes.filter(Boolean))];
  const chunkSize = 200;

  for (let index = 0; index < uniqueCodes.length; index += chunkSize) {
    const chunk = uniqueCodes.slice(index, index + chunkSize);
    const inClause = chunk.map((value) => `"${value}"`).join(",");
    const url = new URL(`${supabaseUrl}/rest/v1/catalog_products`);
    url.searchParams.set("select", "normalized_code,product_code,description");
    url.searchParams.set("organization_id", `eq.${target.organization_id}`);
    url.searchParams.set("brand_id", `eq.${target.brand_id}`);
    url.searchParams.set("normalized_code", `in.(${inClause})`);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Live Bosch placeholder lookup failed: ${response.status} ${text}`);
    }
    const rows = await response.json();
    for (const row of Array.isArray(rows) ? rows : []) {
      const normalizedCode = normalizeCode(row.normalized_code || row.product_code || "");
      if (!normalizedCode) continue;
      const normalizedDescription = normalizeCode(row.description || "");
      if (!normalizedDescription || normalizedDescription === normalizedCode) {
        placeholderCodes.add(normalizedCode);
      }
    }
  }

  return placeholderCodes;
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

function parseCsv(text) {
  const rows = [];
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length === 0) return rows;

  const headers = splitCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function writeCsv(filePath, header, rows) {
  const content = [header, ...rows]
    .map((row) =>
      row
        .map((value) => {
          const raw = value == null ? "" : String(value);
          if (/[",\n]/.test(raw)) {
            return `"${raw.replace(/"/g, '""')}"`;
          }
          return raw;
        })
        .join(","),
    )
    .join("\n");
  fs.writeFileSync(filePath, `${content}\n`, "utf8");
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function parseWeight(value) {
  if (value == null) return null;
  const normalized = String(value).replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyToNull(value) {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

async function detectCatalogEanColumn() {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=ean&limit=1`, { headers });
  if (response.ok) return true;
  const text = await response.text();
  if (String(text || "").toLowerCase().includes("ean")) return false;
  throw new Error(`catalog_products ean probe failed: ${response.status} ${text}`);
}

function dedupeBy(rows, getKey) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = getKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
