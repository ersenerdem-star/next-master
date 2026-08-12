import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, getJson, json, readJson, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import { verifyMiraBridgeRequest } from "./_shared/mira-bridge-auth.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

type MissionInput = {
  objective?: unknown;
  missionArea?: unknown;
  maxPages?: unknown;
  delayMs?: unknown;
};

type BridgeMission = {
  id: string;
  organization_id: string;
  status: string;
  bridge_event_id?: string | null;
  result?: unknown;
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

  if (objective.length < 8 || objective.length > 500) {
    throw new Error("Mission objective must be between 8 and 500 characters.");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
    throw new Error("Page budget must be an integer between 1 and 50.");
  }
  if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 10000) {
    throw new Error("Request interval must be between 1000 and 10000 milliseconds.");
  }

  return { objective, missionArea, maxPages, delayMs };
}

async function listMissions(caller: Awaited<ReturnType<typeof requireCallerProfile>>) {
  if ("error" in caller) return json({ error: caller.error }, caller.status);
  const url = buildRestUrl(caller.supabaseUrl, "mira_missions", {
    select: "id,objective,mission_area,max_pages,delay_ms,status,execution_mode,result,error_message,created_at,started_at,finished_at,bridge_client,bridge_event_id,bridge_protocol_version,bridge_received_at",
    organization_id: `eq.${caller.profile.organization_id}`,
    order: "created_at.desc",
    limit: "50",
  });
  const missions = await getJson<unknown[]>(url, { headers: serviceRoleHeaders(caller.serviceRoleKey), timeoutMs: 12000 });
  return json({ ok: true, online: true, missions });
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

async function loadBridgeMission(supabaseUrl: string, serviceRoleKey: string, organizationId: string, missionId: string) {
  const url = buildRestUrl(supabaseUrl, "mira_missions", {
    select: "id,organization_id,status,bridge_event_id,result",
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

  const updateUrl = buildRestUrl(supabaseUrl, "mira_missions", {
    id: `eq.${missionId}`,
    organization_id: `eq.${auth.config.organizationId}`,
    status: "eq.processing",
  });
  const updated = await sendJson<BridgeMission[]>(updateUrl, {
    method: "PATCH",
    headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify({
      status: envelope.terminalStatus,
      result: envelope.normalizedResult,
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
  return bridge === "claim" || bridge === "result" ? bridge : null;
}

export default async (req: Request, _context: Context) => {
  const bridgeRoute = isBridgeRoute(req);
  try {
    if (bridgeRoute === "claim") {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return await claimBridgeMission(req);
    }
    if (bridgeRoute === "result") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return await acceptBridgeResult(req);
    }
    if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);
    if (req.method === "GET") return listMissions(caller);

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
