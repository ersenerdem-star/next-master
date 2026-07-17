#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";
import {
  buildReviewQueue,
  compareObservationToProduct,
} from "./lib/catalog-observation-review-core.mjs";
import {
  DECISION_THRESHOLDS,
  RECOMMENDATIONS,
  buildDecisionRecommendations,
  stableJson,
} from "./lib/catalog-observation-decision-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = String(args.get("artifact-dir") || `/Users/ersen/Developer/NextMaster/artifacts/wp2d-decision-${timestamp}`);
  const runId = String(args.get("run-id") || "").trim();
  const organizationId = String(args.get("organization-id") || "").trim();
  const observationIds = parseCsvArg(args.get("observation-ids"));
  const trustedProductCountArtifact = String(args.get("trusted-product-count-artifact") || "").trim();

  if (!runId) block("--run-id is required.");
  if (!organizationId) block("--organization-id is required.");
  if (observationIds.length > DECISION_THRESHOLDS.maximumReviewItems) {
    block(`--observation-ids exceeds ${DECISION_THRESHOLDS.maximumReviewItems} items.`);
  }

  const supabaseUrl = readEnvValue("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = readEnvValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey || !supabaseUrl.startsWith("http")) {
    block("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const db = createReadOnlyDbClient({ supabaseUrl, serviceRoleKey });
  const result = await runDecisionEngine({
    db,
    artifactDir,
    runId,
    organizationId,
    observationIds,
    trustedProductCountArtifact,
  });
  console.log(JSON.stringify(sanitizeSummary(result), null, 2));
}

export async function runDecisionEngine({
  db,
  artifactDir: inputArtifactDir,
  runId: inputRunId,
  organizationId: inputOrganizationId,
  observationIds: inputObservationIds = [],
  trustedProductCountArtifact: inputTrustedProductCountArtifact = "",
  generatedAt = new Date().toISOString(),
  now = generatedAt,
}) {
  fs.mkdirSync(inputArtifactDir, { recursive: true });
  const gitCommit = await readGitCommit();

  const before = await captureDecisionSnapshot({
    db,
    runId: inputRunId,
    organizationId: inputOrganizationId,
    observationIds: inputObservationIds,
    trustedProductCountArtifact: inputTrustedProductCountArtifact,
    gitCommit,
  });
  writeJson(inputArtifactDir, "before-snapshot.json", before);

  const productById = new Map(before.products.map((product) => [product.id, product]));
  const sourceById = new Map(before.sources.map((source) => [source.id, source]));
  const trustProfileBySourceId = new Map(before.trust_profiles.map((profile) => [profile.source_id, profile]));
  const runById = new Map(before.runs.map((run) => [run.id, run]));
  const observationById = new Map(before.observations.map((observation) => [observation.id, observation]));

  const comparisons = before.observations.map((observation) => compareObservationToProduct({
    observation,
    product: productById.get(observation.catalog_product_id) || null,
    createdAt: generatedAt,
  }));
  const reviewQueue = buildReviewQueue(comparisons);
  const selectedQueue = inputObservationIds.length
    ? reviewQueue.filter((item) => inputObservationIds.includes(item.observation))
    : reviewQueue;

  if (selectedQueue.length > DECISION_THRESHOLDS.maximumReviewItems) {
    throw new Error(`Decision engine refuses unbounded review input above ${DECISION_THRESHOLDS.maximumReviewItems} items.`);
  }

  const recommendations = buildDecisionRecommendations({
    reviewQueue: selectedQueue,
    observationsById: observationById,
    productsById: productById,
    sourcesById: sourceById,
    trustProfilesById: trustProfileBySourceId,
    runsById: runById,
    allObservations: before.observations,
    generatedAt,
    now,
  });
  const repeatRecommendations = buildDecisionRecommendations({
    reviewQueue: selectedQueue,
    observationsById: observationById,
    productsById: productById,
    sourcesById: sourceById,
    trustProfilesById: trustProfileBySourceId,
    runsById: runById,
    allObservations: before.observations,
    generatedAt: "2099-01-01T00:00:00.000Z",
    now,
  });

  const deterministicRepeatability = stableRecommendationBody(recommendations) === stableRecommendationBody(repeatRecommendations);
  const fingerprintRepeatability = recommendations.every((recommendation, index) => (
    recommendation.recommendation_fingerprint === repeatRecommendations[index]?.recommendation_fingerprint
  ));

  const summary = summarizeRecommendations({
    runId: inputRunId,
    artifactDir: inputArtifactDir,
    gitCommit,
    generatedAt,
    reviewQueue: selectedQueue,
    recommendations,
    deterministicRepeatability,
    fingerprintRepeatability,
  });

  writeJson(inputArtifactDir, "comparisons.json", comparisons);
  writeJson(inputArtifactDir, "review-queue.json", selectedQueue);
  writeJson(inputArtifactDir, "recommendations.json", recommendations);
  writeJson(inputArtifactDir, "summary.json", summary);

  const after = await captureDecisionSnapshot({
    db,
    runId: inputRunId,
    organizationId: inputOrganizationId,
    observationIds: inputObservationIds,
    trustedProductCountArtifact: inputTrustedProductCountArtifact,
    gitCommit,
  });
  writeJson(inputArtifactDir, "after-snapshot.json", after);

  const safety = buildSafetyProof(before, after);
  writeJson(inputArtifactDir, "safety-proof.json", safety);

  if (!safety.product_snapshots_unchanged || !safety.observation_snapshots_unchanged || !safety.review_decision_count_unchanged) {
    throw new Error("Read-only decision engine safety proof failed: source data changed during recommendation generation.");
  }

  return { artifactDir: inputArtifactDir, gitCommit, runId: inputRunId, before, after, comparisons, reviewQueue: selectedQueue, recommendations, summary, safety };
}

async function captureDecisionSnapshot({ db, runId, organizationId, observationIds, trustedProductCountArtifact, gitCommit }) {
  const observationParams = {
    select: [
      "id",
      "organization_id",
      "source_id",
      "trust_profile_id",
      "job_id",
      "run_id",
      "brand_id",
      "catalog_product_id",
      "product_code",
      "normalized_code",
      "external_product_ref",
      "field_family",
      "field_name",
      "raw_value",
      "normalized_value",
      "evidence_url",
      "evidence_reference",
      "evidence_hash",
      "evidence_payload",
      "confidence",
      "freshness_status",
      "license_posture",
      "observed_at",
      "ingested_at",
      "deduplication_key",
    ].join(","),
    organization_id: `eq.${organizationId}`,
    run_id: `eq.${runId}`,
    order: "ingested_at.asc",
  };
  if (observationIds.length) observationParams.id = `in.(${observationIds.join(",")})`;

  const observations = await db.get("catalog_external_observations", observationParams);
  const productIds = dedupeStrings(observations.map((observation) => observation.catalog_product_id).filter(Boolean));
  const sourceIds = dedupeStrings(observations.map((observation) => observation.source_id).filter(Boolean));
  const trustProfileIds = dedupeStrings(observations.map((observation) => observation.trust_profile_id).filter(Boolean));
  const runIds = dedupeStrings(observations.map((observation) => observation.run_id).filter(Boolean));
  const observationRowIds = dedupeStrings(observations.map((observation) => observation.id));

  const products = productIds.length
    ? await db.get("catalog_products", {
        select: "id,organization_id,brand_id,product_code,normalized_code,description,image_url,updated_at",
        id: `in.(${productIds.join(",")})`,
        order: "product_code.asc",
      })
    : [];
  const sources = sourceIds.length
    ? await db.get("catalog_external_sources", {
        select: "id,organization_id,source_key,display_name,source_type,license_posture,is_active",
        id: `in.(${sourceIds.join(",")})`,
        order: "source_key.asc",
      })
    : [];
  const trustProfiles = trustProfileIds.length
    ? await db.get("catalog_external_source_trust_profiles", {
        select: "id,organization_id,source_id,trust_level,trust_score,allowed_field_families,human_review_required,evidence_required,is_active",
        id: `in.(${trustProfileIds.join(",")})`,
        order: "source_id.asc",
      })
    : [];
  const runs = runIds.length
    ? await db.get("catalog_observation_runs", {
        select: "id,organization_id,job_id,source_id,brand_id,status,started_at,finished_at,observed_count,deduped_count,candidate_count,review_routed_count,apply_event_count,error_message",
        id: `in.(${runIds.join(",")})`,
        order: "started_at.asc",
      })
    : [];
  const reviewDecisionCount = observationRowIds.length
    ? await db.count("catalog_observation_review_decisions", { observation_id: `in.(${observationRowIds.join(",")})` }, "id")
    : 0;

  return {
    captured_at: new Date().toISOString(),
    git_commit: gitCommit,
    run_id: runId,
    organization_id: organizationId,
    trusted_product_count: readTrustedProductCount(trustedProductCountArtifact),
    observation_count: observations.length,
    review_decision_count: reviewDecisionCount,
    products,
    observations,
    sources,
    trust_profiles: trustProfiles,
    runs,
  };
}

function buildSafetyProof(before, after) {
  return {
    trusted_product_count_before: before.trusted_product_count,
    trusted_product_count_after: after.trusted_product_count,
    selected_product_count_before: before.products.length,
    selected_product_count_after: after.products.length,
    product_snapshots_unchanged: stableJson(before.products) === stableJson(after.products),
    observation_count_before: before.observation_count,
    observation_count_after: after.observation_count,
    observation_snapshots_unchanged: stableJson(before.observations) === stableJson(after.observations),
    review_decision_count_before: before.review_decision_count,
    review_decision_count_after: after.review_decision_count,
    review_decision_count_unchanged: before.review_decision_count === after.review_decision_count,
  };
}

function summarizeRecommendations({
  runId,
  artifactDir: inputArtifactDir,
  gitCommit,
  generatedAt,
  reviewQueue,
  recommendations,
  deterministicRepeatability,
  fingerprintRepeatability,
}) {
  const totals = {
    AUTO_SAFE: 0,
    LIKELY_ACCEPT: 0,
    MANUAL_REQUIRED: 0,
    LIKELY_REJECT: 0,
    INSUFFICIENT_EVIDENCE: 0,
  };
  for (const recommendation of recommendations) totals[recommendation.recommendation] += 1;
  return {
    run_id: runId,
    artifact_dir: inputArtifactDir,
    git_commit: gitCommit,
    generated_at: generatedAt,
    review_items_processed: reviewQueue.length,
    recommendation_totals: totals,
    deterministic_repeatability: deterministicRepeatability,
    fingerprint_repeatability: fingerprintRepeatability,
    no_single_source_auto_safe: totals.AUTO_SAFE === 0 || recommendations.every((item) => (
      item.recommendation !== RECOMMENDATIONS.AUTO_SAFE
      || item.positive_factors.includes("independent corroboration present")
    )),
  };
}

function stableRecommendationBody(recommendations) {
  return stableJson(recommendations.map(({ generated_at: _generatedAt, ...body }) => body));
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

function readEnvValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const value = resolveSyncEnvValue(key, { projectRoot: repoRoot });
    return String(value || "").startsWith("No project id found") ? "" : value;
  } catch {
    return "";
  }
}

function readTrustedProductCount(filePath) {
  if (!filePath) return null;
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return payload.product_count_after ?? payload.product_count_before ?? null;
}

function parseArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    const match = String(arg).match(/^--([^=]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function parseCsvArg(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
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
    review_items_processed: result.reviewQueue.length,
    recommendation_totals: result.summary.recommendation_totals,
    deterministic_repeatability: result.summary.deterministic_repeatability,
    fingerprint_repeatability: result.summary.fingerprint_repeatability,
    product_state: {
      trusted_product_count_before: result.safety.trusted_product_count_before,
      trusted_product_count_after: result.safety.trusted_product_count_after,
      selected_product_count_before: result.safety.selected_product_count_before,
      selected_product_count_after: result.safety.selected_product_count_after,
      product_snapshots_unchanged: result.safety.product_snapshots_unchanged,
    },
    observation_state: {
      observation_count_before: result.safety.observation_count_before,
      observation_count_after: result.safety.observation_count_after,
      observation_snapshots_unchanged: result.safety.observation_snapshots_unchanged,
    },
    review_decision_state: {
      review_decision_count_before: result.safety.review_decision_count_before,
      review_decision_count_after: result.safety.review_decision_count_after,
    },
  };
}

function block(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
