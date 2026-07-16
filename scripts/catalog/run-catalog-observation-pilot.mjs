#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";
import { fetchZfAftermarketOfficialObservation } from "../../netlify/functions/_shared/catalog/zf-aftermarket-sync.mts";
import {
  ALLOWED_FIELD_FAMILIES,
  JOB_KEY,
  MAX_OBSERVATIONS,
  MAX_SOURCE_CONCURRENCY,
  SOURCE_DISPLAY_NAME,
  SOURCE_KEY,
  buildCheckpointCursor,
  buildObservationInputs,
  deriveFinalStatus,
  normalizeCode,
  parseArgs,
  parseCodeList,
  runPool,
  validateCliOptions,
} from "./lib/catalog-observation-pilot-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const args = parseArgs();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = String(args.get("artifact-dir") || `/Users/ersen/Developer/NextMaster/artifacts/wp2b-acquisition-${timestamp}`);

const options = {
  dryRun: args.has("dry-run"),
  confirmProduction: args.has("confirm-production"),
  organizationId: String(args.get("organization-id") || "").trim(),
  actorId: String(args.get("actor-id") || "").trim(),
  brand: String(args.get("brand") || "").trim(),
  codes: parseCodeList(args.get("codes") || ""),
  requestTimeoutMs: Math.max(5000, Number.parseInt(String(args.get("request-timeout-ms") || "30000"), 10) || 30000),
};

const errors = validateCliOptions(options);
if (errors.length) {
  console.error(`BLOCKED: ${errors.join("; ")}`);
  process.exit(1);
}

const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });
if (!supabaseUrl || !serviceRoleKey) {
  console.error("BLOCKED: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const db = createDbClient({ supabaseUrl, serviceRoleKey });
const result = await runPilot({ db, options, artifactDir });
console.log(JSON.stringify(sanitizeSummary(result), null, 2));

export async function runPilot({ db, options: inputOptions, artifactDir: inputArtifactDir, sourceFetcher = fetchZfAftermarketOfficialObservation }) {
  fs.mkdirSync(inputArtifactDir, { recursive: true });

  const gitCommit = await readGitCommit();
  const brand = await resolveSachsBrand(db, inputOptions.organizationId);
  const actor = await resolveActiveActor(db, inputOptions.organizationId, inputOptions.actorId);
  const products = await resolveProducts(db, inputOptions.organizationId, brand.id, inputOptions.codes);
  const before = await captureSafetySnapshot(db, {
    organizationId: inputOptions.organizationId,
    sourceKey: SOURCE_KEY,
    jobKey: JOB_KEY,
    brandId: brand.id,
    products,
    gitCommit,
  });
  writeJson(inputArtifactDir, "before-snapshot.json", before);

  const sourceResults = [];
  const failures = [];
  await runPool(products, MAX_SOURCE_CONCURRENCY, async (product) => {
    try {
      const source = await sourceFetcher({
        brandName: "SACHS",
        productCode: product.product_code,
        requestTimeoutMs: inputOptions.requestTimeoutMs,
        searchPageSize: 100,
      });
      const observations = buildObservationInputs({ product, source });
      sourceResults.push({ product, source, observations });
    } catch (error) {
      failures.push({ product, error: errorMessage(error) });
    }
  });

  const plannedObservations = sourceResults.flatMap((entry) => entry.observations).slice(0, MAX_OBSERVATIONS);
  if (plannedObservations.some((item) => !ALLOWED_FIELD_FAMILIES.has(item.input_field_family))) {
    throw new Error("Pilot produced a forbidden observation field family");
  }

  const dryRunSummary = {
    mode: inputOptions.dryRun ? "dry_run" : "confirmed_production",
    organization_id: inputOptions.organizationId,
    actor_id: actor.id,
    brand,
    selected_products: products.map((product) => ({
      id: product.id,
      product_code: product.product_code,
      normalized_code: product.normalized_code,
      selection_reason: product.image_url || product.description ? "selected explicit existing SACHS Product" : "missing image or description",
    })),
    planned_observation_count: plannedObservations.length,
    planned_observations: plannedObservations.map((item) => ({
      product_code: item.input_product_code,
      normalized_code: item.input_normalized_code,
      field_family: item.input_field_family,
      field_name: item.input_field_name,
      evidence_reference: item.input_evidence_reference,
      evidence_hash: item.input_evidence_hash,
    })),
    source_failures: failures,
  };
  writeJson(inputArtifactDir, "dry-run-summary.json", dryRunSummary);

  if (inputOptions.dryRun) {
    return {
      artifactDir: inputArtifactDir,
      gitCommit,
      brand,
      products,
      dryRun: dryRunSummary,
      runId: null,
      finalStatus: "dry_run",
      before,
      after: before,
      appendedObservationIds: [],
      dedupe: null,
    };
  }

  let runId = null;
  const appendedObservationIds = [];
  const sourceId = await db.rpc("configure_catalog_external_source", {
    input_organization_id: inputOptions.organizationId,
    input_source_key: SOURCE_KEY,
    input_display_name: SOURCE_DISPLAY_NAME,
    input_source_owner: "ZF Aftermarket",
    input_source_type: "manufacturer",
    input_base_url: "https://aftermarket.zf.com",
    input_license_posture: "internal_review_required",
    input_robots_posture: "not_applicable",
    input_rate_limit_posture: "bounded",
    input_is_active: true,
    input_metadata: {
      work_package: "NM-CATALOG-WP2-B",
      downstream_publication: "internal_only",
    },
  });
  const trustProfileId = await db.rpc("configure_catalog_external_source_trust_profile", {
    input_organization_id: inputOptions.organizationId,
    input_source_id: sourceId,
    input_trust_level: "T3",
    input_trust_score: 0.8,
    input_allowed_field_families: Array.from(ALLOWED_FIELD_FAMILIES),
    input_human_review_required: true,
    input_downstream_publication_restriction: "internal_only",
    input_evidence_required: true,
    input_is_active: true,
    input_notes: "Controlled WP2B single-source single-brand pilot.",
  });
  const jobId = await db.rpc("configure_single_brand_catalog_observation_job", {
    input_organization_id: inputOptions.organizationId,
    input_source_id: sourceId,
    input_trust_profile_id: trustProfileId,
    input_brand_id: brand.id,
    input_job_key: JOB_KEY,
    input_allowed_field_families: Array.from(ALLOWED_FIELD_FAMILIES),
    input_max_observations_per_run: MAX_OBSERVATIONS,
    input_max_retry_attempts: 5,
    input_lock_timeout_seconds: 600,
    input_status: "active",
    input_metadata: {
      work_package: "NM-CATALOG-WP2-B",
      source_concurrency: MAX_SOURCE_CONCURRENCY,
    },
  });

  try {
    runId = await db.rpc("begin_catalog_observation_run", {
      input_job_id: jobId,
      input_actor_id: actor.id,
      input_metadata: {
        requested_codes: inputOptions.codes.map((code) => code.normalized),
        dry_run_artifact: path.join(inputArtifactDir, "dry-run-summary.json"),
      },
    });

    for (const observation of plannedObservations) {
      const observationId = await db.rpc("append_catalog_external_observation", {
        input_run_id: runId,
        input_collector_actor_id: actor.id,
        ...observation,
      });
      appendedObservationIds.push(observationId);
    }

    const dedupe = appendedObservationIds[0]
      ? await db.rpc("append_catalog_external_observation", {
          input_run_id: runId,
          input_collector_actor_id: actor.id,
          ...plannedObservations[0],
        })
      : null;

    const finalStatus = deriveFinalStatus({ appendedCount: appendedObservationIds.length, failureCount: failures.length });
    const finishResult = await db.rpc("finish_catalog_observation_run", {
      input_run_id: runId,
      input_status: finalStatus,
      input_error_message: finalStatus === "failed" ? "No real observations were appended." : null,
    });
    if (finalStatus === "succeeded") {
      await db.rpc("advance_catalog_observation_checkpoint", {
        input_job_id: jobId,
        input_run_id: runId,
        input_cursor_value: buildCheckpointCursor({ codes: inputOptions.codes, observations: plannedObservations }),
        input_cursor_metadata: {
          requested_codes: inputOptions.codes.map((code) => code.normalized),
          observation_count: appendedObservationIds.length,
        },
        input_last_observed_at: new Date().toISOString(),
      });
    }
    const after = await captureSafetySnapshot(db, {
      organizationId: inputOptions.organizationId,
      sourceKey: SOURCE_KEY,
      jobKey: JOB_KEY,
      brandId: brand.id,
      products,
      gitCommit,
      runId,
    });
    writeJson(inputArtifactDir, "after-snapshot.json", after);
    writeJson(inputArtifactDir, "run-summary.json", {
      run_id: runId,
      final_status: finalStatus,
      finish_result: finishResult,
      appended_observation_ids: appendedObservationIds,
      dedupe_result: dedupe,
      source_failures: failures,
    });
    return {
      artifactDir: inputArtifactDir,
      gitCommit,
      brand,
      products,
      dryRun: dryRunSummary,
      runId,
      finalStatus,
      before,
      after,
      appendedObservationIds,
      dedupe,
    };
  } catch (error) {
    if (runId) {
      await db.rpc("finish_catalog_observation_run", {
        input_run_id: runId,
        input_status: "failed",
        input_error_message: errorMessage(error),
      }).catch(() => null);
    }
    throw error;
  }
}

function createDbClient({ supabaseUrl, serviceRoleKey }) {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  return {
    async get(table, params = {}) {
      const url = new URL(`/rest/v1/${table}`, supabaseUrl);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, { headers });
      return parseResponse(response, `GET ${table}`);
    },
    async count(table, params = {}, selectColumn = "id") {
      const url = new URL(`/rest/v1/${table}`, supabaseUrl);
      url.searchParams.set("select", selectColumn);
      url.searchParams.set("limit", "1");
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, { headers: { ...headers, Prefer: "count=exact" } });
      await parseResponse(response, `COUNT ${table}`);
      const total = String(response.headers.get("content-range") || "").split("/").pop();
      return Number.parseInt(total || "0", 10) || 0;
    },
    async rpc(name, args = {}) {
      const response = await fetch(new URL(`/rest/v1/rpc/${name}`, supabaseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      });
      return parseResponse(response, `RPC ${name}`);
    },
  };
}

async function resolveSachsBrand(db, organizationId) {
  const rows = await db.get("brands", {
    select: "id,organization_id,name",
    organization_id: `eq.${organizationId}`,
    name: "ilike.Sachs",
    limit: "2",
  });
  if (rows.length !== 1) throw new Error(`Expected exactly one SACHS brand in organization; found ${rows.length}`);
  return { id: rows[0].id, name: rows[0].name, organization_id: rows[0].organization_id };
}

async function resolveActiveActor(db, organizationId, actorId) {
  const rows = await db.get("profiles", {
    select: "*",
    id: `eq.${actorId}`,
    organization_id: `eq.${organizationId}`,
    limit: "1",
  });
  if (rows.length !== 1) throw new Error("Actor must be an existing profile in the supplied organization");
  const actor = rows[0];
  if (actor.is_active === false || ["inactive", "disabled", "deleted"].includes(String(actor.status || "").toLowerCase())) {
    throw new Error("Actor must be active");
  }
  return actor;
}

async function resolveProducts(db, organizationId, brandId, codes) {
  const products = [];
  for (const code of codes) {
    const rows = await db.get("catalog_products", {
      select: "id,organization_id,brand_id,product_code,normalized_code,description,image_url,updated_at",
      organization_id: `eq.${organizationId}`,
      brand_id: `eq.${brandId}`,
      normalized_code: `eq.${code.normalized}`,
      limit: "2",
    });
    if (rows.length === 0) throw new Error(`Unknown SACHS product code: ${code.input}`);
    if (rows.length > 1) throw new Error(`Ambiguous SACHS product code: ${code.input}`);
    products.push(rows[0]);
  }
  return products;
}

async function captureSafetySnapshot(db, { organizationId, sourceKey, jobKey, brandId, products, gitCommit, runId = null }) {
  const productIds = products.map((product) => product.id);
  const productIdFilter = `in.(${productIds.join(",")})`;
  const productSnapshots = await db.get("catalog_products", {
    select: "*",
    id: productIdFilter,
    order: "product_code.asc",
  });
  const integrityQueueRows = await safeGet(db, "catalog_integrity_queue", {
    select: "*",
    product_id: productIdFilter,
    order: "product_id.asc",
  });
  const backfillState = await safeGet(db, "catalog_integrity_backfill_state", {
    select: "*",
    organization_id: `eq.${organizationId}`,
  });
  const initialBackfillCount = await safeCount(db, "catalog_integrity_queue", {
    organization_id: `eq.${organizationId}`,
    reason: "eq.initial_backfill",
  }, "product_id");
  const productCount = await db.count("catalog_products", {
    organization_id: `eq.${organizationId}`,
  });
  const observationRows = await safeGet(db, "catalog_external_observations", {
    select: "id,organization_id,source_id,job_id,run_id,brand_id,catalog_product_id,product_code,normalized_code,field_family,field_name,evidence_reference,evidence_hash,confidence,observed_at,ingested_at",
    normalized_code: `in.(${products.map((product) => product.normalized_code).join(",")})`,
    order: "ingested_at.asc",
  });
  const sourceRows = await safeGet(db, "catalog_external_sources", {
    select: "id,organization_id,source_key,display_name",
    organization_id: `eq.${organizationId}`,
    source_key: `eq.${sourceKey}`,
  });
  const jobRows = await safeGet(db, "catalog_observation_jobs", {
    select: "id,organization_id,job_key,brand_id,status",
    organization_id: `eq.${organizationId}`,
    brand_id: `eq.${brandId}`,
    job_key: `eq.${jobKey}`,
  });
  return {
    captured_at: new Date().toISOString(),
    git_commit: gitCommit,
    run_id: runId,
    product_count: productCount,
    selected_catalog_products: productSnapshots,
    selected_product_integrity_queue: integrityQueueRows,
    catalog_integrity_backfill_state: backfillState,
    initial_backfill_queue_count: initialBackfillCount,
    source_rows: sourceRows,
    job_rows: jobRows,
    observation_count_for_selected_codes: observationRows.length,
    observations_for_selected_codes: observationRows,
  };
}

async function safeGet(db, table, params) {
  try {
    return await db.get(table, params);
  } catch (error) {
    return { unavailable: true, error: errorMessage(error) };
  }
}

async function safeCount(db, table, params, selectColumn = "id") {
  try {
    return await db.count(table, params, selectColumn);
  } catch (error) {
    return { unavailable: true, error: errorMessage(error) };
  }
}

async function parseResponse(response, label) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text}`);
  return payload;
}

async function readGitCommit() {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot }, (error, stdout) => {
      resolve(error ? "unknown" : String(stdout || "").trim());
    });
  });
}

function writeJson(directory, filename, value) {
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeSummary(result) {
  return {
    artifact_dir: result.artifactDir,
    git_commit: result.gitCommit,
    brand: result.brand,
    selected_products: result.products.map((product) => ({
      id: product.id,
      product_code: product.product_code,
      normalized_code: product.normalized_code,
    })),
    dry_run_result: {
      planned_observation_count: result.dryRun.planned_observation_count,
      source_failure_count: result.dryRun.source_failures.length,
    },
    run_id: result.runId,
    final_run_status: result.finalStatus,
    appended_observation_count: result.appendedObservationIds.length,
    observation_count_before: result.before.observation_count_for_selected_codes,
    observation_count_after: result.after.observation_count_for_selected_codes,
    product_count_before: result.before.product_count,
    product_count_after: result.after.product_count,
    deduplication_result: result.dedupe,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
