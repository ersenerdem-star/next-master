#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOSCH_API_BASE_URL = "https://ps.emea.dxtservice.com/ps/api";
const BOSCH_LOCALE_PATH = "tr/TR";
const BOSCH_CATALOG_ID = "AA_WEBSITE_TR";
const BOSCH_PIM_COUNTRY = "tr";
const BOSCH_PIM_LANGUAGE = "tr_tr";
const OFFICIAL_SOURCE_LABEL = "Bosch Aftermarket official source";

const requestHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  "user-agent": "Next-Master governed Bosch lifecycle sync/1.0",
};

export function normalizeCode(value = "") {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isDiscontinuedStatus(value = "") {
  const text = cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!text || text === "normal") return false;
  return /discontinued|obsolete|ended|withdrawn|kaldir|kalkti|uretimden|artik yok|artik uretilmiyor/.test(text);
}

export function extractOfficialLifecycle(detail, currentProductNumber) {
  const statusLabel = extractSpecificationValue(detail?.specificationTabData, ["Makale durumu", "Article status"]);
  const replacements = extractReplacementCodes(detail, currentProductNumber);
  const discontinued = isDiscontinuedStatus(statusLabel);
  const replacementCode = replacements[0] || "";
  const note = discontinued
    ? replacementCode
      ? `Not in production according to Bosch. Replacement code: ${formatDisplayCode(replacementCode)}.`
      : "Not in production according to Bosch."
    : replacementCode
      ? `Replacement code: ${formatDisplayCode(replacementCode)}.`
      : "";
  return {
    status_label: statusLabel,
    discontinued,
    replacement_code: replacementCode,
    replacement_codes: replacements,
    lifecycle_note: note,
  };
}

export function exactSearchCandidates(payload, requestedCode) {
  const requested = normalizeCode(requestedCode);
  const products = Array.isArray(payload?.products) ? payload.products : [];
  const normalized = products
    .map((product) => ({
      product_code: formatDisplayCode(product?.productNumber || ""),
      normalized_code: normalizeCode(product?.productNumber || ""),
      description: cleanText(product?.name || product?.description || ""),
    }))
    .filter((product) => product.normalized_code);
  return {
    exact: normalized.find((product) => product.normalized_code === requested) || null,
    candidates: normalized,
  };
}

export async function inspectBoschLifecycle(productCode, options = {}) {
  const normalizedCode = normalizeCode(productCode);
  if (!looksLikeBoschProductNumber(normalizedCode)) {
    return { status: "skipped", normalized_code: normalizedCode, reason: "INVALID_BOSCH_PRODUCT_CODE" };
  }

  const requestTimeoutMs = clampInteger(options.requestTimeoutMs, 5_000, 120_000, 25_000);
  const fetchImpl = options.fetchImpl || fetch;
  const detail = await fetchOfficialJson(detailUrl(normalizedCode), requestTimeoutMs, fetchImpl).catch(() => null);
  if (normalizeCode(detail?.productNumber || "") === normalizedCode) {
    return {
      status: "resolved",
      normalized_code: normalizedCode,
      source_url: detailUrl(normalizedCode),
      ...extractOfficialLifecycle(detail, normalizedCode),
    };
  }

  if (options.includeSearchEvidence !== true) {
    return {
      status: "unresolved",
      normalized_code: normalizedCode,
      source_url: detailUrl(normalizedCode),
      reason: "EXACT_DETAIL_UNAVAILABLE",
      candidate_codes: [],
      guarantee: "No search result was interpreted as a directional replacement.",
    };
  }

  const search = await fetchOfficialJson(searchUrl(normalizedCode), requestTimeoutMs, fetchImpl).catch(() => null);
  const matches = exactSearchCandidates(search, normalizedCode);
  return {
    status: "unresolved",
    normalized_code: normalizedCode,
    source_url: searchUrl(normalizedCode),
    reason: matches.exact ? "EXACT_DETAIL_UNAVAILABLE" : "NO_EXACT_OFFICIAL_PRODUCT",
    candidate_codes: matches.candidates.map((candidate) => candidate.normalized_code).slice(0, 20),
    guarantee: "Search alternatives were not interpreted as directional replacements.",
  };
}

export async function runBoschLifecycleSync(options = {}) {
  const supabaseUrl = requiredEnvironment("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY");
  const apply = options.apply === true;
  if (apply && options.confirmProduction !== true) throw new Error("--confirm-production is required with --apply");

  const pageSize = clampInteger(options.pageSize, 10, 500, 200);
  const concurrency = clampInteger(options.concurrency, 1, 12, 6);
  const requestDelayMs = clampInteger(options.requestDelayMs, 100, 60_000, 500);
  const startPage = clampInteger(options.startPage, 0, 100_000, 0);
  const maxPages = options.maxPages === "all" ? Number.POSITIVE_INFINITY : clampInteger(options.maxPages, 1, 100_000, 1);
  const requestTimeoutMs = clampInteger(options.requestTimeoutMs, 5_000, 120_000, 25_000);
  const artifactDir = path.resolve(options.artifactDir || path.join("artifacts", "bosch-official-lifecycle", `bosch-lifecycle-${Date.now()}`));
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  await fs.mkdir(artifactDir, { recursive: true });
  const brand = await resolveBoschBrand(supabaseUrl, headers);
  const aggregate = {
    mode: apply ? "apply" : "dry_run",
    organization_id: brand.organization_id,
    brand_id: brand.id,
    brand: brand.name,
    source: OFFICIAL_SOURCE_LABEL,
    started_at: new Date().toISOString(),
    start_page: startPage,
    page_size: pageSize,
    pages_processed: 0,
    catalog_rows_scanned: 0,
    official_rows_resolved: 0,
    discontinued_found: 0,
    replacements_found: 0,
    catalog_rows_updated: 0,
    code_references_upserted: 0,
    unresolved_rows: 0,
    failed_rows: 0,
    next_page: startPage,
    completed: false,
    guarantees: {
      alternatives_as_replacements: false,
      stock_as_discontinued: false,
      price_as_discontinued: false,
      credentials_persisted: false,
    },
  };
  const unresolved = [];
  const failures = [];

  for (let page = startPage; page < startPage + maxPages; page += 1) {
    const catalogRows = await fetchCatalogPage(supabaseUrl, headers, brand, page, pageSize);
    if (!catalogRows.length) {
      aggregate.completed = true;
      aggregate.next_page = page;
      break;
    }

    const inspections = new Array(catalogRows.length);
    await runPool(catalogRows, concurrency, async (row, index) => {
      try {
        inspections[index] = await inspectBoschLifecycle(row.normalized_code || row.product_code, { requestTimeoutMs });
      } catch (error) {
        inspections[index] = {
          status: "failed",
          normalized_code: normalizeCode(row.normalized_code || row.product_code),
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await sleep(requestDelayMs);
      }
    });

    const catalogUpdates = [];
    const replacementRows = [];
    for (let index = 0; index < catalogRows.length; index += 1) {
      const row = catalogRows[index];
      const inspection = inspections[index];
      aggregate.catalog_rows_scanned += 1;
      if (inspection?.status === "resolved") {
        aggregate.official_rows_resolved += 1;
        if (inspection.discontinued) aggregate.discontinued_found += 1;
        if (inspection.replacement_code) aggregate.replacements_found += 1;
        if (inspection.discontinued || inspection.replacement_code) {
          catalogUpdates.push({
            id: row.id,
            lifecycle_status: inspection.discontinued ? "discontinued" : row.lifecycle_status || "active",
            lifecycle_note: inspection.lifecycle_note,
          });
        }
        if (inspection.replacement_code) {
          replacementRows.push({
            organization_id: brand.organization_id,
            brand_id: brand.id,
            old_code: formatDisplayCode(row.product_code || row.normalized_code),
            new_code: formatDisplayCode(inspection.replacement_code),
            original_number: null,
            reason: `Official Bosch lifecycle replacement. Evidence: ${inspection.source_url}`,
            is_active: true,
            updated_at: new Date().toISOString(),
          });
        }
      } else if (inspection?.status === "unresolved") {
        aggregate.unresolved_rows += 1;
        unresolved.push({ product_code: row.product_code, ...inspection });
      } else if (inspection?.status === "failed") {
        aggregate.failed_rows += 1;
        failures.push({ product_code: row.product_code, ...inspection });
      }
    }

    if (apply) {
      for (const update of catalogUpdates) {
        await patchCatalogLifecycle(supabaseUrl, headers, update);
        aggregate.catalog_rows_updated += 1;
      }
      if (replacementRows.length) {
        await upsertReplacementRows(supabaseUrl, headers, replacementRows);
        aggregate.code_references_upserted += replacementRows.length;
      }
    }

    aggregate.pages_processed += 1;
    aggregate.next_page = page + 1;
    await writeCheckpoint(artifactDir, aggregate, unresolved, failures);
    console.error(JSON.stringify({
      phase: "page_complete",
      page,
      scanned: catalogRows.length,
      discontinued: catalogUpdates.filter((row) => row.lifecycle_status === "discontinued").length,
      replacements: replacementRows.length,
      unresolved: inspections.filter((row) => row?.status === "unresolved").length,
      failed: inspections.filter((row) => row?.status === "failed").length,
      next_page: aggregate.next_page,
    }));

    if (catalogRows.length < pageSize) {
      aggregate.completed = true;
      break;
    }
  }

  aggregate.finished_at = new Date().toISOString();
  await writeCheckpoint(artifactDir, aggregate, unresolved, failures);
  return { artifact_dir: artifactDir, ...aggregate };
}

async function resolveBoschBrand(supabaseUrl, headers) {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=ilike.Bosch&limit=1`, { headers });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Bosch brand lookup failed: ${response.status} ${text}`);
  const brand = Array.isArray(rows) ? rows[0] : null;
  if (!brand?.id || !brand?.organization_id) throw new Error("Bosch brand was not found");
  return brand;
}

async function fetchCatalogPage(supabaseUrl, headers, brand, page, pageSize) {
  const offset = page * pageSize;
  const query = new URLSearchParams({
    select: "id,product_code,normalized_code,lifecycle_status,lifecycle_note",
    organization_id: `eq.${brand.organization_id}`,
    brand_id: `eq.${brand.id}`,
    order: "normalized_code.asc",
    limit: String(pageSize),
    offset: String(offset),
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?${query}`, { headers });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Bosch catalog page ${page} failed: ${response.status} ${text}`);
  return Array.isArray(rows) ? rows : [];
}

async function patchCatalogLifecycle(supabaseUrl, headers, update) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?id=eq.${encodeURIComponent(update.id)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({
      lifecycle_status: update.lifecycle_status,
      lifecycle_note: update.lifecycle_note,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Bosch lifecycle update failed: ${response.status} ${await response.text()}`);
}

async function upsertReplacementRows(supabaseUrl, headers, rows) {
  const response = await fetch(`${supabaseUrl}/rest/v1/item_code_references?on_conflict=organization_id,brand_id,normalized_old_code`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(`Bosch code reference upsert failed: ${response.status} ${await response.text()}`);
}

async function fetchOfficialJson(url, timeoutMs, fetchImpl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchOfficialJsonOnce(url, timeoutMs, fetchImpl);
    } catch (error) {
      lastError = error;
      if (error?.retryable === false) break;
      if (attempt < 3) await sleep(attempt * 500);
    }
  }
  throw lastError || new Error("Official Bosch request failed");
}

async function fetchOfficialJsonOnce(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: requestHeaders, signal: controller.signal, redirect: "error" });
    const text = await response.text();
    if (!response.ok || !/^\s*[\[{]/.test(text)) {
      const error = new Error(`HTTP ${response.status}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function detailUrl(code) {
  const url = new URL(`${BOSCH_API_BASE_URL}/${BOSCH_LOCALE_PATH}/search-details/${encodeURIComponent(code)}`);
  addOfficialParameters(url);
  return url.toString();
}

function searchUrl(code) {
  const url = new URL(`${BOSCH_API_BASE_URL}/${BOSCH_LOCALE_PATH}/search/${encodeURIComponent(code)}`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "20");
  addOfficialParameters(url);
  return url.toString();
}

function addOfficialParameters(url) {
  url.searchParams.set("queryPIM", "true");
  url.searchParams.set("catalogId", BOSCH_CATALOG_ID);
  url.searchParams.set("pimCountry", BOSCH_PIM_COUNTRY);
  url.searchParams.set("pimLanguage", BOSCH_PIM_LANGUAGE);
}

function extractReplacementCodes(detail, currentProductNumber) {
  const current = normalizeCode(currentProductNumber);
  const candidates = [detail?.replacementsTabData, detail?.exchangesTabData, detail?.correspondingArticlesTabData]
    .flatMap((value) => collectStrings(value))
    .map(normalizeCode)
    .filter((value) => value && value !== current && looksLikeBoschProductNumber(value));
  return [...new Set(candidates)];
}

function extractSpecificationValue(rows, labels) {
  const accepted = new Set(labels.map(normalizeLabel));
  for (const row of Array.isArray(rows) ? rows : []) {
    const values = Array.isArray(row?.columnData) ? row.columnData : [];
    if (!accepted.has(normalizeLabel(values[0] || ""))) continue;
    const value = cleanText(values[1] || "");
    if (value) return value;
  }
  return "";
}

function collectStrings(value) {
  if (value == null) return [];
  if (["string", "number", "boolean"].includes(typeof value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

function looksLikeBoschProductNumber(value) {
  const compact = normalizeCode(value);
  return compact.length === 10 && /\d/.test(compact);
}

function formatDisplayCode(value) {
  const compact = normalizeCode(value);
  return compact.length === 10 ? `${compact.slice(0, 1)} ${compact.slice(1, 4)} ${compact.slice(4, 7)} ${compact.slice(7)}` : compact;
}

function cleanText(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeLabel(value) {
  return cleanText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function writeCheckpoint(artifactDir, aggregate, unresolved, failures) {
  const payload = { ...aggregate, unresolved, failures };
  await fs.writeFile(path.join(artifactDir, "checkpoint.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function requiredEnvironment(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  throw new Error(`${names.join(" or ")} is required`);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const separator = token.indexOf("=");
    if (separator > 2) args.set(token.slice(2, separator), token.slice(separator + 1));
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) args.set(token.slice(2), argv[++index]);
    else args.set(token.slice(2), "true");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const maxPages = args.get("max-pages") === "all" ? "all" : args.get("max-pages");
  const result = await runBoschLifecycleSync({
    apply: args.get("apply") === "true",
    confirmProduction: args.get("confirm-production") === "true",
    startPage: args.get("start-page"),
    maxPages,
    pageSize: args.get("page-size"),
    concurrency: args.get("concurrency"),
    requestDelayMs: args.get("request-delay-ms"),
    requestTimeoutMs: args.get("timeout-ms"),
    artifactDir: args.get("artifact-dir"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
