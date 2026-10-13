// V3-only server bridge for the C3 immutable snapshot/export path.
// Feature-flagged by NM_V3_EXPORT_BRIDGE=1; never selected by production defaults.
import { Pool } from "pg";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDurablePriceExportWorkflow, priceExportWorkflowId } from "../../../apps/engine/supplier-price-shadow/src/export/durable-price-export-workflow.mjs";
import { createJobPriceSnapshotReader } from "../../../apps/engine/supplier-price-shadow/src/export/job-price-snapshot-reader.mjs";
import { createExportArtifactStore } from "../../../apps/engine/supplier-price-shadow/src/export/shared-export-artifact.mjs";
import { createExportPartsStore } from "../../../apps/engine/supplier-price-shadow/src/export/shared-export-parts.mjs";
import { exportBinding, preparePriceExport, assemblePriceExport } from "../../../apps/engine/supplier-price-shadow/src/export/partitioned-price-export.mjs";
import { createDuckDbPagedExportSource, materializeSealedSnapshotWithDuckDB } from "../../../apps/engine/supplier-price-shadow/src/export/duckdb-export-source.mjs";
import { resolvePortalPriceListExportContext } from "./portal-orders.mts";
import { canAccessOperationsModules } from "./roles.mts";
import { getJson, serviceRoleHeaders } from "./http.mts";

const V3_REF = "kaxsqafdevabkxofwdod";
const V3_URL = `https://${V3_REF}.supabase.co`;
const PROD_REF = "zjgueqijumzlfioihnkt";
const PROD_URL = `https://${PROD_REF}.supabase.co`;
const TARGETS = {
  v3: { ref: V3_REF, url: V3_URL, flag: "NM_V3_EXPORT_BRIDGE", targetError: "EXACT_V3_REQUIRED" },
  production: { ref: PROD_REF, url: PROD_URL, flag: "NM_PRODUCTION_EXPORT_BRIDGE", targetError: "EXACT_PRODUCTION_REQUIRED" },
} as const;
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
const WORKER_TIMESTAMP_WINDOW_MS = 60_000;

function targetConfig() {
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

function required(name: string) {
  const value = Netlify.env.get(name) || "";
  if (!value.trim()) throw new Error(`V3_EXPORT_${name}_MISSING`);
  return value.trim();
}

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
  const query = `${supabaseUrl}/rest/v1/app_export_jobs?id=eq.${encodeURIComponent(jobId)}${options.leaseOwner ? `&worker_lease_owner=eq.${encodeURIComponent(options.leaseOwner)}` : ""}&select=*`;
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

function inviteFromActor(actor: any) {
  return {
    id: String(actor.id), organization_id: String(actor.organization_id), customer_id: String(actor.customer_id),
    party_type: String(actor.party_type), status: String(actor.status), access_can_view_orders: Boolean(actor.access_can_view_orders),
    allowed_brand_ids: Array.isArray(actor.allowed_brand_ids) ? actor.allowed_brand_ids : [],
    seller_company_profile_id: actor.seller_company_profile_id || null,
    email: "", party_name: "", updated_at: String(actor.updated_at || ""), expires_at: null,
  } as any;
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
  try {
    if (!await claimJob(pool, job.id, leaseOwner)) return { status: "in-progress", jobId: job.id };
    await patchJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "running", started_at: job.started_at || new Date().toISOString(), progress_done: 0,
      progress_total: null, progress_message: "V3 snapshot worker is preparing rows.", error_message: null,
    }, { leaseOwner });
    const reader = createJobPriceSnapshotReader({
      pool, mode: "hosted-v3", pageSize: EXPORT_PAGE_SIZE,
      operationsAllowed: (role: string, department: string, permissions: Record<string, boolean>) => canAccessOperationsModules(role, department, permissions),
      resolvePortalContext: async ({ invite, brandName }: any) => {
        const context = await resolvePortalPriceListExportContext(supabaseUrl, serviceRoleKey, inviteFromActor(invite), brandName);
        return {
          organizationId: context.organizationId, inviteId: context.inviteId, customerId: context.customerId,
          brandId: context.brandId, brandName: context.brandName, priceListType: context.priceListType,
          effectiveMarginA: context.effectiveMarginA, effectiveMarginB: context.effectiveMarginB,
          currency: context.currency, cPriceListIds: context.cPriceListIds,
        };
      },
      checkpoint: async ({ processed, total }: any) => {
        await patchJob(supabaseUrl, serviceRoleKey, job.id, {
          progress_done: processed, progress_total: total, row_count: processed,
          progress_message: `V3 snapshot prepared ${processed.toLocaleString("en-US")}${total ? ` / ${total.toLocaleString("en-US")}` : ""} rows.`,
        }, { leaseOwner });
      },
    });
    const spec = await reader.resolveAuthorizedInput(job.id);
    const binding = exportBinding(spec);
    duckdbExportDirectory = await mkdtemp(join("/tmp", "nm-duckdb-export-"));
    const duckdbMaterialized = await materializeSealedSnapshotWithDuckDB({
      pool, snapshotId: spec.snapshotId, binding, expectedRows: spec.expectedRows,
      outputDir: duckdbExportDirectory, tempDirectory: duckdbExportDirectory,
    });
    const duckdbFetchPage = createDuckDbPagedExportSource({
      sortedPath: duckdbMaterialized.sortedPath, binding, expectedRows: spec.expectedRows, pageSize: EXPORT_PAGE_SIZE,
    });
    const artifact = createExportArtifactStore({ supabaseUrl, serviceRoleKey, input: spec,
      expectedSupabaseUrl: target.url, expectedProjectRef: target.ref, targetError: target.targetError });
    const localProgress = async (event: any) => {
      if (event.processedRows != null) {
        await patchJob(supabaseUrl, serviceRoleKey, job.id, {
          progress_done: event.processedRows, progress_total: event.totalRows ?? spec.expectedRows, row_count: event.processedRows,
          progress_message: `V3 export ${event.stage || "processing"}: ${Number(event.processedRows).toLocaleString("en-US")} rows.`,
        }, { leaseOwner });
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
    await patchJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "finalized", finalized_at: new Date().toISOString(), file_name: fileName, content_type: MIME,
      storage_bucket: "app-exports", storage_path: ready.path, row_count: ready.rows, byte_size: ready.bytes,
      progress_done: ready.rows, progress_total: ready.rows, progress_message: "V3 export file is ready.", error_message: null,
      worker_lease_owner: null, worker_lease_expires_at: null,
    }, { leaseOwner, renewLease: false });
    return { status: "finalized", jobId: job.id, rows: ready.rows, bytes: ready.bytes, path: ready.path };
  } catch (error) {
    await patchJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "failed", failed_at: new Date().toISOString(), error_message: error instanceof Error ? error.message : String(error), progress_message: "V3 export failed.",
      worker_lease_owner: null, worker_lease_expires_at: null,
    }, { leaseOwner, renewLease: false }).catch(() => {});
    throw error;
  } finally {
    if (duckdbExportDirectory) await rm(duckdbExportDirectory, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }
}
