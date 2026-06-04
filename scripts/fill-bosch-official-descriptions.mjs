import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const BOSCH_API_BASE_URL = "https://ps.emea.dxtservice.com/ps/api";
const BOSCH_LOCALE_PATH = "tr/TR";
const BOSCH_CATALOG_ID = "AA_WEBSITE_TR";
const BOSCH_PIM_COUNTRY = "tr";
const BOSCH_PIM_LANGUAGE = "tr_tr";
const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const concurrency = parseIntArg("--concurrency=", 6);
const requestTimeoutMs = parseIntArg("--timeout-ms=", 20000);
const batchSize = parseIntArg("--batch-size=", 100);
const offset = parseIntArg("--offset=", 0);
const limit = parseIntArg("--limit=", 500);

const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const { brandId, organizationId } = await resolveBoschTarget();
const existingRows = await fetchAllBoschRows(organizationId, brandId);
const allCandidateRows = existingRows.filter((row) => isPlaceholderDescription(row.description, row.normalized_code || row.product_code));
const candidateRows = allCandidateRows.slice(offset, offset + limit);
const updates = [];
const errors = [];
let processedCount = 0;

await runPool(candidateRows, concurrency, async (row) => {
  try {
    const detail = await fetchBoschDetail(row.normalized_code, requestTimeoutMs);
    const nextDescription = extractBoschDescription(detail, row);
    if (!nextDescription || isPlaceholderDescription(nextDescription, row.normalized_code || row.product_code)) {
      return;
    }
    if (normalizeTextValue(nextDescription) === normalizeTextValue(row.description)) {
      return;
    }
    updates.push({
      organization_id: organizationId,
      brand_id: brandId,
      product_code: row.product_code,
      description: nextDescription,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    errors.push({
      product_code: row.product_code,
      normalized_code: row.normalized_code,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    processedCount += 1;
    if (processedCount % 100 === 0 || processedCount === candidateRows.length) {
      console.error(JSON.stringify({ phase: "progress", processed: processedCount, total: candidateRows.length, updates: updates.length, errors: errors.length }));
    }
  }
});

const processedBatches = [];
for (let index = 0; index < updates.length; index += batchSize) {
  const batch = updates.slice(index, index + batchSize);
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
  }
  processedBatches.push({ batch: index / batchSize + 1, rows: batch.length, status: response.status });
}

const refreshedRows = await fetchAllBoschRows(organizationId, brandId);
const remainingPlaceholderRows = refreshedRows.filter((row) => isPlaceholderDescription(row.description, row.normalized_code || row.product_code));
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(projectRoot, "docs", "bosch-official-description-fill");
await mkdir(outDir, { recursive: true });
const summaryPath = path.join(outDir, `bosch-official-description-fill-summary-${timestamp}.json`);
const changesPath = path.join(outDir, `bosch-official-description-fill-changes-${timestamp}.csv`);
const errorsPath = path.join(outDir, `bosch-official-description-fill-errors-${timestamp}.csv`);

const summary = {
  organizationId,
  brandId,
  scannedRows: existingRows.length,
  totalCandidateRows: allCandidateRows.length,
  candidateOffset: offset,
  candidateLimit: limit,
  candidateRows: candidateRows.length,
  updatedRows: updates.length,
  errorRows: errors.length,
  remainingPlaceholderRows: remainingPlaceholderRows.length,
  sampleRemainingCodes: remainingPlaceholderRows.slice(0, 25).map((row) => row.product_code),
  processedBatches,
};

await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(
  changesPath,
  ["product_code,normalized_code,description", ...updates.map((row) => toCsvRow([row.product_code, row.normalized_code, row.description]))].join("\n") + "\n",
  "utf8",
);
await writeFile(
  errorsPath,
  ["product_code,normalized_code,error", ...errors.map((row) => toCsvRow([row.product_code, row.normalized_code, row.error]))].join("\n") + "\n",
  "utf8",
);

console.log(
  JSON.stringify(
    {
      summaryPath,
      changesPath,
      errorsPath,
      ...summary,
    },
    null,
    2,
  ),
);

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(execFileSync("npx", ["netlify", "env:get", name], { cwd: projectRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

async function resolveBoschTarget() {
  const brands = await fetchJson(
    `${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=eq.Bosch&limit=1`,
    headers,
  );
  const row = Array.isArray(brands) ? brands[0] : null;
  if (!row?.id || !row?.organization_id) {
    throw new Error("Bosch brand row was not found");
  }
  return {
    brandId: String(row.id).trim(),
    organizationId: String(row.organization_id).trim(),
  };
}

async function fetchAllBoschRows(organizationId, brandId) {
  const pageLimit = 1000;
  const results = [];
  for (let offset = 0; ; offset += pageLimit) {
    const page = await fetchJson(
      `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code,description&organization_id=eq.${encodeURIComponent(organizationId)}&brand_id=eq.${encodeURIComponent(brandId)}&limit=${pageLimit}&offset=${offset}`,
      headers,
    );
    if (!Array.isArray(page) || !page.length) break;
    results.push(
      ...page.map((row) => ({
        product_code: String(row.product_code || "").trim(),
        normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
        description: String(row.description || "").trim(),
      })),
    );
    if (page.length < pageLimit) break;
  }
  return results;
}

async function fetchBoschDetail(productNumber, timeoutMs) {
  const url = new URL(`${BOSCH_API_BASE_URL}/${BOSCH_LOCALE_PATH}/search-details/${encodeURIComponent(normalizeCode(productNumber))}`);
  url.searchParams.set("queryPIM", "true");
  url.searchParams.set("catalogId", BOSCH_CATALOG_ID);
  url.searchParams.set("pimCountry", BOSCH_PIM_COUNTRY);
  url.searchParams.set("pimLanguage", BOSCH_PIM_LANGUAGE);
  const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Bosch detail failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function extractBoschDescription(detail, existingRow) {
  const referenceCode = detail?.productNumber || existingRow?.normalized_code || existingRow?.product_code || "";
  const detailName = normalizeTextValue(detail?.name || "");
  const specName = extractSpecificationValue(detail, ["Tanımlama", "Identification"]);
  const detailDescription = normalizeTextValue(detail?.description || "");

  for (const candidate of [detailName, specName, detailDescription]) {
    if (candidate && !isPlaceholderDescription(candidate, referenceCode)) {
      return candidate;
    }
  }
  return detailName || specName || detailDescription || "";
}

function extractSpecificationValue(detail, labels) {
  const targetLabels = new Set(labels.map((label) => normalizeTextValue(label).toLowerCase()));
  const items = Array.isArray(detail?.specificationTabData) ? detail.specificationTabData : [];
  for (const item of items) {
    const values = Array.isArray(item?.columnData) ? item.columnData : [];
    const label = normalizeTextValue(values[0]).toLowerCase();
    if (!targetLabels.has(label)) continue;
    return normalizeTextValue(values[1] || "");
  }
  return "";
}

async function fetchJson(url, requestHeaders) {
  const response = await fetch(url, { headers: requestHeaders });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function runPool(items, concurrencyLimit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrencyLimit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeTextValue(value) {
  return String(value || "").trim();
}

function isPlaceholderDescription(description, productCode) {
  const normalizedDescription = normalizeCode(description);
  const normalizedCode = normalizeCode(productCode);
  return Boolean(normalizedDescription && normalizedCode && normalizedDescription === normalizedCode);
}

function parseIntArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  const parsed = Number.parseInt(String(arg || "").slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toCsvRow(values) {
  return values
    .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
    .join(",");
}
