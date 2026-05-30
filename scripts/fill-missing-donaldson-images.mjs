#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "donaldson-image-fill");

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
const inputCsvPath = String(args.get("input-csv") || "").trim();
const limitArg = args.get("limit");
const rowLimit = limitArg == null ? null : Math.max(1, Number.parseInt(limitArg, 10) || 0);
const batchSize = Math.max(1, Number.parseInt(args.get("batch-size") || "200", 10) || 200);
const concurrency = Math.max(1, Number.parseInt(args.get("concurrency") || "10", 10) || 10);
const requestTimeoutMs = Math.max(2000, Number.parseInt(args.get("request-timeout-ms") || "12000", 10) || 12000);
const sleepMs = Math.max(0, Number.parseInt(args.get("sleep-ms") || "20", 10) || 20);

fs.mkdirSync(outputDir, { recursive: true });

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const matchedCsvPath = path.join(outputDir, `donaldson-image-fill-${timestamp}.csv`);
  const errorsCsvPath = path.join(outputDir, `donaldson-image-fill-errors-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `donaldson-image-fill-summary-${timestamp}.json`);

  const target = await resolveDonaldsonTarget();
  const supportsImageColumn = await detectCatalogImageColumn();
  if (!supportsImageColumn) {
    throw new Error("catalog_products.image_url column not available");
  }

  const rows = inputCsvPath ? [] : await fetchDonaldsonCatalogRows(target.brand_id);
  const candidates = inputCsvPath ? [] : rows.filter((row) => !String(row.image_url || "").trim());
  const selectedRows = inputCsvPath ? [] : rowLimit == null ? candidates : candidates.slice(0, rowLimit);

  const resolved = inputCsvPath
    ? readResolvedCsv(inputCsvPath).map((row) => ({
        organization_id: target.organization_id,
        brand_id: target.brand_id,
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        image_url: row.image_url,
        action: "update",
      }))
    : [];
  const errors = [];

  if (!inputCsvPath) {
    await runPool(selectedRows, concurrency, async (row, index) => {
      try {
        const imageUrl = await resolveDonaldsonImageUrl(row.product_code);
        if (imageUrl) {
          resolved.push({
            ...row,
            image_url: imageUrl,
            action: "update",
          });
        } else {
          errors.push({
            product_code: row.product_code,
            normalized_code: row.normalized_code,
            error: "Image not found",
          });
        }
      } catch (error) {
        errors.push({
          product_code: row.product_code,
          normalized_code: row.normalized_code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if ((index + 1) % 100 === 0 || index + 1 === selectedRows.length) {
        console.error(`Donaldson image progress: ${index + 1}/${selectedRows.length}`);
      }
      if (sleepMs > 0) {
        await sleep(sleepMs);
      }
    });
  }

  writeCsv(
    matchedCsvPath,
    ["Product_Code", "Normalized_Code", "Image_URL", "Action"],
    resolved.map((row) => [row.product_code, row.normalized_code, row.image_url, row.action]),
  );
  writeCsv(
    errorsCsvPath,
    ["Product_Code", "Normalized_Code", "Error"],
    errors.map((row) => [row.product_code, row.normalized_code, row.error]),
  );

  const processedBatches = [];
  if (applyMode && resolved.length) {
    const payload = resolved.map((row) => ({
      organization_id: row.organization_id,
      brand_id: row.brand_id,
      product_code: row.product_code,
      image_url: row.image_url,
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
    mode: applyMode ? "apply" : "plan",
    brand_name: target.name,
    brand_id: target.brand_id,
    organization_id: target.organization_id,
    existing_rows: rows.length,
    missing_image_rows: candidates.length,
    checked_rows: inputCsvPath ? resolved.length : selectedRows.length,
    resolved_rows: resolved.length,
    error_rows: errors.length,
    apply_rows: applyMode ? resolved.length : 0,
    matched_csv: matchedCsvPath,
    errors_csv: errorsCsvPath,
    processed_batches: processedBatches,
    source_pattern: "https://assets.donaldson.com/<product_code_lower>.700.700.jpg",
    input_csv: inputCsvPath || null,
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

async function fetchDonaldsonCatalogRows(brandId) {
  const results = [];
  const pageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,image_url&brand_id=eq.${encodeURIComponent(brandId)}&limit=${pageLimit}&offset=${offset}`,
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
        organization_id: String(row.organization_id || "").trim(),
        brand_id: String(row.brand_id || brandId).trim(),
        product_code: String(row.product_code || "").trim(),
        normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
        image_url: String(row.image_url || "").trim(),
      })),
    );
    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function resolveDonaldsonImageUrl(productCode) {
  const normalized = normalizeCode(productCode);
  if (!normalized) return "";
  const candidates = [
    `https://assets.donaldson.com/${normalized.toLowerCase()}.700.700.jpg`,
    `https://assets.donaldson.com/${normalized.toUpperCase()}.700.700.jpg`,
  ];
  for (const url of candidates) {
    const ok = await checkImageUrl(url);
    if (ok) return url;
  }
  return "";
}

async function checkImageUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return false;
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      return false;
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
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

async function getJson(resource) {
  const response = await fetch(`${supabaseUrl}${resource}`, { headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${text}`);
  }
  return data;
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

function readResolvedCsv(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(1).map((line) => {
    const [product_code = "", normalized_code = "", image_url = ""] = line.split(",");
    return {
      product_code: String(product_code || "").trim(),
      normalized_code: String(normalized_code || "").trim(),
      image_url: String(image_url || "").trim(),
    };
  }).filter((row) => row.product_code && row.image_url);
}

function toCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/["\n,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
