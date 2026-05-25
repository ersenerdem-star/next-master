#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { canonicalizeBrandName } from "./_shared/brand-standardization.mjs";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "spareto-reference-fill");

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

const requestedBrand = canonicalizeBrandName(String(args.get("brand-name") || "").trim());
const importMode = args.has("import");
const sleepMs = Number.parseInt(args.get("sleep-ms") || "100", 10) || 100;
const batchSize = Number.parseInt(args.get("batch-size") || "200", 10) || 200;
const requestTimeoutMs = Number.parseInt(args.get("request-timeout-ms") || "20000", 10) || 20000;
const concurrency = Math.max(1, Number.parseInt(args.get("concurrency") || "6", 10) || 6);
const limitArg = args.get("limit");
const limit = limitArg == null ? null : Number.parseInt(limitArg, 10) || null;
const offset = Number.parseInt(args.get("offset") || "0", 10) || 0;

if (!requestedBrand) {
  throw new Error("--brand-name is required");
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

const originCodes = {
  germany: "DE",
  poland: "PL",
  italy: "IT",
  france: "FR",
  spain: "ES",
  czechrepublic: "CZ",
  netherlands: "NL",
  belgium: "BE",
  portugal: "PT",
  austria: "AT",
  hungary: "HU",
  romania: "RO",
  slovakia: "SK",
  slovenia: "SI",
  sweden: "SE",
  denmark: "DK",
  finland: "FI",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  turkey: "TR",
  china: "CN",
  taiwan: "TW",
  japan: "JP",
  korea: "KR",
  southkorea: "KR",
  india: "IN",
  indonesia: "ID",
  thailand: "TH",
  malaysia: "MY",
  vietnam: "VN",
  singapore: "SG",
  philippines: "PH",
  unitedstates: "US",
  usa: "US",
  mexico: "MX",
  brazil: "BR",
  argentina: "AR",
  southafrica: "ZA",
  unitedkingdom: "GB",
  uk: "GB",
};

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileBrand = normalizeFileSegment(requestedBrand);
  const matchedCsvPath = path.join(outputDir, `spareto-${fileBrand}-reference-fill-${timestamp}.csv`);
  const unmatchedCsvPath = path.join(outputDir, `spareto-${fileBrand}-reference-unmatched-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `spareto-${fileBrand}-reference-summary-${timestamp}.json`);

  const target = await resolveTargetBrand(requestedBrand);
  const existingCatalog = await fetchExistingCatalogCodes(target.brand_id);
  const codeReferences = await fetchReferenceCodes(target.brand_id);
  const missingReferenceCodes = codeReferences
    .filter((row) => row.old_code && row.normalized_old_code && !existingCatalog.has(row.normalized_old_code))
    .slice(offset, limit == null ? undefined : offset + limit);

  const matched = [];
  const unmatched = [];

  await runPool(missingReferenceCodes, concurrency, async (row, index) => {
    try {
      const result = await resolveCodeFromSpareto({
        brandName: requestedBrand,
        productCode: row.old_code,
        normalizedCode: row.normalized_old_code,
      });
      if (result) {
        matched.push(result);
      } else {
        unmatched.push({
          product_code: row.old_code,
          normalized_code: row.normalized_old_code,
          reason: "No exact Spareto match found",
        });
      }
    } catch (error) {
      unmatched.push({
        product_code: row.old_code,
        normalized_code: row.normalized_old_code,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if ((index + 1) % 100 === 0 || index + 1 === missingReferenceCodes.length) {
      console.error(`${requestedBrand} reference fill progress: ${index + 1}/${missingReferenceCodes.length}`);
    }
    if (sleepMs > 0 && index < missingReferenceCodes.length - 1) {
      await sleep(sleepMs);
    }
  });

  writeCsv(
    matchedCsvPath,
    [
      "Product_Code",
      "Brand",
      "Product_Name",
      "OEM_No",
      "HS_Code",
      "Origin",
      "Weight_kg",
      "Image_URL",
      "Lifecycle_Status",
      "Lifecycle_Note",
      "Source_URL",
    ],
    matched.map((row) => [
      row.product_code,
      requestedBrand,
      row.description,
      row.oem_no,
      row.hs_code,
      row.origin,
      row.weight_kg == null ? "" : String(row.weight_kg),
      row.image_url,
      row.lifecycle_status,
      row.lifecycle_note,
      row.source_url,
    ]),
  );

  writeCsv(
    unmatchedCsvPath,
    ["Product_Code", "Normalized_Code", "Reason"],
    unmatched.map((row) => [row.product_code, row.normalized_code, row.reason]),
  );

  const dedupedMatched = dedupeBy(matched, (row) => normalizeCode(row.product_code));
  const processedBatches = [];

  if (importMode && dedupedMatched.length) {
    const payload = dedupedMatched.map((row) => ({
      organization_id: target.organization_id,
      brand_id: target.brand_id,
      product_code: row.product_code,
      description: emptyToNull(row.description),
      oem_no: emptyToNull(row.oem_no),
      hs_code: emptyToNull(row.hs_code),
      origin: emptyToNull(row.origin),
      weight_kg: row.weight_kg == null || Number.isNaN(row.weight_kg) ? null : row.weight_kg,
      image_url: emptyToNull(row.image_url),
      lifecycle_status: row.lifecycle_status,
      lifecycle_note: emptyToNull(row.lifecycle_note),
      updated_at: new Date().toISOString(),
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
    brand_name: requestedBrand,
    brand_id: target.brand_id,
    organization_id: target.organization_id,
    reference_rows: codeReferences.length,
    catalog_rows: existingCatalog.size,
    missing_reference_rows: missingReferenceCodes.length,
    matched_rows: dedupedMatched.length,
    unmatched_rows: unmatched.length,
    matched_csv: matchedCsvPath,
    unmatched_csv: unmatchedCsvPath,
    processed_batches: processedBatches,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function resolveTargetBrand(brandName) {
  const rows = await fetchAll(`/rest/v1/brands?select=id,name,organization_id&name=ilike.${encodeURIComponent(brandName)}`);
  const target =
    rows.find((row) => normalizeCode(row.name) === normalizeCode(brandName)) ||
    rows.find((row) => String(row.name || "").toLowerCase().includes(brandName.toLowerCase())) ||
    null;

  if (!target?.id || !target?.organization_id) {
    throw new Error(`Brand not found: ${brandName}`);
  }

  return {
    brand_id: String(target.id),
    organization_id: String(target.organization_id),
  };
}

async function fetchExistingCatalogCodes(brandId) {
  const rows = await fetchAll(
    `/rest/v1/catalog_products?select=normalized_code,product_code&brand_id=eq.${encodeURIComponent(brandId)}`,
  );
  return new Set(rows.map((row) => normalizeCode(row.normalized_code || row.product_code || "")).filter(Boolean));
}

async function fetchReferenceCodes(brandId) {
  const rows = await fetchAll(
    `/rest/v1/item_code_references?select=old_code,normalized_old_code,is_active&brand_id=eq.${encodeURIComponent(brandId)}&is_active=eq.true`,
  );
  return rows.map((row) => ({
    old_code: String(row.old_code || "").trim(),
    normalized_old_code: normalizeCode(row.normalized_old_code || row.old_code || ""),
  }));
}

async function resolveCodeFromSpareto({ brandName, productCode, normalizedCode }) {
  const searchUrl = `https://spareto.com/products?keywords=${encodeURIComponent(productCode)}`;
  const searchHtml = await fetchText(searchUrl);
  if (searchHtml.includes("Nothing Matches your Search")) {
    return null;
  }

  const cards = extractSearchCards(searchHtml);
  const exact = cards.find(
    (card) => normalizeCode(card.brand) === normalizeCode(brandName) && normalizeCode(card.item_id) === normalizedCode,
  );
  if (!exact?.href) {
    return null;
  }

  const sourceUrl = new URL(exact.href, "https://spareto.com").toString();
  const detailHtml = await fetchText(sourceUrl);
  const detail = extractDetailProperties(detailHtml);
  const lifecycle = extractLifecycle(detailHtml);

  return {
    product_code: normalizeDisplayCode(detail.product_code || exact.item_id || productCode),
    description: detail.product_name || exact.item_name || "",
    oem_no: detail.oe_numbers || "",
    hs_code: detail.customs_code || "",
    origin: formatOrigin(detail.country_of_origin),
    weight_kg: detail.weight_kg,
    image_url: sanitizeImageUrl(detail.image_url),
    lifecycle_status: lifecycle.discontinued ? "discontinued" : "active",
    lifecycle_note: lifecycle.note,
    source_url: sourceUrl,
  };
}

function extractSearchCards(html) {
  const cards = [];
  const cardRegex =
    /<div class='card bg-transparent card-product mt-4'[\s\S]*?data-variant-card-gtm-item-value='([^']+)'[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g;
  for (const match of html.matchAll(cardRegex)) {
    try {
      const data = JSON.parse(decodeHtml(match[1]));
      cards.push({
        item_id: String(data.item_id || "").trim(),
        item_name: String(data.item_name || "").trim(),
        brand: String(data.item_brand || "").trim(),
        href: match[2],
      });
    } catch {
      continue;
    }
  }
  return cards;
}

function extractDetailProperties(html) {
  const ogTitle =
    capture(html, /<meta content='([^']+)' property='og:title'>/i) ||
    capture(html, /<meta property="og:title" content="([^"]+)"/i);
  const titleText = capture(html, /<title>([\s\S]*?)<\/title>/i);
  const canonicalPath = capture(html, /<link rel="canonical" href="https:\/\/spareto\.com\/products\/[^/]+\/([^"'?]+)"/i);
  return {
    product_code: canonicalPath || "",
    product_name: extractDetailName(ogTitle || titleText) || capture(html, /<p class='m-0 name'>([\s\S]*?)<\/p>/i) || "",
    image_url:
      capture(html, /<meta content='([^']+)' property='og:image'>/i) ||
      capture(html, /<meta property="og:image" content="([^"]+)"/i) ||
      "",
    customs_code: captureTableValue(html, "Customs Code"),
    country_of_origin: captureTableValue(html, "Country of Origin"),
    weight_kg: parseWeight(
      capture(
        html,
        /translation missing: en\.spree\.shared\.variant_item\.weight[\s\S]*?<td>\s*([\d.,]+)\s*Kg\s*<\/td>/i,
      ),
    ),
    oe_numbers: extractReferenceNumbers(html, "OE Numbers"),
  };
}

function extractReferenceNumbers(html, heading) {
  const escaped = escapeRegExp(heading);
  const sectionMatch = html.match(new RegExp(`<h3[^>]*>${escaped}<\\/h3>([\\s\\S]*?)(?:<h3|<\\/section>)`, "i"));
  if (!sectionMatch) return "";
  const numbers = [];
  for (const match of sectionMatch[1].matchAll(/<a[^>]+href="[^"]+"[^>]*>([\s\S]*?)<\/a>/g)) {
    const value = cleanText(match[1]);
    if (value) numbers.push(value);
  }
  return compactReferenceNumbers(numbers);
}

function extractLifecycle(html) {
  const preAlternatives = html.split("<section class='mb-5' id='nav-alternatives'")[0] || html;
  const discontinued = /No longer deliverable by the manufacturer/i.test(preAlternatives);
  const match = preAlternatives.match(/Product has been replaced by:\s*<\/[^>]+>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
  const replacementCode = match ? cleanText(match[1]) : "";
  return {
    discontinued,
    note: replacementCode ? `Replacement code: ${replacementCode}.` : "",
  };
}

function extractDetailName(value) {
  const text = cleanText(value);
  if (!text) return "";
  return text
    .replace(/\|\s*Spareto\s*$/i, "")
    .replace(/^[A-Z0-9 .-]+\s+[A-Z0-9 .-]+\s+/i, "")
    .replace(/^[A-Z0-9 .-]+\s*-\s*/i, "")
    .trim();
}

function compactReferenceNumbers(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.join(", ");
}

function captureTableValue(html, label) {
  const escaped = escapeRegExp(label);
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

async function fetchAll(initialPath) {
  const results = [];
  const restPageLimit = 1000;
  let offset = 0;
  while (true) {
    const separator = initialPath.includes("?") ? "&" : "?";
    const pathWithRange = `${initialPath}${separator}limit=${restPageLimit}&offset=${offset}`;
    const batch = await getJson(pathWithRange);
    results.push(...batch);
    if (batch.length < restPageLimit) break;
    offset += restPageLimit;
  }
  return results;
}

async function getJson(requestPath) {
  const response = await fetch(`${supabaseUrl}${requestPath}`, { headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data : [];
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

function formatOrigin(value) {
  const raw = String(value || "").replace(/_/g, " ").trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase().replace(/[^a-z]/g, "");
  return originCodes[normalized] || (raw.length <= 3 ? raw.toUpperCase() : raw.replace(/\b\w/g, (letter) => letter.toUpperCase()));
}

function sanitizeImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lowered = text.toLowerCase();
  if (lowered.includes("/no-image.") || lowered.includes("noimage/")) return "";
  return text;
}

function parseWeight(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function normalizeCode(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeDisplayCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeFileSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function writeCsv(filePath, header, rows) {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
