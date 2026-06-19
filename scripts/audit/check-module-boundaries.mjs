import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const functionsDir = path.join(repoRoot, "netlify", "functions");
const appEntryFile = path.join(repoRoot, "apps", "web", "src", "app", "App.tsx");
const presentationPagesDir = path.join(repoRoot, "apps", "web", "src", "presentation", "pages");
const frontendModuleRouteFiles = [
  path.join(repoRoot, "apps", "web", "src", "modules", "admin", "routes.ts"),
  path.join(repoRoot, "apps", "web", "src", "modules", "portal", "routes.ts"),
  path.join(repoRoot, "apps", "web", "src", "modules", "warehouse", "routes.ts"),
];

function read(filePath) {
  return readFileSync(filePath, "utf8");
}

function listFunctionFiles() {
  return readdirSync(functionsDir)
    .filter((name) => name.endsWith(".mts"))
    .map((name) => path.join(functionsDir, name));
}

function classifyFunction(name) {
  if (name.startsWith("portal-")) return "portal";
  if (name.startsWith("warehouse-")) return "warehouse";
  if (name.startsWith("admin-warehouse-")) return "warehouse-admin";
  if (name.startsWith("admin-") || name.startsWith("app-")) return "admin";
  return "shared-public";
}

function addFinding(findings, severity, moduleName, file, message) {
  findings.push({ severity, module: moduleName, file: path.relative(repoRoot, file), message });
}

function listPresentationPageFiles() {
  return readdirSync(presentationPagesDir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => path.join(presentationPagesDir, name));
}

const findings = [];
const files = listFunctionFiles();

for (const file of files) {
  const name = path.basename(file);
  const moduleName = classifyFunction(name);
  const source = read(file);
  const usesServiceRole = /SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey|serviceRoleHeaders/.test(source);

  if (moduleName === "admin") {
    const hasAdminAuth =
      /requireCallerProfile/.test(source) ||
      /resolveCaller/.test(source) ||
      /isSuperadminRole/.test(source) ||
      name === "admin-login-branding.mts";
    if (usesServiceRole && !hasAdminAuth) {
      addFinding(findings, "critical", moduleName, file, "Admin service-role path has no visible caller/role verification.");
    }
  }

  if (moduleName === "portal") {
    const hasPortalVerification =
      /resolvePortalInvite|resolvePortalInvitePreview|verifyPortalSessionToken|readPortalSessionCookie|fetchPortalInviteByEmail|fetchPortalInviteByIdAndEmail|verifyPortalPasswordResetToken/.test(
        source,
      );
    const hasRateLimit = /enforcePortalRateLimit/.test(source) || name === "portal-logout.mts";
    if (usesServiceRole && !hasPortalVerification) {
      addFinding(findings, "critical", moduleName, file, "Portal service-role path has no visible invite/session verification.");
    }
    if (!hasRateLimit) {
      addFinding(findings, "warning", moduleName, file, "Portal endpoint has no visible rate-limit call.");
    }
  }

  if (moduleName === "warehouse") {
    if (!/readPartnerApiKey/.test(source) || !/enforcePartnerRequestSecurity/.test(source)) {
      addFinding(findings, "critical", moduleName, file, "External warehouse endpoint must enforce API key and partner request security.");
    }
  }

  if (moduleName === "warehouse-admin") {
    if (!/requireCallerProfile/.test(source)) {
      addFinding(findings, "critical", moduleName, file, "Warehouse admin configuration endpoint must verify caller profile.");
    }
  }

  if (/select:\s*"\*"/.test(source)) {
    addFinding(findings, "warning", moduleName, file, "Avoid unbounded select=* in Netlify functions.");
  }
}

const requiredPaths = [
  "apps/web/src/modules/admin/README.md",
  "apps/web/src/modules/admin/api.ts",
  "apps/web/src/modules/admin/routes.ts",
  "apps/web/src/modules/portal/README.md",
  "apps/web/src/modules/portal/api.ts",
  "apps/web/src/modules/portal/routes.ts",
  "apps/web/src/modules/warehouse/README.md",
  "apps/web/src/modules/warehouse/api.ts",
  "apps/web/src/modules/warehouse/routes.ts",
  "netlify/functions/_modules/admin/README.md",
  "netlify/functions/_modules/portal/README.md",
  "netlify/functions/_modules/warehouse/README.md",
  "docs/module-boundaries.md",
];

for (const relativePath of requiredPaths) {
  try {
    read(path.join(repoRoot, relativePath));
  } catch {
    addFinding(findings, "critical", "boundary", path.join(repoRoot, relativePath), "Required module boundary file is missing.");
  }
}

const appEntrySource = read(appEntryFile);
if (/presentation\/pages/.test(appEntrySource)) {
  addFinding(
    findings,
    "critical",
    "frontend",
    appEntryFile,
    "App entrypoint must load pages through module route entries, not presentation/pages directly.",
  );
}

for (const moduleRouteFile of frontendModuleRouteFiles) {
  const moduleRouteSource = read(moduleRouteFile);
  if (/presentation\/pages/.test(moduleRouteSource)) {
    addFinding(
      findings,
      "critical",
      "frontend",
      moduleRouteFile,
      "Module route entry must load module-owned page adapters, not presentation/pages directly.",
    );
  }
}

for (const presentationPageFile of listPresentationPageFiles()) {
  const source = read(presentationPageFile).trim();
  if (!/^export\s+\{\s*[A-Za-z0-9_]+\s+\}\s+from\s+["'][^"']+["'];?$/.test(source)) {
    addFinding(
      findings,
      "critical",
      "frontend",
      presentationPageFile,
      "Presentation pages must remain compatibility wrappers only; move implementation to a module page.",
    );
  }
}

const summary = {
  checkedAt: new Date().toISOString(),
  functionsChecked: files.length,
  critical: findings.filter((item) => item.severity === "critical").length,
  warning: findings.filter((item) => item.severity === "warning").length,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `module-boundary-audit-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) {
  process.exitCode = 1;
}
