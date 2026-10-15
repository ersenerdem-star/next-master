// Small recovery scan for price export jobs whose browser or self-dispatch
// handoff stopped before the next background invocation.  The target is
// allow-listed so this cannot turn an arbitrary Netlify deploy into a worker
// for either database.
import { V3_REF } from "./v3-export-dispatch.mts";

export const V3_EXPORT_STAGING_SITE_ID = "6778214b-94e6-4e4a-8a01-99afc80200bd";
export const V3_EXPORT_STAGING_SITE_URL = "https://next-master-v3-staging-20261006.netlify.app";
export const V3_EXPORT_PRODUCTION_SITE_ID = "08d7af8d-484c-4dba-a069-234e52dcfd6c";
export const V3_EXPORT_PRODUCTION_SITE_URL = "https://portal.next-master.com";
export const V3_EXPORT_PRODUCTION_DEPLOY_URL = "https://ersen-quote-desk.netlify.app";
export const V3_EXPORT_PRODUCTION_REF = "zjgueqijumzlfioihnkt";
const V3_EXPORT_STAGING_DB_URL = `https://${V3_REF}.supabase.co`;
const V3_EXPORT_PRODUCTION_DB_URL = `https://${V3_EXPORT_PRODUCTION_REF}.supabase.co`;
const MAX_DISPATCHES_PER_TICK = 2;
const STALE_QUEUED_MS = 30_000;
const STALE_RUNNING_MS = 120_000;

export type RecoveryTarget = {
  siteId?: string;
  siteUrl?: string;
  supabaseUrl?: string;
  bridgeFlag?: string;
};

export type RecoveryJob = {
  id: string;
  audience: string;
  export_type: string;
  status: string;
  updated_at: string | null;
  expires_at: string | null;
  worker_lease_expires_at: string | null;
};

const PRICE_EXPORTS = [
  { audience: "portal", exportType: "portal_price_list" },
  { audience: "admin", exportType: "admin_price_list" },
] as const;

export function isExactV3RecoveryTarget(target: RecoveryTarget) {
  return target.siteId === V3_EXPORT_STAGING_SITE_ID
    && target.siteUrl === V3_EXPORT_STAGING_SITE_URL
    && target.supabaseUrl === V3_EXPORT_STAGING_DB_URL
    && target.bridgeFlag === "1";
}

export function isExactProductionRecoveryTarget(target: RecoveryTarget) {
  return target.siteId === V3_EXPORT_PRODUCTION_SITE_ID
    && (target.siteUrl === V3_EXPORT_PRODUCTION_SITE_URL || target.siteUrl === V3_EXPORT_PRODUCTION_DEPLOY_URL)
    && target.supabaseUrl === V3_EXPORT_PRODUCTION_DB_URL
    && target.bridgeFlag === "1";
}

export function isExactExportRecoveryTarget(target: RecoveryTarget) {
  return isExactV3RecoveryTarget(target) || isExactProductionRecoveryTarget(target);
}

export function recoveryTargetSiteUrl(target: RecoveryTarget) {
  if (isExactV3RecoveryTarget(target)) return V3_EXPORT_STAGING_SITE_URL;
  if (isExactProductionRecoveryTarget(target)) return V3_EXPORT_PRODUCTION_SITE_URL;
  return null;
}

export function recoveryQueryUrls(nowMs: number, databaseUrl = V3_EXPORT_STAGING_DB_URL) {
  const now = new Date(nowMs).toISOString();
  return PRICE_EXPORTS.flatMap(({ audience, exportType }) => ["queued", "running"].map((status) => {
    const url = new URL("/rest/v1/app_export_jobs", databaseUrl);
    url.searchParams.set("select", "id,audience,export_type,status,updated_at,expires_at,worker_lease_expires_at");
    url.searchParams.set("audience", `eq.${audience}`);
    url.searchParams.set("export_type", `eq.${exportType}`);
    url.searchParams.set("status", `eq.${status}`);
    url.searchParams.set("updated_at", `lte.${new Date(nowMs - (status === "queued" ? STALE_QUEUED_MS : STALE_RUNNING_MS)).toISOString()}`);
    url.searchParams.set("expires_at", `gt.${now}`);
    url.searchParams.set("or", `(worker_lease_expires_at.is.null,worker_lease_expires_at.lte.${now})`);
    url.searchParams.set("order", "updated_at.asc");
    url.searchParams.set("limit", String(MAX_DISPATCHES_PER_TICK));
    return url.toString();
  }));
}

function isRecoverable(job: RecoveryJob, nowMs: number) {
  const validType = PRICE_EXPORTS.some(({ audience, exportType }) => job.audience === audience && job.export_type === exportType);
  const updated = Date.parse(job.updated_at || "");
  const expires = Date.parse(job.expires_at || "");
  const leaseExpires = job.worker_lease_expires_at == null ? -Infinity : Date.parse(job.worker_lease_expires_at);
  const staleMs = job.status === "queued" ? STALE_QUEUED_MS : job.status === "running" ? STALE_RUNNING_MS : Infinity;
  return /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(job.id)
    && validType && Number.isFinite(updated) && updated <= nowMs - staleMs
    && Number.isFinite(expires) && expires > nowMs
    && leaseExpires <= nowMs;
}

export function selectRecoverableJobs(rows: RecoveryJob[], nowMs: number) {
  const seen = new Set<string>();
  return rows.filter((job) => isRecoverable(job, nowMs))
    .sort((left, right) => Date.parse(left.updated_at!) - Date.parse(right.updated_at!))
    .filter((job) => !seen.has(job.id) && Boolean(seen.add(job.id)))
    .slice(0, MAX_DISPATCHES_PER_TICK);
}

export async function recoverV3ExportJobs(options: {
  target: RecoveryTarget;
  nowMs: number;
  listJobs: (url: string) => Promise<RecoveryJob[]>;
  dispatchJob: (jobId: string) => Promise<unknown>;
}) {
  const siteUrl = recoveryTargetSiteUrl(options.target);
  if (!siteUrl) return { status: "disabled", scanned: 0, dispatched: 0, failed: 0 };
  const databaseUrl = isExactProductionRecoveryTarget(options.target)
    ? V3_EXPORT_PRODUCTION_DB_URL
    : V3_EXPORT_STAGING_DB_URL;
  const batches = await Promise.all(recoveryQueryUrls(options.nowMs, databaseUrl).map(options.listJobs));
  const jobs = selectRecoverableJobs(batches.flat(), options.nowMs);
  let dispatched = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await options.dispatchJob(job.id);
      dispatched += 1;
    } catch (error) {
      failed += 1;
      console.error("v3 export recovery dispatch failed", job.id, error);
    }
  }
  return { status: "checked", scanned: batches.reduce((count, batch) => count + batch.length, 0), dispatched, failed };
}

// Kept as a named compatibility export for the existing staging tests and
// callers while the same bounded scan is now also used in production.
export const recoverStagingV3ExportJobs = recoverV3ExportJobs;
