import { createHash } from "node:crypto";
import {
  MIRA_OBSERVATION_INTAKE_VERSION,
  MIRA_OBSERVATION_MAX_BATCH,
  MiraObservationIntakeError,
  createMiraObservationIntakeClient,
} from "./mira-observation-intake.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const FORBIDDEN_SCOPE_KEYS = new Set([
  "organization_id",
  "organizationId",
  "source_id",
  "sourceId",
  "trust_profile_id",
  "trustProfileId",
  "job_id",
  "jobId",
  "brand_id",
  "brandId",
  "catalog_product_id",
  "catalogProductId",
  "run_id",
  "runId",
  "actor_id",
  "actorId",
  "collector_actor_id",
  "collectorActorId",
]);

function fail(code, message, details = {}) {
  throw new MiraObservationIntakeError(code, message, details);
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizedLabel(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function hasForbiddenScopeKey(value, depth = 0) {
  if (depth > 7 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenScopeKey(item, depth + 1));
  return Object.entries(value).some(([key, item]) => FORBIDDEN_SCOPE_KEYS.has(key) || hasForbiddenScopeKey(item, depth + 1));
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function normalizeMiraObservationResultIntake(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RESULT_INTAKE", "MIRA observation intake must be an object");
  }
  if (hasForbiddenScopeKey(value)) {
    fail("CLIENT_SCOPE_FORBIDDEN", "MIRA result must not provide tenant, source, trust, job, or brand scope identifiers");
  }
  if (value.protocolVersion !== MIRA_OBSERVATION_INTAKE_VERSION) {
    fail("UNSUPPORTED_RESULT_INTAKE", "Unsupported MIRA observation intake protocol version");
  }
  const sourceKey = text(value.sourceKey).toLowerCase();
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) {
    fail("INVALID_SOURCE_KEY", "MIRA result sourceKey is invalid");
  }
  const brand = text(value.brand);
  if (!brand || brand.length > 120 || /[\u0000-\u001f\u007f]/.test(brand)) {
    fail("INVALID_BRAND", "MIRA result brand is invalid");
  }
  const candidateCount = value.candidateCount === undefined ? null : value.candidateCount;
  if (candidateCount !== null && (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > MIRA_OBSERVATION_MAX_BATCH)) {
    fail("BOUND_EXCEEDED", `MIRA result candidateCount must be an integer between 1-${MIRA_OBSERVATION_MAX_BATCH}`);
  }
  const skippedCount = value.skippedCount === undefined ? 0 : value.skippedCount;
  if (!Number.isInteger(skippedCount) || skippedCount < 0 || skippedCount > MIRA_OBSERVATION_MAX_BATCH) {
    fail("BOUND_EXCEEDED", `MIRA result skippedCount must be an integer between 0-${MIRA_OBSERVATION_MAX_BATCH}`);
  }
  if (!Array.isArray(value.observations) || value.observations.length > MIRA_OBSERVATION_MAX_BATCH) {
    fail("BOUND_EXCEEDED", `MIRA result observations must contain 0-${MIRA_OBSERVATION_MAX_BATCH} items`);
  }
  if (value.observations.length === 0 && !(candidateCount !== null && skippedCount === candidateCount)) {
    fail("BOUND_EXCEEDED", "An empty MIRA observation batch requires every candidate to have an explicit skip reason");
  }
  if (candidateCount !== null && value.observations.length + skippedCount !== candidateCount) {
    fail("CANDIDATE_COUNT_MISMATCH", "MIRA result candidateCount must equal observations plus skippedCount");
  }
  const skipReasons = value.skipReasons === undefined ? [] : value.skipReasons;
  if (!Array.isArray(skipReasons) || skipReasons.length > MIRA_OBSERVATION_MAX_BATCH || skipReasons.length > skippedCount) {
    fail("BOUND_EXCEEDED", "MIRA result skipReasons exceed the skipped candidate count");
  }
  for (const [index, reason] of skipReasons.entries()) {
    if (!reason || typeof reason !== "object" || Array.isArray(reason)
      || typeof reason.candidateId !== "string" || !reason.candidateId.trim()
      || typeof reason.code !== "string" || !reason.code.trim()
      || typeof reason.reason !== "string" || !reason.reason.trim()) {
      fail("INVALID_SKIP_REASON", `MIRA result skipReasons[${index}] is invalid`);
    }
  }
  for (const [index, observation] of value.observations.entries()) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)
      || observation.writeDisposition !== "observation-staging-only") {
      fail("WRITE_DISPOSITION_BLOCKED", `MIRA result observations[${index}] must remain observation-staging-only`);
    }
  }
  if (jsonBytes(value) > 192 * 1024) {
    fail("BOUND_EXCEEDED", "MIRA observation intake exceeds the server-side result bound");
  }
  return {
    protocolVersion: MIRA_OBSERVATION_INTAKE_VERSION,
    sourceKey,
    brand,
    observations: value.observations,
    candidateCount,
    skippedCount,
    skipReasons,
  };
}

async function getRows({ supabaseUrl, serviceRoleKey, table, query, fetchImpl }) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(url, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(payload)) {
      fail("SCOPE_LOOKUP_FAILED", `Server-side MIRA scope lookup failed for ${table}`, { status: response.status });
    }
    return payload;
  } catch (error) {
    if (error instanceof MiraObservationIntakeError) throw error;
    if (error?.name === "AbortError") fail("SCOPE_LOOKUP_TIMEOUT", `Server-side MIRA scope lookup timed out for ${table}`);
    fail("SCOPE_LOOKUP_FAILED", `Server-side MIRA scope lookup failed for ${table}`);
  } finally {
    clearTimeout(timer);
  }
}

function exactlyOne(rows, code, message) {
  if (rows.length !== 1) fail(code, message, { matches: rows.length });
  return rows[0];
}

export async function resolveMiraObservationScope({
  supabaseUrl,
  serviceRoleKey,
  organizationId,
  sourceKey,
  brand,
  fetchImpl = fetch,
}) {
  if (!UUID_PATTERN.test(text(organizationId))) fail("INVALID_TENANT", "MIRA bridge organization is invalid");
  const base = { supabaseUrl, serviceRoleKey, fetchImpl };
  const source = exactlyOne(await getRows({
    ...base,
    table: "catalog_external_sources",
    query: {
      select: "id,organization_id,source_key,license_posture,robots_posture,rate_limit_posture,credential_boundary,is_active,metadata",
      organization_id: `eq.${organizationId}`,
      source_key: `eq.${sourceKey}`,
      is_active: "eq.true",
      limit: "2",
    },
  }), "SOURCE_MAPPING_MISSING", "MIRA sourceKey does not resolve to exactly one active tenant source");

  const trustProfile = exactlyOne(await getRows({
    ...base,
    table: "catalog_external_source_trust_profiles",
    query: {
      select: "id,organization_id,source_id,allowed_field_families,is_active,human_review_required,downstream_publication_restriction,evidence_required",
      organization_id: `eq.${organizationId}`,
      source_id: `eq.${source.id}`,
      is_active: "eq.true",
      limit: "2",
    },
  }), "TRUST_MAPPING_MISSING", "MIRA source does not resolve to exactly one active trust profile");

  const brands = await getRows({
    ...base,
    table: "brands",
    // The production brands table has no lifecycle column; tenant membership
    // is the authoritative scope here. Source/trust/job activity remains
    // enforced by their own active filters above.
    query: { select: "id,organization_id,name", organization_id: `eq.${organizationId}`, limit: "1000" },
  });
  const matchingBrands = brands.filter((row) => normalizedLabel(row.name) === normalizedLabel(brand));
  const brandRecord = exactlyOne(matchingBrands, "BRAND_MAPPING_MISSING", "MIRA brand does not resolve to exactly one tenant brand");

  const jobs = await getRows({
    ...base,
    table: "catalog_observation_jobs",
    query: {
      select: "id,organization_id,source_id,trust_profile_id,brand_id,status,allowed_field_families,sync_mode,metadata",
      organization_id: `eq.${organizationId}`,
      source_id: `eq.${source.id}`,
      trust_profile_id: `eq.${trustProfile.id}`,
      brand_id: `eq.${brandRecord.id}`,
      status: "eq.active",
      limit: "20",
    },
  });
  const approvedJobs = jobs.filter((row) => row.sync_mode === "observation_only" && row.metadata?.mira_intake_protocol === "v1");
  const job = exactlyOne(approvedJobs, "JOB_MAPPING_MISSING", "MIRA source and brand do not resolve to exactly one approved observation-only job");

  return { source, trustProfile, job, brand: brandRecord };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function stageMiraObservationResult({
  supabaseUrl,
  serviceRoleKey,
  organizationId,
  missionId,
  resultIntake,
  fetchImpl = fetch,
}) {
  if (!UUID_PATTERN.test(text(missionId))) fail("INVALID_MISSION", "MIRA mission identifier is invalid");
  const normalized = normalizeMiraObservationResultIntake(resultIntake);
  if (normalized.observations.length === 0) {
    fail("NO_OBSERVATIONS", "MIRA result contains no stageable observations");
  }
  const scope = await resolveMiraObservationScope({
    supabaseUrl,
    serviceRoleKey,
    organizationId,
    sourceKey: normalized.sourceKey,
    brand: normalized.brand,
    fetchImpl,
  });
  const canonical = JSON.stringify({
    sourceKey: normalized.sourceKey,
    brand: normalized.brand,
    candidateCount: normalized.candidateCount,
    skippedCount: normalized.skippedCount,
    skipReasons: normalized.skipReasons,
    observations: normalized.observations,
  });
  const requestFingerprint = sha256(canonical);
  const client = createMiraObservationIntakeClient({ supabaseUrl, serviceRoleKey, fetchImpl });
  const receipt = await client.ingest({
    organization_id: organizationId,
    source_id: scope.source.id,
    trust_profile_id: scope.trustProfile.id,
    job_id: scope.job.id,
    brand_id: scope.brand.id,
    idempotency_key: `mira:${missionId}:observation-intake:v1`,
    request_fingerprint: requestFingerprint,
    observations: normalized.observations,
    metadata: {
      mission_id: missionId,
      source_key: normalized.sourceKey,
      brand: scope.brand.name,
      result_intake_protocol: MIRA_OBSERVATION_INTAKE_VERSION,
    },
  }, scope);
  const accepted = ["succeeded", "completed_with_warnings"].includes(text(receipt?.status));
  return {
    protocolVersion: MIRA_OBSERVATION_INTAKE_VERSION,
    status: accepted ? "staged" : "blocked",
    intakeStatus: text(receipt?.status) || "blocked",
    runId: UUID_PATTERN.test(text(receipt?.run_id)) ? text(receipt.run_id) : null,
    observedCount: Number.isInteger(receipt?.observed_count) ? receipt.observed_count : 0,
    dedupedCount: Number.isInteger(receipt?.deduped_count) ? receipt.deduped_count : 0,
    idempotent: receipt?.idempotent === true,
    catalogProductsWritten: 0,
    applyPerformed: false,
  };
}
