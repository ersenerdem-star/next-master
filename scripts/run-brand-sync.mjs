import { execFileSync } from "node:child_process";
import {
  syncBrandCatalog,
  syncBrandCatalogWithProgressiveBatches,
} from "../netlify/functions/_shared/catalog/catalog-sync-provider.mts";

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(execFileSync("npx", ["netlify", "env:get", name], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
const brandName = String(process.argv[2] || "").trim();
const refreshExisting = process.argv.includes("--no-refresh") ? false : true;
const singlePass = process.argv.includes("--single-pass");
const skipCompletion = process.argv.includes("--skip-completion");
const onlyNew = process.argv.includes("--only-new");
const expandPrefixes = !process.argv.includes("--no-expand");
const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const pageSizeArg = process.argv.find((arg) => arg.startsWith("--page-size="));
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
const lineIdsArg = process.argv.find((arg) => arg.startsWith("--line-ids="));
const seedPrefixesArg = process.argv.find((arg) => arg.startsWith("--seed-prefixes="));
const maxPagesArg = process.argv.find((arg) => arg.startsWith("--max-pages="));
const candidateLimitArg = process.argv.find((arg) => arg.startsWith("--candidate-limit="));
const sparetoFallbackLimitArg = process.argv.find((arg) => arg.startsWith("--spareto-fallback-limit="));

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

if (!brandName) {
  throw new Error("Brand name argument is required");
}

const concurrency = Number.parseInt(concurrencyArg?.split("=")[1] || "8", 10);
const pageSize = Number.parseInt(pageSizeArg?.split("=")[1] || "48", 10);
const requestTimeoutMs = Number.parseInt(timeoutArg?.split("=")[1] || "20000", 10);
const maxPages = Number.parseInt(maxPagesArg?.split("=")[1] || "0", 10);
const candidateLimit = Number.parseInt(candidateLimitArg?.split("=")[1] || "0", 10);
const sparetoFallbackLimit = Number.parseInt(sparetoFallbackLimitArg?.split("=")[1] || "0", 10);
const lineIds = String(lineIdsArg?.split("=")[1] || "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const seedPrefixes = String(seedPrefixesArg?.split("=")[1] || "")
  .split(",")
  .map((value) => String(value || "").trim())
  .filter(Boolean);

const syncInput = {
  supabaseUrl,
  serviceRoleKey,
  brandName,
  refreshExisting,
  onlyNew,
  concurrency: Number.isFinite(concurrency) ? concurrency : 8,
  pageSize: Number.isFinite(pageSize) ? pageSize : 48,
  requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 20000,
  maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : undefined,
  expandPrefixes,
  candidateLimit: Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : undefined,
  lineIds,
  seedPrefixes,
  sparetoFallbackLimit:
    Number.isFinite(sparetoFallbackLimit) && sparetoFallbackLimit > 0 ? sparetoFallbackLimit : undefined,
  skipCompletion,
};

const result = singlePass
  ? await syncBrandCatalog(syncInput)
  : await syncBrandCatalogWithProgressiveBatches(syncInput);

console.log(JSON.stringify(result, null, 2));
