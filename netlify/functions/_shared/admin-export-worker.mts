import { createHmac, timingSafeEqual } from "node:crypto";
import { getJson, serviceRoleHeaders } from "./http.mts";
import type { ExportJobRow } from "./export-jobs.mts";

const TIMESTAMP_WINDOW_MS = 60_000;
const LEASE_MS = 120_000;

function signature(key: string, jobId: string, timestamp: string) {
  return createHmac("sha256", key).update(`admin-export-worker.v1\n${jobId}\n${timestamp}`).digest("hex");
}

function isSignatureEqual(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right)
    && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function requiredServiceRoleKey() {
  const value = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!value.trim()) throw new Error("ADMIN_EXPORT_WORKER_SERVICE_ROLE_KEY_MISSING");
  return value.trim();
}

export async function dispatchAdminExportWorker(req: Request, jobId: string) {
  const key = requiredServiceRoleKey();
  const timestamp = String(Date.now());
  const endpoint = new URL("/api/admin-export-worker-background", req.url);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-export-worker-time": timestamp,
      "x-admin-export-worker-signature": signature(key, jobId, timestamp),
    },
    body: JSON.stringify({ jobId }), redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok && response.status !== 202) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`ADMIN_EXPORT_WORKER_DISPATCH_${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return { accepted: true as const, status: response.status };
}

export function assertAdminExportWorkerRequest(req: Request, jobId: string) {
  const key = requiredServiceRoleKey();
  const timestamp = req.headers.get("x-admin-export-worker-time") || "";
  const supplied = req.headers.get("x-admin-export-worker-signature") || "";
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > TIMESTAMP_WINDOW_MS
    || !isSignatureEqual(supplied, signature(key, jobId, timestamp))) {
    throw new Error("ADMIN_EXPORT_WORKER_UNAUTHORIZED");
  }
}

export async function claimRemainingExportJob(
  supabaseUrl: string,
  serviceRoleKey: string,
  job: Pick<ExportJobRow, "id" | "status" | "updated_at">,
): Promise<ExportJobRow | null> {
  if (!job.id || !job.updated_at || !["queued", "running"].includes(job.status)) return null;
  const updatedAt = Date.parse(job.updated_at);
  if (!Number.isFinite(updatedAt)) return null;
  if (job.status === "running" && Date.now() - updatedAt <= LEASE_MS) return null;
  const url = new URL("/rest/v1/app_export_jobs", supabaseUrl);
  url.searchParams.set("id", `eq.${job.id}`);
  url.searchParams.set("status", `eq.${job.status}`);
  url.searchParams.set("updated_at", `eq.${job.updated_at}`);
  url.searchParams.set("select", "*");
  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=representation", "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "running",
      // started_at is the per-attempt fence token. Every stale retry receives
      // a new value so older workers cannot heartbeat or finalize afterward.
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      progress_message: "Admin export worker claimed the job.",
      error_message: null,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`ADMIN_EXPORT_CLAIM_${response.status}`);
  const rows = await response.json() as ExportJobRow[];
  return rows[0] || null;
}

export async function assertAndTouchExportJobLease(supabaseUrl: string, serviceRoleKey: string, jobId: string, leaseStartedAt: string) {
  const url = new URL("/rest/v1/app_export_jobs", supabaseUrl);
  url.searchParams.set("id", `eq.${jobId}`);
  url.searchParams.set("status", "eq.running");
  url.searchParams.set("started_at", `eq.${leaseStartedAt}`);
  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=representation", "Content-Type": "application/json" },
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`ADMIN_EXPORT_LEASE_TOUCH_${response.status}`);
  const rows = await response.json() as unknown[];
  if (!rows.length) throw new Error("ADMIN_EXPORT_LEASE_LOST");
}

export function startExportJobHeartbeat(supabaseUrl: string, serviceRoleKey: string, jobId: string, leaseStartedAt: string) {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let heartbeatError: Error | null = null;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    const url = new URL("/rest/v1/app_export_jobs", supabaseUrl);
    url.searchParams.set("id", `eq.${jobId}`);
    url.searchParams.set("status", "eq.running");
    url.searchParams.set("started_at", `eq.${leaseStartedAt}`);
    inFlight = fetch(url, {
      method: "PATCH",
      headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=representation", "Content-Type": "application/json" },
      body: JSON.stringify({ updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`ADMIN_EXPORT_HEARTBEAT_${response.status}`);
      const rows = await response.json() as unknown[];
      if (!rows.length) throw new Error("ADMIN_EXPORT_LEASE_LOST");
    }).catch((error) => {
      heartbeatError = error instanceof Error ? error : new Error(String(error));
    }).finally(() => { inFlight = null; });
  }, 30_000);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight) await inFlight;
    if (heartbeatError) throw heartbeatError;
  };
}

export async function fetchAdminExportWorkerJob(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  const url = new URL("/rest/v1/app_export_jobs", supabaseUrl);
  url.searchParams.set("id", `eq.${jobId}`);
  url.searchParams.set("select", "id,organization_id,audience,export_type,status,scope,cache_key,data_version,updated_at");
  url.searchParams.set("limit", "1");
  const rows = await getJson<Array<Record<string, unknown>>>(url.toString(), { headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 10_000 });
  return rows[0] || null;
}
