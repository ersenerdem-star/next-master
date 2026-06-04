import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCatalogSyncPlan, syncBrandCatalog } from "../netlify/functions/_shared/catalog-sync-provider.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
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

const targetBrands = (requestedBrands.length > 0 ? requestedBrands : liveBrands.map((row) => String(row?.name || "").trim()))
  .filter(Boolean)
  .filter((brand) => brand.toLowerCase() !== "unbranded");

const startedAt = new Date().toISOString();
mkdirSync(docsDir, { recursive: true });

const summaries = [];

for (const brandName of targetBrands) {
  const plan = resolveCatalogSyncPlan(brandName);
  try {
    const result = await Promise.race([
      syncBrandCatalog({
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
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Brand sync timeout after ${brandTimeoutMs}ms`)), brandTimeoutMs),
      ),
    ]);

    const completion = Array.isArray(result?.sourceCompletion) ? result.sourceCompletion[0] || null : null;
    summaries.push({
      brandName,
      status: "ok",
      syncBrandName: result?.syncBrandName || plan.brandName,
      preferredProviderKey: result?.preferredProviderKey || plan.preferredProviderKey,
      preferredSourceUrl: result?.preferredSourceUrl || plan.preferredSourceUrl,
      executionProviderKey: result?.executionProviderKey || plan.executionProviderKey,
      fallbackUsed: Boolean(result?.fallbackUsed),
      syncMode: result?.syncMode || (plan.mandatorySourceCompletion ? "source_pipeline" : "single_source"),
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
        status: "ok",
        preferredProviderKey: plan.preferredProviderKey,
        executionProviderKey: result?.executionProviderKey || plan.executionProviderKey,
        fallbackUsed: Boolean(result?.fallbackUsed),
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
      status: "error",
      syncBrandName: plan.brandName,
      preferredProviderKey: plan.preferredProviderKey,
      preferredSourceUrl: plan.preferredSourceUrl,
      executionProviderKey: plan.executionProviderKey,
      fallbackUsed: plan.fallbackUsed,
      syncMode: plan.mandatorySourceCompletion ? "source_pipeline" : "single_source",
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
    console.log(JSON.stringify({ brandName, status: "error", message: error instanceof Error ? error.message : String(error) }));
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
  "status",
  "sync_brand_name",
  "preferred_provider_key",
  "preferred_source_url",
  "execution_provider_key",
  "fallback_used",
  "sync_mode",
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
      row.status,
      row.syncBrandName,
      row.preferredProviderKey,
      row.preferredSourceUrl,
      row.executionProviderKey,
      row.fallbackUsed,
      row.syncMode,
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
