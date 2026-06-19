import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const strict = process.argv.includes("--strict");

function runGit(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  const file = line.slice(3).trim();
  return { status, file };
}

function isProtectedSource(file) {
  return (
    file.startsWith("apps/web/src/") ||
    file.startsWith("netlify/functions/") ||
    file.startsWith("supabase/migrations/") ||
    file.startsWith("scripts/") ||
    file === "package.json" ||
    file === "apps/web/package.json" ||
    file === "netlify.toml"
  );
}

function isGeneratedNoise(file) {
  return (
    file === "review-package.zip" ||
    file.startsWith("review-package/") ||
    file.startsWith("docs/security/") ||
    file.startsWith("docs/performance/") ||
    file.includes("/captures/") ||
    /^docs\/.*\.(csv|json)$/i.test(file) ||
    /docs\/.*-(summary|errors|changes|catalog|import|fill|audit)-20/.test(file) ||
    file === "deno.lock" ||
    file === "eng.traineddata" ||
    file === "capacitor.config.ts" ||
    file.startsWith("android/") ||
    file.startsWith("ios/")
  );
}

const statusLines = runGit(["status", "--short", "--untracked-files=all"]).split(/\r?\n/).filter(Boolean);
const entries = statusLines.map(parseStatusLine);

const modified = entries.filter((entry) => entry.status !== "??");
const untracked = entries.filter((entry) => entry.status === "??");
const untrackedProtectedSource = untracked.filter((entry) => isProtectedSource(entry.file));
const visibleGeneratedNoise = untracked.filter((entry) => isGeneratedNoise(entry.file));
const otherUntracked = untracked.filter((entry) => !isProtectedSource(entry.file) && !isGeneratedNoise(entry.file));

const findings = [];
for (const entry of untrackedProtectedSource) {
  findings.push({
    severity: strict ? "critical" : "warning",
    type: "untracked-source",
    file: entry.file,
    message: "Source/migration/script file is not tracked. Commit intentionally or move it out of the product repo.",
  });
}

for (const entry of otherUntracked) {
  findings.push({
    severity: "warning",
    type: "uncategorized-untracked",
    file: entry.file,
    message: "Untracked file is not covered by generated-artifact policy. Classify it before deploy.",
  });
}

if (strict && modified.length > 0) {
  for (const entry of modified) {
    findings.push({
      severity: "critical",
      type: "modified-file",
      file: entry.file,
      message: "Strict hygiene requires a clean worktree before production deploy.",
    });
  }
}

const summary = {
  checkedAt: new Date().toISOString(),
  strict,
  modified: modified.length,
  untracked: untracked.length,
  untrackedProtectedSource: untrackedProtectedSource.length,
  visibleGeneratedNoise: visibleGeneratedNoise.length,
  otherUntracked: otherUntracked.length,
  critical: findings.filter((finding) => finding.severity === "critical").length,
  warning: findings.filter((finding) => finding.severity === "warning").length,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `worktree-hygiene-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) process.exitCode = 1;
