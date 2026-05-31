import { syncBrandCatalog } from "../netlify/functions/_shared/catalog-sync-provider.mts";

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const brandName = String(process.argv[2] || "").trim();
const refreshExisting = process.argv.includes("--no-refresh") ? false : true;
const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const pageSizeArg = process.argv.find((arg) => arg.startsWith("--page-size="));
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
const lineIdsArg = process.argv.find((arg) => arg.startsWith("--line-ids="));

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

const result = await syncBrandCatalog({
  supabaseUrl,
  serviceRoleKey,
  brandName,
  refreshExisting,
  concurrency: Number.isFinite(concurrency) ? concurrency : 8,
  pageSize: Number.isFinite(pageSize) ? pageSize : 48,
  requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 20000,
  lineIds,
});

console.log(JSON.stringify(result, null, 2));
