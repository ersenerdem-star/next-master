#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "juventa-brand-imports");
const juventaApiBase = "https://admin.juventa.ae/api";

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

const brandId = Number.parseInt(args.get("brand-id") || "", 10);
const requestedBrandName = String(args.get("brand-name") || "").trim();
const importMode = args.has("import");
const sleepMs = Number.parseInt(args.get("sleep-ms") || "90", 10) || 90;
const batchSize = Number.parseInt(args.get("batch-size") || "300", 10) || 300;
const pageSize = Number.parseInt(args.get("page-size") || "100", 10) || 100;
const requestTimeoutMs = Number.parseInt(args.get("request-timeout-ms") || "20000", 10) || 20000;
const limitArg = args.get("limit");
const limit = limitArg == null ? null : Number.parseInt(limitArg, 10) || null;

if (!Number.isFinite(brandId) || brandId <= 0) {
  throw new Error("--brand-id is required");
}
if (!requestedBrandName) {
  throw new Error("--brand-name is required");
}

fs.mkdirSync(outputDir, { recursive: true });

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(outputDir, `juventa-${normalizeFileSegment(requestedBrandName)}-summary-${timestamp}.json`);
  const matchedCsvPath = path.join(outputDir, `juventa-${normalizeFileSegment(requestedBrandName)}-catalog-${timestamp}.csv`);

  const juventaBrand = await resolveJuventaBrand();
  const target = await resolveOrCreateTargetBrand(requestedBrandName);
  const supportsImageColumn = await detectCatalogImageColumn();
  const source = await fetchJuventaBrandCatalog(juventaBrand.id, juventaBrand.name);
  const rows = source.rows;
  const selectedRows = limit == null ? rows : rows.slice(0, limit);

  writeCsv(
    matchedCsvPath,
    ["Product_Code", "Brand", "Product_Name", "OEM_No", "HS_Code", "Origin", "Weight_kg", "Image_URL", "Source_File"],
    selectedRows.map((row) => [
      row.product_code,
      target.name,
      row.description,
      row.oem_no,
      row.hs_code,
      row.origin,
      row.weight_kg == null ? "" : String(row.weight_kg),
      row.image_url,
      row.source_file,
    ]),
  );

  const processedBatches = [];
  if (importMode && selectedRows.length) {
    const payload = selectedRows.map((row) => ({
      organization_id: target.organization_id,
      brand_id: target.brand_id,
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
    juventa_brand_id: juventaBrand.id,
    juventa_brand_name: juventaBrand.name,
    target_brand_id: target.brand_id,
    target_brand_name: target.name,
    organization_id: target.organization_id,
    source_total_rows: source.totalRows,
    source_last_page: source.lastPage,
    unique_rows: rows.length,
    duplicate_rows_collapsed: source.duplicateRowsCollapsed,
    rows_without_description: source.rowsWithoutDescription,
    image_column_supported: supportsImageColumn,
    total_rows: rows.length,
    selected_rows: selectedRows.length,
    imported_rows: importMode ? selectedRows.length : 0,
    batch_size: batchSize,
    page_size: pageSize,
    matched_csv: matchedCsvPath,
    processed_batches: processedBatches,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function resolveJuventaBrand() {
  const payload = await fetchJuventaJson(`${juventaApiBase}/brands`);
  const brands = Array.isArray(payload) ? payload : payload?.data?.brands || [];
  const match =
    brands.find((brand) => Number(brand?.id) === brandId) ||
    brands.find((brand) => normalizeBrand(brand?.name) === normalizeBrand(requestedBrandName)) ||
    null;

  if (!match) {
    throw new Error(`Juventa brand not found: id=${brandId} name=${requestedBrandName}`);
  }

  return {
    id: Number(match.id),
    name: String(match.name || requestedBrandName).trim() || requestedBrandName,
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

async function fetchJuventaBrandCatalog(juventaBrandId, juventaBrandName) {
  const rowsByCode = new Map();
  let page = 1;
  let lastPage = 1;
  let totalRows = 0;
  let duplicateRowsCollapsed = 0;
  let rowsWithoutDescription = 0;

  do {
    const payload = await fetchJuventaJson(`${juventaApiBase}/products?brand_ids=${juventaBrandId}&page=${page}&limit=${pageSize}`);
    const data = payload?.data || {};
    const products = Array.isArray(data.products) ? data.products : [];
    lastPage = Number(data.last_page || 1);
    totalRows = Number(data.total || totalRows || 0);

    for (const product of products) {
      const row = extractJuventaProduct(product, juventaBrandName);
      if (!row.normalized_code) continue;
      if (!row.description) rowsWithoutDescription += 1;
      const existing = rowsByCode.get(row.normalized_code);
      if (existing) {
        duplicateRowsCollapsed += 1;
        rowsByCode.set(row.normalized_code, mergeJuventaRows(existing, row));
      } else {
        rowsByCode.set(row.normalized_code, row);
      }
      if (limit != null && rowsByCode.size >= limit) {
        return {
          rows: Array.from(rowsByCode.values()),
          totalRows,
          lastPage,
          duplicateRowsCollapsed,
          rowsWithoutDescription,
        };
      }
    }

    if (page % 25 === 0 || page === lastPage) {
      console.error(`Juventa ${juventaBrandName}: page ${page}/${lastPage}`);
    }

    page += 1;
    if (sleepMs > 0 && page <= lastPage) {
      await sleep(sleepMs);
    }
  } while (page <= lastPage);

  return {
    rows: Array.from(rowsByCode.values()),
    totalRows,
    lastPage,
    duplicateRowsCollapsed,
    rowsWithoutDescription,
  };
}

function extractJuventaProduct(product, juventaBrandName) {
  const attributes = product?.attributes || {};
  const shippingDetails = attributes.shipping_details || {};
  const rawCode = String(product?.part || "").trim();
  const title = String(product?.title || "").trim();
  const description = extractJuventaDescription(rawCode, title);

  return {
    product_code: rawCode,
    normalized_code: normalizeCode(rawCode),
    description,
    oem_no: emptyToNull(firstJuventaValue(product?.part_old)) || "",
    hs_code: firstJuventaValue(shippingDetails.customs_code),
    origin: formatOrigin(firstJuventaValue(shippingDetails.country_of_origin)),
    weight_kg: parseWeight(firstJuventaValue(shippingDetails.weight)),
    image_url: sanitizeImageUrl(product?.image_url),
    source_file: `juventa-api:${juventaBrandName}`,
  };
}

function mergeJuventaRows(existing, incoming) {
  return {
    ...existing,
    product_code: preferValue(existing.product_code, incoming.product_code),
    description: preferValue(existing.description, incoming.description),
    oem_no: preferValue(existing.oem_no, incoming.oem_no),
    hs_code: preferValue(existing.hs_code, incoming.hs_code),
    origin: preferValue(existing.origin, incoming.origin),
    weight_kg: existing.weight_kg ?? incoming.weight_kg,
    image_url: preferValue(existing.image_url, incoming.image_url),
  };
}

function extractJuventaDescription(rawCode, title) {
  if (!title) return "";
  const normalizedTitle = title.trim();
  const codeRegex = new RegExp(`^${escapeRegExp(rawCode)}\\s*-\\s*`, "i");
  return normalizedTitle.replace(codeRegex, "").trim() || normalizedTitle;
}

async function fetchJuventaJson(url) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json, text/plain, */*",
          "user-agent": "Mozilla/5.0",
        },
      });

      if (response.ok) {
        return await response.json();
      }

      if (response.status === 429 || response.status >= 500) {
        await sleep(Math.min(20000, 1200 * attempt));
        continue;
      }

      throw new Error(`Juventa request failed: ${response.status} ${url}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Juventa request repeatedly failed: ${url}`);
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

function firstJuventaValue(value) {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }
  return String(value || "").trim();
}

function formatOrigin(value) {
  const raw = String(value || "")
    .replace(/_/g, " ")
    .trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase().replace(/[^a-z]/g, "");
  return ORIGIN_CODES[normalized] || (raw.length <= 3 ? raw.toUpperCase() : raw.replace(/\b\w/g, (letter) => letter.toUpperCase()));
}

function parseWeight(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function sanitizeImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("/no-image.")) return "";
  return text;
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  unitedarabemirates: "AE",
  unitedkingdom: "GB",
  uk: "GB",
  usa: "US",
  unitedstates: "US",
  vietnam: "VN",
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
