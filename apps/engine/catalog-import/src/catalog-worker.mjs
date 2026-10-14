import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  createCatalogImportBatches,
  parseCatalogImportRows,
  validateCatalogImportSource,
} from "./catalog-import-adapter.mjs";
import { preflightCatalogCsv } from "./catalog-duckdb.mjs";
import { withCatalogHeavyImportGate } from "./catalog-import-gate.mjs";

const DEFAULT_BUCKET = "catalog-imports";

function storageOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw new Error("CATALOG_STORAGE_ORIGIN_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("CATALOG_STORAGE_ORIGIN_INVALID");
  return parsed.origin;
}

function storageBucket(value) {
  const bucket = String(value || DEFAULT_BUCKET);
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(bucket)) throw new Error("CATALOG_STORAGE_BUCKET_INVALID");
  return bucket;
}

function storageHeaders(serviceRoleKey) {
  const key = String(serviceRoleKey || "").trim();
  if (!key) throw new Error("CATALOG_STORAGE_KEY_REQUIRED");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function responseBody(response) {
  if (!response?.body) throw new Error("CATALOG_SOURCE_BODY_MISSING");
  if (typeof response.body[Symbol.asyncIterator] === "function") return response.body;
  if (typeof response.body.getReader === "function") return Readable.fromWeb(response.body);
  throw new Error("CATALOG_SOURCE_BODY_UNREADABLE");
}

async function writeVerifiedBody(response, outputPath, expectedBytes, expectedSha256, maxBytes) {
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of responseBody(response)) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes || (expectedBytes != null && bytes > expectedBytes)) throw new Error("CATALOG_SOURCE_SIZE_EXCEEDED");
      hash.update(buffer);
      if (!output.write(buffer)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (expectedBytes != null && bytes !== expectedBytes) throw new Error("CATALOG_SOURCE_SIZE_MISMATCH");
  const actualSha256 = hash.digest("hex");
  if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error("CATALOG_SOURCE_CHECKSUM_MISMATCH");
  return { bytes, sha256: actualSha256 };
}

/**
 * Download a private catalog object to a mode-600 temporary file. Parsing starts
 * only after byte count and SHA-256 have been verified, so a bad object cannot
 * leave partially staged rows behind.
 */
export async function downloadAndVerifyCatalogSource({
  supabaseUrl,
  serviceRoleKey,
  bucket = DEFAULT_BUCKET,
  source,
  fetchImpl = fetch,
  maxBytes = 1_073_741_824,
  timeoutMs = 120_000,
}) {
  const metadata = validateCatalogImportSource(source, { requireChecksum: Boolean(source?.sourceSha256 || source?.checksum), maxBytes });
  const origin = storageOrigin(supabaseUrl);
  const safeBucket = storageBucket(bucket);
  const encodedPath = metadata.sourcePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const objectUrl = `${origin}/storage/v1/object/${encodeURIComponent(safeBucket)}/${encodedPath}`;
  const response = await fetchImpl(objectUrl, {
    method: "GET",
    headers: storageHeaders(serviceRoleKey),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response?.ok || !response.body) {
    await response?.body?.cancel?.().catch(() => {});
    throw new Error(`CATALOG_SOURCE_DOWNLOAD_FAILED:${response?.status ?? 0}`);
  }
  const workDir = await mkdtemp(join(tmpdir(), "catalog-import-"));
  const filePath = join(workDir, `source.${metadata.format}`);
  try {
    const verified = await writeVerifiedBody(response, filePath, metadata.sourceBytes, metadata.sourceSha256, maxBytes);
    return { ...metadata, ...verified, filePath, workDir };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

function rpcValue(result, ...keys) {
  const value = Array.isArray(result) ? result[0] : result;
  for (const key of keys) if (value?.[key] != null) return value[key];
  return null;
}

/**
 * Execute one catalog import against injectable RPC calls. The worker owns the
 * source transfer and cursor; the RPC implementation owns DB transactions.
 */
async function runCatalogStorageImportUnlocked({
  supabaseUrl,
  serviceRoleKey,
  bucket = DEFAULT_BUCKET,
  source,
  rpc,
  runId,
  organizationId,
  actorId,
  resumeAfter = -1,
  sourceSha256,
  fallbackBrand = "",
  fallbackMarketSegment = "",
  batchOptions = {},
  lease,
  fetchImpl = fetch,
  maxBytes = 1_073_741_824,
}) {
  if (typeof rpc !== "function") throw new Error("CATALOG_RPC_REQUIRED");
  const sourceMetadata = { ...(typeof source === "string" ? { sourcePath: source } : source), ...(sourceSha256 ? { sourceSha256 } : {}) };
  const pinnedSource = validateCatalogImportSource(sourceMetadata, {
    requireChecksum: Boolean(sourceMetadata.sourceSha256 || sourceMetadata.checksum), maxBytes,
  });
  const sourceBytes = Number(sourceMetadata.sourceBytes || 0);
  const transferTimeoutMs = Math.min(30 * 60 * 1000, Math.max(120_000,
    Math.ceil((sourceBytes > 0 ? sourceBytes / (4 * 1024 * 1024) : 0) * 1000 + 120_000)));
  const activeRunId = String(runId || "").trim();
  if (!activeRunId || !organizationId || !actorId) throw new Error("CATALOG_STORAGE_RUN_CONTEXT_REQUIRED");
  let processedRows = 0;
  // The durable source cursor is zero-based (matching catalog_import_stage),
  // while the parser's source row number is one-based (data row 1 is the first
  // row after the header).
  const durableResumeCursor = Number.isSafeInteger(Number(resumeAfter)) ? Number(resumeAfter) : -1;
  const parserResumeAfter = durableResumeCursor + 1;
  let lastCursor = durableResumeCursor;
  const calls = { batches: 0 };
  const fence = {
    input_worker_id: String(lease?.workerId || "").trim(),
    input_lease_token: String(lease?.leaseToken || "").trim(),
    input_lease_generation: Number(lease?.leaseGeneration),
  };
  if (!fence.input_worker_id || !fence.input_lease_token || !Number.isSafeInteger(fence.input_lease_generation)) {
    throw new Error("CATALOG_STORAGE_LEASE_CONTEXT_REQUIRED");
  }
  const heartbeat = async () => {
    await rpc("heartbeat_catalog_import_storage_source_system", {
      input_source_id: String(lease.sourceId || ""),
      input_organization_id: organizationId,
      input_actor_id: actorId,
      ...fence,
      input_lease_seconds: Number(lease.leaseSeconds || 900),
    });
  };
  let downloaded;
  try {
    const completion = await rpc("get_catalog_import_storage_read_completion_system", {
      input_run_id: activeRunId, input_organization_id: organizationId, input_actor_id: actorId,
      input_source_id: String(lease.sourceId || ""), input_source_sha256: pinnedSource.sourceSha256 || null,
      input_source_bytes: pinnedSource.sourceBytes,
    });
    const proof = Array.isArray(completion) ? completion[0] : completion;
    if (proof?.read_complete === true) {
      const total = Number(proof.total_rows);
      if (proof.run_id !== activeRunId || proof.source_id !== lease.sourceId
          || proof.source_path !== pinnedSource.sourcePath || Number(proof.source_bytes) !== pinnedSource.sourceBytes
          || !/^[0-9a-f]{64}$/.test(proof.source_sha256 || "")
          || (pinnedSource.sourceSha256 && proof.source_sha256 !== pinnedSource.sourceSha256)
          || !Number.isSafeInteger(total) || total < 1 || Number(proof.cursor_row) !== total - 1
          || durableResumeCursor >= total || !["staged", "completed"].includes(proof.source_status)
          || typeof proof.read_completed_at !== "string" || !Number.isFinite(Date.parse(proof.read_completed_at))) {
        throw new Error("CATALOG_SOURCE_READ_RECEIPT_INVALID");
      }
      // Finalization can commit after EOF but before this DBOS step checkpoints.
      // The immutable proof binds the workflow's source identity, path and bytes
      // to the verified SHA. Its object may already have been cleaned up; replay
      // completed ingestion without downloading or touching terminal data.
      return { runId: activeRunId, processedRows: total - Math.max(0, durableResumeCursor + 1),
        cursorEnd: total - 1, sourceSha256: proof.source_sha256, batches: 0,
        preflight: { engine: "durable-read-receipt", totalRows: total }, result: null,
        queued: { queued: true, status: "queued", run_id: activeRunId, source_id: lease.sourceId,
          read_complete_rows: total, read_completed_at: proof.read_completed_at, replayed: true }, replayed: true };
    }
    if (proof?.read_complete !== false) throw new Error("CATALOG_SOURCE_READ_RECEIPT_INVALID");
    downloaded = await downloadAndVerifyCatalogSource({
      supabaseUrl, serviceRoleKey, bucket, source: sourceMetadata, fetchImpl, maxBytes,
      timeoutMs: transferTimeoutMs,
    });
    await rpc("complete_catalog_import_storage_upload_system", {
      input_run_id: activeRunId,
      input_organization_id: organizationId,
      input_actor_id: actorId,
      ...fence,
      input_uploaded_bytes: downloaded.bytes,
      input_checksum_sha256: downloaded.sha256,
    });
    const preflight = await preflightCatalogCsv({ inputPath: downloaded.filePath, tempDirectory: downloaded.workDir });
    const rows = parseCatalogImportRows(Readable.from(createReadStream(downloaded.filePath)), { fallbackBrand, fallbackMarketSegment });
    const batches = createCatalogImportBatches(rows, { ...batchOptions, resumeAfter: parserResumeAfter, sourceSha256: downloaded.sha256 });
    let pending = null;
    for await (const batch of batches) {
      if (pending) {
        await heartbeat();
        const staged = await rpc("stage_catalog_import_storage_batch_system", {
          input_run_id: activeRunId,
          input_organization_id: organizationId,
          input_actor_id: actorId,
          ...fence,
          input_payload: pending.rows,
          input_cursor_row: pending.cursorEnd - 1,
          input_is_final: false,
        });
        const stagedCount = rpcValue(staged, "staged_count", "row_count", "count");
        if (stagedCount != null && Number(stagedCount) !== pending.rowCount) throw new Error("CATALOG_STAGE_RECEIPT_INVALID");
        processedRows += pending.rowCount;
        lastCursor = pending.cursorEnd - 1;
        calls.batches += 1;
      }
      pending = batch;
    }
    let completed = null;
    if (pending) {
      await heartbeat();
      completed = await rpc("stage_catalog_import_storage_batch_system", {
        input_run_id: activeRunId,
        input_organization_id: organizationId,
        input_actor_id: actorId,
        ...fence,
        input_payload: pending.rows,
        input_cursor_row: pending.cursorEnd - 1,
        input_is_final: true,
      });
      const finalCount = rpcValue(completed, "staged_count", "row_count", "count");
      if (finalCount != null && Number(finalCount) !== pending.rowCount) throw new Error("CATALOG_STAGE_RECEIPT_INVALID");
      processedRows += pending.rowCount;
      lastCursor = pending.cursorEnd - 1;
      calls.batches += 1;
    }
    const expectedProcessed = preflight.totalRows - Math.max(0, durableResumeCursor + 1);
    if (expectedProcessed !== processedRows) throw new Error("CATALOG_SOURCE_ROW_COUNT_MISMATCH");
    // A retry after the last stage receipt may legitimately have no rows left.
    // A queue marker exists before ingestion. A separate durable full-file
    // acknowledgement, after the parser/preflight count agrees, authorizes
    // validation. A final staged batch alone must never authorize it.
    await heartbeat();
    const queued = await rpc("complete_catalog_import_storage_read_system", {
      input_run_id: activeRunId,
      input_organization_id: organizationId,
      input_actor_id: actorId,
      ...fence,
      input_total_rows: preflight.totalRows,
    });
    const receipt = Array.isArray(queued) ? queued[0] : queued;
    if (receipt?.queued !== true || receipt.status !== "queued" || receipt.run_id !== activeRunId
        || receipt.source_id !== lease.sourceId || Number(receipt.read_complete_rows) !== preflight.totalRows
        || typeof receipt.read_completed_at !== "string" || !Number.isFinite(Date.parse(receipt.read_completed_at))) {
      throw new Error("CATALOG_SOURCE_READ_RECEIPT_INVALID");
    }
    return { runId: activeRunId, processedRows, cursorEnd: lastCursor, sourceSha256: downloaded.sha256, batches: calls.batches, preflight, result: completed, queued };
  } finally {
    if (downloaded) await rm(downloaded.workDir, { recursive: true, force: true });
  }
}

/**
 * Serialize heavy storage imports within this worker process. DBOS's internal
 * recovery queue and the named application queue have separate limits, so a
 * process-global gate is required to keep their download/DuckDB work from
 * overlapping after restart.
 */
export async function runCatalogStorageImport(options) {
  return withCatalogHeavyImportGate(() => runCatalogStorageImportUnlocked(options));
}
