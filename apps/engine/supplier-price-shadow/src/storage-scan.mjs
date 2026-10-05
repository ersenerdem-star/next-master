import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseNormalizedSupplierPriceRows } from "./streaming-csv.mjs";
import { parseNormalizedSupplierPriceRowsFromXlsx } from "./streaming-xlsx.mjs";
import { supabaseApiHeaders } from "./supabase-headers.mjs";

export function applyReleaseSourceDate(row, sourceDate) {
  const normalizedDate = String(sourceDate || "").slice(0, 10);
  if (!normalizedDate || row.valid_from || !String(row.error_message || "").includes("INVALID_VALID_FROM")) return row;
  const remainingWarnings = String(row.error_message)
    .split(",")
    .filter((code) => code && code !== "INVALID_VALID_FROM");
  row.valid_from = normalizedDate;
  row.error_message = remainingWarnings.length ? remainingWarnings.join(",") : null;
  if (row.row_status === "warning" && remainingWarnings.length === 0) {
    row.row_status = "accepted";
    row.error_code = null;
  }
  const { row_hash: _oldHash, ...hashable } = row;
  row.row_hash = createHash("sha256").update(JSON.stringify(hashable)).digest("hex");
  return row;
}

export async function fetchReleaseMetadata({ supabaseUrl, serviceRoleKey, releaseId, fetchImpl = fetch }) {
  const url = `${String(supabaseUrl).replace(/\/+$/, "")}/rest/v1/rpc/get_supplier_price_release_manifest`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: supabaseApiHeaders(serviceRoleKey, "application/json"),
    body: JSON.stringify({ input_release_id: releaseId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.error || `RELEASE_LOOKUP_FAILED:${response.status}`);
  const release = Array.isArray(body) ? body[0] : null;
  if (!release) throw new Error("RELEASE_NOT_FOUND");
  return release;
}

export async function scanSupplierPriceStorageBatch({
  release,
  claim,
  supabaseUrl,
  serviceRoleKey,
  bucket = "supplier-price-imports",
  includeRows = false,
  fetchImpl = fetch,
  timeoutMs = 60000,
  maxSourceBytes = 1073741824,
}) {
  const sourcePath = String(release?.source_file_path || "").trim();
  const isXlsx = /\.xlsx$/i.test(sourcePath);
  const isCsv = /\.(csv|tsv|txt)$/i.test(sourcePath);
  if (!isCsv && !isXlsx) throw new Error("UNSUPPORTED_SOURCE_FORMAT");
  // The service key must never be forwarded to a redirected URL or a path
  // which URL normalization can turn into a different Storage object.
  if (sourcePath.split("/").some(segment => !segment || segment === "." || segment === "..")
      || /[\\\x00-\x1f\x7f]/.test(sourcePath) || sourcePath !== release.source_file_path) {
    throw new Error("SOURCE_PATH_INVALID");
  }
  const origin = new URL(supabaseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("SOURCE_ORIGIN_INVALID");
  if (bucket !== "supplier-price-imports") throw new Error("SOURCE_BUCKET_INVALID");
  if (!/^[0-9a-f]{64}$/.test(release.source_file_sha256 || "")) throw new Error("SOURCE_CHECKSUM_REQUIRED");
  const totalRows = Number(release.total_rows);
  const cursorStart = Number(claim?.cursor_start);
  const cursorEnd = Number(claim?.cursor_end);
  if (!Number.isSafeInteger(totalRows) || totalRows < 1) throw new Error("SOURCE_ROW_COUNT_REQUIRED");
  if (!Number.isSafeInteger(cursorStart) || !Number.isSafeInteger(cursorEnd)
      || cursorStart < 1 || cursorEnd < cursorStart || cursorEnd > totalRows
      || cursorEnd - cursorStart + 1 > 10000) throw new Error("SOURCE_CLAIM_RANGE_INVALID");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000
      || !Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > 1073741824) {
    throw new Error("SOURCE_LIMIT_INVALID");
  }
  const expectedBytes = release.source_file_bytes;
  if (expectedBytes != null && (!Number.isSafeInteger(Number(expectedBytes))
      || Number(expectedBytes) < 1 || Number(expectedBytes) > maxSourceBytes)) throw new Error("SOURCE_SIZE_INVALID");
  const encodedPath = sourcePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  // Private Supabase objects are downloaded through the object endpoint. The
  // /object/download route is not a valid Storage API route and returns 400.
  const url = `${origin.origin}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sourceHash = createHash("sha256");
  let sourceBytes = 0;
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      sourceBytes += chunk.length;
      if (sourceBytes > maxSourceBytes || (expectedBytes != null && sourceBytes > Number(expectedBytes))) {
        callback(new Error("SOURCE_SIZE_EXCEEDED"));
        return;
      }
      sourceHash.update(chunk);
      callback(null, chunk);
    },
  });
  let sourceStream = null;
  let transfer = null;
  let tempDir = null;
  let scannedRows = 0;
  let batchRows = 0;
  let acceptedRows = 0;
  let warningRows = 0;
  let rejectedRows = 0;
  const rows = includeRows ? [] : null;
  let lastBatchCursor = cursorStart - 1;
  try {
    const response = await fetchImpl(url, {
      headers: supabaseApiHeaders(serviceRoleKey),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`SOURCE_DOWNLOAD_FAILED:${response.status}`);
    }
    sourceStream = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
    let input = hashingStream;
    if (isXlsx) {
      tempDir = await mkdtemp(join(tmpdir(), "supplier-price-storage-"));
      input = join(tempDir, "source.xlsx");
      transfer = pipeline(sourceStream, hashingStream, createWriteStream(input), { signal: controller.signal });
      await transfer;
      if (sourceHash.copy().digest("hex") !== release.source_file_sha256) throw new Error("SOURCE_CHECKSUM_MISMATCH");
    } else {
      // pipe() alone does not forward source errors and can crash the process.
      // pipeline() joins cancellation/errors on both sides. Observe rejection
      // immediately, even while the parser is still consuming the output.
      transfer = pipeline(sourceStream, hashingStream, { signal: controller.signal });
      transfer.catch(() => {});
    }
    const parser = isXlsx
      ? parseNormalizedSupplierPriceRowsFromXlsx(input)
      : parseNormalizedSupplierPriceRows(input);
    for await (const parsedRow of parser) {
      controller.signal.throwIfAborted();
      const row = applyReleaseSourceDate(parsedRow, release.source_date);
      scannedRows += 1;
      if (row.source_row_number < cursorStart || row.source_row_number > cursorEnd) continue;
      batchRows += 1;
      lastBatchCursor = row.source_row_number;
      if (row.row_status === "accepted") acceptedRows += 1;
      else if (row.row_status === "warning") warningRows += 1;
      else rejectedRows += 1;
      if (rows) rows.push(row);
    }
    await transfer;
    if (expectedBytes != null && sourceBytes !== Number(expectedBytes)) throw new Error("SOURCE_SIZE_MISMATCH");
    const actualChecksum = sourceHash.digest("hex");
    if (actualChecksum !== release.source_file_sha256) {
      throw new Error("SOURCE_CHECKSUM_MISMATCH");
    }
    if (totalRows !== scannedRows) {
      throw new Error(`SOURCE_ROW_COUNT_MISMATCH:${scannedRows}:${release.total_rows}`);
    }
    return {
      cursorEnd: lastBatchCursor,
      scannedRows,
      batchRows,
      acceptedRows,
      warningRows,
      rejectedRows,
      checksum: actualChecksum,
      ...(rows ? { rows } : {}),
    };
  } finally {
    clearTimeout(timer);
    sourceStream?.destroy();
    hashingStream.destroy();
    await transfer?.catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

// Backwards-compatible export for existing CSV-only callers and tests.
export const scanCsvStorageBatch = scanSupplierPriceStorageBatch;
