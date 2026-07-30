#!/usr/bin/env node

/*
 * Explicit provider-stage -> canonical Catalog publication runner.
 *
 * The database RPC enforces strict sealing, source authorization, exact
 * cardinality, insert-only behavior, provenance, and resumability.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

const DEFAULT_ORGANIZATION_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const DATABASE_REQUEST_TIMEOUT_MS = 240_000;

const args = parseArgs(process.argv.slice(2));
const confirmed = args.has("confirm-production");
const runId = String(args.get("run-id") || "").trim();
const brandName = normalizeBrandName(args.get("brand"));
const expectedRows = readInteger(args.get("expected-rows"), 1, 100_000, "expected-rows");
const batchSize = readInteger(args.get("batch-size") || "500", 1, 1000, "batch-size");
const organizationId = String(
  args.get("organization-id") || DEFAULT_ORGANIZATION_ID,
).trim();
const approvalActor = String(args.get("approved-by") || "").trim();
const approvalReference = String(args.get("approval-reference") || "").trim();

if (!confirmed) fail("Use --confirm-production to publish canonical catalog products.");
if (!isUuid(runId)) fail("--run-id must be a UUID.");
if (!organizationId || !isUuid(organizationId)) fail("--organization-id must be a UUID.");
if (!brandName) fail("--brand must be FEBI or BLUE_PRINT.");
if (!approvalActor) fail("--approved-by is required.");
if (!approvalReference) fail("--approval-reference is required.");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });

if (!/^https:\/\//i.test(supabaseUrl) || !serviceRoleKey) {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    fetch: fetchDatabaseWithTimeout,
  },
});

const { data: brand, error: brandError } = await db
  .from("brands")
  .select("id, organization_id, name")
  .eq("organization_id", organizationId)
  .eq("name", brandName)
  .maybeSingle();

if (brandError) fail(`Brand lookup failed: ${brandError.message}`);
if (!brand?.id) fail(`${brandName} brand was not found in the target organization.`);

console.log("CATALOG PROVIDER STAGE PUBLICATION START");
console.log(`run=${runId}`);
console.log(`brand=${brandName}; expected_rows=${expectedRows}; batch_size=${batchSize}`);
console.log("mode=production_insert_only; provider_stage=immutable");

let iteration = 0;
let lastProcessed = -1;
while (iteration < 1000) {
  iteration += 1;

  const { data, error } = await db.rpc("publish_catalog_provider_stage_batch", {
    input_run_id: runId,
    input_brand_id: brand.id,
    input_expected_rows: expectedRows,
    input_approval_actor: approvalActor,
    input_approval_reference: approvalReference,
    input_batch_size: batchSize,
  });

  if (error) {
    fail(`Publication RPC failed: ${error.message}`);
  }

  const result = data || {};
  console.log(
    `${result.status}: processed=${result.processed_rows}/${result.expected_rows}; `
      + `inserted=${result.inserted_rows}; provenance=${result.provenance_rows}`,
  );

  if (result.status === "completed") {
    console.log(JSON.stringify(result, null, 2));
    console.log("CATALOG PROVIDER STAGE PUBLICATION COMPLETE");
    process.exit(0);
  }

  if (
    !Number.isInteger(result.processed_rows)
    || result.processed_rows <= lastProcessed
  ) {
    fail("Publication made no forward progress.");
  }

  lastProcessed = result.processed_rows;
}

fail("Publication exceeded the safety iteration limit.");

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const separator = token.indexOf("=");
    if (separator >= 0) {
      values.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }
  return values;
}

function normalizeBrandName(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, "_");
  if (normalized === "FEBI") return "Febi";
  if (normalized === "BLUE_PRINT" || normalized === "BLUEPRINT") return "Blue Print";
  return "";
}

function readInteger(value, min, max, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`--${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function fetchDatabaseWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DATABASE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `Supabase request timed out after ${DATABASE_REQUEST_TIMEOUT_MS / 1000} seconds.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
