import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const page = readFileSync(path.join(repoRoot, "apps/web/src/presentation/pages/CatalogPage.tsx"), "utf8");
const sync = readFileSync(path.join(repoRoot, "netlify/functions/_shared/catalog/catalog-sync-provider.mts"), "utf8");
const admin = readFileSync(path.join(repoRoot, "netlify/functions/admin-sync-brand-catalog.mts"), "utf8");

const checks = [
  [page, "syncBrandCatalog"],
  [page, "Re-Synching"],
  [page, "fallbackUsed"],
  [sync, "completeMissingCatalogFieldsFromSpareto"],
  [sync, "preferredSourceType: \"official\""],
  [sync, "executionProviderKey: \"spareto\""],
  [sync, "mandatorySourceCompletion"],
  [sync, "mandatoryTechnicalFields"],
  [sync, "sourcePolicyVersion"],
  [admin, "syncBrandCatalog"],
];

const findings = checks.flatMap(([source, token]) => (source.includes(token) ? [] : [{ severity: "critical", file: "resync", message: `Missing resync signal: ${token}` }]));

const summary = {
  checkedAt: new Date().toISOString(),
  gate: "resync",
  critical: findings.length,
  warning: 0,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `catalog-resync-audit-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) process.exitCode = 1;
