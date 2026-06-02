#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalizeBrandName } from "./_shared/brand-standardization.mjs";
import {
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  sanitizeCatalogOemNumbers,
} from "./_shared/catalog-standardization.mjs";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "hengst-imports");

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

const sourceDir = String(args.get("source-dir") || "").trim();
const brandName = canonicalizeBrandName(String(args.get("brand-name") || "Hengst").trim() || "Hengst");
const importMode = args.has("import");
const batchSize = Number.parseInt(args.get("batch-size") || "200", 10) || 200;

if (!sourceDir) {
  throw new Error("--source-dir is required");
}

if (importMode && (!supabaseUrl || !serviceRoleKey)) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required with --import");
}

fs.mkdirSync(outputDir, { recursive: true });

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function main() {
  const htmlFiles = listHtmlFiles(sourceDir);
  if (!htmlFiles.length) {
    throw new Error(`No .html, .htm, .xhtml, or .webarchive files found under ${sourceDir}`);
  }

  const rowsByCode = new Map();
  let duplicateRowsCollapsed = 0;

  for (const filePath of htmlFiles) {
    const html = readSourceHtml(filePath);
    const row = extractHengstProduct(html, filePath, brandName);
    if (!row.product_code || !row.normalized_code) continue;
    const existing = rowsByCode.get(row.normalized_code);
    if (existing) {
      duplicateRowsCollapsed += 1;
      rowsByCode.set(row.normalized_code, mergeRows(existing, row));
    } else {
      rowsByCode.set(row.normalized_code, row);
    }
  }

  const rows = [...rowsByCode.values()].sort((a, b) => a.product_code.localeCompare(b.product_code));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = path.join(outputDir, `hengst-catalog-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `hengst-summary-${timestamp}.json`);

  writeCsv(
    csvPath,
    [
      "Product_Code",
      "Internal_Item_Number",
      "Brand",
      "Description",
      "OEM_No",
      "Vehicle",
      "Weight_Kg",
      "Image_URL",
      "Detail_URL",
      "Source_File",
    ],
    rows.map((row) => [
      row.product_code,
      row.internal_item_number,
      brandName,
      row.description,
      row.oem_no,
      row.vehicle,
      row.weight_kg == null ? "" : String(row.weight_kg),
      row.image_url,
      row.detail_url,
      row.source_file,
    ]),
  );

  let target = null;
  let processedBatches = [];
  if (importMode && rows.length) {
    target = await resolveOrCreateTargetBrand(brandName);
    const supportsImageColumn = await detectCatalogImageColumn();
    const supportsWeightColumn = await detectCatalogWeightColumn();
    const payload = rows.map((row) => ({
      organization_id: target.organization_id,
      brand_id: target.brand_id,
      product_code: row.product_code,
      description: emptyToNull(row.description),
      oem_no: emptyToNull(row.oem_no),
      vehicle: emptyToNull(row.vehicle),
      ...(supportsWeightColumn ? { weight_kg: row.weight_kg == null || Number.isNaN(row.weight_kg) ? null : row.weight_kg } : {}),
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
    brand_name: brandName,
    source_dir: sourceDir,
    scanned_files: htmlFiles.length,
    unique_rows: rows.length,
    duplicate_rows_collapsed: duplicateRowsCollapsed,
    csv_path: csvPath,
    summary_path: summaryPath,
    imported_rows: importMode ? rows.length : 0,
    target_brand_id: target?.brand_id || null,
    organization_id: target?.organization_id || null,
    processed_batches: processedBatches,
    note: "Hengst product_code is the visible title code like 'E340H D247'. Numeric item numbers remain secondary references.",
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

function listHtmlFiles(rootDir) {
  const results = [];
  const pending = [path.resolve(rootDir)];
  while (pending.length) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(nextPath);
        continue;
      }
      if (entry.isFile() && /\.(html?|xhtml|webarchive)$/i.test(entry.name)) {
        results.push(nextPath);
      }
    }
  }
  return results;
}

function readSourceHtml(filePath) {
  if (/\.webarchive$/i.test(filePath)) {
    return extractHtmlFromWebArchive(filePath);
  }
  return fs.readFileSync(filePath, "utf8");
}

function extractHtmlFromWebArchive(filePath) {
  const jsonText = execFileSync("plutil", ["-convert", "json", "-o", "-", filePath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const payload = JSON.parse(jsonText);
  const mainResource = payload?.WebMainResource || payload?.MainResource || null;
  const data = mainResource?.WebResourceData?.CF$UID != null
    ? resolveUidData(payload, mainResource.WebResourceData.CF$UID)
    : mainResource?.WebResourceData;
  const text = decodePlistData(data);
  if (!text) {
    throw new Error(`Unable to extract HTML from webarchive: ${filePath}`);
  }
  return text;
}

function resolveUidData(payload, uid) {
  const objects = Array.isArray(payload?.$objects) ? payload.$objects : null;
  if (!objects || !Number.isInteger(uid) || uid < 0 || uid >= objects.length) return null;
  return objects[uid];
}

function decodePlistData(value) {
  if (!value) return "";
  if (typeof value === "string") {
    try {
      return Buffer.from(value, "base64").toString("utf8");
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return Buffer.from(value).toString("utf8");
  }
  if (value?.data && typeof value.data === "string") {
    return Buffer.from(value.data, "base64").toString("utf8");
  }
  return "";
}

function extractHengstProduct(html, filePath, brand) {
  const productCode = normalizeCatalogDisplayCode(extractProductTitleCode(html), brand);
  const internalItemNumber = extractLabelValue(html, "Item number");
  const description = normalizeCatalogDescription(extractDescription(html, productCode));
  const oemNo = sanitizeCatalogOemNumbers(extractOemTableCodes(html).join(", "));
  const vehicle = extractVehicleStrings(html).join(" | ");
  const weightKg = extractWeightKg(html);
  const imageUrl = sanitizeImageUrl(extractPrimaryImage(html));
  const detailUrl = sanitizeDetailUrl(extractCanonicalUrl(html));

  return {
    product_code: productCode,
    normalized_code: normalizeCode(productCode),
    internal_item_number: internalItemNumber,
    description,
    oem_no: oemNo,
    vehicle,
    weight_kg: weightKg,
    image_url: imageUrl,
    detail_url: detailUrl,
    source_file: filePath,
  };
}

function extractProductTitleCode(html) {
  const headingMatch = html.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i);
  if (headingMatch?.[1]) return decodeHtml(headingMatch[1]).trim();

  const titleMatch = html.match(/<title>\s*([^<|]+?)\s*\|/i);
  if (titleMatch?.[1]) return decodeHtml(titleMatch[1]).trim();

  throw new Error("Unable to extract Hengst title code from saved page");
}

function extractDescription(html, productCode) {
  const introDescription = html.match(/<div[^>]*class="c-product-intro__description"[^>]*>\s*([\s\S]*?)\s*<\/div>/i)?.[1];
  if (introDescription) {
    const cleaned = decodeHtml(String(introDescription).replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) return cleaned;
  }

  const productName = extractProductName(html);
  if (productName) return productName;

  const snippet = html.match(/<h1[^>]*>[\s\S]{0,900}?<\/h1>/i)?.[0] || "";
  const cleaned = decodeHtml(snippet.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(productCode, "")
    .replace(/Item number:\s*[A-Z0-9 ]+/i, "")
    .replace(/EAN number:\s*[A-Z0-9 ]+/i, "")
    .trim();
  if (cleaned) return cleaned;

  return extractMetaDescription(html);
}

function extractMetaDescription(html) {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return match?.[1] ? decodeHtml(match[1]).trim() : "";
}

function extractProductName(html) {
  const match = html.match(/<div[^>]*class="c-product-headline__name"[^>]*>\s*([\s\S]*?)\s*<\/div>/i);
  if (!match?.[1]) return "";
  return decodeHtml(String(match[1]).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractLabelValue(html, label) {
  const escaped = escapeRegExp(label);
  const textMatch = html.match(new RegExp(`${escaped}:\\s*([^<\\n\\r]+)`, "i"));
  return textMatch?.[1] ? decodeHtml(textMatch[1]).trim() : "";
}

function extractOemTableCodes(html) {
  const values = new Set();
  for (const match of html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<\/tr>/gi)) {
    const code = decodeHtml(match[1] || "").trim();
    const manufacturer = decodeHtml(match[2] || "").trim();
    if (!code || !manufacturer) continue;
    values.add(code);
  }
  return [...values];
}

function extractVehicleStrings(html) {
  const values = new Set();
  const section = html.match(/<hengst-product-vehicle-data[\s\S]*?<\/hengst-product-vehicle-data>/i)?.[0] || "";
  if (!section) return [...values];

  for (const match of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...String(match[1] || "").matchAll(/<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi)]
      .map((cell) => decodeHtml(String(cell[1] || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!cells.length) continue;
    const text = cells.join(" | ").trim();
    if (text) {
      values.add(text);
    }
  }
  return [...values];
}

function extractWeightKg(html) {
  const section = html.match(/<table[^>]*class="c-product-tab__table"[\s\S]*?Dimensions and weight[\s\S]*?<\/table>/i)?.[0] || "";
  if (!section) return null;
  const match = section.match(/<td[^>]*>\s*Net Weight\s*<\/td>\s*<td[^>]*>[\s\S]*?<li[^>]*>\s*([\d.,]+)\s*<span[^>]*>\s*kg\s*<\/span>/i);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(String(match[1]).replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function extractPrimaryImage(html) {
  const match = html.match(/Images for[\s\S]{0,1500}?<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] ? decodeHtml(match[1]).trim() : "";
}

function extractCanonicalUrl(html) {
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  if (canonical?.[1]) return decodeHtml(canonical[1]).trim();
  const og = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  return og?.[1] ? decodeHtml(og[1]).trim() : "";
}

function sanitizeDetailUrl(url) {
  return String(url || "")
    .replace(/(?:%0D|%0A)+/gi, "")
    .replace(/[\r\n]+/g, "")
    .trim();
}

function mergeRows(existing, incoming) {
  return {
    ...existing,
    product_code: preferValue(existing.product_code, incoming.product_code),
    description: preferValue(existing.description, incoming.description),
    oem_no: preferValue(existing.oem_no, incoming.oem_no),
    vehicle: preferValue(existing.vehicle, incoming.vehicle),
    image_url: preferValue(existing.image_url, incoming.image_url),
    detail_url: preferValue(existing.detail_url, incoming.detail_url),
    internal_item_number: preferValue(existing.internal_item_number, incoming.internal_item_number),
  };
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

async function detectCatalogWeightColumn() {
  try {
    await getJson("/rest/v1/catalog_products?select=weight_kg&limit=1");
    return true;
  } catch (error) {
    if (String(error || "").toLowerCase().includes("weight_kg")) {
      return false;
    }
    throw error;
  }
}

async function upsertCatalogBatch(payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`catalog_products upsert failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data.length : 0;
}

async function fetchAll(initialPath) {
  const results = [];
  const pageLimit = 1000;
  let offset = 0;

  while (true) {
    const separator = initialPath.includes("?") ? "&" : "?";
    const pathWithRange = `${initialPath}${separator}limit=${pageLimit}&offset=${offset}`;
    const batch = await getJson(pathWithRange);
    results.push(...batch);
    if (batch.length < pageLimit) break;
    offset += pageLimit;
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

function sanitizeImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("/no-image.")) return "";
  return text;
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

function preferValue(existing, incoming) {
  const current = String(existing || "").trim();
  const next = String(incoming || "").trim();
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
