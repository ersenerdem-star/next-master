#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

function read(command, args, options = {}) {
  return String(execFileSync(command, args, { encoding: "utf8", ...options }) || "").trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function parseArgs(argv) {
  const options = {
    files: [],
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      options.files.push(String(argv[index + 1] || "").trim());
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function stagedMigrationFiles(repoRoot) {
  return read("git", ["diff", "--cached", "--name-only"])
    .split("\n")
    .map((file) => file.trim())
    .filter((file) => file.startsWith("supabase/migrations/") && file.endsWith(".sql"))
    .sort()
    .map((file) => path.join(repoRoot, file));
}

function normalizeFiles(repoRoot, files) {
  const selected = files.length ? files : stagedMigrationFiles(repoRoot);
  return selected
    .map((file) => (path.isAbsolute(file) ? file : path.join(repoRoot, file)))
    .filter((file) => file.includes(`${path.sep}supabase${path.sep}migrations${path.sep}`) && file.endsWith(".sql"))
    .filter((file) => existsSync(file))
    .sort();
}

function resolveProjectRef(projectRoot) {
  const explicit = resolveSyncEnvValue("SUPABASE_PROJECT_REF", {
    projectRoot,
    extraAliases: ["PROJECT_REF"],
  });
  if (explicit) return explicit;

  const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", {
    projectRoot,
    extraAliases: ["VITE_SUPABASE_URL"],
  });
  const match = supabaseUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\b/i);
  return match?.[1] || "";
}

function percentEncodeConnectionString(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = encodeURIComponent(decodeURIComponent(parsed.password));
    return parsed.toString();
  } catch {
    return url;
  }
}

function buildConnectionString({ host, password }) {
  const url = new URL("postgresql://placeholder");
  url.username = "postgres";
  url.password = encodeURIComponent(password);
  url.host = host;
  url.pathname = "/postgres";
  return url.toString().replace("placeholder", host);
}

function resolveDatabaseUrl(projectRoot) {
  const directNames = [
    "SUPABASE_DB_URL",
    "SUPABASE_DATABASE_URL",
    "SUPABASE_DIRECT_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
  ];
  for (const name of directNames) {
    const value = resolveSyncEnvValue(name, { projectRoot });
    if (value) return percentEncodeConnectionString(value);
  }

  const password = resolveSyncEnvValue("SUPABASE_DB_PASSWORD", {
    projectRoot,
    extraAliases: ["POSTGRES_PASSWORD", "DATABASE_PASSWORD"],
  });
  const projectRef = resolveProjectRef(projectRoot);
  if (password && projectRef) {
    return buildConnectionString({
      host: `db.${projectRef}.supabase.co:6543`,
      password,
    });
  }

  return "";
}

function applyMigrationFile(projectRoot, dbUrl, filePath) {
  const relative = path.relative(projectRoot, filePath);
  console.log(`Applying Supabase migration: ${relative}`);
  run("npx", ["supabase", "db", "query", "--db-url", dbUrl, "--file", filePath, "--output", "table"], {
    cwd: projectRoot,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = read("git", ["rev-parse", "--show-toplevel"]);
  const files = normalizeFiles(repoRoot, options.files);

  if (!files.length) {
    console.log("No staged Supabase migration files to apply.");
    return;
  }

  console.log("Supabase migration gate");
  for (const file of files) console.log(`- ${path.relative(repoRoot, file)}`);

  if (options.dryRun) {
    console.log("Dry run: no live DB changes were made.");
    return;
  }

  const dbUrl = resolveDatabaseUrl(repoRoot);
  if (!dbUrl) {
    throw new Error(
      [
        "Supabase migration gate stopped before commit/push.",
        "Provide one of these env values, then rerun the same ship command:",
        "- SUPABASE_DB_URL",
        "- SUPABASE_DATABASE_URL",
        "- SUPABASE_DIRECT_URL",
        "- DATABASE_URL",
        "- POSTGRES_URL",
        "- or SUPABASE_DB_PASSWORD plus SUPABASE_PROJECT_REF/SUPABASE_URL",
      ].join("\n"),
    );
  }

  for (const file of files) applyMigrationFile(repoRoot, dbUrl, file);
  console.log("Supabase migration gate passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
