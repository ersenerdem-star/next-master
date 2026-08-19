import { buildRestUrl, getJson, serviceRoleHeaders } from "../http.mts";

const FIELD_MAP: Record<string, string> = {
  ean_reference: "ean",
  gtin_reference: "gtin",
  oem_reference: "oem",
  fitment: "vehicle",
  vehicle: "vehicle",
  vehicle_model: "vehicle_model",
  supplemental_description: "description",
  image_reference: "image",
  origin: "origin",
  weight: "weight_kg",
  weight_kg: "weight_kg",
  hs_code: "hs_code",
  market_segment: "market_segment",
  technical_specification: "technical_specification",
};

type Row = Record<string, unknown>;

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fields(...values: unknown[]) {
  return [...new Set(values.flatMap(array).map(String).map((value) => FIELD_MAP[value] || "").filter(Boolean))];
}

function permittedFields(job: Row, trust: Row | undefined) {
  const jobFields = new Set(fields(job.allowed_field_families));
  return fields(trust?.allowed_field_families, trust?.auto_enrichment_allowed_fields)
    .filter((field) => jobFields.has(field));
}

function sourceAdmitted(source: Row, trust: Row | undefined, job: Row | undefined) {
  const meta = metadata(source.metadata);
  return source.is_active === true
    && source.license_posture === "allowed"
    && ["allowed", "not_applicable"].includes(String(source.robots_posture || ""))
    && ["bounded", "not_applicable"].includes(String(source.rate_limit_posture || ""))
    && meta.automated_read_only_approved === true
    && (meta.internal_catalog_persistence_allowed === true || meta.internal_observation_allowed === true)
    && trust?.is_active === true
    && job?.status === "active";
}

function missingFields(row: Row) {
  const definitions = [
    ["ean", row.missing_ean_count],
    ["oem", row.missing_oem_count],
    ["vehicle", row.missing_vehicle_count],
    ["vehicle_model", row.missing_vehicle_model_count],
    ["description", row.missing_description_count],
    ["image", row.missing_image_count],
    ["origin", row.missing_origin_count],
    ["weight_kg", row.missing_weight_count],
    ["hs_code", row.missing_hs_code_count],
    ["market_segment", row.missing_market_segment_count],
  ] as const;
  return definitions
    .map(([field, value]) => ({ field, missingCount: Math.max(0, Number(value || 0)) }))
    .filter((entry) => entry.missingCount > 0)
    .map((entry) => ({ ...entry, priority: entry.missingCount }));
}

function rest(supabaseUrl: string, table: string, params: Record<string, string>) {
  return buildRestUrl(supabaseUrl, table, params);
}

function publicSourceUrl(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

export async function buildMiraKnowledgeSnapshot({
  supabaseUrl,
  serviceRoleKey,
  organizationId,
  fetchRows = getJson,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  fetchRows?: typeof getJson;
}) {
  const headers = serviceRoleHeaders(serviceRoleKey);
  function get<T>(table: string, params: Record<string, string>) {
    return fetchRows<T>(rest(supabaseUrl, table, params), { headers, timeoutMs: 12_000 });
  }
  const [summaries, brands, sources, trusts, jobs, runs, missions] = await Promise.all([
    get<Row[]>("catalog_operations_brand_summary", { select: "brand_id,total_products,missing_ean_count,missing_oem_count,missing_vehicle_count,missing_vehicle_model_count,missing_description_count,missing_image_count,missing_origin_count,missing_weight_count,missing_hs_code_count,missing_market_segment_count,last_catalog_change_at,updated_at", organization_id: `eq.${organizationId}`, total_products: "gt.0", order: "total_products.desc", limit: "100" }),
    // The production brands table has no lifecycle flag. Keep this lookup to
    // the canonical identity columns so the read-only snapshot cannot fail on
    // a field that belongs to another brand projection.
    get<Row[]>("brands", { select: "id,name", organization_id: `eq.${organizationId}`, limit: "200" }),
    get<Row[]>("catalog_external_sources", { select: "id,source_key,display_name,source_type,base_url,license_posture,robots_posture,rate_limit_posture,credential_boundary,is_active,metadata", organization_id: `eq.${organizationId}`, limit: "200" }),
    get<Row[]>("catalog_external_source_trust_profiles", { select: "id,source_id,allowed_field_families,auto_enrichment_allowed_fields,human_review_required,evidence_required,is_active", organization_id: `eq.${organizationId}`, limit: "200" }),
    get<Row[]>("catalog_observation_jobs", { select: "id,source_id,trust_profile_id,brand_id,job_key,status,allowed_field_families,updated_at", organization_id: `eq.${organizationId}`, limit: "200" }),
    get<Row[]>("catalog_observation_runs", { select: "id,job_id,source_id,brand_id,status,observed_count,deduped_count,error_message,started_at,finished_at", organization_id: `eq.${organizationId}`, order: "started_at.desc", limit: "500" }),
    get<Row[]>("mira_missions", { select: "id,objective,status,created_at,started_at", organization_id: `eq.${organizationId}`, status: "in.(queued,processing)", order: "created_at.asc", limit: "100" }),
  ]);

  const brandById = new Map(brands.map((row) => [String(row.id), String(row.name || "")]));
  const sourceById = new Map(sources.map((row) => [String(row.id), row]));
  const trustById = new Map(trusts.map((row) => [String(row.id), row]));
  const jobById = new Map(jobs.map((row) => [String(row.id), row]));
  const runsByJob = new Map<string, Row[]>();
  for (const run of runs) {
    const key = String(run.job_id || "");
    if (!runsByJob.has(key)) runsByJob.set(key, []);
    runsByJob.get(key)?.push(run);
  }

  const channels = jobs.map((job) => {
    const source = sourceById.get(String(job.source_id)) || {};
    const trust = trustById.get(String(job.trust_profile_id));
    const jobRuns = runsByJob.get(String(job.id)) || [];
    const succeeded = jobRuns.filter((run) => ["succeeded", "completed_with_warnings"].includes(String(run.status))).length;
    const failed = jobRuns.filter((run) => ["failed", "dead_letter"].includes(String(run.status))).length;
    const latestSuccess = jobRuns.find((run) => ["succeeded", "completed_with_warnings"].includes(String(run.status)));
    const latestFailure = jobRuns.find((run) => ["failed", "dead_letter"].includes(String(run.status)));
    return {
      channelId: String(job.job_key || `${source.source_key || "source"}:${job.brand_id || "brand"}`),
      sourceKey: String(source.source_key || ""),
      sourceUrl: publicSourceUrl(source.base_url),
      brand: brandById.get(String(job.brand_id)) || null,
      kind: String(source.source_type || "unknown"),
      // A field is runnable only when both the job and the trust profile allow
      // it.  Using a union here would advertise authority that one side did
      // not grant.
      supportedFields: permittedFields(job, trust),
      status: sourceAdmitted(source, trust, job) ? "ready" : String(job.status || "unknown"),
      admitted: sourceAdmitted(source, trust, job),
      successRate: jobRuns.length ? succeeded / jobRuns.length : 0,
      observedCount: jobRuns.reduce((sum, run) => sum + Number(run.observed_count || 0), 0),
      failedCount: failed,
      lastSuccessAt: latestSuccess?.finished_at || null,
      // Operational errors can contain upstream response fragments.  The
      // snapshot reports the failure state without exporting those fragments.
      lastError: latestFailure ? "Observation channel reported a failed run." : null,
      policy: {
        license: source.license_posture || "unknown",
        robots: source.robots_posture || "unknown",
        rateLimit: source.rate_limit_posture || "unknown",
        credentialBoundary: source.credential_boundary || "none",
        evidenceRequired: trust?.evidence_required !== false,
        humanReviewRequired: trust?.human_review_required !== false,
      },
    };
  });

  const catalogGaps = summaries.map((row) => ({
    brand: brandById.get(String(row.brand_id)) || "Unknown brand",
    totalProducts: Number(row.total_products || 0),
    missingFields: missingFields(row),
    lastCatalogChangeAt: row.last_catalog_change_at || null,
    projectionUpdatedAt: row.updated_at || null,
  })).filter((row) => row.missingFields.length > 0);

  return {
    knowledgeVersion: "mira-system-knowledge.v1",
    organizationId,
    capturedAt: new Date().toISOString(),
    catalog: { gaps: catalogGaps },
    channels,
    runs: runs.map((run) => ({
      runId: String(run.id || ""),
      channelId: String(jobById.get(String(run.job_id))?.job_key || sourceById.get(String(run.source_id))?.source_key || "unknown"),
      brand: brandById.get(String(run.brand_id)) || null,
      status: String(run.status || "unknown"),
      observedCount: Number(run.observed_count || 0),
      failedCount: ["failed", "dead_letter"].includes(String(run.status)) ? 1 : 0,
      finishedAt: run.finished_at || null,
      error: run.error_message || null,
    })),
    activeMissions: missions.map((mission) => ({
      missionId: String(mission.id || ""),
      objective: String(mission.objective || ""),
      status: String(mission.status || "unknown"),
      createdAt: mission.created_at || null,
      startedAt: mission.started_at || null,
    })),
    guarantees: {
      readOnly: true,
      catalogWrite: false,
      apply: false,
      customerDataIncluded: false,
      supplierPriceDataIncluded: false,
      credentialsIncluded: false,
    },
  };
}
