#!/usr/bin/env node

/*
 * Discovers one brand's public Spareto product URLs from the product sitemap.
 *
 * Read-only guarantees:
 * - reads robots.txt and public sitemap files only;
 * - reads current catalog product codes only;
 * - never creates or updates catalog, price, replacement, or staging rows.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SPARETO_ORIGIN = "https://spareto.com";
const PRODUCT_SITEMAP = `${SPARETO_ORIGIN}/sitemaps/spareto.com/products/sitemap.xml.gz`;
const args = parseArgs(process.argv.slice(2));
const brand = String(args.brand || "").trim();
const brandSlug = slug(String(args["brand-slug"] || brand));
const delayMs = clampInt(args["request-delay-ms"], 100, 50, 10_000);
const requestTimeoutMs = clampInt(args["request-timeout-ms"], 30_000, 5_000, 120_000);

if (!brand) fail("BLOCKED: --brand is required.");
if (!brandSlug) fail("BLOCKED: a safe brand slug could not be derived.");

const runId = `spareto-${brandSlug}-manifest-${Date.now()}`;
const artifactDir = path.resolve(
  String(args["artifact-dir"] || path.join(ROOT, "artifacts", "spareto-manifests", runId)),
);
await fs.mkdir(artifactDir, { recursive: true });

const robotsText = await fetchText(`${SPARETO_ORIGIN}/robots.txt`);
const advertisedSitemap = robotsText.match(
  /Sitemap:\s*(https:\/\/spareto\.com\/sitemaps\/spareto\.com\/products\/sitemap\.xml\.gz)/i,
)?.[1];
if (advertisedSitemap !== PRODUCT_SITEMAP) {
  fail("BLOCKED: Spareto product sitemap was not advertised by robots.txt.");
}

const sitemapIndex = gunzip(await fetchBinary(advertisedSitemap));
const childSitemaps = [...sitemapIndex.matchAll(
  /<loc>(https:\/\/spareto\.com\/sitemaps\/spareto\.com\/products\/sitemap\d+\.xml\.gz)<\/loc>/gi,
)].map((match) => decodeXml(match[1]));
if (!childSitemaps.length) fail("BLOCKED: no Spareto product sitemap children were found.");

const byCode = new Map();
const rejectedUrls = [];
for (const [index, sitemapUrl] of childSitemaps.entries()) {
  if (index > 0) await sleep(delayMs);
  const xml = gunzip(await fetchBinary(sitemapUrl));
  const urls = [...xml.matchAll(/<loc>(https:\/\/spareto\.com\/products\/[^<]+)<\/loc>/gi)]
    .map((match) => decodeXml(match[1]));
  for (const sourceUrl of urls) {
    const parsed = new URL(sourceUrl);
    if (!parsed.pathname.toLowerCase().startsWith(`/products/${brandSlug}-`)) continue;
    const lastSegment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "");
    // The sitemap slug suffix is the manufacturer product code. Preserve
    // punctuation such as the hyphens used by BF (for example
    // `20-0303-44200`); taking only the first alphanumeric token collapsed
    // hundreds of distinct products into the false code `20`.
    const productCode = lastSegment.replace(/_+$/, "").trim();
    if (!productCode) {
      rejectedUrls.push({ source_url: sourceUrl, reason: "PRODUCT_CODE_NOT_DERIVED" });
      continue;
    }
    const normalizedCode = normalizeCode(productCode);
    const existing = byCode.get(normalizedCode);
    if (existing && existing.source_url !== sourceUrl) {
      rejectedUrls.push({ source_url: sourceUrl, reason: "DUPLICATE_CODE_DIFFERENT_URL", product_code: productCode });
      continue;
    }
    byCode.set(normalizedCode, { product_code: productCode, normalized_code: normalizedCode, source_url: sourceUrl });
  }
  if ((index + 1) % 10 === 0 || index + 1 === childSitemaps.length) {
    console.error(`SITEMAP ${index + 1}/${childSitemaps.length} | ${brand}=${byCode.size}`);
  }
}

const catalogCodes = await readCatalogCodes(brand);
const acceptedCodes = await readAcceptedArtifactCodes(brand);
const catalogSet = new Set(catalogCodes.map(normalizeCode));
const acceptedSet = new Set(acceptedCodes.map(normalizeCode));
const products = [...byCode.values()].sort((left, right) => left.normalized_code.localeCompare(right.normalized_code));
const missingFromCatalog = products.filter((row) => !catalogSet.has(row.normalized_code));
const notYetAccepted = products.filter((row) => !acceptedSet.has(row.normalized_code));

const manifest = {
  schema_version: "spareto.brand-sitemap-manifest.v1",
  run_id: runId,
  generated_at: new Date().toISOString(),
  brand,
  brand_slug: brandSlug,
  source: {
    robots_url: `${SPARETO_ORIGIN}/robots.txt`,
    sitemap_index_url: advertisedSitemap,
    child_sitemaps_read: childSitemaps.length,
    access_mode: "public_sitemap_read_only",
  },
  summary: {
    sitemap_products: products.length,
    current_catalog_products: catalogSet.size,
    previously_accepted_products: acceptedSet.size,
    missing_from_catalog: missingFromCatalog.length,
    not_yet_accepted: notYetAccepted.length,
    rejected_urls: rejectedUrls.length,
  },
  products,
  rejected_urls: rejectedUrls,
  guarantee: "No catalog, price, replacement, staging, or source row was written.",
};

await fs.writeFile(path.join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeCodeManifest(path.join(artifactDir, "missing-from-catalog.json"), missingFromCatalog, runId);
await writeCodeManifest(path.join(artifactDir, "not-yet-accepted.json"), notYetAccepted, runId);
await fs.writeFile(
  path.join(artifactDir, "products.csv"),
  `product_code,source_url,catalog_status,review_status\n${products.map((row) => [
    csv(row.product_code),
    csv(row.source_url),
    catalogSet.has(row.normalized_code) ? "present" : "missing",
    acceptedSet.has(row.normalized_code) ? "accepted" : "pending",
  ].join(",")).join("\n")}\n`,
);

console.log(JSON.stringify({ artifact_dir: artifactDir, ...manifest.summary }, null, 2));

async function readCatalogCodes(brandName) {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) fail("BLOCKED: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for catalog comparison.");
  const brands = await getJson(`${url}/rest/v1/brands?select=id,name&name=ilike.${encodeURIComponent(brandName)}&limit=10`, key);
  const target = brands.find((row) => normalizeBrand(row.name) === normalizeBrand(brandName));
  if (!target?.id) fail(`BLOCKED: catalog brand not found: ${brandName}`);
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await getJson(
      `${url}/rest/v1/catalog_products?select=product_code&brand_id=eq.${encodeURIComponent(target.id)}&order=id.asc&limit=1000&offset=${offset}`,
      key,
    );
    rows.push(...page.map((row) => String(row.product_code || "").trim()).filter(Boolean));
    if (page.length < 1000) break;
  }
  return rows;
}

async function readAcceptedArtifactCodes(brandName) {
  const packagesDir = path.join(ROOT, "artifacts", "spareto-packages");
  let entries = [];
  try {
    entries = await fs.readdir(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const payload = JSON.parse(await fs.readFile(path.join(packagesDir, entry.name, "package.json"), "utf8"));
      if (normalizeBrand(payload?.package?.brand) !== normalizeBrand(brandName)) continue;
      for (const row of payload.observations || []) {
        if (row?.status === "accepted" && row?.product_code) output.push(String(row.product_code));
      }
    } catch {
      // Ignore incomplete artifact directories; they are not accepted evidence.
    }
  }
  return output;
}

async function writeCodeManifest(file, rows, sourceRunId) {
  await fs.writeFile(file, `${JSON.stringify({
    schema_version: "spareto.product-code-manifest.v1",
    source_run_id: sourceRunId,
    // Preserve the robots-advertised detail URL so the review collector can
    // read the exact product page instead of falling back to a search route.
    products: rows.map((row) => ({
      product_code: row.product_code,
      normalized_code: row.normalized_code,
      source_url: row.source_url,
    })),
    product_codes: rows.map((row) => row.product_code),
  }, null, 2)}\n`);
}

async function fetchText(url) {
  const response = await fetchUrl(url, "text/plain,application/xml,text/xml");
  return response.text();
}

async function fetchBinary(url) {
  const response = await fetchUrl(url, "application/gzip,application/xml");
  return Buffer.from(await response.arrayBuffer());
}

async function fetchUrl(url, accept) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "spareto.com") throw new Error("SOURCE_URL_OUTSIDE_ALLOWLIST");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(parsed, {
      redirect: "error",
      signal: controller.signal,
      headers: { accept, "user-agent": "NextMaster Spareto sitemap manifest/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}: ${parsed}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, key) {
  const response = await fetch(url, {
    redirect: "error",
    headers: { apikey: key, Authorization: `Bearer ${key}`, accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`CATALOG_READ_${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

function gunzip(buffer) {
  return zlib.gunzipSync(buffer).toString("utf8");
}

function decodeXml(value) {
  return String(value || "").replace(/&amp;/g, "&");
}

function normalizeCode(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function normalizeBrand(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function csv(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function parseArgs(values) {
  const output = {};
  const supported = new Set(["brand", "brand-slug", "request-delay-ms", "request-timeout-ms", "artifact-dir"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, ...rest] = value.slice(2).split("=");
    if (!supported.has(key)) fail(`BLOCKED: unknown option --${key}.`);
    if (rest.length) output[key] = rest.join("=");
    else if (values[index + 1] && !values[index + 1].startsWith("--")) output[key] = values[++index];
    else output[key] = true;
  }
  return output;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
