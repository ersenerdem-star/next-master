import { execFileSync } from "node:child_process";
import { syncBrandCatalog } from "../netlify/functions/_shared/catalog-sync-provider.mts";

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(execFileSync("npx", ["netlify", "env:get", name], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
const brandName = String(process.argv[2] || "").trim();
const refreshExisting = process.argv.includes("--no-refresh") ? false : true;
const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const pageSizeArg = process.argv.find((arg) => arg.startsWith("--page-size="));
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
const lineIdsArg = process.argv.find((arg) => arg.startsWith("--line-ids="));
const seedPrefixesArg = process.argv.find((arg) => arg.startsWith("--seed-prefixes="));

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

if (!brandName) {
  throw new Error("Brand name argument is required");
}

const concurrency = Number.parseInt(concurrencyArg?.split("=")[1] || "8", 10);
const pageSize = Number.parseInt(pageSizeArg?.split("=")[1] || "48", 10);
const requestTimeoutMs = Number.parseInt(timeoutArg?.split("=")[1] || "20000", 10);
const lineIds = String(lineIdsArg?.split("=")[1] || "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const seedPrefixes = String(seedPrefixesArg?.split("=")[1] || "")
  .split(",")
  .map((value) => String(value || "").trim())
  .filter(Boolean);

const result = await syncBrandCatalog({
  supabaseUrl,
  serviceRoleKey,
  brandName,
  refreshExisting,
  concurrency: Number.isFinite(concurrency) ? concurrency : 8,
  pageSize: Number.isFinite(pageSize) ? pageSize : 48,
  requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 20000,
  lineIds,
  seedPrefixes,
});

console.log(JSON.stringify(result, null, 2));
