#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function read(command, args) {
  return String(execFileSync(command, args, { encoding: "utf8" }) || "").trim();
}

function commandExists(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipBuild: false,
    message: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--allow-migrations") {
      console.log("Legacy --allow-migrations detected. Staged Supabase migrations are now applied automatically before commit/push.");
    }
    else if (arg === "--message" || arg === "-m") {
      options.message = String(argv[index + 1] || "").trim();
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function ensureMainBranch() {
  const branch = read("git", ["branch", "--show-current"]);
  const upstream = read("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (branch !== "main" || upstream !== "origin/main") {
    throw new Error(`Refusing production ship from ${branch || "detached"} / ${upstream || "no upstream"}. Use main tracking origin/main.`);
  }
}

function stagedFiles() {
  return read("git", ["diff", "--cached", "--name-only"])
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function ensureSafeStagedSet(files) {
  if (!files.length) {
    throw new Error("No staged files. Stage only the intended production files first, then run npm run ship.");
  }
}

function commitMessage(options) {
  if (options.message) return options.message;
  const files = stagedFiles();
  if (files.some((file) => file.includes("portal"))) return "fix: stabilize portal production flow";
  if (files.some((file) => file.includes("catalog"))) return "fix: stabilize catalog production flow";
  return "chore: ship production update";
}

const options = parseArgs(process.argv.slice(2));
const repoRoot = read("git", ["rev-parse", "--show-toplevel"]);

function runBuild() {
  if (commandExists("npm")) {
    run("npm", ["run", "build"]);
    return;
  }
  run(process.execPath, [path.join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(repoRoot, "apps/web/tsconfig.json"), "--noEmit"]);
  run(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: path.join(repoRoot, "apps/web"),
  });
}

function runAudit(scriptPath) {
  if (commandExists("npm")) {
    const scriptName = scriptPath.includes("core") ? "audit:core" : "audit:secrets";
    run("npm", ["run", scriptName]);
    return;
  }
  run(process.execPath, [path.join(repoRoot, scriptPath)]);
}

function runProductionGuardians() {
  if (commandExists("npm")) {
    run("npm", ["run", "guardian:brands:apply"]);
    return;
  }
  run(process.execPath, [path.join(repoRoot, "scripts/maintenance/ensure-tecalliance-brand-records.mjs"), "--apply"]);
}

function stagedMigrationFiles(files) {
  return files.filter((file) => file.startsWith("supabase/migrations/") && file.endsWith(".sql"));
}

function applySupabaseMigrations(files) {
  const migrations = stagedMigrationFiles(files);
  if (!migrations.length) return;

  const applyScript = path.join(repoRoot, "scripts/ops/apply-staged-supabase-migrations.mjs");
  const args = [applyScript];
  for (const file of migrations) args.push("--file", file);
  run(process.execPath, args);
}

function reportDeployState(commit) {
  const deployStateScript = path.join(repoRoot, "scripts/ops/check-netlify-deploy-state.mjs");
  const result = spawnSync(process.execPath, [deployStateScript, "--commit", commit], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    console.log("Production deploy status check did not complete. Git push remains complete; rerun npm run deploy:status.");
  }
}

ensureMainBranch();
const files = stagedFiles();
ensureSafeStagedSet(files);

console.log("Production ship staged files:");
for (const file of files) console.log(`- ${file}`);

run("git", ["diff", "--check", "--cached"]);

if (!options.skipBuild) {
  runProductionGuardians();
  runBuild();
  runAudit("scripts/check-core-guardian.mjs");
  runAudit("scripts/check-secret-surface.mjs");
}

if (options.dryRun) {
  run(process.execPath, [path.join(repoRoot, "scripts/ops/apply-staged-supabase-migrations.mjs"), "--dry-run"]);
  console.log("Dry run complete. No commit or push was made.");
  process.exit(0);
}

applySupabaseMigrations(files);

const message = commitMessage(options);
run("git", ["commit", "-m", message]);
const shippedCommit = read("git", ["rev-parse", "HEAD"]);
run("git", ["push", "origin", "HEAD:main"]);

console.log("Pushed to origin/main. Checking Git-connected Netlify production deploy state...");
reportDeployState(shippedCommit);
