import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const page = readFileSync(path.join(repoRoot, "apps/web/src/modules/admin/pages/CatalogPage.tsx"), "utf8");
const api = readFileSync(path.join(repoRoot, "apps/web/src/infrastructure/api/importApi.ts"), "utf8");
const templates = readFileSync(path.join(repoRoot, "apps/web/src/shared/catalog/importTemplates.ts"), "utf8");
const rpc = readFileSync(path.join(repoRoot, "netlify/functions/app-rpc.mts"), "utf8");
const migration = readFileSync(path.join(repoRoot, "supabase/migrations/20260608_53_catalog_vehicle_model_import.sql"), "utf8");

const checks = [
  [page, "bulkImportCatalog"],
  [page, "downloadCatalogTemplate"],
  [page, "downloadCatalogLifecycleTemplate"],
  [page, "Vehicle_Model"],
  [api, "vehicle_model: row.vehicle_model == null ? null : String(row.vehicle_model || \"\").trim() || null"],
  [templates, "Vehicle_Model"],
  [templates, "catalog-import-template.csv"],
  [rpc, "vehicle_model?: string | null;"],
  [rpc, "vehicle_model: String(row.vehicle_model || \"\")"],
  [migration, "vehicle_model text"],
  [migration, "vehicle_model = coalesce(excluded.vehicle_model, public.catalog_products.vehicle_model)"],
  [migration, "nullif(trim(coalesce(vehicle_model, '')), '')"],
];

const findings = checks.flatMap(([source, token]) => (source.includes(token) ? [] : [{ severity: "critical", file: "import", message: `Missing import signal: ${token}` }]));

const summary = {
  checkedAt: new Date().toISOString(),
  gate: "import",
  critical: findings.length,
  warning: 0,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `catalog-import-audit-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) process.exitCode = 1;
