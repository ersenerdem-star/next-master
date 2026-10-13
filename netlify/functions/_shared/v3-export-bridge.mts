// V3-only server bridge for the C3 immutable snapshot/export path.
// Feature-flagged by NM_V3_EXPORT_BRIDGE=1; never selected by production defaults.
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createJobPriceSnapshotReader } from "../../../apps/engine/supplier-price-shadow/src/export/job-price-snapshot-reader.mjs";
import { createExportArtifactStore } from "../../../apps/engine/supplier-price-shadow/src/export/shared-export-artifact.mjs";
import { exportBinding, preparePriceExport, assemblePriceExport } from "../../../apps/engine/supplier-price-shadow/src/export/partitioned-price-export.mjs";
import { createDuckDbPagedExportSource, materializeSealedSnapshotWithDuckDB } from "../../../apps/engine/supplier-price-shadow/src/export/duckdb-export-source.mjs";
import { resolvePortalPriceListExportContextFromDb } from "./v3-export-pricing-context.mts";
import { createThrottledExportProgress } from "./v3-export-progress.mts";
import { canAccessOperationsModules } from "./roles.mts";
import { getJson, serviceRoleHeaders } from "./http.mts";
import { V3_REF, PROD_REF, targetConfig, assertV3ExportAllowed, required } from "./v3-export-dispatch.mts";

const POOL_HOSTS = new Set([
  "aws-0-eu-west-1.pooler.supabase.com",
  "db.kaxsqafdevabkxofwdod.supabase.co",
  "db.zjgueqijumzlfioihnkt.supabase.co",
]);
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// Keep the snapshot/export page count bounded for million-row releases while
// staying within the database function's 5,000-row limit.
const EXPORT_PAGE_SIZE = 5000;
const WORKER_LEASE_SECONDS = 120;
// Leave time for one slow DB page, the lease handoff and Netlify shutdown.
// A fresh million-row snapshot is resumed by another signed background call.
const SNAPSHOT_SEGMENT_MAX_MS = 7 * 60 * 1000;

function assertTargetConnection(value: string, target: { targetError: string }) {
  const url = new URL(value);
  const expectedRef = target.targetError === "EXACT_V3_REQUIRED" ? V3_REF : PROD_REF;
  const user = decodeURIComponent(url.username);
  const userMatches = url.hostname === "aws-0-eu-west-1.pooler.supabase.com"
    ? user === `postgres.${expectedRef}` : user === "postgres";
  if (url.protocol !== "postgresql:" || !POOL_HOSTS.has(url.hostname)
    || !["5432", "6543"].includes(url.port) || url.pathname !== "/postgres" || url.hash || !userMatches) {
    throw new Error(target.targetError === "EXACT_V3_REQUIRED"
      ? "V3_EXPORT_DATABASE_TARGET_REQUIRED" : "PRODUCTION_EXPORT_DATABASE_TARGET_REQUIRED");
  }
  return value;
}

function stripConnectionStringTlsOptions(value: string) {
  // pg merges options parsed from connectionString after the explicit pool
  // options.  A hosted URL containing sslmode=require/verify-ca can therefore
  // replace the CA object we pass below and produce SELF_SIGNED_CERT_IN_CHAIN.
  // Keep all non-TLS query options, but make TLS policy exclusively code-owned.
  const url = new URL(value);
  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat", "sslnegotiation"]) {
    url.searchParams.delete(name);
  }
  return url.toString();
}

function postgresSsl(target: { ref: string }) {
  const configuredCa = Netlify.env.get(target.ref === V3_REF ? "V3_POSTGRES_SSL_CA" : "POSTGRES_SSL_CA") || "";
  // Netlify UI/API values may arrive as real PEM line breaks, JSON-quoted PEM,
  // repeated escaped `\\n` sequences, or one-line PEM. Normalize all forms
  // without weakening TLS checks.
  let ca = configuredCa.trim();
  if (ca.startsWith('"') && ca.endsWith('"')) {
    try { ca = JSON.parse(ca); } catch { /* continue with raw value */ }
  }
  ca = ca.replace(/\\+r?\\n/g, "\n").replace(/\\r/g, "\r").trim();
  if (ca.includes("-----BEGIN CERTIFICATE-----") && ca.includes("-----END CERTIFICATE-----")) {
    const begin = "-----BEGIN CERTIFICATE-----";
    const end = "-----END CERTIFICATE-----";
    const body = ca.slice(ca.indexOf(begin) + begin.length, ca.indexOf(end)).replace(/\s+/g, "");
    ca = `${begin}\n${body.match(/.{1,64}/g)?.join("\n") || ""}\n${end}\n`;
  }
  if (ca) return { ca, rejectUnauthorized: true };
  // Self-signed TLS is permitted only for the isolated V3 test target.
  if (target.ref === V3_REF && Netlify.env.get("V3_POSTGRES_SSL_ALLOW_SELF_SIGNED") === "1") {
    return { rejectUnauthorized: false };
  }
  throw new Error(target.ref === V3_REF ? "V3_EXPORT_POSTGRES_CA_REQUIRED" : "PRODUCTION_EXPORT_POSTGRES_CA_REQUIRED");
}

async function fetchJob(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  const rows = await getJson<any[]>(`${supabaseUrl}/rest/v1/app_export_jobs?select=*&id=eq.${encodeURIComponent(jobId)}&limit=1`, {
    headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 10000,
  });
  return rows[0] || null;
}

function patchRetryable(status: number, body: string) {
  // Postgres cancellation/lock errors are deterministic and retrying them
  // only multiplies contention. Retry only transient gateway/service errors.
  if (![502, 503, 504].includes(status)) return false;
  return !/(57014|55P03|statement timeout|lock timeout|canceling statement)/i.test(body);
}

async function patchJob(
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
  patch: Record<string, unknown>,
  options: { leaseOwner?: string; renewLease?: boolean } = {},
) {
  let lastStatus = 500;
  let lastBody = "";
  const query = `${supabaseUrl}/rest/v1/app_export_jobs?id=eq.${encodeURIComponent(jobId)}${options.leaseOwner ? `&worker_lease_owner=eq.${encodeURIComponent(options.leaseOwner)}&worker_lease_expires_at=gt.${encodeURIComponent(new Date().toISOString())}` : ""}&select=*`;
  const bodyPatch = { ...patch };
  if (options.leaseOwner && options.renewLease !== false) {
    bodyPatch.worker_lease_expires_at = new Date(Date.now() + WORKER_LEASE_SECONDS * 1000).toISOString();
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(query, {
      method: "PATCH", headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=representation", "Content-Type": "application/json" },
      body: JSON.stringify(bodyPatch),
    });
    if (response.ok) {
      const rows = await response.json() as any[];
      if (options.leaseOwner && !rows[0]) throw new Error("V3_EXPORT_LEASE_LOST");
      return rows[0] || null;
    }
    lastStatus = response.status;
    lastBody = (await response.text().catch(() => "")).slice(0, 400);
    if (!patchRetryable(response.status, lastBody) || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error(`V3_EXPORT_JOB_PATCH_${lastStatus}${lastBody ? `: ${lastBody}` : ""}`);
}

async function claimJob(pool: Pool, jobId: string, leaseOwner: string) {
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("begin");
    begun = true;
    await client.query("set local lock_timeout='2s'");
    const lock = (await client.query(
      "select pg_try_advisory_xact_lock(hashtextextended('v3-export-job:' || $1, 0)) as locked",
      [jobId],
    )).rows[0]?.locked;
    if (!lock) {
      await client.query("rollback");
      begun = false;
      return false;
    }
    const claimed = (await client.query(
      `update public.app_export_jobs
       set status='running', started_at=coalesce(started_at, clock_timestamp()),
           worker_lease_owner=$2,
           worker_lease_expires_at=clock_timestamp() + interval '120 seconds'
       where id=$1 and status in ('queued','running')
         and (worker_lease_expires_at is null or worker_lease_expires_at <= clock_timestamp() or worker_lease_owner=$2)
       returning id`,
      [jobId, leaseOwner],
    )).rowCount === 1;
    await client.query("commit");
    begun = false;
    return claimed;
  } catch (error) {
    if (begun) await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runV3PriceExportJob(jobId: string) {
  const target = targetConfig();
  if (!target) throw new Error("EXPORT_BRIDGE_DISABLED");
  assertV3ExportAllowed();
  const supabaseUrl = required("SUPABASE_URL");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const connectionString = stripConnectionStringTlsOptions(
    assertTargetConnection(required("POSTGRES_URL"), target),
  );
  const job = await fetchJob(supabaseUrl, serviceRoleKey, jobId);
  if (!job || !["queued", "running"].includes(String(job.status))) return { status: "ignored", reason: "job-not-queued" };
  if (!((job.audience === "admin" && job.export_type === "admin_price_list") || (job.audience === "portal" && job.export_type === "portal_price_list"))) {
    throw new Error("V3_EXPORT_TYPE_UNSUPPORTED");
  }
  const pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, ssl: postgresSsl(target) });
  const leaseOwner = randomUUID();
  let duckdbExportDirectory: string | null = null;
  let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let leaseHeartbeatInFlight: Promise<void> | null = null;
  let leaseHeartbeatError: Error | null = null;
  try {
    if (!await claimJob(pool, job.id, leaseOwner)) return { status: "in-progress", jobId: job.id };
    await patchJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "running", started_at: job.started_at || new Date().toISOString(),
      progress_message: Number(job.progress_done || 0) > 0 ? "V3 snapshot worker resumed." : "V3 snapshot worker is preparing rows.",
      error_message: null,
    }, { leaseOwner });
    const snapshotDeadline = Date.now() + SNAPSHOT_SEGMENT_MAX_MS;
    const reader = createJobPriceSnapshotReader({
      pool, mode: "hosted-v3", pageSize: EXPORT_PAGE_SIZE,
      shouldYieldSnapshot: () => Date.now() >= snapshotDeadline,
      // Hold the job row lock through each page insert (and seal). A worker
      // whose lease was replaced cannot write another page after a retry.
      assertWriteLease: async (client: any, writerJobId: string) => {
        const lease = (await client.query(
          `select worker_lease_owner, worker_lease_expires_at > clock_timestamp() as live
           from public.app_export_jobs where id=$1 and status='running' for update`,
          [writerJobId],
        )).rows[0];
        if (!lease || lease.worker_lease_owner !== leaseOwner || !lease.live) throw new Error("V3_EXPORT_LEASE_LOST");
      },
      operationsAllowed: (role: string, department: string, permissions: Record<string, boolean>) => canAccessOperationsModules(role, department, permissions),
      resolvePortalContext: resolvePortalPriceListExportContextFromDb,
      checkpoint: async ({ processed, total }: any) => {
        await patchJob(supabaseUrl, serviceRoleKey, job.id, {
          progress_done: processed, progress_total: total, row_count: processed,
          progress_message: `V3 snapshot prepared ${processed.toLocaleString("en-US")}${total ? ` / ${total.toLocaleString("en-US")}` : ""} rows.`,
        }, { leaseOwner });
      },
      onPageTiming: ({ processed, total, pageRows, pricingRpcMs, replacementLookupMs, snapshotInsertMs,
        transactionMs, checkpointMs, pageMs, checkpointOk }: any) => {
        // One bounded record per committed 5,000-row page. IDs/counts/timing
        // only: never log customer scope, pricing parameters or row payloads.
        console.info("V3_EXPORT_SNAPSHOT_PAGE_TIMING", JSON.stringify({
          jobId: job.id, workerRunId: leaseOwner, processed, total, pageRows,
          pricingRpcMs: Math.round(pricingRpcMs),
          replacementLookupMs: Math.round(replacementLookupMs),
          snapshotInsertMs: Math.round(snapshotInsertMs),
          transactionMs: Math.round(transactionMs),
          checkpointMs: Math.round(checkpointMs),
          pageMs: Math.round(pageMs), checkpointOk,
        }));
      },
    });
    const spec = await reader.resolveAuthorizedInput(job.id);
    if (spec.status === "building" || Date.now() >= snapshotDeadline) {
      // The snapshot rows are already committed. Release ownership before
      // dispatching the next invocation. Also yield if the final page was
      // sealed near the deadline, so XLSX assembly gets a fresh time window.
      const rows = spec.status === "building" ? spec.processed : spec.expectedRows;
      const total = spec.status === "building" ? spec.total : spec.expectedRows;
      await patchJob(supabaseUrl, serviceRoleKey, job.id, {
        status: "queued", progress_done: rows, progress_total: total, row_count: rows,
        progress_message: `V3 snapshot checkpoint ${rows.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} rows; continuing.`,
        worker_lease_owner: null, worker_lease_expires_at: null,
      }, { leaseOwner, renewLease: false });
      return { status: "continuation", jobId: job.id, snapshotId: spec.snapshotId, rows, total };
    }
    const binding = exportBinding(spec);
    duckdbExportDirectory = await mkdtemp(join("/tmp", "nm-duckdb-export-"));
    // Snapshot materialization can exceed the two-minute job lease without
    // emitting export progress. Renew ownership independently while DuckDB
    // reads and sorts; a competing worker must not publish this artifact.
    leaseHeartbeatTimer = setInterval(() => {
      if (leaseHeartbeatInFlight || leaseHeartbeatError) return;
      leaseHeartbeatInFlight = patchJob(supabaseUrl, serviceRoleKey, job.id, {}, { leaseOwner })
        .then(() => {})
        .catch((error) => {
          if (error instanceof Error && error.message === "V3_EXPORT_LEASE_LOST") leaseHeartbeatError = error;
          else console.warn("V3_EXPORT_LEASE_HEARTBEAT_RETRY", job.id);
        })
        .finally(() => { leaseHeartbeatInFlight = null; });
    }, 30_000);
    const duckdbMaterialized = await materializeSealedSnapshotWithDuckDB({
      pool, snapshotId: spec.snapshotId, binding, expectedRows: spec.expectedRows,
      outputDir: duckdbExportDirectory, tempDirectory: duckdbExportDirectory,
      assertActive: () => { if (leaseHeartbeatError) throw leaseHeartbeatError; },
    });
    if (leaseHeartbeatInFlight) await leaseHeartbeatInFlight;
    if (leaseHeartbeatError) throw leaseHeartbeatError;
    // This fenced write verifies that the same live lease still owns the job
    // after materialization, before any artifact can become downloadable.
    await patchJob(supabaseUrl, serviceRoleKey, job.id, {}, { leaseOwner });
    const duckdbFetchPage = createDuckDbPagedExportSource({
      sortedPath: duckdbMaterialized.sortedPath, binding, expectedRows: spec.expectedRows, pageSize: EXPORT_PAGE_SIZE,
    });
    const artifact = createExportArtifactStore({ supabaseUrl, serviceRoleKey, input: spec,
      expectedSupabaseUrl: target.url, expectedProjectRef: target.ref, targetError: target.targetError });
    const throttledProgress = createThrottledExportProgress({
      expectedRows: spec.expectedRows,
      report: async (event) => {
        await patchJob(supabaseUrl, serviceRoleKey, job.id, {
          progress_done: event.processedRows, progress_total: event.totalRows, row_count: event.processedRows,
          progress_message: `V3 export ${event.stage}: ${Number(event.processedRows).toLocaleString("en-US")} rows.`,
        }, { leaseOwner });
      },
    });
    const localProgress = async (event: any) => {
      try {
        await throttledProgress(event);
      } catch (error) {
        if (error instanceof Error && error.message === "V3_EXPORT_LEASE_LOST") throw error;
        // Telemetry is advisory. The sealed snapshot, local receipt and
        // final fenced update determine whether the export succeeded.
        console.warn("V3_EXPORT_PROGRESS_RETRY", job.id);
      }
    };
    const prepared = await preparePriceExport({ input: spec, directory: duckdbExportDirectory, fetchPage: duckdbFetchPage, progress: localProgress });
    if (!prepared?.manifest || prepared.manifest.rows !== spec.expectedRows) throw new Error("V3_EXPORT_PREPARED_METADATA_INVALID");
    const receipt = await assemblePriceExport({ input: spec, directory: duckdbExportDirectory, progress: localProgress });
    const ready = await artifact.commit({ file: join(duckdbExportDirectory, receipt.file), receipt });
    if (!ready || ready.contentType !== MIME || ready.rows !== spec.expectedRows) throw new Error("V3_EXPORT_RECEIPT_INVALID");
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const brandName = String(job.scope?.brandName || spec.brand);
    const priceListType = String(job.scope?.priceListType || "A");
    const fileName = `portal-price-list-${brandName}-${priceListType}-${stamp}.xlsx`;
    // Stop renewal before clearing ownership in the final fenced update.
    clearInterval(leaseHeartbeatTimer);
    leaseHeartbeatTimer = null;
    if (leaseHeartbeatInFlight) await leaseHeartbeatInFlight;
    if (leaseHeartbeatError) throw leaseHeartbeatError;
    await patchJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "finalized", finalized_at: new Date().toISOString(), file_name: fileName, content_type: MIME,
      storage_bucket: "app-exports", storage_path: ready.path, row_count: ready.rows, byte_size: ready.bytes,
      progress_done: ready.rows, progress_total: ready.rows, progress_message: "V3 export file is ready.", error_message: null,
      worker_lease_owner: null, worker_lease_expires_at: null,
    }, { leaseOwner, renewLease: false });
    return { status: "finalized", jobId: job.id, rows: ready.rows, bytes: ready.bytes, path: ready.path };
  } catch (error) {
    if (leaseHeartbeatTimer) clearInterval(leaseHeartbeatTimer);
    leaseHeartbeatTimer = null;
    if (leaseHeartbeatInFlight) await leaseHeartbeatInFlight;
    await patchJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "failed", failed_at: new Date().toISOString(), error_message: error instanceof Error ? error.message : String(error), progress_message: "V3 export failed.",
      worker_lease_owner: null, worker_lease_expires_at: null,
    }, { leaseOwner, renewLease: false }).catch(() => {});
    throw error;
  } finally {
    if (leaseHeartbeatTimer) clearInterval(leaseHeartbeatTimer);
    if (leaseHeartbeatInFlight) await leaseHeartbeatInFlight;
    if (duckdbExportDirectory) await rm(duckdbExportDirectory, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }
}
