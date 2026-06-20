import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const docsDir = path.join(repoRoot, "docs");
const sharedDir = path.join(repoRoot, "netlify", "functions", "_shared");

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function addFinding(findings, severity, area, file, message) {
  findings.push({ severity, area, file: path.relative(repoRoot, file), message });
}

function exists(targetPath) {
  try {
    statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hasAnyText(source, needles) {
  return needles.every((needle) => source.includes(needle));
}

function listFiles(targetDir) {
  if (!exists(targetDir)) return [];
  return readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

const findings = [];

const requiredFiles = [
  "docs/core-architecture.md",
  "docs/core-guardian.md",
  "docs/module-boundaries.md",
  "docs/repo-hygiene-protocol.md",
  "docs/catalog-source-policy.md",
  "apps/web/src/modules/README.md",
  "apps/web/src/modules/admin/README.md",
  "apps/web/src/modules/admin/api.ts",
  "apps/web/src/modules/admin/routes.ts",
  "apps/web/src/modules/portal/README.md",
  "apps/web/src/modules/portal/api.ts",
  "apps/web/src/modules/portal/routes.ts",
  "apps/web/src/modules/warehouse/README.md",
  "apps/web/src/modules/warehouse/api.ts",
  "apps/web/src/modules/warehouse/routes.ts",
  "apps/web/src/modules/catalog/README.md",
  "apps/web/src/modules/shared/README.md",
  "netlify/functions/_shared/core/http.mts",
  "netlify/functions/_shared/core/user-message.mts",
  "netlify/functions/_shared/catalog/catalog-segments.mts",
  "netlify/functions/_shared/catalog/catalog-source-policy.mts",
  "netlify/functions/_shared/catalog/catalog-standardization.mts",
  "netlify/functions/_shared/catalog/catalog-sync-provider.mts",
  "netlify/functions/_shared/catalog/tecalliance-sync.mts",
  "netlify/functions/_shared/portal/portal-access.mts",
  "netlify/functions/_shared/portal/portal-orders.mts",
  "netlify/functions/_shared/portal/portal-rate-limit.mts",
  "netlify/functions/_shared/portal/portal-security.mts",
  "netlify/functions/_shared/warehouse/warehouse-partner-auth.mts",
  "scripts/ops/ensure-netlify-linked.mjs",
];

const requiredDirectories = [
  "apps/web/src/modules/admin",
  "apps/web/src/modules/portal",
  "apps/web/src/modules/warehouse",
  "apps/web/src/modules/catalog",
  "apps/web/src/modules/shared",
  "netlify/functions/_shared/auth",
  "netlify/functions/_shared/catalog",
  "netlify/functions/_shared/core",
  "netlify/functions/_shared/portal",
  "netlify/functions/_shared/pricing",
  "netlify/functions/_shared/warehouse",
  "scripts/audit",
  "scripts/maintenance",
  "scripts/ops",
  "scripts/shared",
  "scripts/sync",
  "scripts/maintenance/ensure-tecalliance-brand-records.mjs",
];

for (const relativePath of requiredFiles) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!exists(absolutePath)) {
    addFinding(findings, "critical", "core", absolutePath, "Required core file is missing.");
  }
}

for (const relativePath of requiredDirectories) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!exists(absolutePath)) {
    addFinding(findings, "critical", "core", absolutePath, "Required core directory is missing.");
  }
}

if (exists(path.join(docsDir, "core-architecture.md"))) {
  const architecture = read("docs/core-architecture.md");
  if (!hasAnyText(architecture, ["Protocol Chain", "Mandatory Catalog Rule", "Surface Rules"])) {
    addFinding(findings, "critical", "docs", path.join(docsDir, "core-architecture.md"), "Core architecture doc is missing protocol or surface rules.");
  }
}

if (exists(path.join(docsDir, "core-guardian.md"))) {
  const guardianDoc = read("docs/core-guardian.md");
  if (!hasAnyText(guardianDoc, ["Core Guardian", "audit:core", "predeploy:verify"])) {
    addFinding(findings, "critical", "docs", path.join(docsDir, "core-guardian.md"), "Guardian doc is missing enforcement references.");
  }
  if (!hasAnyText(guardianDoc, ["guardian:brands", "guardian:brands:apply", "registry-backed TecAlliance brands"])) {
    addFinding(findings, "critical", "docs", path.join(docsDir, "core-guardian.md"), "Guardian doc is missing brand registry repair references.");
  }
  if (!hasAnyText(guardianDoc, ["netlify:ensure-link", "ersen-quote-desk", "state.json"])) {
    addFinding(findings, "critical", "docs", path.join(docsDir, "core-guardian.md"), "Guardian doc is missing Netlify link bootstrap references.");
  }
}

const packageJsonPath = path.join(repoRoot, "package.json");
if (exists(packageJsonPath)) {
  const packageJson = read("package.json");
  if (!hasAnyText(packageJson, ["guardian:brands:apply", "predeploy:verify", "netlify:ensure-link"])) {
    addFinding(findings, "critical", "scripts", packageJsonPath, "Package scripts must wire Netlify link bootstrap and brand guardian apply into production verification.");
  }
}

const appAdminRecordsPath = path.join(repoRoot, "netlify/functions/app-admin-records.mts");
if (exists(appAdminRecordsPath)) {
  const appAdminRecords = read("netlify/functions/app-admin-records.mts");
  if (!hasAnyText(appAdminRecords, ["ensureTecAllianceBrandRecords", "listTecAllianceBrandEntries"])) {
    addFinding(findings, "critical", "functions", appAdminRecordsPath, "Admin brand-list endpoint must auto-seed registry-backed brands.");
  }
}

const shipPath = path.join(repoRoot, "scripts/ship-staged-to-production.mjs");
if (exists(shipPath)) {
  const shipScript = read("scripts/ship-staged-to-production.mjs");
  if (!hasAnyText(shipScript, ["runProductionGuardians", "guardian:brands:apply", "netlify:ensure-link"])) {
    addFinding(findings, "critical", "scripts", shipPath, "Production ship script must run Netlify link bootstrap and brand guardian apply before build/push.");
  }
}

if (exists(path.join(docsDir, "catalog-source-policy.md"))) {
  const catalogPolicy = read("docs/catalog-source-policy.md");
  if (
    !hasAnyText(catalogPolicy, [
      "Mandatory Official Fetch Contract",
      "Batch Execution Order",
      "TecAlliance is the primary authority",
    ])
  ) {
    addFinding(findings, "critical", "docs", path.join(docsDir, "catalog-source-policy.md"), "Catalog source policy lost mandatory authority rules.");
  }
}

const coreSharedFiles = listFiles(path.join(sharedDir, "core"));
if (!coreSharedFiles.includes("http.mts") || !coreSharedFiles.includes("user-message.mts")) {
  addFinding(findings, "critical", "core", path.join(sharedDir, "core"), "Core shared helpers are incomplete.");
}

const catalogSharedFiles = listFiles(path.join(sharedDir, "catalog"));
for (const requiredCatalogFile of [
  "catalog-segments.mts",
  "catalog-source-policy.mts",
  "catalog-standardization.mts",
  "catalog-sync-provider.mts",
  "tecalliance-sync.mts",
]) {
  if (!catalogSharedFiles.includes(requiredCatalogFile)) {
    addFinding(findings, "critical", "catalog", path.join(sharedDir, "catalog", requiredCatalogFile), "Catalog core helper is missing.");
  }
}

const portalSharedFiles = listFiles(path.join(sharedDir, "portal"));
for (const requiredPortalFile of [
  "portal-access.mts",
  "portal-orders.mts",
  "portal-rate-limit.mts",
  "portal-security.mts",
]) {
  if (!portalSharedFiles.includes(requiredPortalFile)) {
    addFinding(findings, "critical", "portal", path.join(sharedDir, "portal", requiredPortalFile), "Portal shared helper is missing.");
  }
}

const guardReport = {
  checkedAt: new Date().toISOString(),
  critical: findings.filter((item) => item.severity === "critical").length,
  warning: findings.filter((item) => item.severity === "warning").length,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `core-guardian-audit-${guardReport.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(guardReport, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...guardReport, report: outPath }, null, 2));
if (guardReport.critical > 0) {
  process.exitCode = 1;
}
