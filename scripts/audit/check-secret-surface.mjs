import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const riskyNamePattern = /\.(apk|aab|keystore|jks)$/i;
const riskyFileNamePattern = /(^|\/)(\.env(\..*)?|keystore\.properties)$/i;
const safeExamplePattern = /(^|\/)(\.env\.example|.*\.example)$/i;
const generatedAssetPattern = /^(android\/app\/src\/main\/assets\/public|ios\/App\/App\/public)\/assets\/.*\.js$/i;
const secretAssignmentPattern = /^\s*(?:export\s+)?(?:SUPABASE_SERVICE_ROLE_KEY|PORTAL_SESSION_SECRET|RESEND_API_KEY|WAREHOUSE_API_KEY|PRIVATE_KEY|DATABASE_URL|POSTGRES_URL|storePassword|keyPassword)\s*(?:=\s*["']?[^"'\s<]{8,}|:\s*["'][^"']{8,})/i;
const connectionStringPattern = /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i;

function listGitVisibleFiles() {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to list git-visible files");
  }
  return result.stdout.split("\0").filter(Boolean);
}

function scanFile(relativePath, findings) {
  const fullPath = path.join(repoRoot, relativePath);
  const fileName = path.basename(relativePath);
  if ((riskyNamePattern.test(fileName) || riskyFileNamePattern.test(relativePath)) && !safeExamplePattern.test(relativePath)) {
    findings.push({ type: "risky-file", path: relativePath });
    return;
  }
  if (generatedAssetPattern.test(relativePath)) return;
  try {
    const size = statSync(fullPath).size;
    if (size > 1_000_000) return;
    const text = readFileSync(fullPath, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if ((secretAssignmentPattern.test(line) || connectionStringPattern.test(line)) && !/placeholder|example|changeme|your-/i.test(line)) {
        findings.push({
          type: "secret-like-line",
          path: relativePath,
          line: index + 1,
          sample: line.trim().slice(0, 180),
        });
      }
    });
  } catch {
    // Binary or unreadable text; skip.
  }
}

const findings = [];
for (const relativePath of listGitVisibleFiles()) {
  scanFile(relativePath, findings);
}

const riskyFiles = findings.filter((item) => item.type === "risky-file");
const secretLines = findings.filter((item) => item.type === "secret-like-line");

const report = {
  checkedAt: new Date().toISOString(),
  riskyFiles,
  secretLines,
  critical: riskyFiles.length + secretLines.length,
};

console.log(JSON.stringify(report, null, 2));
if (report.critical > 0) {
  process.exitCode = 1;
}
