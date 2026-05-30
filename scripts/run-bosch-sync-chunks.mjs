import { syncBrandCatalog } from "../netlify/functions/_shared/catalog-sync-provider.mts";

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const chunkSize = parseIntArg("--chunk-size=", 12);
const maxPrefixes = parseIntArg("--max-prefixes=", 160);
const concurrency = parseIntArg("--concurrency=", 8);
const pageSize = parseIntArg("--page-size=", 48);
const requestTimeoutMs = parseIntArg("--timeout-ms=", 20000);

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};

const { brandId, organizationId, beforeRowCount, prefixes } = await loadBoschPrefixPlan();

console.error(
  JSON.stringify(
    {
      phase: "plan",
      organizationId,
      brandId,
      beforeRowCount,
      totalPrefixes: prefixes.length,
      chunkSize,
    },
    null,
    2,
  ),
);

const chunks = [];
for (let index = 0; index < prefixes.length; index += chunkSize) {
  chunks.push(prefixes.slice(index, index + chunkSize));
}

const chunkResults = [];
for (let index = 0; index < chunks.length; index += 1) {
  const seedPrefixes = chunks[index];
  console.error(
    JSON.stringify(
      {
        phase: "chunk-start",
        chunk: index + 1,
        totalChunks: chunks.length,
        seedPrefixes,
      },
      null,
      2,
    ),
  );

  const result = await syncBrandCatalog({
    supabaseUrl,
    serviceRoleKey,
    brandName: "Bosch",
    refreshExisting: false,
    concurrency,
    pageSize,
    requestTimeoutMs,
    seedPrefixes,
  });

  chunkResults.push({
    chunk: index + 1,
    totalChunks: chunks.length,
    seedPrefixes,
    result,
  });

  console.error(
    JSON.stringify(
      {
        phase: "chunk-complete",
        chunk: index + 1,
        totalChunks: chunks.length,
        seedPrefixes,
        resolvedRows: result.resolvedRows,
        changedRows: result.changedRows,
        newRowsInListing: result.newRowsInListing,
        errorRows: result.errorRows,
      },
      null,
      2,
    ),
  );
}

const afterRowCount = await fetchBoschRowCount(organizationId, brandId);

const aggregate = {
  organizationId,
  brandId,
  beforeRowCount,
  afterRowCount,
  actualNewRowsAdded: afterRowCount - beforeRowCount,
  totalPrefixes: prefixes.length,
  chunkSize,
  totalChunks: chunks.length,
  aggregateResolvedRows: sum(chunkResults.map((entry) => entry.result.resolvedRows)),
  aggregateChangedRows: sum(chunkResults.map((entry) => entry.result.changedRows || 0)),
  aggregateDiscoveredRows: sum(chunkResults.map((entry) => entry.result.newRowsInListing || 0)),
  aggregateErrorRows: sum(chunkResults.map((entry) => entry.result.errorRows || 0)),
  aggregateReplacementRows: sum(chunkResults.map((entry) => entry.result.replacementRows || 0)),
  chunkResults,
};

console.log(JSON.stringify(aggregate, null, 2));

async function loadBoschPrefixPlan() {
  const brands = await fetchJson(
    `${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=eq.Bosch&limit=1`,
    headers,
  );
  const brand = Array.isArray(brands) ? brands[0] : null;
  if (!brand?.id || !brand?.organization_id) {
    throw new Error("Bosch brand row was not found");
  }

  const rows = await fetchAllCatalogRows(brand.organization_id, brand.id);
  const beforeRowCount = rows.length;
  const prefixCounts = new Map();
  const normalizedCodes = rows
    .map((row) => normalizeCode(row.normalized_code || row.product_code || ""))
    .filter((value) => value.length >= 4 && /^\d/.test(value));

  const prefixes = buildAdaptivePrefixes(normalizedCodes).slice(0, maxPrefixes);

  return {
    brandId: brand.id,
    organizationId: brand.organization_id,
    beforeRowCount,
    prefixes,
  };
}

async function fetchAllCatalogRows(organizationId, brandId) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchJson(
      `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code&organization_id=eq.${organizationId}&brand_id=eq.${brandId}&limit=${pageSize}&offset=${offset}`,
      headers,
    );
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchBoschRowCount(organizationId, brandId) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/catalog_products?select=id&organization_id=eq.${organizationId}&brand_id=eq.${brandId}`,
    {
      method: "HEAD",
      headers: {
        ...headers,
        Prefer: "count=exact",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Bosch row count failed: ${response.status}`);
  }
  const contentRange = response.headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function fetchJson(url, requestHeaders) {
  const response = await fetch(url, { headers: requestHeaders });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${url}`);
  }
  return response.json();
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function buildAdaptivePrefixes(normalizedCodes) {
  const fourDigitCounts = countPrefixes(normalizedCodes, 4);
  const prefixes = [];

  for (const [prefix4, count4] of [...fourDigitCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
    if (count4 <= 250) {
      prefixes.push(prefix4);
      continue;
    }

    const matching4 = normalizedCodes.filter((value) => value.startsWith(prefix4));
    const fiveDigitCounts = countPrefixes(matching4, 5);
    for (const [prefix5, count5] of [...fiveDigitCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
      if (count5 <= 120) {
        prefixes.push(prefix5);
        continue;
      }

      const matching5 = matching4.filter((value) => value.startsWith(prefix5));
      const sixDigitCounts = countPrefixes(matching5, 6);
      for (const [prefix6] of [...sixDigitCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
        prefixes.push(prefix6);
      }
    }
  }

  return [...new Set(prefixes)];
}

function countPrefixes(values, length) {
  const counts = new Map();
  for (const value of values) {
    if (value.length < length) continue;
    const prefix = value.slice(0, length);
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  return counts;
}

function parseIntArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  const parsed = Number.parseInt(arg?.slice(prefix.length) || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}
