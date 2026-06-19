import { syncBrandCatalogWithProgressiveBatches } from "../../netlify/functions/_shared/catalog/catalog-sync-provider.mts";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot });
const brandName = String(process.argv[2] || "").trim();
const refreshExisting = process.argv.includes("--no-refresh") ? false : true;
const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const pageSizeArg = process.argv.find((arg) => arg.startsWith("--page-size="));
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
const lineIdsArg = process.argv.find((arg) => arg.startsWith("--line-ids="));
const seedPrefixesArg = process.argv.find((arg) => arg.startsWith("--seed-prefixes="));
const maxPagesArg = process.argv.find((arg) => arg.startsWith("--max-pages="));
const noExpand = process.argv.includes("--no-expand");
const skipDiscovery = process.argv.includes("--skip-discovery");
const candidateLimitArg = process.argv.find((arg) => arg.startsWith("--candidate-limit="));
const sparetoFallbackLimitArg = process.argv.find((arg) => arg.startsWith("--spareto-fallback-limit="));

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Pass them via env, .sync-secrets.local, or --supabase-url/--supabase-service-role-key.");
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

const result = await syncBrandCatalogWithProgressiveBatches({
  supabaseUrl,
  serviceRoleKey,
  brandName,
  refreshExisting,
  concurrency: Number.isFinite(concurrency) ? concurrency : 8,
  pageSize: Number.isFinite(pageSize) ? pageSize : 48,
  requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 20000,
  maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : undefined,
  expandPrefixes: noExpand ? false : undefined,
  skipDiscovery: skipDiscovery ? true : undefined,
  candidateLimit: Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : undefined,
  lineIds,
  seedPrefixes,
  sparetoFallbackLimit:
    Number.isFinite(sparetoFallbackLimit) && sparetoFallbackLimit > 0 ? sparetoFallbackLimit : undefined,
});

console.log(JSON.stringify(result, null, 2));
