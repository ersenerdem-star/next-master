#!/usr/bin/env node

/*
 * Creates a bounded, read-only product manifest from a user-provided Spareto
 * brand listing. The listing route is used only with an explicit authorization
 * reference; no catalog, price, replacement, source, or staging row is written.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const ORIGIN = "https://spareto.com";
const args = parseArgs(process.argv.slice(2));
const brand = String(args.brand || "").trim();
const listingUrl = validateListingUrl(args["listing-url"], brand);
const authorizationReference = String(args["authorization-reference"] || "").trim();
const delayMs = clampInt(args["request-delay-ms"], 600, 600, 60_000);
// Large brand catalogues such as SWAG exceed the original 50-page pilot cap.
// Keep the user-authorized listing read bounded, but allow a full brand
// manifest without silently truncating it.
const maxPages = clampInt(args["max-pages"], 50, 1, 250);
const timeoutMs = clampInt(args["request-timeout-ms"], 30_000, 5_000, 120_000);

if (!brand) fail("BLOCKED: --brand is required.");
if (!authorizationReference) fail("BLOCKED: --authorization-reference is required.");

const runId = `spareto-${slug(brand)}-authorized-listing-${Date.now()}`;
const artifactDir = path.resolve(String(args["artifact-dir"] || path.join(ROOT, "artifacts", "spareto-manifests", runId)));
await fs.mkdir(artifactDir, { recursive: true });

const robots = await fetchText(`${ORIGIN}/robots.txt`, "text/plain");
const productsByCode = new Map();
let declaredTotal = null;
let totalPages = null;

for (let page = 1; page <= maxPages; page += 1) {
  if (page > 1) await sleep(delayMs);
  const url = new URL(listingUrl);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", "48");
  const html = await fetchText(url.toString(), "text/html,application/xhtml+xml");
  if (declaredTotal === null) {
    declaredTotal = parseDeclaredTotal(html);
    const declaredPages = Math.ceil(declaredTotal / 48);
    const paginationLastPage = parsePaginationLastPage(html);
    // Spareto caps this listing at 9,984 visible cards even when the counter
    // says 10,000. Respect the actual pagination instead of requesting a
    // redirected page forever.
    totalPages = paginationLastPage ? Math.min(declaredPages, paginationLastPage) : declaredPages;
    if (totalPages > maxPages) fail(`BLOCKED: listing requires ${totalPages} pages; max is ${maxPages}.`);
  }
  const pageProducts = extractCards(html, brand);
  for (const row of pageProducts) productsByCode.set(row.normalized_code, row);
  console.error(`LISTING ${page}/${totalPages} | ${brand}=${productsByCode.size}`);
  if (page >= totalPages) break;
}

const products = [...productsByCode.values()].sort((left, right) => left.normalized_code.localeCompare(right.normalized_code));
if (declaredTotal !== products.length) {
  console.error(`LISTING GAP: declared ${declaredTotal} products but ${products.length} unique identities were accessible.`);
}

const catalogCodes = await readCatalogCodes(brand);
const catalogSet = new Set(catalogCodes.map(normalizeCode));
const missing = products.filter((row) => !catalogSet.has(row.normalized_code));
const manifest = {
  schema_version: "spareto.authorized-brand-listing-manifest.v1",
  run_id: runId,
  generated_at: new Date().toISOString(),
  brand,
  authorization_reference: authorizationReference,
  source: {
    listing_url: listingUrl,
    robots_url: `${ORIGIN}/robots.txt`,
    robots_brand_filter_disallowed: robots.split(/\r?\n/).some((line) => /^Disallow:\s*\/\*\?\*brand=/i.test(line.trim())),
    access_mode: "user_authorized_bounded_listing_read_only",
    pages_read: totalPages,
    request_delay_ms: delayMs,
  },
  summary: {
    declared_listing_products: declaredTotal,
    listing_products: products.length,
    current_catalog_products: catalogSet.size,
    already_in_catalog: products.length - missing.length,
    missing_from_catalog: missing.length,
  },
  products,
  guarantee: "No catalog, price, replacement, source, or staging row was written.",
};

await fs.writeFile(path.join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(path.join(artifactDir, "missing-from-catalog.json"), `${JSON.stringify({
  schema_version: "spareto.product-code-manifest.v1",
  source_run_id: runId,
  products: missing,
  product_codes: missing.map((row) => row.product_code),
}, null, 2)}\n`);
console.log(JSON.stringify({ artifact_dir: artifactDir, ...manifest.summary }, null, 2));

function extractCards(html, targetBrand) {
  const rows = [];
  // Spareto currently renders product cards with mt-3 (older pages used
  // mt-4). Match the stable card-product marker instead of the spacing class.
  const cardRegex = /<div class='card bg-transparent card-product[^']*'[\s\S]*?data-variant-card-gtm-item-value='([^']+)'[\s\S]*?<a[^>]+href="([^"]+)"/g;
  for (const match of html.matchAll(cardRegex)) {
    let data;
    try { data = JSON.parse(decodeHtml(match[1])); } catch { continue; }
    if (normalizeBrand(data.item_brand) !== normalizeBrand(targetBrand)) continue;
    const productCode = String(data.item_id || "").trim();
    if (!productCode) continue;
    const sourceUrl = new URL(match[2], ORIGIN);
    if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "spareto.com" || !sourceUrl.pathname.toLowerCase().startsWith(`/products/${slug(targetBrand)}-`)) continue;
    rows.push({
      product_code: productCode,
      normalized_code: normalizeCode(productCode),
      source_url: sourceUrl.toString(),
    });
  }
  return rows;
}

function parseDeclaredTotal(html) {
  const value = html.match(/Showing\s+\d+[–-]\d+\s+of\s+(?:<span[^>]*>)?([\d,]+)(?:<\/span>)?\s+Products/i)?.[1];
  const parsed = Number.parseInt(String(value || "").replace(/,/g, ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25_000) fail("BLOCKED: listing total could not be verified.");
  return parsed;
}

function parsePaginationLastPage(html) {
  const pages = [...String(html || "").matchAll(/(?:[?&]|&amp;)page=(\d+)/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return pages.length ? Math.max(...pages) : null;
}

async function readCatalogCodes(brandName) {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) fail("BLOCKED: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for catalog comparison.");
  const brands = await getJson(`${url}/rest/v1/brands?select=id,name&name=ilike.${encodeURIComponent(brandName)}&limit=10`, key);
  const target = brands.find((row) => normalizeBrand(row.name) === normalizeBrand(brandName));
  if (!target?.id) fail(`BLOCKED: catalog brand not found: ${brandName}`);
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    // The composite brand/product-code path is indexed and stays fast at
    // large offsets; ordering by the global UUID/id forced expensive sorts
    // and caused 57014 timeouts on brands with tens of thousands of rows.
    const page = await getJson(`${url}/rest/v1/catalog_products?select=product_code&brand_id=eq.${encodeURIComponent(target.id)}&order=product_code.asc&limit=1000&offset=${offset}`, key);
    rows.push(...page.map((row) => String(row.product_code || "").trim()).filter(Boolean));
    if (page.length < 1000) break;
  }
  return rows;
}

async function fetchText(value, accept) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "spareto.com") throw new Error("SOURCE_URL_OUTSIDE_ALLOWLIST");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "error", signal: controller.signal, headers: { accept, "user-agent": "NextMaster Spareto authorized listing manifest/1.0" } });
    if (!response.ok) throw new Error(`HTTP_${response.status}: ${url}`);
    return response.text();
  } finally { clearTimeout(timer); }
}

async function getJson(url, key) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "error", headers: { apikey: key, Authorization: `Bearer ${key}`, accept: "application/json" } });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : [];
      const error = new Error(`CATALOG_READ_${response.status}: ${text.slice(0, 200)}`);
      if (![500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await sleep(500 * (2 ** attempt));
  }
  throw lastError || new Error("CATALOG_READ_FAILED");
}

function validateListingUrl(value, targetBrand) {
  let url;
  try { url = new URL(String(value || "")); } catch { fail("BLOCKED: --listing-url must be a valid URL."); }
  if (url.protocol !== "https:" || url.hostname !== "spareto.com" || url.pathname !== "/products") fail("BLOCKED: listing URL must be https://spareto.com/products.");
  const selectedBrands = url.searchParams.getAll("brand[]");
  if (selectedBrands.length !== 1 || normalizeBrand(selectedBrands[0]) !== normalizeBrand(targetBrand)) fail("BLOCKED: listing URL brand does not match --brand.");
  url.searchParams.delete("page");
  url.searchParams.delete("per_page");
  return url.toString();
}

function decodeHtml(value) { return String(value || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'"); }
function normalizeCode(value) { return String(value || "").replace(/\s+/g, "").replace(/_+$/, "").toUpperCase(); }
function normalizeBrand(value) { return String(value || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function slug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clampInt(value, fallback, min, max) { const parsed = Number.parseInt(String(value ?? ""), 10); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function parseArgs(values) { const output = {}; const supported = new Set(["brand", "listing-url", "authorization-reference", "request-delay-ms", "request-timeout-ms", "max-pages", "artifact-dir"]); for (let index = 0; index < values.length; index += 1) { const value = values[index]; if (!value.startsWith("--")) continue; const [key, ...rest] = value.slice(2).split("="); if (!supported.has(key)) fail(`BLOCKED: unknown option --${key}.`); if (rest.length) output[key] = rest.join("="); else if (values[index + 1] && !values[index + 1].startsWith("--")) output[key] = values[++index]; else output[key] = true; } return output; }
function fail(message) { console.error(message); process.exit(1); }
