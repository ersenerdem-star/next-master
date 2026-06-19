import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listCatalogSyncManagedBrands,
  resolveCatalogSyncPlan,
  syncBrandCatalogWithProgressiveBatches,
} from "../../netlify/functions/_shared/catalog/catalog-sync-provider.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const docsDir = path.join(repoRoot, "docs", "brand-sync-batches");

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(execFileSync("npx", ["netlify", "env:get", name, "--context", "production"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

function parseIntegerArg(name, fallback) {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  const parsed = Number.parseInt(String(arg || "").split("=")[1] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBrandsArg() {
  const arg = process.argv.find((value) => value.startsWith("--brands="));
  return String(arg || "")
    .split("=")[1]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) || [];
}

function toCsvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};

const concurrency = parseIntegerArg("--concurrency", 4);
const pageSize = parseIntegerArg("--page-size", 24);
const requestTimeoutMs = parseIntegerArg("--timeout-ms", 15000);
const maxPages = parseIntegerArg("--max-pages", 1);
const candidateLimit = parseIntegerArg("--candidate-limit", 24);
const sparetoFallbackLimit = parseIntegerArg("--spareto-fallback-limit", 24);
const brandTimeoutMs = parseIntegerArg("--brand-timeout-ms", 60000);
const requestedBrands = parseBrandsArg();

const liveBrands = await fetchJson(
  `${supabaseUrl}/rest/v1/brands?select=name&order=name.asc&limit=500`,
  headers,
);

function normalizeBrandName(value) {
  return String(value || "").trim();
}

function uniqueBrands(values) {
  return [...new Set(values.map(normalizeBrandName).filter(Boolean))];
}

const liveBrandNames = uniqueBrands(
  liveBrands
    .map((row) => String(row?.name || "").trim())
    .filter((brand) => brand.toLowerCase() !== "unbranded"),
);
const liveBrandSet = new Set(liveBrandNames.map((brand) => brand.toLowerCase()));
const managedBrandNames = uniqueBrands(listCatalogSyncManagedBrands());

const explicitRequested = uniqueBrands(requestedBrands);
const existingPhaseBrands = explicitRequested.length
  ? explicitRequested.filter((brand) => liveBrandSet.has(brand.toLowerCase()))
  : liveBrandNames;
const missingPhaseBrands = explicitRequested.length
  ? explicitRequested.filter((brand) => !liveBrandSet.has(brand.toLowerCase()))
  : managedBrandNames.filter((brand) => !liveBrandSet.has(brand.toLowerCase()));

const targetBrandPhases = [
  ...existingPhaseBrands.map((brandName) => ({ brandName, phase: "existing_system_brand" })),
  ...missingPhaseBrands.map((brandName) => ({ brandName, phase: "missing_brand_bootstrap" })),
];

const startedAt = new Date().toISOString();
mkdirSync(docsDir, { recursive: true });

const summaries = [];

for (const targetBrand of targetBrandPhases) {
  const brandName = targetBrand.brandName;
  const plan = resolveCatalogSyncPlan(brandName);
  try {
    const result = await Promise.race([
      syncBrandCatalogWithProgressiveBatches({
        supabaseUrl,
        serviceRoleKey,
        brandName,
        refreshExisting: true,
        concurrency,
        pageSize,
        requestTimeoutMs,
        maxPages,
        candidateLimit,
        sparetoFallbackLimit,
        batchSequence: [1, 50, 100, 500, 1000, 2000, 3000],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Brand sync timeout after ${brandTimeoutMs}ms`)), brandTimeoutMs),
      ),
    ]);

    const completion = Array.isArray(result?.sourceCompletion) ? result.sourceCompletion[0] || null : null;
    const sourcePolicy = result?.sourcePolicy || plan.sourcePolicy || null;
    summaries.push({
      brandName,
      phase: targetBrand.phase,
      status: "ok",
      syncBrandName: result?.syncBrandName || plan.brandName,
      preferredProviderKey: result?.preferredProviderKey || plan.preferredProviderKey,
      preferredSourceUrl: result?.preferredSourceUrl || plan.preferredSourceUrl,
      executionProviderKey: result?.executionProviderKey || plan.executionProviderKey,
      fallbackUsed: Boolean(result?.fallbackUsed),
      syncMode: result?.syncMode || (plan.mandatorySourceCompletion ? "source_pipeline" : "single_source"),
      sourcePolicyVersion: result?.sourcePolicyVersion || plan.sourcePolicyVersion || "",
      primaryAuthorityKey: sourcePolicy?.primaryAuthority?.key || "",
      helperSources: Array.isArray(sourcePolicy?.helperSources) ? sourcePolicy.helperSources.map((item) => item.key).join("|") : "",
      candidateRows: Number(result?.candidateRows || 0),
      resolvedRows: Number(result?.resolvedRows || 0),
      errorRows: Number(result?.errorRows || 0),
      targetBrandId: String(result?.targetBrandId || ""),
      completionProviderKey: completion?.providerKey || "",
      completionCandidateRows: Number(completion?.candidateRows || 0),
      completionMatchedRows: Number(completion?.matchedRows || 0),
      completionUpdatedRows: Number(completion?.updatedRows || 0),
      completionErrorRows: Number(completion?.errorRows || 0),
    });
    console.log(
      JSON.stringify({
        brandName,
        phase: targetBrand.phase,
        status: "ok",
        preferredProviderKey: plan.preferredProviderKey,
        executionProviderKey: result?.executionProviderKey || plan.executionProviderKey,
        fallbackUsed: Boolean(result?.fallbackUsed),
        sourcePolicyVersion: result?.sourcePolicyVersion || plan.sourcePolicyVersion || "",
        primaryAuthorityKey: sourcePolicy?.primaryAuthority?.key || "",
        helperSources: Array.isArray(sourcePolicy?.helperSources) ? sourcePolicy.helperSources.map((item) => item.key).join("|") : "",
        candidateRows: Number(result?.candidateRows || 0),
        resolvedRows: Number(result?.resolvedRows || 0),
        errorRows: Number(result?.errorRows || 0),
        completionMatchedRows: Number(completion?.matchedRows || 0),
        completionUpdatedRows: Number(completion?.updatedRows || 0),
      }),
    );
  } catch (error) {
    summaries.push({
      brandName,
      phase: targetBrand.phase,
      status: "error",
      syncBrandName: plan.brandName,
      preferredProviderKey: plan.preferredProviderKey,
      preferredSourceUrl: plan.preferredSourceUrl,
      executionProviderKey: plan.executionProviderKey,
      fallbackUsed: plan.fallbackUsed,
      syncMode: plan.mandatorySourceCompletion ? "source_pipeline" : "single_source",
      sourcePolicyVersion: plan.sourcePolicyVersion || "",
      primaryAuthorityKey: plan.sourcePolicy?.primaryAuthority?.key || "",
      helperSources: Array.isArray(plan.sourcePolicy?.helperSources) ? plan.sourcePolicy.helperSources.map((item) => item.key).join("|") : "",
      candidateRows: 0,
      resolvedRows: 0,
      errorRows: 1,
      targetBrandId: "",
      completionProviderKey: plan.completionProviders.join(","),
      completionCandidateRows: 0,
      completionMatchedRows: 0,
      completionUpdatedRows: 0,
      completionErrorRows: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    console.log(
      JSON.stringify({
        brandName,
        phase: targetBrand.phase,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

const finishedAt = new Date().toISOString();
const stamp = finishedAt.replaceAll(":", "-").replaceAll(".", "-");
const jsonPath = path.join(docsDir, `brand-sync-batch-summary-${stamp}.json`);
const csvPath = path.join(docsDir, `brand-sync-batch-summary-${stamp}.csv`);

const aggregate = {
  startedAt,
  finishedAt,
  totalBrands: summaries.length,
  existingPhaseBrands: summaries.filter((row) => row.phase === "existing_system_brand").length,
  missingPhaseBrands: summaries.filter((row) => row.phase === "missing_brand_bootstrap").length,
  okBrands: summaries.filter((row) => row.status === "ok").length,
  errorBrands: summaries.filter((row) => row.status === "error").length,
  totalCandidateRows: summaries.reduce((sum, row) => sum + Number(row.candidateRows || 0), 0),
  totalResolvedRows: summaries.reduce((sum, row) => sum + Number(row.resolvedRows || 0), 0),
  totalCompletionMatchedRows: summaries.reduce((sum, row) => sum + Number(row.completionMatchedRows || 0), 0),
  totalCompletionUpdatedRows: summaries.reduce((sum, row) => sum + Number(row.completionUpdatedRows || 0), 0),
};

writeFileSync(jsonPath, JSON.stringify({ aggregate, brands: summaries }, null, 2));

const csvHeaders = [
  "brand_name",
  "phase",
  "status",
  "sync_brand_name",
  "preferred_provider_key",
  "preferred_source_url",
  "execution_provider_key",
  "fallback_used",
  "sync_mode",
  "source_policy_version",
  "primary_authority_key",
  "helper_sources",
  "candidate_rows",
  "resolved_rows",
  "error_rows",
  "target_brand_id",
  "completion_provider_key",
  "completion_candidate_rows",
  "completion_matched_rows",
  "completion_updated_rows",
  "completion_error_rows",
  "message",
];

const csvLines = [
  csvHeaders.join(","),
  ...summaries.map((row) =>
    [
      row.brandName,
      row.phase || "",
      row.status,
      row.syncBrandName,
      row.preferredProviderKey,
      row.preferredSourceUrl,
      row.executionProviderKey,
      row.fallbackUsed,
      row.syncMode,
      row.sourcePolicyVersion || "",
      row.primaryAuthorityKey || "",
      row.helperSources || "",
      row.candidateRows,
      row.resolvedRows,
      row.errorRows,
      row.targetBrandId,
      row.completionProviderKey,
      row.completionCandidateRows,
      row.completionMatchedRows,
      row.completionUpdatedRows,
      row.completionErrorRows,
      row.message || "",
    ]
      .map(toCsvCell)
      .join(","),
  ),
];

writeFileSync(csvPath, `${csvLines.join("\n")}\n`);

console.log(JSON.stringify({ aggregate, jsonPath, csvPath }, null, 2));
