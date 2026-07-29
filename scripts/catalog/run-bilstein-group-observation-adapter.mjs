#!/usr/bin/env node

/*
 * Bilstein Group PartsFinder -> governed Catalog Observation adapter.
 *
 * This collector never writes to catalog_products and never applies a review
 * decision. In confirmed mode it writes only durable, review-required
 * observations to catalog_external_observations.
 *
 * The current observation contract accepts supplemental_description as the
 * reviewable field family. OEM and technical facts are therefore preserved in
 * immutable evidence_payload, not forced into unrelated canonical columns.
 *
 * Examples:
 *   node scripts/catalog/run-bilstein-group-observation-adapter.mjs \
 *     --dry-run --brand FEBI --max-items 10
 *
 *   node scripts/catalog/run-bilstein-group-observation-adapter.mjs \
 *     --confirm-production --brand FEBI --max-items 10
 *
 * Detail evidence is opt-in and remains review-only:
 *   node scripts/catalog/run-bilstein-group-observation-adapter.mjs \
 *     --dry-run --include-details --brand FEBI --max-items 10
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";

const API_URL = "https://partsfinder.bilsteingroup.com/api/articles";
const SOURCE_KEY = "bilstein_group_partsfinder_observation";
const SOURCE_DISPLAY_NAME = "Bilstein Group PartsFinder Observation";
const DEFAULT_ORGANIZATION_ID = "1e4c5e99-e387-41aa-a6d3-cbe74558f766";
const SUPPORTED_BRANDS = new Set(["FEBI", "SWAG", "BLUE_PRINT"]);
const DATABASE_REQUEST_TIMEOUT_MS = readRequestTimeoutMs(
  process.env.SUPABASE_REQUEST_TIMEOUT_MS,
  45_000,
);

const args = parseArgs();
const options = {
  dryRun: args.has("dry-run"),
  confirmProduction: args.has("confirm-production"),
  includeDetails: args.has("include-details"),
  brand: normalizeBrand(args.get("brand") || ""),
  maxItems: readPositiveInteger(args.get("max-items"), 10, 50),
  page: readNonNegativeInteger(args.get("page"), 0),
  country: String(args.get("country") || "TR").trim().toUpperCase(),
  vehicleType: String(args.get("vehicle-type") || "CAR").trim().toUpperCase(),
  organizationId: String(
    args.get("organization-id") || process.env.NEXT_MASTER_ORGANIZATION_ID || DEFAULT_ORGANIZATION_ID,
  ).trim(),
};

if (!options.brand) block("--brand must be FEBI, SWAG, or BLUE_PRINT.");
if (!options.dryRun && !options.confirmProduction) {
  block("Use --dry-run first, then explicitly use --confirm-production to stage observations.");
}

console.log("BILSTEIN GROUP OBSERVATION ADAPTER START");
console.log(`mode=${options.dryRun ? "dry_run" : "stage_only"}`);
console.log(`brand=${options.brand}; max_items=${options.maxItems}; page=${options.page}`);
console.log(`detail_evidence=${options.includeDetails ? "enabled" : "disabled"}`);

const observations = await collectObservations(options);

if (options.dryRun) {
  console.log(JSON.stringify({
    mode: "dry_run",
    source_key: SOURCE_KEY,
    brand: options.brand,
    planned_observations: observations.length,
    observations: observations.map(summarizeObservation),
    guarantee: "No Supabase table was read or written.",
  }, null, 2));
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot: repoRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot: repoRoot });
if (!/^https:\/\//i.test(supabaseUrl) || !serviceRoleKey) {
  block("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --confirm-production.");
}

const db = createDbClient({ supabaseUrl, serviceRoleKey });
const brand = await resolveBrand(db, options.organizationId, options.brand);
const baseFieldFamilies = ["supplemental_description"];
const detailFieldFamilies = ["oem_reference", "technical_specification"];
const sourceId = await db.rpc("configure_catalog_external_source", {
  input_organization_id: options.organizationId,
  input_source_key: SOURCE_KEY,
  input_display_name: SOURCE_DISPLAY_NAME,
  input_source_owner: "Bilstein Group",
  input_source_type: "manufacturer",
  input_base_url: "https://partsfinder.bilsteingroup.com",
  input_license_posture: "internal_review_required",
  input_robots_posture: "not_applicable",
  input_rate_limit_posture: "bounded",
  input_is_active: true,
  input_metadata: {
    collection_mode: "official_api_observation_only",
    human_review_required: true,
    automatic_apply: false,
  },
});
const trustProfileId = await db.rpc("configure_catalog_external_source_trust_profile", {
  input_organization_id: options.organizationId,
  input_source_id: sourceId,
  input_trust_level: "T3",
  input_trust_score: 0.8,
  input_allowed_field_families: baseFieldFamilies,
  input_human_review_required: true,
  input_downstream_publication_restriction: "internal_only",
  input_evidence_required: true,
  input_is_active: true,
  input_notes: "Bilstein Group PartsFinder bounded observation adapter; detail evidence is review-only and canonical Apply is disabled.",
});
const jobId = await db.rpc("configure_single_brand_catalog_observation_job", {
  input_organization_id: options.organizationId,
  input_source_id: sourceId,
  input_trust_profile_id: trustProfileId,
  input_brand_id: brand.id,
  input_job_key: `nm-catalog-bilstein-partsfinder-${options.brand.toLowerCase()}-v1`,
  input_allowed_field_families: baseFieldFamilies,
  input_max_observations_per_run: Math.max(options.maxItems, observations.length),
  input_max_retry_attempts: 3,
  input_lock_timeout_seconds: 600,
  input_status: "active",
  input_metadata: {
    source_key: SOURCE_KEY,
    brand: options.brand,
    collection_mode: options.includeDetails ? "stage_only_detail_evidence" : "stage_only",
  },
});

if (options.includeDetails) {
  await db.rpc("configure_catalog_detail_observation_scope", {
    input_organization_id: options.organizationId,
    input_source_id: sourceId,
    input_trust_profile_id: trustProfileId,
    input_job_id: jobId,
    input_allowed_field_families: detailFieldFamilies,
  });
}

let runId = null;
const appendedObservationIds = [];
const failures = [];
try {
  runId = await db.rpc("begin_catalog_observation_run", {
    input_job_id: jobId,
    input_actor_id: null,
    input_metadata: {
      collector: "run-bilstein-group-observation-adapter.mjs",
      source_page: options.page,
      source_country: options.country,
      source_vehicle_type: options.vehicleType,
      requested_count: observations.length,
    },
  });

  for (const observation of observations) {
    try {
      const observationId = await db.rpc("append_catalog_external_observation", {
        input_run_id: runId,
        ...observation,
      });
      appendedObservationIds.push(observationId);
    } catch (error) {
      failures.push({ product_code: observation.input_product_code, error: errorMessage(error) });
    }
  }

  const status = appendedObservationIds.length === 0
    ? "failed"
    : failures.length > 0
      ? "completed_with_warnings"
      : "succeeded";
  await db.rpc("finish_catalog_observation_run", {
    input_run_id: runId,
    input_status: status,
    input_error_message: status === "failed" ? "No Bilstein observations were appended." : null,
  });

  console.log(JSON.stringify({
    mode: "stage_only",
    run_id: runId,
    source_key: SOURCE_KEY,
    source_id: sourceId,
    job_id: jobId,
    brand,
    staged_observations: appendedObservationIds.length,
    failed_observations: failures.length,
    failures,
    guarantee: "No catalog_products row was inserted, updated, or finalized.",
  }, null, 2));
} catch (error) {
  if (runId) {
    await db.rpc("finish_catalog_observation_run", {
      input_run_id: runId,
      input_status: "failed",
      input_error_message: errorMessage(error),
    }).catch(() => undefined);
  }
  throw error;
}

async function collectObservations(input) {
  const url = new URL(API_URL);
  url.searchParams.set("page[number]", String(input.page));
  url.searchParams.set("page[size]", String(input.maxItems));
  url.searchParams.set("filter[brands]", input.brand);
  url.searchParams.set("filter[country]", input.country);
  url.searchParams.set("filter[vehicleType]", input.vehicleType);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.api+json",
      "User-Agent": "Next-Master Bilstein Group observation adapter",
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Bilstein API ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const articles = Array.isArray(payload?.data) ? payload.data : [];
  return articles.slice(0, input.maxItems).flatMap((article) => {
    return buildObservations(article, input);
  });
}

function buildObservations(article, input) {
  const attributes = article?.attributes || {};
  const productCode = cleanText(article?.id);
  const description = cleanText(attributes.articleDescription) || cleanText(attributes.additionalDescription);
  if (!productCode || !description) return [];

  const normalizedCode = normalizeCode(productCode);
  const observedAt = new Date().toISOString();
  const sourceUrl = buildArticleUrl({ productCode, brand: input.brand, country: input.country, vehicleType: input.vehicleType });
  const oemNumbers = normalizeOemNumbers(attributes.oeNumbers);
  const technicalAttributes = normalizeTechnicalAttributes(attributes.articleAttributes);
  const evidencePayload = {
    schema_version: "bilstein-partsfinder-observation.v2",
    source_key: SOURCE_KEY,
    source_brand: input.brand,
    product_code: productCode,
    normalized_code: normalizedCode,
    description,
    vehicle_type: cleanText(attributes.vehicleType) || input.vehicleType,
    fitting_side: cleanText(attributes.fittingSide),
    packaging_quantity: finiteNumber(attributes.packagingQty),
    oem_numbers: oemNumbers,
    technical_attributes: technicalAttributes,
    source_url: sourceUrl,
    observed_at: observedAt,
    raw_attributes: attributes,
  };
  const observations = [buildObservationRecord({
    productCode,
    normalizedCode,
    sourceBrand: input.brand,
    fieldFamily: "supplemental_description",
    fieldName: "description",
    rawValue: description,
    normalizedValue: normalizeWhitespace(description),
    sourceUrl,
    observedAt,
    evidencePayload,
  })];

  if (input.includeDetails && oemNumbers.length > 0) {
    observations.push(buildObservationRecord({
      productCode,
      normalizedCode,
      sourceBrand: input.brand,
      fieldFamily: "oem_reference",
      fieldName: "oem_numbers",
      rawValue: stableJson(oemNumbers),
      normalizedValue: stableJson(oemNumbers),
      sourceUrl,
      observedAt,
      evidencePayload,
    }));
  }

  const technicalProfile = {
    vehicle_type: cleanText(attributes.vehicleType) || input.vehicleType,
    fitting_side: cleanText(attributes.fittingSide),
    packaging_quantity: finiteNumber(attributes.packagingQty),
    article_attributes: technicalAttributes,
  };
  if (input.includeDetails && hasTechnicalProfile(technicalProfile)) {
    observations.push(buildObservationRecord({
      productCode,
      normalizedCode,
      sourceBrand: input.brand,
      fieldFamily: "technical_specification",
      fieldName: "partsfinder_profile",
      rawValue: stableJson(technicalProfile),
      normalizedValue: stableJson(technicalProfile),
      sourceUrl,
      observedAt,
      evidencePayload,
    }));
  }

  return observations;
}

function buildObservationRecord({
  productCode,
  normalizedCode,
  sourceBrand,
  fieldFamily,
  fieldName,
  rawValue,
  normalizedValue,
  sourceUrl,
  observedAt,
  evidencePayload,
}) {
  const evidenceHash = sha256(stableJson({
    evidence_payload: evidencePayload,
    field_family: fieldFamily,
    field_name: fieldName,
    normalized_value: normalizedValue,
  }));
  return {
    input_product_code: productCode,
    input_normalized_code: normalizedCode,
    input_field_family: fieldFamily,
    input_field_name: fieldName,
    input_raw_value: rawValue,
    input_normalized_value: normalizedValue,
    input_evidence_reference: `${SOURCE_KEY}:${sourceBrand}:${normalizedCode}:${fieldFamily}:${fieldName}:${evidenceHash}`,
    input_evidence_url: sourceUrl,
    input_evidence_hash: evidenceHash,
    input_evidence_payload: evidencePayload,
    input_external_product_ref: productCode,
    input_confidence: 0.8,
    input_observed_at: observedAt,
    input_collector_actor_id: null,
  };
}

function hasTechnicalProfile(profile) {
  return Boolean(
    profile.vehicle_type
    || profile.fitting_side
    || profile.packaging_quantity !== null
    || profile.article_attributes.length > 0,
  );
}

function buildArticleUrl({ productCode, brand, country, vehicleType }) {
  const url = new URL(API_URL);
  url.pathname = `/api/articles/${productCode}`;
  url.searchParams.set("filter[brands]", brand);
  url.searchParams.set("filter[country]", country);
  url.searchParams.set("filter[vehicleType]", vehicleType);
  return url.toString();
}

async function resolveBrand(db, organizationId, requestedBrand) {
  const expectedName = {
    FEBI: "FEBI",
    SWAG: "SWAG",
    BLUE_PRINT: "Blue Print",
  }[requestedBrand];
  const rows = await db.get("brands", {
    select: "id,organization_id,name",
    organization_id: `eq.${organizationId}`,
    name: `ilike.${expectedName}`,
    limit: "2",
  });
  const matches = rows.filter((row) => normalizeBrand(row.name) === requestedBrand);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${requestedBrand} brand in the organization; found ${matches.length}.`);
  }
  return matches[0];
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
      return parseResponse(await fetchWithTimeout(url, { headers }), `GET ${table}`);
    },
    async rpc(name, args) {
      const response = await fetchWithTimeout(new URL(`/rest/v1/rpc/${name}`, supabaseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(args),
      });
      return parseResponse(response, `RPC ${name}`);
    },
  };
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DATABASE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Supabase request timed out after ${DATABASE_REQUEST_TIMEOUT_MS / 1000} seconds. No further staging was attempted.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponse(response, label) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text}`);
  return payload;
}

function normalizeOemNumbers(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    make: cleanText(entry?.make),
    numbers: unique((Array.isArray(entry?.numbers) ? entry.numbers : []).map(cleanText).filter(Boolean)),
  })).filter((entry) => entry.make || entry.numbers.length);
}

function normalizeTechnicalAttributes(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    type_id: finiteNumber(entry?.typeId),
    name: cleanText(entry?.type),
    value: cleanText(entry?.value),
    unit: cleanText(entry?.unit),
  })).filter((entry) => entry.name && entry.value);
}

function summarizeObservation(observation) {
  const payload = observation.input_evidence_payload;
  return {
    product_code: observation.input_product_code,
    field_family: observation.input_field_family,
    field_name: observation.input_field_name,
    value_preview: observation.input_normalized_value.slice(0, 160),
    oem_group_count: payload.oem_numbers.length,
    technical_attribute_count: payload.technical_attributes.length,
    source_url: observation.input_evidence_url,
  };
}

function normalizeBrand(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[ -]/g, "_");
  if (normalized === "BLUEPRINT") return "BLUE_PRINT";
  return SUPPORTED_BRANDS.has(normalized) ? normalized : "";
}

function normalizeCode(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue != null) values.set(key, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values.set(key, argv[++index]);
    else values.set(key, "true");
  }
  return values;
}

function readPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) block(`--max-items must be an integer between 1 and ${maximum}.`);
  return parsed;
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) block("--page must be a non-negative integer.");
  return parsed;
}

function readRequestTimeoutMs(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 5_000 || parsed > 60_000) {
    block("SUPABASE_REQUEST_TIMEOUT_MS must be an integer between 5000 and 60000.");
  }
  return parsed;
}

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(values)];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function block(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
