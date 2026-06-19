#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const juventaDir = "/Users/ersen/Documents/Codex/2026-04-19-merhaba-bana-ototmotiv-grubunda-yer-alan";
const outputDir = path.join(repoRoot, "docs", "juventa-catalog-fill");
const juventaApiBase = "https://admin.juventa.ae/api";

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const batchSize = Number(process.env.CATALOG_IMPORT_BATCH_SIZE || 500);
const mode = process.argv.includes("--plan-only") ? "plan" : "import";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

fs.mkdirSync(outputDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const summaryPath = path.join(outputDir, `juventa-fill-summary-${timestamp}.json`);
const matchedCsvPath = path.join(outputDir, `juventa-fill-import-${timestamp}.csv`);
const unmatchedCsvPath = path.join(outputDir, `juventa-fill-unmatched-${timestamp}.csv`);

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function main() {
  const brands = await fetchAll("/rest/v1/brands?select=id,name,organization_id");
  const brandById = new Map(brands.map((row) => [row.id, row]));

  const missingRows = await fetchAll(
    "/rest/v1/catalog_products?select=id,product_code,description,oem_no,hs_code,origin,weight_kg,brand_id&or=(description.is.null,description.eq.)&order=brand_id.asc,product_code.asc",
  );

  const missing = missingRows
    .map((row) => ({
      id: row.id,
      product_code: row.product_code || "",
      normalized_code: normalizeCode(row.product_code),
      description: row.description || "",
      oem_no: row.oem_no || "",
      hs_code: row.hs_code || "",
      origin: row.origin || "",
      weight_kg: row.weight_kg,
      brand_id: row.brand_id,
      brand: brandById.get(row.brand_id)?.name || "",
    }))
    .filter((row) => row.normalized_code && row.brand);

  const missingByBrand = countBy(missing, (row) => row.brand);
  const sourceCatalog = loadJuventaCatalog();
  mergeCatalogMaps(sourceCatalog, loadSupplementalCatalog());
  const juventaBrands = await fetchJuventaBrands();
  const targetBrands = Array.from(new Set(missing.map((row) => row.brand))).sort((left, right) => left.localeCompare(right));
  const juventaCatalog = await loadJuventaLiveCatalog(targetBrands, juventaBrands);

  const matched = [];
  const unmatched = [];

  for (const row of missing) {
    const brandKey = normalizeBrand(row.brand);
    const sourceBrand = juventaCatalog.get(brandKey) || sourceCatalog.get(brandKey);
    const sourceRow = sourceBrand?.get(row.normalized_code);

    if (sourceRow?.description) {
      matched.push({
        brand: row.brand,
        product_code: sourceRow.product_code || row.product_code,
        description: sourceRow.description,
        oem_no: sourceRow.oem_no,
        hs_code: sourceRow.hs_code,
        origin: sourceRow.origin,
        weight_kg: sourceRow.weight_kg,
        source_file: sourceRow.source_file,
      });
      continue;
    }

    unmatched.push({
      brand: row.brand,
      product_code: row.product_code,
      normalized_code: row.normalized_code,
    });
  }

  writeCsv(
    matchedCsvPath,
    ["Product_Code", "Brand", "Product_Name", "OEM_No", "HS_Code", "Origin", "Weight_kg", "Source_File"],
    matched.map((row) => [
      row.product_code,
      row.brand,
      row.description,
      row.oem_no,
      row.hs_code,
      row.origin,
      row.weight_kg == null ? "" : row.weight_kg,
      row.source_file,
    ]),
  );

  writeCsv(
    unmatchedCsvPath,
    ["Brand", "Product_Code", "Normalized_Code"],
    unmatched.map((row) => [row.brand, row.product_code, row.normalized_code]),
  );

  const importPayload = matched.map((row) => ({
    brand: row.brand,
    product_code: row.product_code,
    description: row.description,
    oem_no: emptyToNull(row.oem_no),
    hs_code: emptyToNull(row.hs_code),
    origin: emptyToNull(row.origin),
    weight_kg: row.weight_kg == null || Number.isNaN(row.weight_kg) ? null : row.weight_kg,
  }));

  const processedBatches = [];
  if (mode === "import" && importPayload.length) {
    for (let index = 0; index < importPayload.length; index += batchSize) {
      const batch = importPayload.slice(index, index + batchSize);
      const result = await rpc("bulk_import_catalog", batch);
      processedBatches.push({
        batch: index / batchSize + 1,
        rows: batch.length,
        result,
      });
    }
  }

  const remainingRows = await fetchAll(
    "/rest/v1/catalog_products?select=id,product_code,brand_id&or=(description.is.null,description.eq.)",
  );
  const remainingByBrand = countBy(
    remainingRows.map((row) => ({
      brand: brandById.get(row.brand_id)?.name || "",
    })),
    (row) => row.brand || "Unknown",
  );

  const summary = {
    mode,
    total_missing_before: missing.length,
    missing_by_brand_before: sortCounts(missingByBrand),
    matched_rows: matched.length,
    matched_by_brand: sortCounts(countBy(matched, (row) => row.brand)),
    unmatched_rows: unmatched.length,
    unmatched_by_brand: sortCounts(countBy(unmatched, (row) => row.brand)),
    juventa_brand_map: targetBrands.map((brand) => ({
      brand,
      juventa_brand: juventaCatalog.get(normalizeBrand(brand))?.__meta?.brand_name || null,
      juventa_brand_id: juventaCatalog.get(normalizeBrand(brand))?.__meta?.brand_id || null,
    })),
    processed_batches: processedBatches,
    total_missing_after: remainingRows.length,
    missing_by_brand_after: sortCounts(remainingByBrand),
    output_files: {
      matched_csv: matchedCsvPath,
      unmatched_csv: unmatchedCsvPath,
    },
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

function loadJuventaCatalog() {
  const catalog = new Map();
  const files = fs
    .readdirSync(juventaDir)
    .filter((name) => /^juventa_.*_(products|catalog_import_ready)\.csv$/i.test(name))
    .filter((name) => !/^juventa_bosch_name_fix_/i.test(name));

  for (const fileName of files) {
    const filePath = path.join(juventaDir, fileName);
    const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
    for (const row of rows) {
      const brand = String(row.Brand || "").trim();
      const productCode = String(row.Product_Code || "").trim();
      const description = String(row.Product_Name || row.Description || "").trim();
      const normalizedBrand = normalizeBrand(brand);
      const normalizedCode = normalizeCode(productCode);
      if (!normalizedBrand || !normalizedCode || !description) continue;

      const brandCatalog = catalog.get(normalizedBrand) || new Map();
      if (!catalog.has(normalizedBrand)) {
        catalog.set(normalizedBrand, brandCatalog);
      }

      if (!brandCatalog.has(normalizedCode)) {
        brandCatalog.set(normalizedCode, {
          product_code: productCode,
          description,
          oem_no: String(row.OEM_No || "").trim(),
          hs_code: String(row.HS_Code || "").trim(),
          origin: String(row.Origin || "").trim(),
          weight_kg: parseWeight(row.Weight_kg),
          source_file: fileName,
        });
      }
    }
  }

  return catalog;
}

function loadSupplementalCatalog() {
  const catalog = new Map();
  const files = fs
    .readdirSync(juventaDir)
    .filter((name) => /missing.*\.csv$/i.test(name))
    .filter((name) => !/unmatched/i.test(name));

  for (const fileName of files) {
    const filePath = path.join(juventaDir, fileName);
    const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
    for (const row of rows) {
      const brand = String(row.Brand || "").trim();
      const productCode = String(row.Product_Code || row.CODE || row["Part No."] || "").trim();
      const description = String(row.Product_Name || row.Description || row.MANUFACTURER || "").trim();
      const normalizedBrand = normalizeBrand(brand);
      const normalizedCode = normalizeCode(productCode);
      if (!normalizedBrand || !normalizedCode || !description) continue;

      const brandCatalog = catalog.get(normalizedBrand) || new Map();
      if (!catalog.has(normalizedBrand)) {
        catalog.set(normalizedBrand, brandCatalog);
      }

      if (!brandCatalog.has(normalizedCode)) {
        brandCatalog.set(normalizedCode, {
          product_code: productCode,
          description,
          oem_no: String(row.OEM_No || "").trim(),
          hs_code: String(row.HS_Code || "").trim(),
          origin: String(row.Origin || "").trim(),
          weight_kg: parseWeight(row.Weight_kg),
          source_file: fileName,
        });
      }
    }
  }

  return catalog;
}

function mergeCatalogMaps(target, source) {
  for (const [brandKey, rows] of source.entries()) {
    const targetRows = target.get(brandKey) || new Map();
    if (!target.has(brandKey)) {
      target.set(brandKey, targetRows);
    }
    for (const [normalizedCode, row] of rows.entries()) {
      if (!targetRows.has(normalizedCode)) {
        targetRows.set(normalizedCode, row);
      }
    }
  }
}

async function fetchJuventaBrands() {
  const data = await fetchJuventaJson(`${juventaApiBase}/brands`);
  const brands = Array.isArray(data) ? data : data?.data?.brands || [];
  return brands.map((brand) => ({
    id: Number(brand.id),
    name: String(brand.name || "").trim(),
    normalized: normalizeBrand(brand.name),
    products_count: Number(brand.products_count || 0),
  }));
}

async function loadJuventaLiveCatalog(targetBrands, juventaBrands) {
  const catalog = new Map();
  for (const brandName of targetBrands) {
    const juventaBrand = resolveJuventaBrand(brandName, juventaBrands);
    if (!juventaBrand) continue;

    const brandCatalog = await fetchJuventaBrandCatalog(juventaBrand.id, juventaBrand.name);
    catalog.set(normalizeBrand(brandName), brandCatalog);
  }
  return catalog;
}

function resolveJuventaBrand(brandName, juventaBrands) {
  const normalizedBrand = normalizeBrand(brandName);
  const aliases = getBrandAliases(brandName).map(normalizeBrand);

  return (
    juventaBrands.find((brand) => aliases.includes(brand.normalized)) ||
    juventaBrands.find((brand) => brand.normalized === normalizedBrand) ||
    juventaBrands.find((brand) => brand.normalized.includes(normalizedBrand) || normalizedBrand.includes(brand.normalized)) ||
    null
  );
}

function getBrandAliases(brandName) {
  const normalized = normalizeBrand(brandName);
  if (normalized === "MANN") {
    return ["Mann", "MANN-FILTER"];
  }
  if (normalized === "LEMFORDER") {
    return ["Lemforder", "LEMFÖRDER"];
  }
  return [brandName];
}

async function fetchJuventaBrandCatalog(brandId, brandName) {
  const rows = new Map();
  const pageSize = 100;
  let page = 1;
  let lastPage = 1;

  do {
    const payload = await fetchJuventaJson(`${juventaApiBase}/products?brand_ids=${brandId}&page=${page}&limit=${pageSize}`);
    const data = payload?.data || {};
    const products = data.products || [];
    lastPage = Number(data.last_page || 1);

    for (const product of products) {
      const row = extractJuventaProduct(product);
      if (!row.normalized_code || !row.description) continue;
      if (!rows.has(row.normalized_code)) {
        rows.set(row.normalized_code, row);
      }
    }

    if (page % 25 === 0 || page === lastPage) {
      console.error(`Juventa ${brandName}: page ${page}/${lastPage}`);
    }

    page += 1;
    await sleep(120);
  } while (page <= lastPage);

  rows.__meta = {
    brand_id: brandId,
    brand_name: brandName,
  };

  return rows;
}

async function fetchJuventaJson(url) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0",
      },
    });

    if (response.ok) {
      return response.json();
    }

    if (response.status === 429 || response.status >= 500) {
      await sleep(Math.min(20000, 1200 * attempt));
      continue;
    }

    throw new Error(`Juventa request failed: ${response.status} ${url}`);
  }

  throw new Error(`Juventa request repeatedly failed: ${url}`);
}

function extractJuventaProduct(product) {
  const attributes = product?.attributes || {};
  const shippingDetails = attributes.shipping_details || {};
  const rawCode = String(product?.part || "").trim();
  const title = String(product?.title || "").trim();
  const description = extractJuventaDescription(rawCode, title);
  return {
    product_code: rawCode.replace(/-/g, " "),
    normalized_code: normalizeCode(rawCode),
    description,
    oem_no: "",
    hs_code: firstJuventaValue(shippingDetails.customs_code),
    origin: formatOrigin(firstJuventaValue(shippingDetails.country_of_origin)),
    weight_kg: parseWeight(firstJuventaValue(shippingDetails.weight)),
    source_file: `juventa-api:${product?.brand || ""}`,
  };
}

function extractJuventaDescription(rawCode, title) {
  if (!title) return "";
  const normalizedTitle = title.trim();
  const codeRegex = new RegExp(`^${escapeRegExp(rawCode)}\\s*-\\s*`, "i");
  return normalizedTitle.replace(codeRegex, "").trim() || normalizedTitle;
}

function firstJuventaValue(value) {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }
  return String(value || "").trim();
}

function formatOrigin(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseWeight(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sortCounts(counts) {
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .map(([key, value]) => ({ key, value }));
}

async function rpc(name, payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ payload }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`RPC ${name} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function fetchAll(initialPath) {
  const results = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const separator = initialPath.includes("?") ? "&" : "?";
    const pathWithRange = `${initialPath}${separator}limit=${pageSize}&offset=${offset}`;
    const batch = await getJson(pathWithRange);
    results.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
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

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (insideQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const record = {};
    header.forEach((name, index) => {
      record[name] = cells[index] ?? "";
    });
    return record;
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
