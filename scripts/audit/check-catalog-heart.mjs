import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function addFinding(findings, severity, file, message) {
  findings.push({ severity, file, message });
}

const findings = [];

const catalogPage = read("apps/web/src/modules/admin/pages/CatalogPage.tsx");
const catalogApi = read("apps/web/src/infrastructure/api/catalogApi.ts");
const appRpc = read("netlify/functions/app-rpc.mts");

const requiredCatalogPageSignals = [
  "readCatalogCache",
  "writeCatalogCache",
  "fetchCloudCatalog",
  "fetchCatalogRowsByCodes",
  "fetchCatalogExportRows",
  "syncBrandCatalog",
  "bulkImportCatalog",
  "isSoftCatalogRequestFailure",
  "CATALOG_CACHE_KEY",
  "CATALOG_CACHE_WRITE_DELAY_MS",
];

for (const token of requiredCatalogPageSignals) {
  if (!catalogPage.includes(token)) {
    addFinding(findings, "critical", "apps/web/src/modules/admin/pages/CatalogPage.tsx", `Missing catalog heart signal: ${token}`);
  }
}

if (!catalogApi.includes("vehicle_model: String(row.vehicle_model || \"\")")) {
  addFinding(findings, "critical", "apps/web/src/infrastructure/api/catalogApi.ts", "Catalog API must map vehicle_model from cloud_catalog_page.");
}

const requiredAppRpcSignals = [
  "const CATALOG_SEARCH_CACHE_TTL_MS =",
  "const CATALOG_ROW_FETCH_SOFT_TIMEOUT_MS =",
  "vehicle_model?: string | null;",
  "vehicle_model: String(row.vehicle_model || \"\")",
  "catalogSearchCache.set(cacheKey",
  "cloud-catalog-page-soft-timeout",
];

for (const token of requiredAppRpcSignals) {
  if (!appRpc.includes(token)) {
    addFinding(findings, "critical", "netlify/functions/app-rpc.mts", `Missing catalog backend signal: ${token}`);
  }
}

if (!appRpc.includes("normalized_ean")) {
  addFinding(findings, "critical", "netlify/functions/app-rpc.mts", "Catalog backend must preserve normalized_ean search support.");
}
if (!appRpc.includes("vehicle_model")) {
  addFinding(findings, "critical", "netlify/functions/app-rpc.mts", "Catalog backend must preserve vehicle_model support.");
}

const summary = {
  checkedAt: new Date().toISOString(),
  critical: findings.filter((item) => item.severity === "critical").length,
  warning: findings.filter((item) => item.severity === "warning").length,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `catalog-heart-audit-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) {
  process.exitCode = 1;
}
