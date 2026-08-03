#!/usr/bin/env node

/*
 * Resume-friendly FEBI enrichment runner.
 *
 * The page worker remains the guarded, idempotent writer. This wrapper only
 * discovers the FEBI catalog size and invokes that worker page by page, so a
 * user does not have to inspect or type every product code manually.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

const PAGE_SIZE = 100;
const DEFAULT_ORGANIZATION_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const BRAND_ID = "f6827605-2ad4-4a3d-8e82-e0c9cf335edf";

const args = parseArgs(process.argv.slice(2));
const apply = args.has("apply");
const startPage = readInteger(args.get("start-page"), 0, 0, 100_000);
const maxPages = readInteger(args.get("max-pages"), 100_000, 1, 100_000);
const organizationId = String(
  args.get("organization-id") ||
    process.env.NEXT_MASTER_ORGANIZATION_ID ||
    DEFAULT_ORGANIZATION_ID,
).trim();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });

if (!/^https:\/\//i.test(supabaseUrl) || !serviceRoleKey) {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { count, error } = await loadCountWithRetry();

if (error) fail(`FEBI catalog count failed: ${error.message || "temporary database error"}`);

const totalPages = Math.ceil(Number(count || 0) / PAGE_SIZE);
const endPage = Math.min(totalPages, startPage + maxPages);
let stopped = false;

console.log("BILSTEIN FEBI ENRICHMENT ALL START");
console.log(`mode=${apply ? "apply" : "dry_run"}; pages=${startPage}..${Math.max(startPage, endPage - 1)}; page_size=${PAGE_SIZE}`);
console.log(`brand_id=${BRAND_ID}; product_count=${count || 0}`);

for (let page = startPage; page < endPage; page += 1) {
  console.log(`\n=== FEBI PAGE ${page}/${Math.max(0, totalPages - 1)} ===`);

  const workerArgs = [
    "scripts/catalog/enrich-bilstein-febi.mjs",
    "--page",
    String(page),
    "--max-items",
    String(PAGE_SIZE),
    "--organization-id",
    organizationId,
  ];
  if (apply) workerArgs.push("--apply");

  let exitCode = 1;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    exitCode = await runWorker(workerArgs);
    if (exitCode === 0 || attempt === 3) break;
    console.error(`Worker page ${page} failed; retrying (${attempt}/3)...`);
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
  if (exitCode !== 0) {
    stopped = true;
    console.error(`\nSTOPPED at page ${page}. Resume with:`);
    console.error(
      `node scripts/catalog/enrich-bilstein-febi-all.mjs ${apply ? "--apply " : ""}--start-page ${page}`,
    );
    process.exitCode = exitCode || 1;
    break;
  }
}

if (!stopped && endPage >= totalPages) {
  console.log("\nBILSTEIN FEBI ENRICHMENT ALL COMPLETE");
}

function runWorker(workerArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, workerArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function loadCountWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await db
      .from("catalog_products")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("brand_id", BRAND_ID);
    if (!result.error) return result;
    lastError = result.error;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  return { count: null, error: lastError };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) values.set(key, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values.set(key, argv[++index]);
    else values.set(key, true);
  }
  return values;
}

function readInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`Value must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
