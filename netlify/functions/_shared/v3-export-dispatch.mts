// Lightweight target and signed handoff shared by export request functions
// and the background worker. Keep native export runtime imports out of here.
import { createHmac, timingSafeEqual } from "node:crypto";

export const V3_REF = "kaxsqafdevabkxofwdod";
const V3_URL = `https://${V3_REF}.supabase.co`;
export const PROD_REF = "zjgueqijumzlfioihnkt";
const PROD_URL = `https://${PROD_REF}.supabase.co`;
const TARGETS = {
  v3: { ref: V3_REF, url: V3_URL, flag: "NM_V3_EXPORT_BRIDGE", targetError: "EXACT_V3_REQUIRED" },
  production: { ref: PROD_REF, url: PROD_URL, flag: "NM_PRODUCTION_EXPORT_BRIDGE", targetError: "EXACT_PRODUCTION_REQUIRED" },
} as const;
const WORKER_TIMESTAMP_WINDOW_MS = 60_000;

export function targetConfig() {
  const url = Netlify.env.get("SUPABASE_URL");
  for (const target of Object.values(TARGETS)) {
    if (Netlify.env.get(target.flag) === "1" && url === target.url) return target;
  }
  return null;
}

// Production is fail-closed until the staging size gates have passed and the
// bridge is explicitly reopened with NM_PRODUCTION_EXPORT_PAUSED=0.
export function isProductionExportPaused() {
  const target = targetConfig();
  return Boolean(target?.ref === PROD_REF && Netlify.env.get("NM_PRODUCTION_EXPORT_PAUSED") !== "0");
}

export function assertV3ExportAllowed() {
  if (isProductionExportPaused()) throw new Error("V3_EXPORT_PRODUCTION_PAUSED");
}

export function required(name: string) {
  const value = Netlify.env.get(name) || "";
  if (!value.trim()) throw new Error(`V3_EXPORT_${name}_MISSING`);
  return value.trim();
}

export function isV3ExportBridgeEnabled() { return Boolean(targetConfig()); }

function workerSignature(serviceRoleKey: string, jobId: string, timestamp: string) {
  return createHmac("sha256", serviceRoleKey)
    .update(`v3-export-worker.v1\n${jobId}\n${timestamp}`)
    .digest("hex");
}

function signaturesEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Dispatch a long-running export to the Netlify Background Function. The
 * service-role key signs the short-lived handoff; it is never sent in the
 * request body or exposed to the browser.
 */
export async function dispatchV3PriceExportWorker(req: Request, jobId: string) {
  const target = targetConfig();
  if (!target) throw new Error("EXPORT_BRIDGE_DISABLED");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const timestamp = String(Date.now());
  // Netlify's configured function path is the public /api route. Using the
  // internal /.netlify/functions path is intercepted by the SPA fallback on
  // the Drop-deployed staging site, so the worker never receives the handoff.
  const endpoint = new URL("/api/portal-export-worker-background", req.url);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-v3-export-worker-time": timestamp,
      "x-v3-export-worker-signature": workerSignature(serviceRoleKey, jobId, timestamp),
    },
    body: JSON.stringify({ jobId }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok && response.status !== 202) {
    const body = (await response.text().catch(() => "")).slice(0, 240);
    throw new Error(`V3_EXPORT_WORKER_DISPATCH_${response.status}${body ? `: ${body}` : ""}`);
  }
  return { accepted: true, status: response.status };
}

export function assertV3PriceExportWorkerRequest(req: Request, jobId: string) {
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const timestamp = req.headers.get("x-v3-export-worker-time") || "";
  const signature = req.headers.get("x-v3-export-worker-signature") || "";
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > WORKER_TIMESTAMP_WINDOW_MS
    || !signaturesEqual(signature, workerSignature(serviceRoleKey, jobId, timestamp))) {
    throw new Error("V3_EXPORT_WORKER_UNAUTHORIZED");
  }
}
