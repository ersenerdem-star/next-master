#!/usr/bin/env node

import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const captureScript = path.join(repoRoot, "scripts", "capture-hengst-pages-from-safari.mjs");
const importScript = path.join(repoRoot, "scripts", "import-brand-from-hengst-pages.mjs");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const [rawKey, rawValue] = token.slice(2).split("=", 2);
  if (rawValue != null) {
    args.set(rawKey, rawValue);
    continue;
  }
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(rawKey, next);
    index += 1;
  } else {
    args.set(rawKey, "true");
  }
}

const captureArgs = [];
if (args.has("all-tabs")) captureArgs.push("--all-tabs");
if (args.has("delay-ms")) captureArgs.push(`--delay-ms=${String(args.get("delay-ms")).trim()}`);
if (args.has("output-dir")) captureArgs.push(`--output-dir=${String(args.get("output-dir")).trim()}`);

const captureSummary = JSON.parse(
  execNode(captureScript, captureArgs),
);

const sourceDir = String(captureSummary.output_dir || "").trim();
if (!sourceDir) {
  throw new Error("Capture script did not return an output_dir");
}

const importArgs = [`--source-dir=${sourceDir}`];
if (args.has("batch-size")) importArgs.push(`--batch-size=${String(args.get("batch-size")).trim()}`);
if (args.has("import")) importArgs.push("--import");

const importSummary = JSON.parse(
  execNode(importScript, importArgs, resolveImportEnv()),
);

console.log(
  JSON.stringify(
    {
      capture: captureSummary,
      import: importSummary,
      note: "Use --import to write the captured official Hengst pages into catalog_products.",
    },
    null,
    2,
  ),
);

function execNode(scriptPath, scriptArgs, extraEnv = {}) {
  return execFileSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function resolveImportEnv() {
  if (!args.has("import")) return {};

  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (supabaseUrl && serviceRoleKey) {
    return {};
  }

  const nextSupabaseUrl = supabaseUrl || runNetlifyEnvGet("SUPABASE_URL");
  const nextServiceRoleKey = serviceRoleKey || runNetlifyEnvGet("SUPABASE_SERVICE_ROLE_KEY");
  return {
    SUPABASE_URL: nextSupabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: nextServiceRoleKey,
  };
}

function runNetlifyEnvGet(name) {
  const value = execFileSync("npx", ["netlify", "env:get", name], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  }).trim();
  if (!value) {
    throw new Error(`Netlify env ${name} is empty`);
  }
  return value;
}
