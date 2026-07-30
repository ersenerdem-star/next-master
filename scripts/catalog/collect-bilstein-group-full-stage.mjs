#!/usr/bin/env node

/*
 * Bilstein Group PartsFinder -> durable Catalog review staging.
 *
 * This collector is resumable and service-role only. It writes exclusively to
 * catalog_import_runs, catalog_import_stage, and catalog_import_source_pages.
 * It never validates, finalizes, or writes catalog_products.
 *
 * Usage:
 *   node scripts/catalog/collect-bilstein-group-full-stage.mjs \
 *     --confirm-production --brand ALL
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

const API_URL = "https://partsfinder.bilsteingroup.com/api/articles";
const SOURCE_KEY = "bilstein_group_partsfinder_list";
const DEFAULT_ORGANIZATION_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const DEFAULT_COLLECTION_KEY = "bilstein-partsfinder-list-tr-car-v1";
const BLUE_PRINT_COLLECTION_KEY = "bilstein-partsfinder-list-tr-car-cardinality-v2";
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_REQUEST_DELAY_MS = 300;
const PROVIDER_RESULT_WINDOW = 50_000;
const SOURCE_REQUEST_TIMEOUT_MS = 30_000;
const DATABASE_REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 4;

const args = parseArgs(process.argv.slice(2));
const confirmed = args.has("confirm-production");
const brandInput = normalizeBrand(args.get("brand") || "ALL");
const pageSize = readInteger(args.get("page-size"), DEFAULT_PAGE_SIZE, 1, 500, "page-size");
const requestDelayMs = readInteger(
  args.get("delay-ms"),
  DEFAULT_REQUEST_DELAY_MS,
  0,
  5_000,
  "delay-ms",
);
const country = String(args.get("country") || "TR").trim().toUpperCase();
const vehicleType = String(args.get("vehicle-type") || "CAR").trim().toUpperCase();
const collectionKeyOverride = args.has("collection-key")
  ? String(args.get("collection-key") || "").trim()
  : null;
const organizationId = String(
  args.get("organization-id") || DEFAULT_ORGANIZATION_ID,
).trim();
const brands = brandInput === "ALL" ? ["FEBI", "BLUE_PRINT"] : [brandInput];

if (!confirmed) fail("Use --confirm-production to start or resume durable review staging.");
if (collectionKeyOverride === "") fail("--collection-key cannot be empty.");
if (!organizationId) fail("--organization-id cannot be empty.");
if (brands.some((brand) => !["FEBI", "BLUE_PRINT"].includes(brand))) {
  fail("--brand must be FEBI, BLUE_PRINT, or ALL.");
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });
if (!/^https:\/\//i.test(supabaseUrl) || !serviceRoleKey) {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    fetch: fetchDatabaseWithTimeout,
  },
});

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.warn("\nINTERRUPT REQUESTED: the active run will remain resumable.");
});

console.log("BILSTEIN GROUP DURABLE STAGE START");
console.log(`brands=${brands.join(",")}`);
console.log(`page_size=${pageSize}; country=${country}; vehicle_type=${vehicleType}`);
console.log("boundary=review_stage_only; catalog_products=unchanged");

const results = [];
const failures = [];
for (const brand of brands) {
  if (interrupted) break;
  try {
    results.push(await collectBrand(brand));
  } catch (error) {
    if (brandInput !== "ALL") throw error;
    failures.push({
      brand,
      error: String(error?.message || error),
    });
    console.error(`BLOCKED ${brand}: ${error?.message || error}`);
  }
}

if (interrupted) {
  console.warn("STOPPED SAFELY: run the same command to resume.");
  process.exitCode = 130;
} else {
  console.log(JSON.stringify({
    status: failures.length ? "partial" : "completed",
    collection_keys: Object.fromEntries(
      brands.map((brand) => [brand, collectionKeyForBrand(brand)]),
    ),
    results,
    failures,
    guarantee: "No catalog_products row was inserted, updated, validated, or finalized.",
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

async function collectBrand(brand) {
  console.log(`\nSOURCE PREFLIGHT ${brand}`);
  const sourceSnapshot = await preflightProviderSource(brand);
  const firstPage = sourceSnapshot.firstPage;
  const brandCollectionKey = collectionKeyForBrand(brand);
  const canonicalCountBefore = await countCanonicalProducts(brand);
  const run = await rpcWithRetry("begin_or_resume_catalog_provider_stage", {
    input_organization_id: organizationId,
    input_source_key: SOURCE_KEY,
    input_collection_key: brandCollectionKey,
    input_brand: brandDisplayName(brand),
    input_scope: {
      provider: "bilstein_group_partsfinder",
      collector: "collect-bilstein-group-full-stage.mjs",
      country,
      vehicle_type: vehicleType,
      page_size: pageSize,
      automatic_finalize: false,
      canonical_write: false,
    },
  });
  await assertRunScopeMatches(run.run_id, brand);

  const totalElements = sourceSnapshot.totalElements;
  const totalPages = sourceSnapshot.totalPages;
  const storedTotalElements = nullableInteger(run.total_elements);
  const storedTotalPages = nullableInteger(run.total_pages);
  const storedPageSize = nullableInteger(run.page_size);

  if (
    (storedTotalElements !== null && storedTotalElements !== totalElements)
    || (storedTotalPages !== null && storedTotalPages !== totalPages)
    || (storedPageSize !== null && storedPageSize !== pageSize)
  ) {
    throw new Error(
      `${brand} source totals changed during resume. Start a new collection key after review.`,
    );
  }

  console.log(
    `${brand}: run=${run.run_id}; status=${run.status}; `
      + `source=${formatCount(totalElements)} products / ${totalPages} pages`,
  );

  if (run.status === "staged") {
    const canonicalCountAfter = await countCanonicalProducts(brand);
    assertCanonicalUnchanged(brand, canonicalCountBefore, canonicalCountAfter);
    console.log(`${brand}: already strictly staged; reusing run ${run.run_id}.`);
    return {
      brand,
      run_id: run.run_id,
      collection_key: brandCollectionKey,
      status: "staged",
      total_elements: totalElements,
      total_pages: totalPages,
      resumed: true,
      canonical_products_before: canonicalCountBefore,
      canonical_products_after: canonicalCountAfter,
    };
  }

  const nextPage = nullableInteger(run.next_page) ?? 0;
  const startedWithAllPagesCollected = nextPage >= totalPages;

  for (let pageNumber = nextPage; pageNumber < totalPages; pageNumber += 1) {
    assertNotInterrupted(run.run_id, pageNumber);
    const page = pageNumber === 0 && nextPage === 0
      ? firstPage
      : await fetchProviderLogicalPage({
        brand,
        pageNumber,
        totalElements,
      });
    assertStableSourcePage(brand, page, pageNumber, sourceSnapshot);
    const rows = buildStageRows(page.payload.data, { brand, retrievedAt: page.retrievedAt });

    const staged = await rpcWithRetry("stage_catalog_provider_identity_page", {
      input_run_id: run.run_id,
      input_page_number: pageNumber,
      input_page_size: pageSize,
      input_total_elements: totalElements,
      input_total_pages: totalPages,
      input_source_url: page.sourceUrl,
      input_retrieved_at: page.retrievedAt,
      payload: rows,
    });

    console.log(
      `COLLECT ${brand} ${pageNumber + 1}/${totalPages}: `
        + `${formatCount(staged.total_staged_rows || 0)}/${formatCount(totalElements)} staged`
        + `${staged.reused ? " (reused)" : ""}`,
    );
    if (pageNumber + 1 < totalPages) await sleep(requestDelayMs);
  }

  const verifyStart = startedWithAllPagesCollected
    ? nullableInteger(run.next_verify_page) ?? totalPages
    : 0;

  console.log(`VERIFY ${brand}: pages ${verifyStart + 1}..${totalPages}`);
  for (let pageNumber = verifyStart; pageNumber < totalPages; pageNumber += 1) {
    assertNotInterrupted(run.run_id, pageNumber);
    const page = await fetchProviderLogicalPage({
      brand,
      pageNumber,
      totalElements,
    });
    assertStableSourcePage(brand, page, pageNumber, sourceSnapshot);
    const rows = buildStageRows(page.payload.data, { brand, retrievedAt: page.retrievedAt });

    await rpcWithRetry("verify_catalog_provider_stage_page", {
      input_run_id: run.run_id,
      input_page_number: pageNumber,
      input_page_size: pageSize,
      input_total_elements: totalElements,
      input_total_pages: totalPages,
      payload: rows,
    });

    if ((pageNumber + 1) % 5 === 0 || pageNumber + 1 === totalPages) {
      console.log(`VERIFY ${brand} ${pageNumber + 1}/${totalPages}`);
    }
    if (pageNumber + 1 < totalPages) await sleep(requestDelayMs);
  }

  const sealed = await rpcWithRetry("seal_catalog_provider_stage_strict", {
    input_run_id: run.run_id,
  });
  const canonicalCountAfter = await countCanonicalProducts(brand);
  assertCanonicalUnchanged(brand, canonicalCountBefore, canonicalCountAfter);

  console.log(
    `SEALED ${brand}: ${formatCount(sealed.staged_count)} identities; `
      + `${sealed.verified_pages} pages verified; catalog_products unchanged.`,
  );

  return {
    brand,
    run_id: run.run_id,
    collection_key: brandCollectionKey,
    status: sealed.status,
    total_elements: sealed.total_elements,
    total_pages: sealed.total_pages,
    verified_pages: sealed.verified_pages,
    canonical_products_before: canonicalCountBefore,
    canonical_products_after: canonicalCountAfter,
  };
}

async function preflightProviderSource(brand) {
  const firstPage = await fetchProviderPage({ brand, pageNumber: 0 });
  const totalPages = firstPage.totalPages;
  const lastPageNumber = totalPages - 1;

  if (lastPageNumber * pageSize >= PROVIDER_RESULT_WINDOW) {
    return {
      firstPage,
      totalElements: firstPage.totalElements,
      totalPages,
      reportedTotals: new Set([firstPage.totalElements]),
    };
  }

  const lastPage = lastPageNumber === 0
    ? firstPage
    : await fetchProviderPage({ brand, pageNumber: lastPageNumber });
  if (lastPage.totalPages !== totalPages) {
    throw new Error(`${brand} source page count changed during preflight.`);
  }

  const totalElements = lastPageNumber * pageSize + lastPage.payload.data.length;
  if (
    totalElements <= 0
    || Math.ceil(totalElements / pageSize) !== totalPages
  ) {
    throw new Error(`${brand} source returned an invalid final-page cardinality.`);
  }

  const reportedTotals = new Set([firstPage.totalElements, lastPage.totalElements]);
  if (reportedTotals.size > 1 || !reportedTotals.has(totalElements)) {
    console.warn(
      `SOURCE META ${brand}: pages report ${[...reportedTotals].map(formatCount).join("/")} `
        + `while exact page cardinality is ${formatCount(totalElements)}; `
        + "collection and verification will use exact page cardinality.",
    );
  }

  return {
    firstPage,
    totalElements,
    totalPages,
    reportedTotals,
  };
}

async function assertRunScopeMatches(runId, brand) {
  const { data, error } = await db
    .from("catalog_import_runs")
    .select("input_scope")
    .eq("id", runId)
    .eq("organization_id", organizationId)
    .single();
  if (error) throw new Error(`Provider run scope lookup failed: ${error.message}`);

  const scope = data?.input_scope && typeof data.input_scope === "object"
    ? data.input_scope
    : {};
  const expected = {
    provider: "bilstein_group_partsfinder",
    country,
    vehicle_type: vehicleType,
    page_size: pageSize,
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => String(scope[key] ?? "") !== String(value))
    .map(([key]) => key);

  if (normalizeBrand(scope.source_brand) !== brand) mismatches.push("source_brand");
  if (mismatches.length) {
    throw new Error(
      `${brand} resumable run scope mismatch: ${[...new Set(mismatches)].join(", ")}. `
        + "Use a different collection key; existing staged pages were not changed.",
    );
  }
}

async function fetchProviderLogicalPage({
  brand,
  pageNumber,
  totalElements,
}) {
  if (pageNumber * pageSize >= PROVIDER_RESULT_WINDOW) {
    throw new Error(
      `${brand} source reports ${formatCount(totalElements)} identities, but its official `
        + `list endpoint cannot page beyond ${formatCount(PROVIDER_RESULT_WINDOW)}. `
        + "The run remains resumable; no synthetic tail was staged or sealed.",
    );
  }

  return fetchProviderPage({ brand, pageNumber });
}

async function fetchProviderPage({ brand, pageNumber }) {
  const sourceUrl = new URL(API_URL);
  sourceUrl.searchParams.set("page[number]", String(pageNumber));
  sourceUrl.searchParams.set("page[size]", String(pageSize));
  sourceUrl.searchParams.set("filter[brands]", brand);
  sourceUrl.searchParams.set("filter[country]", country);
  sourceUrl.searchParams.set("filter[vehicleType]", vehicleType);

  return retry(`Bilstein ${brand} page ${pageNumber}`, async () => {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: "application/vnd.api+json",
        "User-Agent": "Next-Master Bilstein durable review-stage collector",
      },
      signal: AbortSignal.timeout(SOURCE_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 500);
      const error = new Error(`Bilstein source HTTP ${response.status}: ${detail}`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      error.retryAfterMs = readRetryAfterMs(response.headers.get("retry-after"));
      throw error;
    }

    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : null;
    const meta = payload?.meta?.page;
    const totalElements = Number(meta?.totalElements);
    const totalPages = Number(meta?.totalPages);
    const returnedPage = Number(meta?.number);
    const returnedPageSize = Number(meta?.size);
    if (
      !data
      || !Number.isInteger(totalElements)
      || totalElements <= 0
      || !Number.isInteger(totalPages)
      || totalPages <= 0
      || returnedPage !== pageNumber
      || returnedPageSize !== pageSize
    ) {
      throw new Error(`Bilstein ${brand} page ${pageNumber} returned invalid pagination metadata.`);
    }

    if (data.length < 1 || data.length > pageSize) {
      throw new Error(`Bilstein ${brand} page ${pageNumber} returned an invalid row count.`);
    }

    return {
      payload: { data },
      sourceUrl: sourceUrl.toString(),
      retrievedAt: new Date().toISOString(),
      totalElements,
      totalPages,
    };
  });
}

function buildStageRows(articles, { brand }) {
  return articles.map((article, offset) => {
    const sourceProductId = cleanText(article?.id);
    const attributes = article?.attributes && typeof article.attributes === "object"
      ? article.attributes
      : {};
    const returnedBrand = normalizeBrand(attributes.bgBrand || "");
    if (!sourceProductId) {
      throw new Error(`${brand} source row ${offset} has no stable article identity.`);
    }
    if (returnedBrand !== brand) {
      throw new Error(
        `${brand} source row ${sourceProductId} returned unexpected brand ${returnedBrand || "UNKNOWN"}.`,
      );
    }

    return {
      source_product_id: sourceProductId,
      product_code: sourceProductId,
      description: cleanText(attributes.articleDescription)
        || cleanText(attributes.additionalDescription),
      oem_no: flattenOemNumbers(attributes.oeNumbers),
      market_segment: "pc",
      source_url: buildArticleUrl(sourceProductId, brand),
      source_payload: article,
    };
  });
}

async function countCanonicalProducts(brand) {
  const brandName = brandDisplayName(brand);
  const { data: brandRows, error: brandError } = await db
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .ilike("name", brandName)
    .limit(5);
  if (brandError) throw new Error(`Brand lookup failed: ${brandError.message}`);
  const brandRow = (brandRows || []).find(
    (row) => normalizeBrand(row.name) === brand,
  );
  if (!brandRow) throw new Error(`${brandName} brand is not configured.`);

  const { count, error } = await db
    .from("catalog_products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("brand_id", brandRow.id);
  if (error) throw new Error(`Canonical product count failed: ${error.message}`);
  return Number(count || 0);
}

async function rpcWithRetry(name, params) {
  return retry(`Supabase RPC ${name}`, async () => {
    const { data, error } = await db.rpc(name, params);
    if (error) {
      const wrapped = new Error(
        `${name} failed: ${error.message}${error.details ? ` (${error.details})` : ""}`,
      );
      wrapped.code = error.code;
      wrapped.retryable = isRetryableDatabaseError(error);
      throw wrapped;
    }
    return data;
  });
}

async function retry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable === true
        || /timeout|timed out|fetch failed|connection|socket|ECONNRESET/i.test(String(error?.message || ""));
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      const waitMs = Number(error?.retryAfterMs)
        || (1_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
      console.warn(`${label} retry ${attempt}/${MAX_ATTEMPTS - 1} in ${waitMs} ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function fetchDatabaseWithTimeout(input, init = {}) {
  const timeoutSignal = AbortSignal.timeout(DATABASE_REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}

function isRetryableDatabaseError(error) {
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    ["57014", "PGRST000", "PGRST001", "PGRST002"].includes(String(error?.code || ""))
    || /timeout|timed out|connection|fetch failed|enotfound|eai_again|dns|upstream|gateway|temporarily unavailable/.test(message)
  );
}

function assertStableSourcePage(brand, page, pageNumber, expected) {
  const expectedRows = Math.min(
    pageSize,
    expected.totalElements - pageNumber * pageSize,
  );
  if (
    page.totalPages !== expected.totalPages
    || !expected.reportedTotals.has(page.totalElements)
    || page.payload.data.length !== expectedRows
  ) {
    throw new Error(
      `${brand} source page ${pageNumber} changed during collection `
        + `(rows=${page.payload.data.length}/${expectedRows}, `
        + `reported_total=${page.totalElements}).`,
    );
  }
}

function assertCanonicalUnchanged(brand, before, after) {
  if (before !== after) {
    throw new Error(
      `${brand} canonical catalog changed during review staging (${before} -> ${after}).`,
    );
  }
}

function assertNotInterrupted(runId, nextPage) {
  if (interrupted) {
    throw new Error(
      `Collection interrupted safely. Run ${runId} remains resumable from page ${nextPage}.`,
    );
  }
}

function flattenOemNumbers(value) {
  const numbers = new Set();
  for (const group of Array.isArray(value) ? value : []) {
    for (const number of Array.isArray(group?.numbers) ? group.numbers : []) {
      const text = cleanText(number);
      if (text) numbers.add(text);
    }
  }
  return numbers.size ? [...numbers].join("; ") : null;
}

function buildArticleUrl(productCode, brand) {
  const url = new URL(`${API_URL}/${encodeURIComponent(productCode)}`);
  url.searchParams.set("filter[brands]", brand);
  url.searchParams.set("filter[country]", country);
  url.searchParams.set("filter[vehicleType]", vehicleType);
  return url.toString();
}

function brandDisplayName(brand) {
  return brand === "BLUE_PRINT" ? "Blue Print" : "Febi";
}

function collectionKeyForBrand(brand) {
  if (collectionKeyOverride) return collectionKeyOverride;
  return brand === "BLUE_PRINT" ? BLUE_PRINT_COLLECTION_KEY : DEFAULT_COLLECTION_KEY;
}

function normalizeBrand(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "BLUEPRINT") return "BLUE_PRINT";
  return normalized;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function nullableInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function readInteger(value, fallback, min, max, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`--${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function readRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      parsed.set(rawKey, inlineValue);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      parsed.set(rawKey, argv[index + 1]);
      index += 1;
    } else {
      parsed.set(rawKey, true);
    }
  }
  return parsed;
}

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
