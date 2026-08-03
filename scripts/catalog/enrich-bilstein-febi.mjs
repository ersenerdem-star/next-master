#!/usr/bin/env node

/*
 * FEBI-only source enrichment.
 *
 * Reads existing FEBI catalog products, fetches the official PartsFinder
 * detail/application evidence, and sends only currently-empty fields through
 * the guarded catalog enrichment RPC. Dry-run is the default; --apply is
 * required for canonical Product changes.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

const API_ORIGIN = "https://partsfinder.bilsteingroup.com";
const API_URL = `${API_ORIGIN}/api/articles`;
const DEFAULT_ORGANIZATION_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 100;
const EVIDENCE_CONCURRENCY = Number(process.env.FEBI_EVIDENCE_CONCURRENCY || 3);
// The guarded RPC also writes provenance/trigger records. In this database
// even small multi-row transactions can hit statement_timeout, so keep the
// canonical write atomic per product.
const RPC_BATCH_SIZE = 1;
const RPC_RETRY_COUNT = 3;
const CATALOG_READ_RETRY_COUNT = 3;

const args = parseArgs(process.argv.slice(2));
const apply = args.has("apply");
const maxItems = readInteger(args.get("max-items"), 10, 1, 100);
const page = readInteger(args.get("page"), 0, 0, 100_000);
const productCode = cleanText(args.get("product-code"));
const organizationId = String(
  args.get("organization-id") || process.env.NEXT_MASTER_ORGANIZATION_ID || DEFAULT_ORGANIZATION_ID,
).trim();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });

if (!/^https:\/\//i.test(supabaseUrl) || !serviceRoleKey) {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const brand = await resolveFebiBrand();
const products = await loadCandidates(brand.id);
const enriched = [];
const failures = [];

console.log("BILSTEIN FEBI ENRICHMENT START");
console.log(`mode=${apply ? "apply" : "dry_run"}; page=${page}; max_items=${maxItems}${productCode ? `; product_code=${productCode}` : ""}`);
console.log(`brand=${brand.name}; brand_id=${brand.id}; evidence_concurrency=${EVIDENCE_CONCURRENCY}`);

const evidenceResults = await mapWithConcurrency(products, async (product) => {
  try {
    const detail = await fetchProductEvidence(product.product_code);
    return { product, row: buildEnrichmentRow(product, detail) };
  } catch (error) {
    return { product, error };
  } finally {
    await sleep(REQUEST_DELAY_MS);
  }
}, EVIDENCE_CONCURRENCY);

for (const result of evidenceResults) {
  if (result.error) {
    failures.push({ product_code: result.product.product_code, phase: "source_evidence", error: errorMessage(result.error) });
  } else if (hasIncomingFields(result.row)) {
    enriched.push(result.row);
  }
}

let rpcResult = null;
if (apply && enriched.length > 0) {
  const totals = {
    applied_count: 0,
    unchanged_count: 0,
    conflict_count: 0,
    affected_product_ids: [],
  };
  // Keep each guarded transaction small. Catalog triggers and provenance
  // work can make a large FEBI batch exceed Postgres statement_timeout.
  for (let index = 0; index < enriched.length; index += RPC_BATCH_SIZE) {
    const batch = enriched.slice(index, index + RPC_BATCH_SIZE);
    let response;
    try {
      response = await callEnrichmentRpcWithRetry(batch, index);
    } catch (error) {
      failures.push({
        product_code: batch[0]?.product_code,
        phase: "guarded_enrichment",
        error: errorMessage(error),
      });
      continue;
    }
    if (response.error) {
      failures.push({
        product_code: batch[0]?.product_code,
        phase: "guarded_enrichment",
        error: response.error.message,
      });
      continue;
    }
    const result = response.data || {};
    totals.applied_count += Number(result.applied_count || 0);
    totals.unchanged_count += Number(result.unchanged_count || 0);
    totals.conflict_count += Number(result.conflict_count || 0);
    totals.affected_product_ids.push(...(Array.isArray(result.affected_product_ids) ? result.affected_product_ids : []));
  }
  totals.affected_product_ids = [...new Set(totals.affected_product_ids)];
  rpcResult = totals;
}

async function callEnrichmentRpcWithRetry(batch, index) {
  let lastError = null;
  for (let attempt = 1; attempt <= RPC_RETRY_COUNT; attempt += 1) {
    try {
      const response = await db.rpc("apply_catalog_product_enrichment_guarded", {
        input_rows: batch,
        input_source_type: "bilstein_group_partsfinder_febi_official",
        input_source_reference: `${API_ORIGIN}/en/article/febi/`,
      });
      if (!response.error) return response;
      lastError = response.error;
      if (!isTransientRpcError(response.error.message) || attempt === RPC_RETRY_COUNT) return response;
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(errorMessage(error)) || attempt === RPC_RETRY_COUNT) {
        throw error;
      }
    }
    await sleep(1500 * attempt);
  }
  throw lastError;
}

function isTransientRpcError(message) {
  const value = String(message || "").toLowerCase();
  return value.includes("fetch failed") || value.includes("network") || value.includes("socket") || value.includes("503") || value.includes("504");
}

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry_run",
  brand: brand.name,
  page,
  candidates: products.length,
  enrichment_rows: enriched.length,
  fields_written: {
    image_url: enriched.filter((row) => row.image_url).length,
    oem_no: enriched.filter((row) => row.oem_no).length,
    vehicle: enriched.filter((row) => row.vehicle).length,
  },
  fields_already_present_before_run: {
    image_url: products.filter((row) => hasText(row.image_url)).length,
    oem_no: products.filter((row) => hasText(row.oem_no)).length,
    vehicle: products.filter((row) => hasText(row.vehicle)).length,
  },
  failures,
  guarded_result: rpcResult,
  guarantee: apply
    ? "Only empty FEBI catalog fields were sent to the guarded enrichment RPC; conflicts are reported by the RPC."
    : "No catalog_products row was changed.",
}, null, 2));

async function resolveFebiBrand() {
  const { data, error } = await db
    .from("brands")
    .select("id,organization_id,name")
    .eq("organization_id", organizationId)
    .ilike("name", "FEBI")
    .limit(2);
  if (error) throw new Error(`FEBI brand lookup failed: ${error.message}`);
  const matches = (data || []).filter((row) => String(row.name || "").trim().toUpperCase() === "FEBI");
  if (matches.length !== 1) throw new Error(`Expected exactly one FEBI brand; found ${matches.length}.`);
  return matches[0];
}

async function loadCandidates(brandId) {
  if (productCode) {
    const rows = await readCatalogRange(brandId, 0, 0, true);
    return rows.filter((row) => !hasText(row.image_url) || !hasText(row.oem_no) || !hasText(row.vehicle)).slice(0, maxItems);
  }

  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  let data;
  try {
    data = await readCatalogRange(brandId, from, to);
  } catch (error) {
    if (!isTransientDbError(errorMessage(error))) throw error;
    // Offset/range reads can hit statement_timeout under load. Fall back to
    // smaller ranges so a page remains resumable without skipping products.
    data = [];
    for (let chunkFrom = from; chunkFrom <= to; chunkFrom += 25) {
      data.push(...await readCatalogRange(brandId, chunkFrom, Math.min(to, chunkFrom + 24)));
    }
  }
  return data
    .filter((row) => !hasText(row.image_url) || !hasText(row.oem_no) || !hasText(row.vehicle))
    .slice(0, maxItems);
}

async function readCatalogRange(brandId, from, to, singleProduct = false) {
  let lastError = null;
  for (let attempt = 1; attempt <= CATALOG_READ_RETRY_COUNT; attempt += 1) {
    let query = db
      .from("catalog_products")
      .select("id,organization_id,brand_id,product_code,image_url,oem_no,vehicle")
      .eq("organization_id", organizationId)
      .eq("brand_id", brandId);
    if (singleProduct) query = query.eq("product_code", productCode).limit(1);
    else query = query.order("product_code", { ascending: true }).range(from, to);
    const { data, error } = await query;
    if (!error) return data || [];
    lastError = error;
    if (!isTransientDbError(error.message) || attempt === CATALOG_READ_RETRY_COUNT) break;
    await sleep(1500 * attempt);
  }
  throw new Error(`FEBI catalog lookup failed: ${errorMessage(lastError)}`);
}

function isTransientDbError(message) {
  const value = String(message || "").toLowerCase();
  return value.includes("statement timeout") || value.includes("canceling statement") || value.includes("connection") || value.includes("fetch failed") || value.includes("timeout");
}

async function fetchProductEvidence(productCode) {
  const detailUrl = new URL(`${API_URL}/${encodeURIComponent(productCode)}`);
  detailUrl.searchParams.set("filter[brands]", "FEBI");
  detailUrl.searchParams.set("filter[country]", "TR");
  detailUrl.searchParams.set("filter[vehicleType]", "CAR");
  const payload = await fetchJson(detailUrl);
  const article = payload?.data || {};
  const attributes = article.attributes || {};
  const oemNumbers = normalizeOemNumbers(attributes.oeNumbers);
  const imageUrl = await fetchImageUrl(productCode);
  const applications = await fetchApplications(productCode);
  return { attributes, oemNumbers, imageUrl, applications };
}

async function fetchImageUrl(productCode) {
  const url = `${API_ORIGIN}/en/article/febi/${encodeURIComponent(productCode)}`;
  const html = await fetchText(url);
  const matches = html.match(/https?:\/\/cdn\.partsfinder\.bilsteingroup\.com\/pf-article-details\/[^"'\\s<]+/g) || [];
  return unique(matches.map((value) => value.replace(/&amp;/g, "&")))[0] || null;
}

async function fetchApplications(productCode) {
  const makesUrl = new URL(`${API_ORIGIN}/api/makes`);
  makesUrl.searchParams.set("filter[country]", "TR");
  makesUrl.searchParams.set("filter[articleId]", productCode);
  makesUrl.searchParams.set("filter[vehicleType]", "CAR");
  makesUrl.searchParams.set("filter[brands]", "FEBI");
  const makesPayload = await fetchJson(makesUrl);
  const applications = [];
  for (const make of Array.isArray(makesPayload?.data) ? makesPayload.data : []) {
    const makeId = cleanText(make?.id);
    if (!makeId) continue;
    const url = new URL(`${API_ORIGIN}/api/applications`);
    url.searchParams.set("articleId", productCode);
    url.searchParams.set("vehicleType", "CAR");
    url.searchParams.set("makeId", makeId);
    url.searchParams.set("filter[brands]", "FEBI");
    url.searchParams.set("filter[country]", "TR");
    url.searchParams.set("include", "limitations");
    const payload = await fetchJson(url);
    for (const entry of Array.isArray(payload?.data) ? payload.data : []) {
      const attributes = entry?.attributes || {};
      const manufacturer = cleanText(attributes.makeTitle) || cleanText(make?.attributes?.title);
      const model = cleanText(attributes.modelTitle);
      const variant = cleanText(attributes.variantTitle);
      const label = [manufacturer, model, variant].filter(Boolean).join(" ");
      if (label) applications.push(label);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return unique(applications);
}

function buildEnrichmentRow(product, detail) {
  const attributes = detail.attributes || {};
  const oemNo = detail.oemNumbers.flatMap((entry) => entry.numbers || []).filter(Boolean);
  const vehicle = detail.applications.join(", ");
  return {
    organization_id: product.organization_id,
    brand_id: product.brand_id,
    product_code: product.product_code,
    image_url: hasText(product.image_url) ? null : detail.imageUrl,
    oem_no: hasText(product.oem_no) ? null : unique(oemNo).join(", ") || null,
    vehicle: hasText(product.vehicle) ? null : vehicle || cleanText(attributes.vehicleType),
    source_reference: `${API_ORIGIN}/api/articles/${encodeURIComponent(product.product_code)}?filter%5Bbrands%5D=FEBI&filter%5Bcountry%5D=TR&filter%5BvehicleType%5D=CAR`,
  };
}

function normalizeOemNumbers(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    numbers: unique((Array.isArray(entry?.numbers) ? entry.numbers : []).map(cleanText).filter(Boolean)),
  })).filter((entry) => entry.numbers.length > 0);
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/vnd.api+json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`PartsFinder ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`PartsFinder ${response.status}: ${text.slice(0, 300)}`);
  return text;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`PartsFinder request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function hasIncomingFields(row) {
  return Boolean(row.image_url || row.oem_no || row.vehicle);
}

function hasText(value) {
  return Boolean(String(value || "").trim());
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function unique(values) {
  return [...new Set(values)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function readInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`Value must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) values.set(key, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values.set(key, argv[++index]);
    else values.set(key, true);
  }
  return values;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
