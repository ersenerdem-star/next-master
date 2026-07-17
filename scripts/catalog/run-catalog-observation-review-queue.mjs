#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";
import {
  buildReviewQueue,
  compareObservationToProduct,
  summarizeComparisons,
} from "./lib/catalog-observation-review-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const args = parseArgs(process.argv.slice(2));
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = String(args.get("artifact-dir") || `/Users/ersen/Developer/NextMaster/artifacts/wp2c-review-${timestamp}`);
const runId = String(args.get("run-id") || "").trim();

if (!runId) {
  console.error("BLOCKED: --run-id is required");
  process.exit(1);
}

const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });
if (!supabaseUrl || !serviceRoleKey) {
  console.error("BLOCKED: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const db = createReadOnlyDbClient({ supabaseUrl, serviceRoleKey });
const result = await runReviewQueue({ db, artifactDir, runId });
console.log(JSON.stringify(sanitizeSummary(result), null, 2));

export async function runReviewQueue({ db, artifactDir: inputArtifactDir, runId: inputRunId, now = new Date().toISOString() }) {
  fs.mkdirSync(inputArtifactDir, { recursive: true });

  const gitCommit = await readGitCommit();
  const before = await captureReadOnlySnapshot(db, inputRunId, gitCommit);
  writeJson(inputArtifactDir, "before-snapshot.json", before);

  const productById = new Map(before.products.map((product) => [product.id, product]));
  const comparisons = before.observations.map((observation) => compareObservationToProduct({
    observation,
    product: productById.get(observation.catalog_product_id) || null,
    createdAt: now,
  }));
  const queue = buildReviewQueue(comparisons);
  const summary = {
    run_id: inputRunId,
    artifact_dir: inputArtifactDir,
    git_commit: gitCommit,
    generated_at: now,
    ...summarizeComparisons(comparisons, queue),
  };

  writeJson(inputArtifactDir, "comparisons.json", comparisons);
  writeJson(inputArtifactDir, "review-queue.json", queue);
  writeJson(inputArtifactDir, "summary.json", summary);

  const after = await captureReadOnlySnapshot(db, inputRunId, gitCommit);
  writeJson(inputArtifactDir, "after-snapshot.json", after);

  const safety = buildSafetyProof(before, after);
  writeJson(inputArtifactDir, "safety-proof.json", safety);

  if (!safety.product_count_unchanged || !safety.product_snapshots_unchanged) {
    throw new Error("Read-only review queue safety proof failed: Product state changed during comparison.");
  }

  return { artifactDir: inputArtifactDir, gitCommit, runId: inputRunId, before, after, comparisons, queue, summary, safety };
}

async function captureReadOnlySnapshot(db, runId, gitCommit) {
  const observations = await db.get("catalog_external_observations", {
    select: [
      "id",
      "organization_id",
      "source_id",
      "job_id",
      "run_id",
      "brand_id",
      "catalog_product_id",
      "product_code",
      "normalized_code",
      "field_family",
      "field_name",
      "raw_value",
      "normalized_value",
      "evidence_url",
      "evidence_reference",
      "evidence_hash",
      "confidence",
      "observed_at",
      "ingested_at",
    ].join(","),
    run_id: `eq.${runId}`,
    order: "ingested_at.asc",
  });
  const organizationId = String(observations[0]?.organization_id || "").trim();
  const productIds = dedupeStrings(observations.map((observation) => observation.catalog_product_id).filter(Boolean));
  const products = productIds.length
    ? await db.get("catalog_products", {
        select: "id,organization_id,brand_id,product_code,normalized_code,description,image_url,updated_at",
        id: `in.(${productIds.join(",")})`,
        order: "product_code.asc",
      })
    : [];
  const productCount = organizationId
    ? await db.count("catalog_products", { organization_id: `eq.${organizationId}` }, "id")
    : null;

  return {
    captured_at: new Date().toISOString(),
    git_commit: gitCommit,
    run_id: runId,
    organization_id: organizationId || null,
    observation_count: observations.length,
    product_count: productCount,
    products,
    observations,
  };
}

function buildSafetyProof(before, after) {
  return {
    product_count_before: before.product_count,
    product_count_after: after.product_count,
    product_count_unchanged: before.product_count === after.product_count,
    selected_product_count_before: before.products.length,
    selected_product_count_after: after.products.length,
    product_snapshots_unchanged: stableJson(before.products) === stableJson(after.products),
    observation_count_before: before.observation_count,
    observation_count_after: after.observation_count,
    observation_count_unchanged: before.observation_count === after.observation_count,
  };
}

function createReadOnlyDbClient({ supabaseUrl, serviceRoleKey }) {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  return {
    async get(table, params) {
      const url = new URL(`/rest/v1/${table}`, supabaseUrl);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, { headers });
      return parseResponse(response, `GET ${table}`);
    },
    async count(table, params, selectColumn = "id") {
      const url = new URL(`/rest/v1/${table}`, supabaseUrl);
      url.searchParams.set("select", selectColumn);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, {
        headers: {
          ...headers,
          Prefer: "count=exact",
          Range: "0-0",
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`COUNT ${table} failed: ${response.status} ${text}`);
      }
      const range = response.headers.get("content-range") || "";
      const total = Number(range.split("/")[1] || "0");
      return Number.isFinite(total) ? total : 0;
    },
  };
}

async function parseResponse(response, label) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text}`);
  return payload;
}

function parseArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    const match = String(arg).match(/^--([^=]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(flattenKeys(value)).sort());
}

function flattenKeys(value, acc = {}) {
  if (Array.isArray(value)) {
    for (const item of value) flattenKeys(item, acc);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      acc[key] = true;
      flattenKeys(child, acc);
    }
  }
  return acc;
}

function writeJson(directory, filename, value) {
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

async function readGitCommit() {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot }, (error, stdout) => {
      resolve(error ? "unknown" : String(stdout || "").trim());
    });
  });
}

function sanitizeSummary(result) {
  return {
    artifact_dir: result.artifactDir,
    git_commit: result.gitCommit,
    run_id: result.runId,
    comparison_totals: result.summary,
    product_count_before: result.safety.product_count_before,
    product_count_after: result.safety.product_count_after,
    product_snapshots_unchanged: result.safety.product_snapshots_unchanged,
    observation_count_before: result.safety.observation_count_before,
    observation_count_after: result.safety.observation_count_after,
  };
}
