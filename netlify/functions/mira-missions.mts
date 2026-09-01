import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, getJson, json, readJson, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import { verifyMiraBridgeRequest } from "./_shared/mira-bridge-auth.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import {
  MiraObservationIntakeError,
} from "./_shared/catalog/mira-observation-intake.mjs";
import {
  normalizeMiraObservationResultIntake,
  stageMiraObservationResult,
} from "./_shared/catalog/mira-observation-result-intake.mjs";
import {
  isMiraQuarantineEligibleError,
  quarantineReasonForResultIntake,
  stageMiraDiscoveryQuarantine,
} from "./_shared/catalog/mira-discovery-quarantine.mjs";
import { buildMiraKnowledgeSnapshot } from "./_shared/catalog/mira-knowledge-snapshot.mts";

type MissionInput = {
  objective?: unknown;
  missionArea?: unknown;
  maxPages?: unknown;
  delayMs?: unknown;
  targetBrand?: unknown;
  sourceKey?: unknown;
  requestedFields?: unknown;
  maxItems?: unknown;
};

type BridgeMission = {
  id: string;
  organization_id: string;
  objective?: string;
  mission_area?: string;
  max_pages?: number;
  delay_ms?: number;
  status: string;
  created_at?: string;
  started_at?: string | null;
  bridge_client?: string | null;
  bridge_event_id?: string | null;
  result?: unknown;
  origin?: "manual" | "planner";
  planner_key?: string | null;
  planner_score?: number | null;
  planner_reason?: string | null;
  planner_context?: Record<string, unknown> | null;
  target_brand?: string | null;
  requested_fields?: string[] | null;
  max_items?: number | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BRIDGE_BODY_BYTES = 256 * 1024;
const MAX_DEBRIEF_BYTES = 128 * 1024;
const TERMINAL_STATUSES = new Set(["completed", "partial", "blocked", "cancelled"]);

function env(name: string) {
  return Netlify.env.get(name)?.trim() || "";
}

function parseMissionInput(body: MissionInput) {
  const objective = String(body.objective ?? "").trim();
  const missionArea = String(body.missionArea ?? "Public catalog signal").trim() || "Public catalog signal";
  const maxPages = Number(body.maxPages ?? 1);
  const delayMs = Number(body.delayMs ?? 2000);
  const targetBrand = String(body.targetBrand ?? "").trim();
  const sourceKey = String(body.sourceKey ?? "mira_auto").trim() || "mira_auto";
  const requestedFields = Array.isArray(body.requestedFields)
    ? [...new Set(body.requestedFields.map((field) => String(field).trim().toLowerCase()).filter(Boolean))].slice(0, 14)
    : [];
  const maxItems = Number(body.maxItems ?? 25);

  if (objective.length < 8 || objective.length > 500) {
    throw new Error("Mission objective must be between 8 and 500 characters.");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
    throw new Error("Page budget must be an integer between 1 and 50.");
  }
  if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 10000) {
    throw new Error("Request interval must be between 1000 and 10000 milliseconds.");
  }
  if (targetBrand.length > 120) throw new Error("Target brand is too long.");
  if (!/^[a-z0-9._:-]{2,80}$/i.test(sourceKey)) throw new Error("Source selection is invalid.");
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) throw new Error("Package size must be between 1 and 50.");

  return { objective, missionArea, maxPages, delayMs, targetBrand, sourceKey, requestedFields, maxItems };
}

async function listMissions(caller: Awaited<ReturnType<typeof requireCallerProfile>>) {
  if ("error" in caller) return json({ error: caller.error }, caller.status);
  const url = buildRestUrl(caller.supabaseUrl, "mira_missions", {
    select: "id,objective,mission_area,max_pages,delay_ms,status,execution_mode,result,error_message,created_at,started_at,finished_at,bridge_client,bridge_event_id,bridge_protocol_version,bridge_received_at,origin,planner_key,planner_score,planner_reason,planner_context,target_brand,requested_fields,max_items",
    organization_id: `eq.${caller.profile.organization_id}`,
    order: "created_at.desc",
    limit: "50",
  });
  const missions = await getJson<unknown[]>(url, { headers: serviceRoleHeaders(caller.serviceRoleKey), timeoutMs: 12000 });
  return json({ ok: true, online: true, missions });
}

async function planMiraMissions({
  supabaseUrl,
  serviceRoleKey,
  organizationId,
  actorId,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  actorId: string | null;
}) {
  const rpcUrl = new URL("/rest/v1/rpc/plan_mira_catalog_missions", supabaseUrl).toString();
  return sendJson<Record<string, unknown>>(rpcUrl, {
    method: "POST",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify({
      input_organization_id: organizationId,
      input_actor_id: actorId,
      input_limit: 1,
    }),
    timeoutMs: 60000,
  });
}

function bridgeEnabled() {
  return ["1", "true", "yes"].includes(env("MIRA_BRIDGE_ENABLED").toLowerCase());
}

function bridgeConfig() {
  const secret = env("MIRA_BRIDGE_HMAC_SECRET");
  const organizationId = env("MIRA_BRIDGE_ORGANIZATION_ID");
  if (!bridgeEnabled() || secret.length < 32 || !UUID_PATTERN.test(organizationId)) {
    throw Object.assign(new Error("MIRA bridge is not configured."), { status: 503 });
  }
  return { secret, organizationId };
}

function boundedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function boundedInteger(value: unknown, max = 1_000_000_000) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

function redactLocalPath(value: string) {
  if (/^(?:\/|~\/|file:|[A-Za-z]:[\\/])/i.test(value)) return "[local path redacted]";
  return value;
}

function sanitizeDebriefValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[nested value omitted]";
  if (typeof value === "string") {
    const text = redactLocalPath(value.trim());
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDebriefValue(item, depth + 1));
  if (typeof value !== "object") return null;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    const sanitized = sanitizeDebriefValue(item, depth + 1);
    output[key.slice(0, 100)] = /(?:path|uri)$/i.test(key) && typeof sanitized === "string" && !/^https:\/\//i.test(sanitized)
      ? "[non-public reference redacted]"
      : sanitized;
  }
  return output;
}

function byteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeBridgeEnvelope(body: Record<string, unknown>, organizationId: string, missionId: string) {
  if (body.protocolVersion !== "mira-bridge.v1") throw new Error("Unsupported MIRA bridge protocol version.");
  if (body.missionId !== missionId) throw new Error("MIRA bridge mission does not match the claimed mission.");
  if (body.organizationId !== organizationId) throw new Error("MIRA bridge organization is not allow-listed.");
  if (!UUID_PATTERN.test(missionId) || !UUID_PATTERN.test(organizationId)) throw new Error("MIRA bridge identifiers are invalid.");

  const terminalStatus = boundedText(body.terminalStatus, 32);
  if (!terminalStatus || !TERMINAL_STATUSES.has(terminalStatus)) throw new Error("MIRA bridge terminal status is invalid.");

  const result = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result as Record<string, unknown> : null;
  const debrief = body.debrief && typeof body.debrief === "object" && !Array.isArray(body.debrief) ? body.debrief as Record<string, unknown> : null;
  const guarantees = body.guarantees && typeof body.guarantees === "object" && !Array.isArray(body.guarantees) ? body.guarantees as Record<string, unknown> : null;
  if (!result || !debrief || !guarantees) throw new Error("MIRA bridge result, debrief, and guarantees are required.");

  for (const key of ["catalogWrite", "apply", "authorityExpansion", "credentialsIncluded"]) {
    if (guarantees[key] !== false) throw new Error("MIRA bridge guarantees must keep Catalog write, Apply, authority expansion, and credentials disabled.");
  }

  const candidateCount = boundedInteger(result.candidateCount);
  const knowledgeGapCount = boundedInteger(result.knowledgeGapCount);
  if (candidateCount === null || knowledgeGapCount === null) throw new Error("MIRA bridge result counts are invalid.");
  const outcome = boundedText(result.outcome, 120);
  if (!outcome) throw new Error("MIRA bridge result outcome is required.");
  if (result.negativeReasons !== undefined && !Array.isArray(result.negativeReasons)) {
    throw new Error("MIRA bridge negativeReasons must be an array when provided.");
  }
  const negativeReasons = Array.isArray(result.negativeReasons)
    ? result.negativeReasons.slice(0, 20).map((reason) => boundedText(reason, 500)).filter((reason): reason is string => Boolean(reason))
    : [];
  const summary = boundedText(result.summary, 4000);
  const contractVersion = boundedText(debrief.contractVersion, 64);
  const debriefFingerprint = boundedText(debrief.debriefFingerprint, 256);
  if (!contractVersion || !debriefFingerprint) throw new Error("MIRA debrief contract version and fingerprint are required.");

  const normalizedDebrief = {
    contractVersion,
    debriefFingerprint,
    payload: sanitizeDebriefValue(debrief.payload ?? {}),
  };
  if (byteLength(normalizedDebrief) > MAX_DEBRIEF_BYTES) throw new Error("MIRA debrief payload is too large.");

  const normalizedResult = {
    protocolVersion: "mira-bridge.v1",
    outcome,
    candidateCount,
    knowledgeGapCount,
    negativeReasons,
    summary,
    debrief: normalizedDebrief,
    guarantees: {
      catalogWrite: false,
      apply: false,
      authorityExpansion: false,
      credentialsIncluded: false,
    },
  };

  return { terminalStatus, normalizedResult };
}

function bridgeRequestError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
  return json({ error: error instanceof Error ? error.message : "MIRA bridge request failed." }, status);
}

/** Preserve upstream status for the worker's transient-outage retry policy. */
async function getBridgeJson<T>(url: string, init: RequestInit & { timeoutMs?: number }) {
  const { timeoutMs, signal, ...requestInit } = init;
  const controller = timeoutMs && !signal ? new AbortController() : null;
  const timer = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { ...requestInit, signal: signal || controller?.signal });
    const text = await response.text().catch(() => "");
    let data: unknown = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok) {
      const message = data && typeof data === "object" && !Array.isArray(data)
        ? String((data as Record<string, unknown>).message || (data as Record<string, unknown>).error || text || `Request failed: ${response.status}`)
        : text || `Request failed: ${response.status}`;
      throw Object.assign(new Error(message.slice(0, 500)), { status: response.status });
    }
    return data as T;
  } catch (error) {
    if ((error instanceof DOMException && error.name === "AbortError") || String(error || "").toLowerCase().includes("aborted")) {
      throw Object.assign(new Error(`Bridge request timed out after ${timeoutMs || 0}ms`), { status: 504 });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTransientSupabaseError(error: unknown) {
  return /PGRST002|schema cache|could not query the database|request timed out/i.test(String(error instanceof Error ? error.message : error));
}

async function authorizeBridge(req: Request, bodyText: string) {
  const config = bridgeConfig();
  const verification = await verifyMiraBridgeRequest(req, bodyText, config.secret);
  if (!verification.ok) return { error: json({ error: verification.error }, 401) } as const;
  return { config, bridgeId: verification.bridgeId } as const;
}

async function claimBridgeMission(req: Request) {
  const auth = await authorizeBridge(req, "");
  if ("error" in auth) return auth.error;
  const missionId = new URL(req.url).searchParams.get("missionId")?.trim() || "";
  if (!UUID_PATTERN.test(missionId)) {
    return json({ error: "MIRA bridge claim requires an exact missionId UUID." }, 400);
  }
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "MIRA bridge server configuration is incomplete." }, 503);
  const rpcUrl = new URL("/rest/v1/rpc/claim_mira_mission_bridge_by_id", supabaseUrl).toString();
  const claimed = await sendJson<BridgeMission[]>(rpcUrl, {
    method: "POST",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify({
      input_organization_id: auth.config.organizationId,
      input_bridge_client: auth.bridgeId,
      input_mission_id: missionId,
    }),
    timeoutMs: 12000,
  });
  if (claimed[0]) return json({ ok: true, mission: claimed[0] });

  const existing = await loadBridgeMission(supabaseUrl, serviceRoleKey, auth.config.organizationId, missionId);
  if (!existing) return json({ error: "MIRA mission was not found for the bridge organization." }, 404);
  return json({ error: `MIRA mission cannot be claimed from status=${existing.status}.` }, 409);
}

/**
 * Run one bounded planner cycle before the worker peeks at the queue. The
 * database function is the tenant-scoped authority and creates at most one
 * review-only mission; this endpoint never writes Catalog products.
 */
async function planBridgeMission(req: Request) {
  const auth = await authorizeBridge(req, "");
  if ("error" in auth) return auth.error;
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "MIRA bridge server configuration is incomplete." }, 503);
  try {
    const planner = await planMiraMissions({
      supabaseUrl,
      serviceRoleKey,
      organizationId: auth.config.organizationId,
      actorId: null,
    });
    return json({ ok: true, planner });
  } catch (error) {
    // A schema-cache/database outage must not turn the scheduled worker into
    // a false application failure. No mission is invented or written here.
    if (isTransientSupabaseError(error)) {
      return json({ ok: true, planner: {
        status: "deferred",
        createdMissionCount: 0,
        reason: "Supabase is temporarily unavailable; planner will retry on the next cycle.",
        retryable: true,
        catalogWrite: false,
        apply: false,
      } });
    }
    throw error;
  }
}

/**
 * Read-only queue peek for the autonomous worker. It deliberately does not
 * claim or mutate a row; the worker must use the exact-ID claim immediately
 * afterwards, which remains the single atomic ownership transition.
 */
async function nextBridgeMission(req: Request) {
  const auth = await authorizeBridge(req, "");
  if ("error" in auth) return auth.error;
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "MIRA bridge server configuration is incomplete." }, 503);
  const url = buildRestUrl(supabaseUrl, "mira_missions", {
    select: "id,organization_id,objective,mission_area,max_pages,delay_ms,status,created_at,started_at,bridge_client,origin,planner_key,planner_score,planner_reason,planner_context,target_brand,requested_fields,max_items",
    organization_id: `eq.${auth.config.organizationId}`,
    status: "eq.queued",
    order: "created_at.asc",
    limit: "1",
  });
  const missions = await getBridgeJson<BridgeMission[]>(url, { headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 12000 });
  return json({ ok: true, mission: missions[0] ?? null });
}

async function getBridgeKnowledgeSnapshot(req: Request) {
  const auth = await authorizeBridge(req, "");
  if ("error" in auth) return auth.error;
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "MIRA bridge server configuration is incomplete." }, 503);
  const snapshot = await buildMiraKnowledgeSnapshot({
    supabaseUrl,
    serviceRoleKey,
    organizationId: auth.config.organizationId,
  });
  return json({ ok: true, snapshot }, 200, {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

/**
 * Requeue a mission that this bridge worker claimed but could not execute.
 * The transition is deliberately exact-ID and bridge-bound.  It never touches
 * Catalog data; it only releases a queue lease so a later worker cycle can
 * retry the same mission safely.
 */
async function releaseBridgeMission(req: Request) {
  const auth = await authorizeBridge(req, "");
  if ("error" in auth) return auth.error;
  const missionId = new URL(req.url).searchParams.get("missionId")?.trim() || "";
  if (!UUID_PATTERN.test(missionId)) {
    return json({ error: "MIRA bridge release requires an exact missionId UUID." }, 400);
  }
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "MIRA bridge server configuration is incomplete." }, 503);

  const current = await loadBridgeMission(supabaseUrl, serviceRoleKey, auth.config.organizationId, missionId);
  if (!current) return json({ error: "MIRA mission was not found for the bridge organization." }, 404);
  if (current.status === "queued") return json({ ok: true, requeued: false, idempotent: true, mission: current });
  if (current.status !== "processing") {
    return json({ error: `MIRA mission cannot be released from status=${current.status}.` }, 409);
  }
  if (current.bridge_client !== auth.bridgeId) {
    return json({ error: "MIRA mission is leased by a different bridge worker." }, 409);
  }

  const updateUrl = buildRestUrl(supabaseUrl, "mira_missions", {
    id: `eq.${missionId}`,
    organization_id: `eq.${auth.config.organizationId}`,
    status: "eq.processing",
    bridge_client: `eq.${auth.bridgeId}`,
  });
  const updated = await sendJson<BridgeMission[]>(updateUrl, {
    method: "PATCH",
    headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify({
      status: "queued",
      started_at: null,
      bridge_client: null,
    }),
    timeoutMs: 12000,
  });
  if (updated.length === 0) {
    const afterRace = await loadBridgeMission(supabaseUrl, serviceRoleKey, auth.config.organizationId, missionId);
    if (afterRace?.status === "queued") return json({ ok: true, requeued: false, idempotent: true, mission: afterRace });
    return json({ error: "MIRA mission was changed by another worker before release." }, 409);
  }
  return json({ ok: true, requeued: true, idempotent: false, mission: updated[0] ?? null });
}

async function loadBridgeMission(supabaseUrl: string, serviceRoleKey: string, organizationId: string, missionId: string) {
  const url = buildRestUrl(supabaseUrl, "mira_missions", {
    select: "id,organization_id,status,bridge_client,bridge_event_id,result",
    id: `eq.${missionId}`,
    organization_id: `eq.${organizationId}`,
    limit: "1",
  });
  const missions = await getJson<BridgeMission[]>(url, { headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 12000 });
  return missions[0] ?? null;
}

async function acceptBridgeResult(req: Request) {
  const bodyText = await req.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BRIDGE_BODY_BYTES) return json({ error: "MIRA bridge body is too large." }, 413);
  const auth = await authorizeBridge(req, bodyText);
  if ("error" in auth) return auth.error;
  const idempotencyKey = req.headers.get("x-mira-idempotency")?.trim() || "";
  if (!/^([A-Za-z0-9._:-]){1,200}$/.test(idempotencyKey)) return json({ error: "MIRA bridge idempotency key is missing or invalid." }, 400);

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return json({ error: "MIRA bridge body is not valid JSON." }, 400);
  }

  const missionId = typeof body.missionId === "string" ? body.missionId : "";
  const envelope = normalizeBridgeEnvelope(body, auth.config.organizationId, missionId);
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "MIRA bridge server configuration is incomplete." }, 503);

  const current = await loadBridgeMission(supabaseUrl, serviceRoleKey, auth.config.organizationId, missionId);
  if (!current) return json({ error: "MIRA mission was not found for the bridge organization." }, 404);
  if (current.bridge_event_id === idempotencyKey) return json({ ok: true, idempotent: true, mission: current });
  if (TERMINAL_STATUSES.has(current.status)) return json({ error: "MIRA mission already has a different terminal result." }, 409);
  if (current.status !== "processing") return json({ error: "MIRA mission must be claimed before a bridge result is accepted." }, 409);
  if (current.bridge_client !== auth.bridgeId) return json({ error: "MIRA mission is leased by a different bridge worker." }, 409);

  let terminalStatus = envelope.terminalStatus;
  let normalizedResult: Record<string, unknown> = envelope.normalizedResult;
  const resultBody = body.result && typeof body.result === "object" && !Array.isArray(body.result)
    ? body.result as Record<string, unknown>
    : null;
  const rawObservationIntake = body.observationIntake ?? resultBody?.observationIntake;
  if (rawObservationIntake === undefined) {
    normalizedResult = {
      ...normalizedResult,
      observationIntake: {
        protocolVersion: "mira-observation-intake.v1",
        status: "skipped",
        code: envelope.normalizedResult.candidateCount > 0 ? "NO_TYPED_OBSERVATIONS" : "NO_CANDIDATES",
        reason: envelope.normalizedResult.candidateCount > 0
          ? "Bridge result contained no typed observation batch; no Catalog staging was attempted."
          : "Mission returned no candidates; no Catalog staging was necessary.",
        catalogProductsWritten: 0,
        applyPerformed: false,
      },
    };
  } else {
    try {
      const resultIntake = normalizeMiraObservationResultIntake(rawObservationIntake);
      const expectedCandidateCount = envelope.normalizedResult.candidateCount;
      const intakeCandidateCount = resultIntake.candidateCount ?? expectedCandidateCount;
      const skippedCount = resultIntake.skippedCount ?? 0;
      if (intakeCandidateCount !== expectedCandidateCount
        || resultIntake.observations.length + skippedCount !== expectedCandidateCount) {
        throw new MiraObservationIntakeError("CANDIDATE_COUNT_MISMATCH", "MIRA result candidateCount must equal staged observations plus explicit skipped candidates");
      }
      if (resultIntake.observations.length === 0) {
        normalizedResult = {
          ...normalizedResult,
          observationIntake: {
            protocolVersion: "mira-observation-intake.v1",
            status: "skipped",
            code: "ALL_CANDIDATES_SKIPPED",
            reason: "No candidate contained a complete product identity and HTTPS evidence pair; no Catalog staging was attempted.",
            candidateCount: expectedCandidateCount,
            stagedCount: 0,
            skippedCount,
            skipReasons: resultIntake.skipReasons,
            catalogProductsWritten: 0,
            applyPerformed: false,
          },
        };
      } else {
        let intake;
        const preflightQuarantineReason = quarantineReasonForResultIntake(resultIntake);
        if (preflightQuarantineReason) {
          intake = await stageMiraDiscoveryQuarantine({
            supabaseUrl,
            serviceRoleKey,
            organizationId: auth.config.organizationId,
            missionId,
            resultIntake,
            reason: preflightQuarantineReason,
          });
        } else {
          try {
            intake = await stageMiraObservationResult({
              supabaseUrl,
              serviceRoleKey,
              organizationId: auth.config.organizationId,
              missionId,
              resultIntake,
            });
            if (intake.status !== "staged") {
              const blockedIntake = intake;
              const quarantine = await stageMiraDiscoveryQuarantine({
                supabaseUrl,
                serviceRoleKey,
                organizationId: auth.config.organizationId,
                missionId,
                resultIntake,
                reason: "CANONICAL_STAGING_BLOCKED",
              });
              intake = {
                ...quarantine,
                canonicalStagingStatus: blockedIntake.intakeStatus,
                canonicalStagingReason: blockedIntake.reason || "Canonical observation staging was blocked.",
              };
            }
          } catch (error) {
            if (!isMiraQuarantineEligibleError(error)) throw error;
            const quarantineReason = error instanceof MiraObservationIntakeError
              ? error.code
              : "CANONICAL_STAGING_BLOCKED";
            intake = await stageMiraDiscoveryQuarantine({
              supabaseUrl,
              serviceRoleKey,
              organizationId: auth.config.organizationId,
              missionId,
              resultIntake,
              reason: quarantineReason,
            });
          }
        }
        normalizedResult = { ...normalizedResult, observationIntake: {
          ...intake,
          candidateCount: expectedCandidateCount,
          stagedCount: intake.status === "staged" ? resultIntake.observations.length : 0,
          quarantinedCount: intake.status === "quarantined" ? intake.quarantinedCount : 0,
          skippedCount,
          skipReasons: resultIntake.skipReasons,
        } };
        if (intake.status !== "staged" && terminalStatus === "completed") terminalStatus = "partial";
      }
    } catch (error) {
      const code = error instanceof MiraObservationIntakeError ? error.code : "OBSERVATION_INTAKE_FAILED";
      normalizedResult = {
        ...normalizedResult,
        observationIntake: {
          protocolVersion: "mira-observation-intake.v1",
          status: "blocked",
          code,
          reason: error instanceof Error ? error.message.slice(0, 500) : "MIRA observation intake failed server-side validation.",
          catalogProductsWritten: 0,
          applyPerformed: false,
        },
      };
      if (terminalStatus === "completed") terminalStatus = "partial";
    }
  }

  const updateUrl = buildRestUrl(supabaseUrl, "mira_missions", {
    id: `eq.${missionId}`,
    organization_id: `eq.${auth.config.organizationId}`,
    status: "eq.processing",
  });
  const updated = await sendJson<BridgeMission[]>(updateUrl, {
    method: "PATCH",
    headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify({
      status: terminalStatus,
      result: normalizedResult,
      bridge_event_id: idempotencyKey,
      bridge_protocol_version: "mira-bridge.v1",
      bridge_received_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }),
    timeoutMs: 12000,
  });
  if (updated.length === 0) {
    const afterRace = await loadBridgeMission(supabaseUrl, serviceRoleKey, auth.config.organizationId, missionId);
    if (afterRace?.bridge_event_id === idempotencyKey) return json({ ok: true, idempotent: true, mission: afterRace });
    return json({ error: "MIRA mission was completed by another bridge result." }, 409);
  }
  return json({ ok: true, idempotent: false, mission: updated[0] ?? null });
}

function isBridgeRoute(req: Request) {
  const bridge = new URL(req.url).searchParams.get("bridge");
  return bridge === "claim" || bridge === "plan" || bridge === "next" || bridge === "knowledge" || bridge === "release" || bridge === "result" ? bridge : null;
}

export default async (req: Request, _context: Context) => {
  const bridgeRoute = isBridgeRoute(req);
  try {
    if (bridgeRoute === "claim") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return await claimBridgeMission(req);
    }
    if (bridgeRoute === "plan") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await planBridgeMission(req);
    }
    if (bridgeRoute === "next") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return await nextBridgeMission(req);
    }
    if (bridgeRoute === "knowledge") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return await getBridgeKnowledgeSnapshot(req);
    }
    if (bridgeRoute === "release") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await releaseBridgeMission(req);
    }
    if (bridgeRoute === "result") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await acceptBridgeResult(req);
    }
    if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);
    if (req.method === "GET") return listMissions(caller);

    if (new URL(req.url).searchParams.get("planner") === "run") {
      const planner = await planMiraMissions({
        supabaseUrl: caller.supabaseUrl,
        serviceRoleKey: caller.serviceRoleKey,
        organizationId: caller.profile.organization_id,
        actorId: caller.profile.id,
      });
      return json({ ok: true, online: true, planner });
    }

    const body = await readJson<MissionInput>(req);
    const input = parseMissionInput(body);
    const insertUrl = buildRestUrl(caller.supabaseUrl, "mira_missions", { select: "*" });
    const created = await sendJson<unknown[]>(insertUrl, {
      method: "POST",
      headers: { ...serviceRoleHeaders(caller.serviceRoleKey), Prefer: "return=representation" },
      body: JSON.stringify({
        organization_id: caller.profile.organization_id,
        created_by: caller.profile.id,
        objective: input.objective,
        mission_area: input.missionArea,
        max_pages: input.maxPages,
        delay_ms: input.delayMs,
        status: "queued",
        execution_mode: "review_only",
        target_brand: input.targetBrand || null,
        requested_fields: input.requestedFields,
        max_items: input.maxItems,
        planner_context: {
          sourceKey: input.sourceKey,
          requestedFields: input.requestedFields,
          packageSize: input.maxItems,
          controlPlane: "mira-desk.v2",
        },
      }),
      timeoutMs: 12000,
    });
    return json({ ok: true, online: true, executionMode: "review_only", mission: created[0] ?? null });
  } catch (error) {
    if (bridgeRoute) return bridgeRequestError(error);
    return json({ error: sanitizeUserFacingError(error, "MIRA online mission request failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/mira-missions",
};
