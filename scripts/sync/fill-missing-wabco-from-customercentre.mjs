#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "wabco-customercentre-fill");

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

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
const locale = String(args.get("locale") || "en_GB").trim() || "en_GB";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
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
  const target = await resolveWabcoTarget();
  const missingRows = await fetchAll(
    `/rest/v1/catalog_products?select=id,product_code,description,oem_no,hs_code,origin,weight_kg&brand_id=eq.${target.brand_id}&or=(description.is.null,description.eq.)&order=product_code.asc`,
  );

  const dedupedRows = dedupeBy(
    missingRows
      .map((row) => ({
        product_code: String(row.product_code || "").trim(),
        normalized_code: normalizeCode(row.product_code || ""),
      }))
      .filter((row) => row.product_code && row.normalized_code),
    (row) => row.normalized_code,
  );

  const selectedRows = dedupedRows.slice(offset, limit == null ? undefined : offset + limit);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const matchedCsvPath = path.join(outputDir, `wabco-fill-matched-${timestamp}.csv`);
  const unmatchedCsvPath = path.join(outputDir, `wabco-fill-unmatched-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `wabco-fill-summary-${timestamp}.json`);

  const matched = [];
  const unmatched = [];
  const errors = [];

  for (let index = 0; index < selectedRows.length; index += 1) {
    const row = selectedRows[index];
    try {
      const result = await resolveWabcoFromCustomerCentre(row.product_code, row.normalized_code);
      if (result) {
        matched.push(result);
      } else {
        unmatched.push({
          brand: "WABCO",
          product_code: row.product_code,
          normalized_code: row.normalized_code,
          reason: "No exact WABCO detail page match",
        });
      }
    } catch (error) {
      errors.push({
        brand: "WABCO",
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
      "OEM_No",
      "HS_Code",
      "Origin",
      "Weight_kg",
      "Source_URL",
      "Matched_WABCO_Code",
    ],
    matched.map((row) => [
      row.product_code,
      row.brand,
      row.description,
      row.oem_no,
      row.hs_code,
      row.origin,
      row.weight_kg == null ? "" : String(row.weight_kg),
      row.source_url,
      row.matched_wabco_code,
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

  const remainingRows = await fetchAll(
    `/rest/v1/catalog_products?select=id,product_code&brand_id=eq.${target.brand_id}&or=(description.is.null,description.eq.)`,
  );

  const summary = {
    mode: importMode ? "import" : "plan",
    locale,
    selected_rows: selectedRows.length,
    offset,
    limit,
    matched_rows: matched.length,
    unmatched_rows: unmatched.length,
    error_rows: errors.length,
    total_missing_after: remainingRows.length,
    matched_csv: matchedCsvPath,
    unmatched_csv: unmatchedCsvPath,
    processed_batches: processedBatches,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function resolveWabcoFromCustomerCentre(productCode, normalizedCode) {
  const sourceUrl = `https://www.wabco-customercentre.com/catalog/${locale}/${encodeURIComponent(productCode)}`;
  const detailHtml = await fetchText(sourceUrl);
  const detail = extractDetailProperties(detailHtml);

  const matchedCode = normalizeCode(detail.material_number || detail.part_number || "");
  if (!matchedCode || matchedCode !== normalizedCode) {
    return null;
  }

  return {
    brand: "WABCO",
    product_code: productCode,
    description: detail.product_name || "",
    oem_no: detail.replaces || "",
    hs_code: detail.customs_code || "",
    origin: detail.country_of_origin || "",
    weight_kg: detail.weight_kg,
    source_url: sourceUrl,
    matched_wabco_code: detail.material_number || detail.part_number || productCode,
  };
}

function extractDetailProperties(html) {
  return {
    product_name:
      capture(html, /<h1[^>]*>\s*([^<][\s\S]*?)<\/h1>/i) ||
      capture(html, /<meta property="og:title" content="([^"]+)"/i) ||
      "",
    material_number:
      captureLabeledValue(html, "Material Number") ||
      captureLabeledValue(html, "Part Number") ||
      "",
    part_number: captureLabeledValue(html, "Part Number") || "",
    customs_code: captureTableValue(html, "Customs Code"),
    country_of_origin: captureTableValue(html, "Country of Origin"),
    weight_kg:
      parseWeight(captureTableValue(html, "Weight (kg)")) ||
      parseWeight(capture(html, /Weight \(kg\)[\s\S]*?<td>\s*([\d.,]+)\s*<\/td>/i)),
    replaces: extractReplaces(html),
  };
}

function extractReplaces(html) {
  const marker = html.match(/Replaces([\s\S]*?)(Documents|Customer Support|<\/body>)/i);
  if (!marker) return "";
  const section = marker[1];
  const values = [];
  for (const match of section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const value = cleanText(match[1]);
    if (value) values.push(value);
  }
  if (!values.length) {
    for (const match of section.matchAll(/<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/gi)) {
      const brand = cleanText(match[1]);
      const code = cleanText(match[2]);
      if (brand && code) values.push(`${brand} ${code}`);
    }
  }
  return dedupeBy(values, (value) => value).join("; ");
}

function captureLabeledValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    capture(html, new RegExp(`${escaped}:\\s*<\\/[^>]+>\\s*<[^>]+>\\s*([A-Z0-9\\-./ ]{6,})\\s*<`, "i")) ||
    capture(html, new RegExp(`${escaped}:\\s*([A-Z0-9\\-./ ]{6,})`, "i"))
  );
}

function captureTableValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    capture(html, new RegExp(`<td[^>]*>${escaped}<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, "i")) ||
    capture(html, new RegExp(`${escaped}[\\s\\S]*?<td[^>]*>\\s*([\\d.,A-Z ()/-]+?)\\s*<\\/td>`, "i"))
  );
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
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
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

async function resolveWabcoTarget() {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands?select=id,organization_id,name&name=ilike.*WABCO*&limit=5`, {
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Brand lookup failed: ${response.status} ${text}`);
  }
  const rows = await response.json();
  const brand = Array.isArray(rows)
    ? rows.find((row) => String(row.name || "").trim().toUpperCase().includes("WABCO")) || rows[0]
    : null;
  if (!brand?.id || !brand?.organization_id) {
    throw new Error("WABCO brand target not found");
  }
  return {
    brand_id: brand.id,
    organization_id: brand.organization_id,
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

async function fetchAll(endpoint) {
  const response = await fetch(`${supabaseUrl}${endpoint}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase fetch failed: ${response.status} ${text}`);
  }
  return response.json();
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
