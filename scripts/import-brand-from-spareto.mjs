#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "spareto-brand-imports");

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

const requestedBrandName = String(args.get("brand-name") || "").trim();
const sparetoBrandQuery = String(args.get("brand-query") || requestedBrandName).trim();
const importMode = args.has("import");
const refreshExisting = args.has("refresh-existing");
const sleepMs = Number.parseInt(args.get("sleep-ms") || "20", 10) || 20;
const batchSize = Number.parseInt(args.get("batch-size") || "300", 10) || 300;
const requestTimeoutMs = Number.parseInt(args.get("request-timeout-ms") || "20000", 10) || 20000;
const concurrency = Math.max(1, Number.parseInt(args.get("concurrency") || "8", 10) || 8);
const pageSize = Math.max(12, Number.parseInt(args.get("page-size") || "48", 10) || 48);
const pageLimitArg = args.get("page-limit");
const pageLimit = pageLimitArg == null ? null : Number.parseInt(pageLimitArg, 10) || null;
const detailLimitArg = args.get("detail-limit");
const detailLimit = detailLimitArg == null ? null : Number.parseInt(detailLimitArg, 10) || null;
const startPage = Math.max(1, Number.parseInt(args.get("start-page") || "1", 10) || 1);

if (!requestedBrandName) {
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

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileBrand = normalizeFileSegment(requestedBrandName);
  const matchedCsvPath = path.join(outputDir, `spareto-${fileBrand}-import-${timestamp}.csv`);
  const errorsCsvPath = path.join(outputDir, `spareto-${fileBrand}-errors-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `spareto-${fileBrand}-summary-${timestamp}.json`);

  const target = await resolveOrCreateTargetBrand(requestedBrandName);
  const supportsImageColumn = await detectCatalogImageColumn();
  const existingRows = await fetchExistingCatalogRows(target.brand_id);
  const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));

  console.error(`${target.name} existing catalog rows: ${existingRows.length}`);

  const listing = await fetchSparetoListing(sparetoBrandQuery);
  console.error(`${target.name} Spareto listing rows: ${listing.rows.length}`);

  const candidates = listing.rows.filter((row) => {
    const existing = existingByCode.get(row.normalized_code);
    if (!existing) return true;
    if (refreshExisting) return true;
    return isIncomplete(existing);
  });
  const selectedCandidates = detailLimit == null ? candidates : candidates.slice(0, detailLimit);

  console.error(`${target.name} candidate detail rows: ${selectedCandidates.length}`);

  const resolvedRows = [];
  const errorRows = [];

  await runPool(selectedCandidates, concurrency, async (candidate, index) => {
    try {
      const detail = await fetchSparetoDetail(candidate);
      const existing = existingByCode.get(candidate.normalized_code) || null;
      resolvedRows.push(buildCatalogRow(target, candidate, detail, existing));
    } catch (error) {
      errorRows.push({
        product_code: candidate.product_code,
        normalized_code: candidate.normalized_code,
        source_url: candidate.source_url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if ((index + 1) % 100 === 0 || index + 1 === selectedCandidates.length) {
      console.error(`${target.name} detail progress: ${index + 1}/${selectedCandidates.length}`);
    }
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  });

  const mergedRows = dedupeBy(resolvedRows, (row) => row.normalized_code);

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
      "Source_URL",
      "Action",
    ],
    mergedRows.map((row) => [
      row.product_code,
      target.name,
      row.description,
      row.oem_no,
      row.hs_code,
      row.origin,
      row.weight_kg == null ? "" : String(row.weight_kg),
      row.image_url,
      row.source_url,
      row.__action,
    ]),
  );

  writeCsv(
    errorsCsvPath,
    ["Product_Code", "Normalized_Code", "Source_URL", "Error"],
    errorRows.map((row) => [row.product_code, row.normalized_code, row.source_url, row.error]),
  );

  const processedBatches = [];
  if (importMode && mergedRows.length) {
    const payload = mergedRows.map((row) => ({
      organization_id: row.organization_id,
      brand_id: row.brand_id,
      product_code: row.product_code,
      description: emptyToNull(row.description),
      oem_no: emptyToNull(row.oem_no),
      hs_code: emptyToNull(row.hs_code),
      origin: emptyToNull(row.origin),
      weight_kg: row.weight_kg == null || Number.isNaN(row.weight_kg) ? null : row.weight_kg,
      ...(supportsImageColumn ? { image_url: emptyToNull(row.image_url) } : {}),
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
    target_brand_id: target.brand_id,
    target_brand_name: target.name,
    organization_id: target.organization_id,
    existing_rows: existingRows.length,
    listing_pages_processed: listing.pagesProcessed,
    listing_last_page: listing.lastPage,
    listing_unique_rows: listing.rows.length,
    new_rows_in_listing: listing.rows.filter((row) => !existingByCode.has(row.normalized_code)).length,
    incomplete_existing_rows: listing.rows.filter((row) => {
      const existing = existingByCode.get(row.normalized_code);
      return existing ? isIncomplete(existing) : false;
    }).length,
    refresh_existing: refreshExisting,
    candidate_rows: selectedCandidates.length,
    resolved_rows: mergedRows.length,
    error_rows: errorRows.length,
    import_rows: importMode ? mergedRows.length : 0,
    supports_image_column: supportsImageColumn,
    matched_csv: matchedCsvPath,
    errors_csv: errorsCsvPath,
    processed_batches: processedBatches,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function resolveOrCreateTargetBrand(brandName) {
  const existingBrands = await fetchAll("/rest/v1/brands?select=id,name,organization_id&order=name.asc");
  const exact =
    existingBrands.find((row) => normalizeBrand(row.name) === normalizeBrand(brandName)) ||
    existingBrands.find((row) => normalizeBrand(row.name).includes(normalizeBrand(brandName))) ||
    null;

  if (exact?.id && exact?.organization_id) {
    return {
      brand_id: String(exact.id),
      organization_id: String(exact.organization_id),
      name: String(exact.name || brandName).trim() || brandName,
    };
  }

  const seedOrgId = String(existingBrands[0]?.organization_id || "").trim();
  if (!seedOrgId) {
    throw new Error("Could not resolve organization_id from brands table");
  }

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
  if (!response.ok) {
    throw new Error(`Brand create failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const created = Array.isArray(data) ? data[0] : data;
  if (!created?.id) {
    throw new Error(`Brand create returned no id: ${JSON.stringify(data)}`);
  }

  return {
    brand_id: String(created.id),
    organization_id: seedOrgId,
    name: brandName.trim(),
  };
}

async function detectCatalogImageColumn() {
  try {
    await getJson("/rest/v1/catalog_products?select=image_url&limit=1");
    return true;
  } catch (error) {
    if (String(error || "").toLowerCase().includes("image_url")) {
      return false;
    }
    throw error;
  }
}

async function fetchExistingCatalogRows(brandId) {
  const results = [];
  const restPageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code,description,oem_no,hs_code,origin,weight_kg,image_url&brand_id=eq.${encodeURIComponent(brandId)}&limit=${restPageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!response.ok) {
      throw new Error(`catalog_products fetch failed: ${response.status} ${text}`);
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows.map((row) => ({
        product_code: String(row.product_code || "").trim(),
        normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
        description: String(row.description || "").trim(),
        oem_no: String(row.oem_no || "").trim(),
        hs_code: String(row.hs_code || "").trim(),
        origin: String(row.origin || "").trim(),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        image_url: String(row.image_url || "").trim(),
      })),
    );
    if (rows.length < restPageLimit) break;
    offset += restPageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function fetchSparetoListing(brandQuery) {
  const rowsByCode = new Map();
  let page = startPage;
  let lastPage = startPage;
  let pagesProcessed = 0;

  while (true) {
    const url = `https://spareto.com/products?utf8=%E2%9C%93&sort_by=&brand%5B%5D=${encodeURIComponent(brandQuery)}&per_page=${pageSize}&page=${page}`;
    const html = await fetchText(url);
    const cards = extractListingCards(html, brandQuery);
    if (pagesProcessed === 0) {
      lastPage = extractLastPage(html, page);
      if (pageLimit != null) {
        lastPage = Math.min(lastPage, startPage + pageLimit - 1);
      }
    }

    for (const card of cards) {
      if (!card.normalized_code) continue;
      const existing = rowsByCode.get(card.normalized_code);
      rowsByCode.set(card.normalized_code, mergeListingCards(existing, card));
    }

    pagesProcessed += 1;
    if (page % 25 === 0 || page === lastPage) {
      console.error(`${brandQuery} listing page ${page}/${lastPage}`);
    }

    if (page >= lastPage) break;
    page += 1;
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }

  return {
    rows: Array.from(rowsByCode.values()),
    pagesProcessed,
    lastPage,
  };
}

function extractListingCards(html, brandQuery) {
  const cards = [];
  const targetBrand = normalizeBrand(brandQuery);
  const cardRegex =
    /<div class='card bg-transparent card-product mt-4'[\s\S]*?data-variant-card-gtm-item-value='([^']+)'[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<img[^>]+(?:data-src|src)="([^"]*)"/g;
  for (const match of html.matchAll(cardRegex)) {
    const gtmValue = decodeHtml(match[1]);
    const href = match[2];
    const imageUrl = match[3];
    try {
      const data = JSON.parse(gtmValue);
      const productCode = String(data.item_id || "").trim();
      const cardBrand = String(data.item_brand || "").trim();
      if (!productCode || normalizeBrand(cardBrand) !== targetBrand) continue;
      cards.push({
        product_code: productCode,
        normalized_code: normalizeCode(productCode),
        description: String(data.item_name || "").trim(),
        brand: cardBrand,
        source_url: new URL(href, "https://spareto.com").toString(),
        image_url: sanitizeImageUrl(imageUrl),
      });
    } catch {
      continue;
    }
  }
  return cards;
}

function mergeListingCards(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing,
    product_code: preferValue(existing.product_code, incoming.product_code),
    description: preferValue(existing.description, incoming.description),
    image_url: preferValue(existing.image_url, incoming.image_url),
    source_url: preferValue(existing.source_url, incoming.source_url),
  };
}

function extractLastPage(html, fallback) {
  let maxPage = fallback;
  for (const match of html.matchAll(/page=(\d+)/g)) {
    const page = Number.parseInt(match[1], 10);
    if (Number.isFinite(page) && page > maxPage) {
      maxPage = page;
    }
  }
  return maxPage;
}

async function fetchSparetoDetail(card) {
  const html = await fetchText(card.source_url);
  const detail = extractDetailProperties(html);
  return {
    product_code: card.product_code,
    normalized_code: card.normalized_code,
    description: detail.product_name || card.description || "",
    oem_no: detail.oe_numbers || "",
    hs_code: detail.customs_code || "",
    origin: formatOrigin(detail.country_of_origin),
    weight_kg: detail.weight_kg,
    image_url: sanitizeImageUrl(detail.image_url || card.image_url),
    source_url: card.source_url,
  };
}

function extractDetailProperties(html) {
  const ogTitle = capture(html, /<meta content='([^']+)' property='og:title'>/i) || capture(html, /<meta property="og:title" content="([^"]+)"/i);
  const titleText = capture(html, /<title>([\s\S]*?)<\/title>/i);
  return {
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

function captureTableValue(html, label) {
  const escaped = escapeRegExp(label);
  return capture(html, new RegExp(`<td>${escaped}<\\/td>\\s*<td>([\\s\\S]*?)<\\/td>`, "i"));
}

function buildCatalogRow(target, candidate, detail, existing) {
  const nextDescription = preferCatalogValue(existing?.description, detail.description, candidate.description);
  const nextOemNo = preferCatalogValue(existing?.oem_no, detail.oem_no);
  const nextHsCode = preferCatalogValue(existing?.hs_code, detail.hs_code);
  const nextOrigin = preferOrigin(existing?.origin, detail.origin);
  const nextWeight = existing?.weight_kg ?? detail.weight_kg ?? null;
  const nextImage = preferCatalogValue(existing?.image_url, detail.image_url, candidate.image_url);

  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: preferCatalogValue(existing?.product_code, detail.product_code, candidate.product_code),
    normalized_code: candidate.normalized_code,
    description: nextDescription,
    oem_no: nextOemNo,
    hs_code: nextHsCode,
    origin: nextOrigin,
    weight_kg: nextWeight,
    image_url: nextImage,
    source_url: detail.source_url || candidate.source_url,
    __action: existing ? "update" : "insert",
  };
}

function isIncomplete(row) {
  return !String(row.description || "").trim() ||
    !String(row.oem_no || "").trim() ||
    !String(row.hs_code || "").trim() ||
    !String(row.origin || "").trim() ||
    row.weight_kg == null ||
    Number.isNaN(Number(row.weight_kg)) ||
    !String(row.image_url || "").trim();
}

function preferCatalogValue(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function preferOrigin(existing, incoming) {
  const current = String(existing || "").trim().toUpperCase();
  const next = String(incoming || "").trim().toUpperCase();
  if (!current) return next;
  if (!next) return current;
  if (current.length > 2 && next.length <= 3) return next;
  return current;
}

function preferValue(existing, incoming) {
  const current = String(existing || "").trim();
  const next = String(incoming || "").trim();
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
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

function compactReferenceNumbers(values, maxLength = 1000) {
  const unique = Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  const kept = [];
  let totalLength = 0;
  for (const value of unique) {
    const nextLength = kept.length === 0 ? value.length : totalLength + 2 + value.length;
    if (nextLength > maxLength) break;
    kept.push(value);
    totalLength = nextLength;
  }
  return kept.join(", ");
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

function parseWeight(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function formatOrigin(value) {
  const raw = String(value || "")
    .replace(/_/g, " ")
    .trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase().replace(/[^a-z]/g, "");
  return ORIGIN_CODES[normalized] || (raw.length <= 3 ? raw.toUpperCase() : raw.replace(/\b\w/g, (letter) => letter.toUpperCase()));
}

function sanitizeImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lowered = text.toLowerCase();
  if (lowered.includes("/no-image.") || lowered.includes("noimage/")) return "";
  return text;
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

function normalizeBrand(value) {
  return normalizeCode(value).replace(/\d+/g, "");
}

function normalizeCode(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeFileSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text ? text : null;
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ORIGIN_CODES = {
  austria: "AT",
  belgium: "BE",
  brazil: "BR",
  bulgaria: "BG",
  canada: "CA",
  china: "CN",
  croatia: "HR",
  czechrepublic: "CZ",
  czechia: "CZ",
  denmark: "DK",
  estonia: "EE",
  finland: "FI",
  france: "FR",
  germany: "DE",
  greece: "GR",
  hungary: "HU",
  india: "IN",
  indonesia: "ID",
  ireland: "IE",
  israel: "IL",
  italy: "IT",
  japan: "JP",
  latvia: "LV",
  lithuania: "LT",
  malaysia: "MY",
  mexico: "MX",
  netherlands: "NL",
  norway: "NO",
  poland: "PL",
  portugal: "PT",
  romania: "RO",
  serbia: "RS",
  singapore: "SG",
  slovakia: "SK",
  slovenia: "SI",
  southafrica: "ZA",
  southkorea: "KR",
  korea: "KR",
  spain: "ES",
  sweden: "SE",
  switzerland: "CH",
  taiwan: "TW",
  thailand: "TH",
  turkey: "TR",
  unitedkingdom: "GB",
  unitedstates: "US",
};

await main();
