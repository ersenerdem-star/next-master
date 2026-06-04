#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { canonicalizeBrandName, resolveSparetoBrandQuery } from "./_shared/brand-standardization.mjs";
import { normalizeCatalogDescription, normalizeCatalogDisplayCode, normalizeCatalogOrigin } from "./_shared/catalog-standardization.mjs";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "catalog-standardization");

const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

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

const defaultBrands = [
  "Bosch",
  "WABCO",
  "TRW",
  "Lemforder",
  "Mann",
  "Sachs",
  "NRF",
  "SKF",
  "Knorr-Bremse",
  "FAG",
  "Nissens",
  "INA",
  "Donaldson",
  "Valeo",
  "HEPU",
];

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

const requestedBrandsArg = String(args.get("brands") || "");
const rawBrandTokens = requestedBrandsArg
  .split(",")
  .map((value) => String(value || "").trim())
  .filter(Boolean);
const useAllBrands = rawBrandTokens.some((value) => value.toLowerCase() === "all");
const inputBrands = rawBrandTokens
  .map((value) => canonicalizeBrandName(value))
  .filter(Boolean);
const skipListing = args.has("skip-listing");
const pageSize = Math.max(12, Number.parseInt(args.get("page-size") || "48", 10) || 48);
const requestTimeoutMs = Math.max(5000, Number.parseInt(args.get("request-timeout-ms") || "20000", 10) || 20000);
const apply = args.has("apply");

fs.mkdirSync(outputDir, { recursive: true });

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(
    execFileSync("npx", ["netlify", "env:get", name, "--context", "production"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }) || "",
  ).trim();
}

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(outputDir, `catalog-standardization-summary-${timestamp}.json`);
  const csvPath = path.join(outputDir, `catalog-standardization-changes-${timestamp}.csv`);

  const brandRows = await fetchAll("/rest/v1/brands?select=id,name,organization_id&order=name.asc");
  const brands =
    useAllBrands
      ? brandRows.map((row) => canonicalizeBrandName(String(row.name || ""))).filter(Boolean)
      : inputBrands.length
        ? inputBrands
        : defaultBrands;
  const changeRows = [];
  const brandSummaries = [];

  for (const requestedBrand of brands) {
    const targetBrand = canonicalizeBrandName(requestedBrand);
    console.error(`Standardizing ${targetBrand}...`);
    const brandRow = brandRows.find((row) => canonicalizeBrandName(String(row.name || "")) === targetBrand);
    if (!brandRow?.id || !brandRow?.organization_id) {
      brandSummaries.push({
        brand: targetBrand,
        status: "missing-brand",
        rows: 0,
        listingRows: 0,
        changedRows: 0,
      });
      continue;
    }

    const existingRows = await fetchCatalogRows(String(brandRow.id), targetBrand);
    const listingMap = skipListing ? new Map() : await fetchSparetoListingMap(resolveSparetoBrandQuery(targetBrand));
    let changedRows = 0;

    for (const row of existingRows) {
      const nextProductCode = listingMap.get(row.normalized_code) || normalizeCatalogDisplayCode(row.product_code, targetBrand);
      const nextDescription = row.description ? normalizeCatalogDescription(row.description) : "";
      const nextOrigin = row.origin ? normalizeCatalogOrigin(row.origin) : "";
      if (nextProductCode === row.product_code && nextDescription === row.description && nextOrigin === row.origin) continue;

      changeRows.push({
        organization_id: row.organization_id,
        brand_id: row.brand_id,
        normalized_code: row.normalized_code,
        product_code: nextProductCode,
        description: nextDescription || null,
        origin: nextOrigin || null,
        updated_at: new Date().toISOString(),
        __brand: targetBrand,
        __from_code: row.product_code,
        __to_code: nextProductCode,
        __from_description: row.description,
        __to_description: nextDescription,
        __from_origin: row.origin,
        __to_origin: nextOrigin,
      });
      changedRows += 1;
    }

    brandSummaries.push({
      brand: targetBrand,
      status: "ok",
      rows: existingRows.length,
      listingRows: listingMap.size,
      changedRows,
      skipListing,
    });
    console.error(`${targetBrand}: ${changedRows} row(s) queued for standardization.`);
  }

  if (apply && changeRows.length) {
    const payload = changeRows.map((row) => ({
      organization_id: row.organization_id,
      brand_id: row.brand_id,
        product_code: row.product_code,
        description: row.description,
        origin: row.origin,
        updated_at: row.updated_at,
      }));

    for (let index = 0; index < payload.length; index += 300) {
      const batch = payload.slice(index, index + 300);
      const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
      }
    }
  }

  writeCsv(
    csvPath,
    ["Brand", "From_Code", "To_Code", "From_Description", "To_Description", "From_Origin", "To_Origin"],
    changeRows.map((row) => [
      row.__brand,
      row.__from_code,
      row.__to_code,
      row.__from_description,
      row.__to_description,
      row.__from_origin,
      row.__to_origin,
    ]),
  );

  const summary = {
    mode: apply ? "apply" : "plan",
    skipListing,
    brandCount: brands.length,
    changedRows: changeRows.length,
    brands: brandSummaries,
    csvPath,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function fetchCatalogRows(brandId, brandName) {
  const rows = await fetchAll(
    `/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,description,origin&brand_id=eq.${encodeURIComponent(brandId)}&order=product_code.asc`,
  );
  return rows.map((row) => ({
    organization_id: String(row.organization_id || "").trim(),
    brand_id: String(row.brand_id || "").trim(),
    product_code: String(row.product_code || "").trim(),
    normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
    description: String(row.description || "").replace(/\s+/g, " ").trim(),
    origin: String(row.origin || "").replace(/\s+/g, " ").trim(),
  }));
}

async function fetchSparetoListingMap(brandQuery) {
  const map = new Map();
  let page = 1;
  let lastPage = 1;
  let firstPage = true;

  while (true) {
    const url = `https://spareto.com/products?utf8=%E2%9C%93&sort_by=&brand%5B%5D=${encodeURIComponent(brandQuery)}&per_page=${pageSize}&page=${page}`;
    const html = await fetchText(url);
    for (const card of extractListingCards(html, brandQuery)) {
      if (!card.normalized_code) continue;
      map.set(card.normalized_code, card.product_code);
    }
    if (firstPage) {
      lastPage = extractLastPage(html, page);
      firstPage = false;
    }
    if (page >= lastPage) break;
    page += 1;
  }

  return map;
}

function extractListingCards(html, brandQuery) {
  const cards = [];
  const targetBrand = normalizeBrand(brandQuery);
  const cardRegex =
    /<div class='card bg-transparent card-product mt-4'[\s\S]*?data-variant-card-gtm-item-value='([^']+)'[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<img[^>]+(?:data-src|src)="([^"]*)"/g;
  for (const match of html.matchAll(cardRegex)) {
    const gtmValue = decodeHtml(match[1]);
    try {
      const data = JSON.parse(gtmValue);
      const productCode = normalizeCatalogDisplayCode(String(data.item_id || "").trim(), brandQuery);
      const cardBrand = String(data.item_brand || "").trim();
      if (!productCode || normalizeBrand(cardBrand) !== targetBrand) continue;
      cards.push({
        product_code: productCode,
        normalized_code: normalizeCode(productCode),
      });
    } catch {
      continue;
    }
  }
  return cards;
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

async function fetchAll(initialPath) {
  const results = [];
  const restPageLimit = 1000;
  let offset = 0;
  while (true) {
    const separator = initialPath.includes("?") ? "&" : "?";
    const pathWithRange = `${initialPath}${separator}limit=${restPageLimit}&offset=${offset}`;
    const response = await fetch(`${supabaseUrl}${pathWithRange}`, { headers });
    const text = await response.text();
    const batch = text ? JSON.parse(text) : [];
    if (!response.ok) {
      throw new Error(`${response.status} ${text}`);
    }
    results.push(...batch);
    if (batch.length < restPageLimit) break;
    offset += restPageLimit;
  }
  return results;
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
  return await response.text();
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

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");
}

function normalizeBrand(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase()
    .trim();
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
