#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { canonicalizeBrandName, resolveSparetoBrandSlug } from "./_shared/brand-standardization.mjs";
import { normalizeCatalogDescription, normalizeCatalogDisplayCode } from "./_shared/catalog-standardization.mjs";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "spareto-replacements");

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

const inputBrandName = String(args.get("brand-name") || "").trim();
const brandName = canonicalizeBrandName(inputBrandName);
const brandSlug = String(args.get("brand-slug") || resolveSparetoBrandSlug(inputBrandName || brandName)).trim().toLowerCase();
const importCsvPath = String(args.get("import-csv") || "").trim();
const sourceMode = String(args.get("source") || "").trim().toLowerCase();
const seedUrls = String(args.get("seed-urls") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const importMode = args.has("import");
const sleepMs = Number.parseInt(args.get("sleep-ms") || "50", 10) || 50;
const batchSize = Number.parseInt(args.get("batch-size") || "200", 10) || 200;
const requestTimeoutMs = Number.parseInt(args.get("request-timeout-ms") || "20000", 10) || 20000;
const concurrency = Math.max(1, Number.parseInt(args.get("concurrency") || "6", 10) || 6);
const limitArg = args.get("limit");
const limit = limitArg == null ? null : Number.parseInt(limitArg, 10) || null;

if (!brandName) {
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
  const fileBrand = normalizeFileSegment(brandName);
  const matchedCsvPath = path.join(outputDir, `spareto-${fileBrand}-replacements-${timestamp}.csv`);
  const unresolvedCsvPath = path.join(outputDir, `spareto-${fileBrand}-replacements-unresolved-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `spareto-${fileBrand}-replacements-summary-${timestamp}.json`);

  const target = await resolveTargetBrand(brandName);
  const existingRows = await fetchExistingCatalogRows(target.brand_id);
  const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));

  const sourceRows = loadSourceRows(importCsvPath);
  const sourceByUrl = new Map(sourceRows.map((row) => [row.source_url, row]));
  const sitemapUrls = sourceMode === "sitemap" || (!seedUrls.length && !sourceRows.length)
    ? await fetchBrandUrlsFromSitemaps(brandSlug)
    : [];
  const urls = dedupeUrls([
    ...seedUrls,
    ...sourceRows.map((row) => row.source_url),
    ...sitemapUrls,
  ]);
  const selectedUrls = limit == null ? urls : urls.slice(0, limit);

  if (!selectedUrls.length) {
    throw new Error("No source URLs found. Pass --seed-urls, --import-csv, or --source sitemap");
  }

  const replacementRows = [];
  const catalogRows = [];
  const unresolvedRows = [];
  const queuedReplacementFetches = new Map();

  await runPool(selectedUrls, concurrency, async (url, index) => {
    try {
      const seed = sourceByUrl.get(url) || null;
      const detail = await fetchSparetoDetailPage({
        source_url: url,
        product_code: seed?.product_code || deriveProductCodeFromUrl(url),
        brand_slug: brandSlug,
      });

      const normalizedCode = normalizeCode(detail.product_code);
      const existing = existingByCode.get(normalizedCode) || null;

      if (detail.lifecycle_status === "discontinued" || detail.replacement_code || !existing) {
        catalogRows.push(buildCatalogRow(target, existing, detail));
      }

      if (detail.replacement_code && detail.replacement_same_brand) {
        replacementRows.push({
          organization_id: target.organization_id,
          brand_id: target.brand_id,
          old_code: detail.product_code,
          new_code: detail.replacement_code,
          original_number: null,
          reason: "Automatic replacement. Production stopped by manufacturer.",
          is_active: true,
          source_url: detail.source_url,
        });

        const normalizedReplacement = normalizeCode(detail.replacement_code);
        const existingReplacement = existingByCode.get(normalizedReplacement) || null;
        if (!existingReplacement) {
          queuedReplacementFetches.set(
            detail.replacement_url,
            {
              source_url: detail.replacement_url,
              product_code: detail.replacement_code,
              brand_slug: brandSlug,
            },
          );
        }
      }

      if (detail.lifecycle_status !== "discontinued" && !detail.replacement_code) {
        unresolvedRows.push({
          product_code: detail.product_code,
          source_url: detail.source_url,
          status: "no_replacement_signal",
        });
      }
    } catch (error) {
      unresolvedRows.push({
        product_code: deriveProductCodeFromUrl(url),
        source_url: url,
        status: error instanceof Error ? error.message : String(error),
      });
    }

    if ((index + 1) % 500 === 0 || index + 1 === selectedUrls.length) {
      console.error(`${brandName} replacement progress: ${index + 1}/${selectedUrls.length}`);
    }
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  });

  for (const fetchRequest of queuedReplacementFetches.values()) {
    try {
      const detail = await fetchSparetoDetailPage(fetchRequest);
      const existing = existingByCode.get(normalizeCode(detail.product_code)) || null;
      catalogRows.push(buildCatalogRow(target, existing, detail));
    } catch (error) {
      unresolvedRows.push({
        product_code: fetchRequest.product_code,
        source_url: fetchRequest.source_url,
        status: `replacement_fetch_failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const dedupedCatalogRows = dedupeBy(catalogRows, (row) => normalizeCode(row.product_code));
  const dedupedReplacementRows = dedupeBy(replacementRows, (row) => normalizeCode(row.old_code));

  writeCsv(
    matchedCsvPath,
    ["Product_Code", "Lifecycle_Status", "Lifecycle_Note", "Replacement_Code", "Replacement_Same_Brand", "Source_URL"],
    dedupedCatalogRows
      .filter((row) => row.lifecycle_status === "discontinued" || row.lifecycle_note)
      .map((row) => [
        row.product_code,
        row.lifecycle_status,
        row.lifecycle_note || "",
        extractReplacementCodeFromNote(row.lifecycle_note),
        extractReplacementSameBrand(row.lifecycle_note),
        row.source_url || "",
      ]),
  );

  writeCsv(
    unresolvedCsvPath,
    ["Product_Code", "Source_URL", "Status"],
    unresolvedRows.map((row) => [row.product_code, row.source_url, row.status]),
  );

  const processedBatches = [];
  if (importMode) {
    if (dedupedCatalogRows.length) {
      for (let index = 0; index < dedupedCatalogRows.length; index += batchSize) {
        const batch = dedupedCatalogRows.slice(index, index + batchSize);
        const result = await upsertCatalogBatch(
          batch.map((row) => ({
            organization_id: row.organization_id,
            brand_id: row.brand_id,
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
          })),
        );
        processedBatches.push({ type: "catalog", batch: index / batchSize + 1, rows: batch.length, result });
      }
    }

    if (dedupedReplacementRows.length) {
      for (let index = 0; index < dedupedReplacementRows.length; index += batchSize) {
        const batch = dedupedReplacementRows.slice(index, index + batchSize);
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
    mode: importMode ? "import" : "plan",
    target_brand_id: target.brand_id,
    target_brand_name: target.name,
    organization_id: target.organization_id,
    source_urls: selectedUrls.length,
    sitemap_urls: sitemapUrls.length,
    catalog_rows_prepared: dedupedCatalogRows.length,
    replacement_rows_prepared: dedupedReplacementRows.length,
    discontinued_rows: dedupedCatalogRows.filter((row) => row.lifecycle_status === "discontinued").length,
    same_brand_replacements: dedupedReplacementRows.length,
    unresolved_rows: unresolvedRows.length,
    matched_csv: matchedCsvPath,
    unresolved_csv: unresolvedCsvPath,
    unresolved_sample: unresolvedRows.slice(0, 10),
    processed_batches: processedBatches,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

function loadSourceRows(filePath) {
  if (!filePath) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((value) => String(value || "").trim());
  const productIndex = headers.findIndex((value) => /product_code/i.test(value));
  const urlIndex = headers.findIndex((value) => /source_url/i.test(value));
  if (productIndex < 0 || urlIndex < 0) {
    throw new Error(`Source CSV must contain Product_Code and Source_URL columns: ${filePath}`);
  }
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return {
      product_code: String(cells[productIndex] || "").trim(),
      source_url: String(cells[urlIndex] || "").trim(),
    };
  }).filter((row) => row.product_code && row.source_url);
}

function splitCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  result.push(current);
  return result;
}

async function resolveTargetBrand(requestedBrandName) {
  const brands = await fetchAll("/rest/v1/brands?select=id,name,organization_id&order=name.asc");
  const target =
    brands.find((row) => normalizeBrand(row.name) === normalizeBrand(requestedBrandName)) ||
    brands.find((row) => normalizeBrand(row.name).includes(normalizeBrand(requestedBrandName))) ||
    null;

  if (!target?.id || !target?.organization_id) {
    throw new Error(`Brand not found: ${requestedBrandName}`);
  }

  return {
    brand_id: String(target.id),
    organization_id: String(target.organization_id),
    name: String(target.name || requestedBrandName).trim() || requestedBrandName,
  };
}

async function fetchExistingCatalogRows(brandId) {
  const results = [];
  const restPageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code,description,oem_no,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(brandId)}&limit=${restPageLimit}&offset=${offset}`,
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
        lifecycle_status: String(row.lifecycle_status || "active").trim().toLowerCase(),
        lifecycle_note: String(row.lifecycle_note || "").trim(),
      })),
    );
    if (rows.length < restPageLimit) break;
    offset += restPageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function fetchSparetoDetailPage(input) {
  const html = await fetchText(input.source_url);
  const detail = extractDetailProperties(html);
  const lifecycle = extractCurrentLifecycle(html, input.brand_slug);
  const productCode = normalizeCatalogDisplayCode(
    input.product_code || detail.product_code || deriveProductCodeFromUrl(input.source_url),
    input.brand_name || "",
  );
  return {
    product_code: productCode,
    description: normalizeCatalogDescription(detail.product_name || ""),
    oem_no: detail.oe_numbers || "",
    hs_code: detail.customs_code || "",
    origin: formatOrigin(detail.country_of_origin),
    weight_kg: detail.weight_kg,
    image_url: sanitizeImageUrl(detail.image_url || ""),
    source_url: input.source_url,
    lifecycle_status: lifecycle.discontinued ? "discontinued" : "active",
    lifecycle_note: lifecycle.note,
    replacement_code: lifecycle.replacement_code,
    replacement_url: lifecycle.replacement_url,
    replacement_same_brand: lifecycle.replacement_same_brand,
  };
}

function extractDetailProperties(html) {
  const ogTitle = capture(html, /<meta content='([^']+)' property='og:title'>/i) || capture(html, /<meta property="og:title" content="([^"]+)"/i);
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

function extractCurrentLifecycle(html, targetBrandSlug) {
  const preAlternatives = html.split("<section class='mb-5' id='nav-alternatives'")[0] || html;
  const discontinued = /No longer deliverable by the manufacturer/i.test(preAlternatives);
  const replacementIndex = preAlternatives.search(/Product has been replaced by:/i);
  let replacement_code = "";
  let replacement_url = "";
  let replacement_same_brand = false;

  if (replacementIndex >= 0) {
    const snippet = preAlternatives.slice(replacementIndex, replacementIndex + 1000);
    const match = snippet.match(/<a[^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (match) {
      replacement_url = new URL(match[1], "https://spareto.com").toString();
      replacement_code = cleanText(match[2]);
      replacement_same_brand = new RegExp(`/products/${escapeRegExp(targetBrandSlug)}-`, "i").test(match[1]);
    }
  }

  let note = "";
  if (replacement_code) {
    if (replacement_same_brand) {
      note = `Replacement code: ${replacement_code}.`;
    } else {
      note = `Replacement code: ${replacement_code}.`;
    }
  }

  return {
    discontinued,
    replacement_code,
    replacement_url,
    replacement_same_brand,
    note,
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

function buildCatalogRow(target, existing, detail) {
  const lifecycleStatus = detail.lifecycle_status === "discontinued" ? "discontinued" : (existing?.lifecycle_status || "active");
  const lifecycleNote = detail.lifecycle_note || existing?.lifecycle_note || "";
  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: normalizeCatalogDisplayCode(detail.product_code || existing?.product_code, target.name),
    description: normalizeCatalogDescription(preferCatalogValue(detail.description, existing?.description)),
    oem_no: preferCatalogValue(existing?.oem_no, detail.oem_no),
    hs_code: preferCatalogValue(existing?.hs_code, detail.hs_code),
    origin: preferOrigin(existing?.origin, detail.origin),
    weight_kg: existing?.weight_kg ?? detail.weight_kg ?? null,
    image_url: preferCatalogValue(existing?.image_url, detail.image_url),
    lifecycle_status: lifecycleStatus,
    lifecycle_note: lifecycleNote,
    source_url: detail.source_url,
  };
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

function extractReplacementCodeFromNote(note) {
  const match = String(note || "").match(/Replacement code:\s*([^.\s]+)/i);
  return match ? match[1] : "";
}

function extractReplacementSameBrand(note) {
  return /Replacement code:/i.test(String(note || "")) ? "yes" : "no";
}

function dedupeUrls(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function deriveProductCodeFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const code = pathname.split("/").filter(Boolean).at(-1) || "";
    return normalizeDisplayCode(code);
  } catch {
    return "";
  }
}

function normalizeDisplayCode(value) {
  return normalizeCatalogDisplayCode(value);
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

async function fetchBinary(url) {
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
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function fetchBrandUrlsFromSitemaps(targetBrandSlug) {
  const robots = await fetchText("https://spareto.com/robots.txt");
  const sitemapIndexUrl = capture(robots, /Sitemap:\s*(https:\/\/spareto\.com\/sitemaps\/spareto\.com\/products\/sitemap\.xml\.gz)/i);
  if (!sitemapIndexUrl) {
    throw new Error("Products sitemap index not found in robots.txt");
  }

  const sitemapIndexXml = gunzipToString(await fetchBinary(sitemapIndexUrl));
  const sitemapUrls = Array.from(sitemapIndexXml.matchAll(/<loc>(https:\/\/spareto\.com\/sitemaps\/spareto\.com\/products\/sitemap\d+\.xml\.gz)<\/loc>/g)).map((match) => match[1]);
  const targetPattern = new RegExp(`<loc>(https://spareto\\.com/products/${escapeRegExp(targetBrandSlug)}-[^<]+)</loc>`, "ig");
  const urls = [];

  for (const [index, sitemapUrl] of sitemapUrls.entries()) {
    const xml = gunzipToString(await fetchBinary(sitemapUrl));
    for (const match of xml.matchAll(targetPattern)) {
      urls.push(match[1]);
    }
    if ((index + 1) % 10 === 0 || index + 1 === sitemapUrls.length) {
      console.error(`${brandName} sitemap progress: ${index + 1}/${sitemapUrls.length}`);
    }
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }

  return dedupeUrls(urls);
}

function gunzipToString(buffer) {
  return zlib.gunzipSync(buffer).toString("utf8");
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
  const raw = String(value || "").replace(/_/g, " ").trim();
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
  const unique = Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
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
