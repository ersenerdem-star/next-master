#!/usr/bin/env node

/*
 * Bilstein Group catalog collector.
 *
 * This script is discovery-only. It deliberately does not write to
 * catalog_products or catalog_import_stage. Canonical catalog writes must be
 * performed only by the authenticated Catalog Import application flow.
 *
 * Required:
 *   DRY_RUN=1
 *   BRAND=<explicit brand name, for example FEBI>
 *
 * Safe defaults:
 *   START_PAGE=0
 *   MAX_PAGES=1
 *   COUNTRY=TR
 *   VEHICLE_TYPE=CAR
 */

import "dotenv/config";

const brand = String(process.env.BRAND || "").trim();
const dryRun = process.env.DRY_RUN === "1";
const startPage = readPositiveInteger("START_PAGE", 0, { allowZero: true });
const maxPages = readPositiveInteger("MAX_PAGES", 1);
const pageSize = readPositiveInteger("PAGE_SIZE", 50);
const requestDelayMs = readPositiveInteger("REQUEST_DELAY_MS", 250, { allowZero: true });
const country = String(process.env.COUNTRY || "TR").trim().toUpperCase();
const vehicleType = String(process.env.VEHICLE_TYPE || "CAR").trim().toUpperCase();

const apiUrl = "https://partsfinder.bilsteingroup.com/api/articles";

if (!dryRun) {
  fail(
    "Terminal staging is disabled. Use DRY_RUN=1 here; actual import must start in the authenticated Catalog Import UI."
  );
}

if (!brand) {
  fail("BRAND is required. The Bilstein API response must not be silently classified as FEBI.");
}

const summary = {
  mode: "dry_run",
  brand,
  start_page: startPage,
  max_pages: maxPages,
  staged: 0,
  skipped: 0,
  pages: []
};

console.log("BILSTEIN STAGE COLLECTOR START");
console.log("mode=dry_run");
console.log(`brand=${brand}`);
console.log(`pages=${startPage}..${startPage + maxPages - 1}`);
console.log(`country=${country}; vehicle_type=${vehicleType}`);

for (let offset = 0; offset < maxPages; offset += 1) {
  const pageNumber = startPage + offset;
  const payload = await fetchPage(pageNumber, { brand, country, vehicleType });
  const articles = Array.isArray(payload?.data) ? payload.data : [];

  if (articles.length === 0) {
    console.log(`PAGE ${pageNumber}: empty; stopping.`);
    break;
  }

  const { rows, skipped } = makeStageRows({ articles, pageNumber });

  summary.staged += rows.length;
  console.log(`PAGE ${pageNumber}: planned=${rows.length} skipped=${skipped}`);

  summary.skipped += skipped;
  summary.pages.push({ page: pageNumber, fetched: articles.length, staged: rows.length, skipped });

  if (articles.length < pageSize) {
    console.log(`PAGE ${pageNumber}: final short page; stopping.`);
    break;
  }

  await sleep(requestDelayMs);
}

console.log(JSON.stringify(summary, null, 2));
console.log("DRY RUN COMPLETE: no Supabase table was read or written.");
console.log("Actual import must start in the authenticated Catalog Import flow.");

function readPositiveInteger(name, fallback, options = {}) {
  const { allowZero = false } = options;
  const value = Number(process.env[name] ?? fallback);
  const valid = Number.isInteger(value) && (allowZero ? value >= 0 : value > 0);

  if (!valid) {
    fail(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }

  return value;
}

async function fetchPage(pageNumber, filters) {
  const url = new URL(apiUrl);
  url.searchParams.set("page[number]", String(pageNumber));
  url.searchParams.set("page[size]", String(pageSize));
  url.searchParams.set("filter[brands]", filters.brand);
  url.searchParams.set("filter[country]", filters.country);
  url.searchParams.set("filter[vehicleType]", filters.vehicleType);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.api+json",
      "User-Agent": "Next-Master Bilstein stage collector"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Bilstein API ${response.status}: ${body.slice(0, 500)}`);
  }

  return response.json();
}

function makeStageRows({ articles, pageNumber }) {
  const rows = [];
  let skipped = 0;

  for (const [offset, article] of articles.entries()) {
    const productCode = readProductCode(article);

    if (!productCode) {
      skipped += 1;
      continue;
    }

    rows.push({
      row_index: pageNumber * pageSize + offset,
      brand,
      product_code: productCode,
      description: readDescription(article),
      lifecycle_note: `Bilstein Group PartsFinder page ${pageNumber}; collected ${new Date().toISOString()}`
    });
  }

  return { rows, skipped };
}

function readProductCode(article) {
  const attributes = article?.attributes || {};
  const values = [
    attributes.articleNumber,
    attributes.article_number,
    attributes.productNumber,
    attributes.product_number,
    attributes.productCode,
    attributes.product_code,
    attributes.number,
    attributes.code,
    attributes.sku,
    article?.id
  ];

  return values.map(cleanText).find(Boolean) || null;
}

function readDescription(article) {
  const attributes = article?.attributes || {};
  const values = [
    attributes.productDescription,
    attributes.product_description,
    attributes.articleDescription,
    attributes.article_description,
    attributes.shortDescription,
    attributes.short_description,
    attributes.description,
    attributes.name,
    attributes.title
  ];

  for (const candidate of values) {
    if (candidate && typeof candidate === "object") {
      const nested = cleanText(
        candidate.en || candidate.de || candidate.tr || candidate.name || candidate.label || candidate.value
      );
      if (nested) return nested;
    }

    const text = cleanText(candidate);
    if (text) return text;
  }

  return null;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
