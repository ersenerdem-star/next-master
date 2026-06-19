import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const files = {
  page: "apps/web/src/modules/admin/pages/CatalogPage.tsx",
  api: "apps/web/src/infrastructure/api/catalogApi.ts",
  rpc: "netlify/functions/app-rpc.mts",
};

const page = readFileSync(path.join(repoRoot, files.page), "utf8");
const api = readFileSync(path.join(repoRoot, files.api), "utf8");
const rpc = readFileSync(path.join(repoRoot, files.rpc), "utf8");

const required = [
  [files.page, "readCatalogCache"],
  [files.page, "writeCatalogCache"],
  [files.page, "fetchCloudCatalog"],
  [files.page, "isSoftCatalogRequestFailure"],
  [files.page, "CATALOG_CACHE_KEY"],
  [files.page, "CATALOG_CACHE_WRITE_DELAY_MS"],
  [files.api, 'vehicle_model: String(row.vehicle_model || "")'],
  [files.rpc, "const CATALOG_SEARCH_CACHE_TTL_MS ="],
  [files.rpc, "const CATALOG_ROW_FETCH_SOFT_TIMEOUT_MS ="],
  [files.rpc, "cloud_catalog_page"],
  [files.rpc, "catalogSearchCache.set(cacheKey"],
  [files.rpc, "normalized_ean"],
  [files.rpc, "vehicle_model"],
];

const findings = required.flatMap(([file, token]) => {
  const source = file === files.page ? page : file === files.api ? api : rpc;
  return source.includes(token) ? [] : [{ severity: "critical", file, message: `Missing search signal: ${token}` }];
});

const summary = {
  checkedAt: new Date().toISOString(),
  gate: "search",
  critical: findings.length,
  warning: 0,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `catalog-search-audit-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) process.exitCode = 1;
