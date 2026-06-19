import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const targets = [
  ".DS_Store",
  "apps/.DS_Store",
  "apps/web/.DS_Store",
  "apps/web/src/.DS_Store",
  "apps/web/src/application/.DS_Store",
  "apps/web/src/infrastructure/.DS_Store",
  "backups/.DS_Store",
  "backups/daily/.DS_Store",
  "docs/.DS_Store",
  "supabase/.DS_Store",
];

function removeLogFiles(relativeDir) {
  const fullDir = path.join(repoRoot, relativeDir);
  try {
    for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
      const childRelative = path.join(relativeDir, entry.name);
      const childFull = path.join(repoRoot, childRelative);
      if (entry.isDirectory()) {
        removeLogFiles(childRelative);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".log")) {
        rmSync(childFull, { force: true });
        removed += 1;
      }
    }
  } catch {
    // Best effort only.
  }
}

let removed = 0;
for (const relativePath of targets) {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    rmSync(fullPath, { force: true, recursive: true });
    removed += 1;
  } catch {
    // Best effort only.
  }
}

removeLogFiles("docs");

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), removed }, null, 2));
