import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const page = readFileSync(path.join(repoRoot, "apps/web/src/modules/admin/pages/CatalogPage.tsx"), "utf8");
const api = readFileSync(path.join(repoRoot, "apps/web/src/infrastructure/api/catalogApi.ts"), "utf8");

const checks = [
  [page, "fetchCatalogExportRows"],
  [page, '["Product_Code", "Brand", "Product_Name", "EAN", "OEM_No", "Vehicle", "Vehicle_Model"'],
  [page, "downloadCsv(`catalog-"],
  [api, "const mapRows = (rows: ExportRow[]) =>"],
  [api, "vehicle_model: row.vehicle_model || \"\""],
  [api, "vehicle_model: String(row.vehicle_model || \"\")"],
  [api, "fetchRowsViaCloudCatalog"],
  [api, "fetchCatalogExportRows"],
];

const findings = checks.flatMap(([source, token]) => (source.includes(token) ? [] : [{ severity: "critical", file: "export", message: `Missing export signal: ${token}` }]));

const summary = {
  checkedAt: new Date().toISOString(),
  gate: "export",
  critical: findings.length,
  warning: 0,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `catalog-export-audit-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) process.exitCode = 1;
