#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeMissingCatalogFieldsFromSpareto } from "../../netlify/functions/_shared/catalog/spareto-sync.mts";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot });

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Pass them via env, .sync-secrets.local, or --supabase-url/--supabase-service-role-key.");
}

const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));

const concurrency = Number.parseInt(concurrencyArg?.split("=")[1] || "6", 10);
const requestTimeoutMs = Number.parseInt(timeoutArg?.split("=")[1] || "20000", 10);
const limit = Number.parseInt(limitArg?.split("=")[1] || "500", 10);

const result = await completeMissingCatalogFieldsFromSpareto({
  supabaseUrl,
  serviceRoleKey,
  brandName: "SKF",
  concurrency: Number.isFinite(concurrency) ? concurrency : 6,
  requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 20000,
  limit: Number.isFinite(limit) ? limit : 500,
});

console.log(JSON.stringify(result, null, 2));
