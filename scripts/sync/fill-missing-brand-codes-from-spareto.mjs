#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeBrandName } from "../shared/brand/brand-standardization.mjs";
import {
  isCatalogPlaceholderDescription,
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  normalizeCatalogEan,
  pickCatalogDescription,
} from "../shared/catalog/catalog-standardization.mjs";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const outputDir = path.join(repoRoot, "docs", "spareto-targeted-fill");

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
const limitArg = args.get("limit");
const limit = limitArg == null ? 100 : Math.max(1, Number.parseInt(limitArg, 10) || 100);
const offset = Math.max(0, Number.parseInt(args.get("offset") || "0", 10) || 0);
const concurrency = Math.max(1, Number.parseInt(args.get("concurrency") || "6", 10) || 6);
const sleepMs = Math.max(0, Number.parseInt(args.get("sleep-ms") || "0", 10) || 0);
const requestTimeoutMs = Math.max(5000, Number.parseInt(args.get("request-timeout-ms") || "20000", 10) || 20000);
const prefixFilter = String(args.get("product-prefixes") || "")
  .split(",")
  .map((value) => normalizeCode(value))
  .filter(Boolean);

if (!requestedBrand) {
  throw new Error("--brand-name is required");
}

const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });

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
  const target = await resolveTargetBrand(requestedBrand);
  const supportsImageColumn = await detectCatalogImageColumn();
  const supportsEanColumn = await detectCatalogEanColumn();
  const existingRows = await fetchExistingCatalogRows(target.brand_id, supportsEanColumn);
  const candidates = existingRows
    .filter((row) => !prefixFilter.length || prefixFilter.some((prefix) => row.normalized_code.startsWith(prefix)))
    .filter((row) => isIncomplete(row, supportsEanColumn))
    .slice(offset, offset + limit);

  const matched = [];
  const unmatched = [];

  await runPool(candidates, concurrency, async (row, index) => {
    try {
      const detail = await resolveCodeFromSpareto(requestedBrand, row.product_code, row.normalized_code);
      if (!detail) {
        unmatched.push({
          product_code: row.product_code,
          normalized_code: row.normalized_code,
          reason: "No exact Spareto match found",
        });
        return;
      }
      matched.push(buildCatalogRow(target, row, detail, supportsEanColumn, supportsImageColumn));
    } catch (error) {
      unmatched.push({
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
        console.error(`${requestedBrand} targeted fill progress: ${index + 1}/${candidates.length}`);
      }
      if (sleepMs > 0 && index < candidates.length - 1) {
        await sleep(sleepMs);
      }
    }
  });

  const payload = dedupeBy(matched, (row) => row.normalized_code);
  const processedBatches = [];
  if (importMode && payload.length) {
    const batchSize = 200;
    for (let index = 0; index < payload.length; index += batchSize) {
      const batch = payload.slice(index, index + batchSize);
      const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(
          batch.map((row) => ({
            organization_id: row.organization_id,
            brand_id: row.brand_id,
            product_code: row.product_code,
            description: emptyToNull(row.description),
            ...(supportsEanColumn ? { ean: emptyToNull(row.ean) } : {}),
            oem_no: emptyToNull(row.oem_no),
            vehicle: emptyToNull(row.vehicle),
            hs_code: emptyToNull(row.hs_code),
            origin: emptyToNull(row.origin),
            weight_kg: row.weight_kg == null || Number.isNaN(Number(row.weight_kg)) ? null : Number(row.weight_kg),
            lifecycle_status: emptyToNull(row.lifecycle_status) || "active",
            lifecycle_note: emptyToNull(row.lifecycle_note),
            ...(supportsImageColumn ? { image_url: emptyToNull(row.image_url) } : {}),
            updated_at: new Date().toISOString(),
          })),
        ),
      });
      if (!response.ok) {
        throw new Error(`catalog_products upsert failed: ${response.status} ${await response.text()}`);
      }
      processedBatches.push({ batch: index / batchSize + 1, rows: batch.length, status: response.status });
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(outputDir, `spareto-${normalizeFileSegment(requestedBrand)}-targeted-summary-${timestamp}.json`);
  const summary = {
    brand_name: requestedBrand,
    brand_id: target.brand_id,
    organization_id: target.organization_id,
    prefix_filter: prefixFilter,
    supports_ean_column: supportsEanColumn,
    supports_image_column: supportsImageColumn,
    candidate_rows: candidates.length,
    matched_rows: payload.length,
    unmatched_rows: unmatched.length,
    processed_batches: processedBatches,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...summary, summary_path: summaryPath, unmatched_sample: unmatched.slice(0, 10) }, null, 2));
}

async function resolveTargetBrand(brandName) {
  const rows = await fetchAll(`/rest/v1/brands?select=id,name,organization_id&name=ilike.${encodeURIComponent(brandName)}`);
  const target =
    rows.find((row) => normalizeBrand(row.name) === normalizeBrand(brandName)) ||
    rows.find((row) => normalizeBrand(row.name).includes(normalizeBrand(brandName))) ||
    null;
  if (!target?.id || !target?.organization_id) throw new Error(`Brand not found: ${brandName}`);
  return {
    brand_id: String(target.id),
    organization_id: String(target.organization_id),
    name: String(target.name || brandName).trim() || brandName,
  };
}

async function detectCatalogImageColumn() {
  try {
    await getJson(`${supabaseUrl}/rest/v1/catalog_products?select=image_url&limit=1`, { headers });
    return true;
  } catch (error) {
    if (String(error || "").toLowerCase().includes("image_url")) return false;
    throw error;
  }
}

async function detectCatalogEanColumn() {
  try {
    await getJson(`${supabaseUrl}/rest/v1/catalog_products?select=ean&limit=1`, { headers });
    return true;
  } catch (error) {
    if (String(error || "").toLowerCase().includes("ean")) return false;
    throw error;
  }
}

async function fetchExistingCatalogRows(brandId, supportsEanColumn) {
  const results = [];
  const restPageLimit = 1000;
  let restOffset = 0;
  const selectColumns = [
    "product_code",
    "normalized_code",
    "description",
    ...(supportsEanColumn ? ["ean"] : []),
    "oem_no",
    "vehicle",
    "hs_code",
    "origin",
    "weight_kg",
    "image_url",
    "lifecycle_status",
    "lifecycle_note",
  ].join(",");
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=${selectColumns}&brand_id=eq.${encodeURIComponent(brandId)}&limit=${restPageLimit}&offset=${restOffset}`,
      { headers },
    );
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!response.ok) throw new Error(`catalog_products fetch failed: ${response.status} ${text}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows.map((row) => ({
        product_code: String(row.product_code || "").trim(),
        normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
        description: String(row.description || "").trim(),
        ean: normalizeCatalogEan(String(row.ean || "").trim()),
        oem_no: String(row.oem_no || "").trim(),
        vehicle: String(row.vehicle || "").trim(),
        hs_code: String(row.hs_code || "").trim(),
        origin: String(row.origin || "").trim(),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        image_url: String(row.image_url || "").trim(),
        lifecycle_status: String(row.lifecycle_status || "active").trim().toLowerCase(),
        lifecycle_note: String(row.lifecycle_note || "").trim(),
      })),
    );
    if (rows.length < restPageLimit) break;
    restOffset += restPageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function resolveCodeFromSpareto(brandName, productCode, normalizedCode) {
  const searchTerms = buildSearchTerms(productCode, normalizedCode);
  let exact = null;
  let sourceUrl = "";
  for (const term of searchTerms) {
    const searchUrl = `https://spareto.com/products?keywords=${encodeURIComponent(term)}`;
    const searchHtml = await fetchText(searchUrl);
    if (searchHtml.includes("Nothing Matches your Search")) continue;
    const cards = extractSearchCards(searchHtml);
    exact = cards.find(
      (card) =>
        normalizeBrand(card.brand) === normalizeBrand(brandName) &&
        normalizeCode(card.item_id) === normalizedCode,
    );
    if (!exact) {
      const relaxed = cards.find(
        (card) =>
          normalizeBrand(card.brand) === normalizeBrand(brandName) &&
          normalizeCode(card.item_id) === stripVariantSuffix(normalizedCode),
      );
      if (relaxed) exact = relaxed;
    }
    if (exact?.href) {
      sourceUrl = new URL(exact.href, "https://spareto.com").toString();
      break;
    }
  }
  if (!exact?.href || !sourceUrl) return null;
  const detailHtml = await fetchText(sourceUrl);
  const detail = extractDetailProperties(detailHtml);
  const lifecycle = extractCurrentLifecycle(detailHtml, normalizeBrand(brandName));
  return {
    product_code: productCode,
    description: normalizeCatalogDescription(
      pickCatalogDescription([detail.product_name, exact.item_name, exact.item_description], productCode),
      productCode,
    ),
    ean: detail.ean || "",
    oem_no: detail.oe_numbers || "",
    vehicle: detail.vehicle || "",
    hs_code: detail.customs_code || "",
    origin: formatOrigin(detail.country_of_origin),
    weight_kg: detail.weight_kg,
    image_url: sanitizeImageUrl(detail.image_url),
    lifecycle_status: lifecycle.lifecycle_status,
    lifecycle_note: lifecycle.lifecycle_note,
    source_url: sourceUrl,
  };
}

function buildSearchTerms(productCode, normalizedCode) {
  const terms = [String(productCode || "").trim(), String(normalizedCode || "").trim()];
  const stripped = stripVariantSuffix(normalizedCode);
  if (stripped && !terms.includes(stripped)) terms.push(stripped);
  const pretty = String(productCode || "")
    .replace(/([A-Z]+)(\d+)/i, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (pretty && !terms.includes(pretty)) terms.push(pretty);
  return terms.filter(Boolean);
}

function stripVariantSuffix(value) {
  const normalized = normalizeCode(value);
  return normalized.replace(/[A-Z]$/, "");
}

function extractSearchCards(html) {
  const cards = [];
  const regex = /data-variant-card-gtm-item-value='([^']+)'[\s\S]*?<a[^>]+href="([^"]+)"/g;
  for (const match of html.matchAll(regex)) {
    try {
      const data = JSON.parse(decodeHtml(match[1]));
      cards.push({
        brand: String(data.item_brand || "").trim(),
        item_id: String(data.item_id || "").trim(),
        item_name: String(data.item_name || "").trim(),
        item_description: String(data.item_description || "").trim(),
        href: match[2],
      });
    } catch {
      continue;
    }
  }
  return cards;
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
    ean: extractSparetoEan(html),
    vehicle: extractVehicleManufacturers(html),
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

function extractVehicleManufacturers(html) {
  const vehiclesSectionMatch = html.match(/<section[^>]+id=['"]nav-vehicles['"][^>]*>([\s\S]*?)<\/section>/i);
  const vehiclesSection = vehiclesSectionMatch?.[1] || "";
  if (!vehiclesSection) return "";
  const manufacturers = [];
  const headingPattern = /<div[^>]*class=['"][^'"]*\bcol-6\b[^'"]*['"][^>]*style=['"][^'"]*font-weight:\s*bold[^'"]*['"][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=['"][^'"]*\bcol-5\b[^'"]*['"][^>]*>\s*\d+\s+vehicles?\s*<\/div>/gi;
  for (const match of vehiclesSection.matchAll(headingPattern)) {
    const formatted = formatVehicleManufacturer(cleanText(match[1]));
    if (formatted) manufacturers.push(formatted);
  }
  return [...new Set(manufacturers)].join(", ");
}

function formatVehicleManufacturer(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const upper = normalized.toUpperCase();
  const known = {
    AUDI: "Audi",
    BMW: "BMW",
    DAF: "DAF",
    FORD: "Ford",
    IVECO: "IVECO",
    MAN: "MAN",
    MERCEDES: "Mercedes-Benz",
    "MERCEDES BENZ": "Mercedes-Benz",
    "MERCEDES-BENZ": "Mercedes-Benz",
    SCANIA: "Scania",
    VW: "Volkswagen",
    VOLKSWAGEN: "Volkswagen",
    VOLVO: "Volvo",
  };
  if (known[upper]) return known[upper];
  return normalized.toLowerCase().replace(/\b([a-z])/g, (_, char) => char.toUpperCase());
}

function captureTableValue(html, label) {
  const escaped = escapeRegExp(label);
  return capture(html, new RegExp(`<td>${escaped}<\\/td>\\s*<td>([\\s\\S]*?)<\\/td>`, "i"));
}

function extractSparetoEan(html) {
  const direct =
    extractSparetoStructuredEan(html) ||
    captureTableValue(html, "EAN") ||
    captureTableValue(html, "GTIN") ||
    captureTableValue(html, "Barcode") ||
    capture(html, /(?:EAN|GTIN|Barcode)[^0-9]{0,40}(\d{8,14})/i);
  return normalizeCatalogEan(direct);
}

function extractSparetoStructuredEan(html) {
  const itemprops = ["gtin14", "gtin13", "gtin12", "gtin8", "gtin", "ean13", "ean", "barcode"];
  for (const itemprop of itemprops) {
    const escaped = escapeRegExp(itemprop);
    for (const pattern of [
      new RegExp(`<meta[^>]+itemprop=['"]${escaped}['"][^>]+content=['"]([^'"]+)['"]`, "i"),
      new RegExp(`<meta[^>]+content=['"]([^'"]+)['"][^>]+itemprop=['"]${escaped}['"]`, "i"),
    ]) {
      const normalized = normalizeCatalogEan(capture(html, pattern));
      if (normalized) return normalized;
    }
  }
  const direct = decodeHtml(html).match(/"(?:gtin14|gtin13|gtin12|gtin8|gtin|ean13|ean|barcode)"\s*:\s*"([^"]+)"/i);
  return normalizeCatalogEan(direct?.[1] || "");
}

function extractCurrentLifecycle(html, normalizedBrand) {
  const preAlternatives = html.split("<section class='mb-5' id='nav-alternatives'")[0] || html;
  const discontinued = /No longer deliverable by the manufacturer/i.test(preAlternatives);
  const replacementMatch = preAlternatives.match(/Product has been replaced by:[\s\S]*?\/products\/([^"']+)["'][\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
  const replacementCode = cleanText(replacementMatch?.[2] || "");
  const replacementSlug = String(replacementMatch?.[1] || "").toLowerCase();
  const replacementSameBrand = replacementSlug.startsWith(`${normalizedBrand.toLowerCase()}-`);
  if (replacementCode && replacementSameBrand) {
    return {
      lifecycle_status: "discontinued",
      lifecycle_note: `Replaced by ${replacementCode}`,
    };
  }
  return {
    lifecycle_status: discontinued ? "discontinued" : "active",
    lifecycle_note: discontinued ? "No longer deliverable by the manufacturer." : "",
  };
}

function buildCatalogRow(target, existing, detail, supportsEanColumn, supportsImageColumn) {
  const nextDescription = normalizeCatalogDescription(
    pickCatalogDescription([detail.description, existing.description, detail.product_name], existing.product_code),
    existing.product_code,
  );
  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: normalizeCatalogDisplayCode(existing.product_code, target.name),
    normalized_code: existing.normalized_code,
    description: nextDescription,
    ean: supportsEanColumn ? preferCatalogEan(existing.ean, detail.ean) : "",
    oem_no: preferCatalogValue(existing.oem_no, detail.oem_no),
    vehicle: preferCatalogValue(existing.vehicle, detail.vehicle),
    hs_code: preferCatalogValue(existing.hs_code, detail.hs_code),
    origin: preferOrigin(existing.origin, detail.origin),
    weight_kg: existing.weight_kg ?? detail.weight_kg ?? null,
    image_url: supportsImageColumn ? preferCatalogValue(existing.image_url, detail.image_url) : "",
    lifecycle_status: preferCatalogValue(existing.lifecycle_status, detail.lifecycle_status) || "active",
    lifecycle_note: preferCatalogValue(existing.lifecycle_note, detail.lifecycle_note),
  };
}

function isIncomplete(row, supportsEanColumn) {
  return (
    !String(row.description || "").trim() ||
    isCatalogPlaceholderDescription(row.description, row.normalized_code || row.product_code) ||
    (supportsEanColumn && !normalizeCatalogEan(row.ean || "")) ||
    !String(row.oem_no || "").trim() ||
    !String(row.vehicle || "").trim() ||
    !String(row.hs_code || "").trim() ||
    !String(row.origin || "").trim() ||
    row.weight_kg == null ||
    Number.isNaN(Number(row.weight_kg)) ||
    !String(row.image_url || "").trim()
  );
}

function preferCatalogValue(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function preferCatalogEan(...values) {
  for (const value of values) {
    const normalized = normalizeCatalogEan(String(value || ""));
    if (normalized) return normalized;
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

function parseWeight(value) {
  const normalized = String(value || "").replace(",", ".").trim();
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
}

function formatOrigin(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  const direct = cleaned.toUpperCase();
  if (/^[A-Z]{2,3}$/.test(direct)) return direct;
  const map = {
    GERMANY: "DE",
    SPAIN: "ES",
    SWEDEN: "SE",
    ITALY: "IT",
    FRANCE: "FR",
    JAPAN: "JP",
    POLAND: "PL",
    CZECHREPUBLIC: "CZ",
    NETHERLANDS: "NL",
    CHINA: "CN",
    TURKEY: "TR",
  };
  return map[normalizeCode(cleaned)] || cleaned;
}

function sanitizeImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  return text;
}

function capture(html, regex) {
  const match = html.match(regex);
  return match ? cleanText(match[1]) : "";
}

function cleanText(value) {
  return decodeHtml(String(value || "")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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

function extractDetailName(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return "";
  const parts = cleaned.split(" - ");
  return parts.length > 1 ? parts.slice(1).join(" - ").trim() : cleaned.trim();
}

function normalizeBrand(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function normalizeCode(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

function normalizeFileSegment(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { headers: requestHeaders, signal: controller.signal, redirect: "follow" });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAll(pathname) {
  const rows = [];
  let pageOffset = 0;
  const pageSize = 1000;
  while (true) {
    const joiner = pathname.includes("?") ? "&" : "?";
    const response = await fetch(`${supabaseUrl}${pathname}${joiner}limit=${pageSize}&offset=${pageOffset}`, { headers });
    const text = await response.text();
    const page = text ? JSON.parse(text) : [];
    if (!response.ok) throw new Error(`fetchAll failed: ${response.status} ${text}`);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    pageOffset += pageSize;
  }
  return rows;
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function dedupeBy(values, getKey) {
  const seen = new Set();
  const results = [];
  for (const value of values) {
    const key = getKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(value);
  }
  return results;
}

async function runPool(items, concurrencyLimit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrencyLimit, queue.length || 1) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      const index = items.indexOf(next);
      await worker(next, index);
    }
  });
  await Promise.all(workers);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
