import { normalizeCatalogDescription } from "../../domain/shared/catalogFormatting";
import { normalizeCatalogMarketSegment } from "../../domain/shared/catalogSegments";
import { callAppRpc } from "./appRpcApi";
import { supabaseClient } from "./supabaseClient";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { formatCanonicalProductCode } from "../../shared/productCodeDisplay";

export type SupplierImportProgress = {
  processedChunks: number;
  totalChunks: number;
  processedRows: number;
  totalRows: number;
};

export type SupplierImportMode = "replace" | "merge";

export type SupplierPriceRollupRefreshRun = {
  id: string;
  organization_id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: "running" | "succeeded" | "failed" | string;
  error_message: string | null;
  supplier_price_rollups_count: number | null;
};

export type SupplierImportStatus =
  | { phase: "upload_progressing"; progress: SupplierImportProgress }
  | { phase: "upload_completed"; progress: SupplierImportProgress }
  | { phase: "finalizing" }
  | { phase: "rollup_refresh_queued" }
  | { phase: "rollup_refresh_pending" }
  | { phase: "rollup_refresh_completed" }
  | { phase: "rollup_refresh_failed_retrying" };

export type SupplierImportResult = {
  processed: number;
  catalogSynced: number;
  totalRows: number;
  totalChunks: number;
  catalogSyncStatus: "pending" | "running" | "succeeded" | "failed";
  catalogSyncPending: boolean;
  catalogSyncMessage: string | null;
  rollupRefreshRun: SupplierPriceRollupRefreshRun | null;
  rollupRefreshPending: boolean;
  rollupRefreshMessage: string | null;
};

export type CatalogImportResult = {
  runId: string | null;
  totalRows: number;
  totalChunks: number;
  stagedRows: number;
  insertCount: number;
  updateCount: number;
  skipCount: number;
  errorCount: number;
  duplicateCount: number;
  conflictCount: number;
  validationStatus: "validated" | "validation_failed" | "finalized";
  finalized: boolean;
  message: string | null;
};

type SupplierImportChunkResult = {
  processed?: number;
  catalog_synced?: number;
  staged_rows?: number;
};

type SupplierImportRunResult = {
  run_id: string;
  supplier_id: string;
  brand_id: string;
  mode: SupplierImportMode;
  status: string;
};

type SupplierImportFinalizeResult = {
  processed?: number;
  catalog_synced?: number;
  deactivated?: number;
  catalog_sync_status?: "pending" | "running" | "succeeded" | "failed" | string;
  catalog_sync_error_message?: string | null;
};

type SupplierPriceImportRunState = {
  status: "running" | "finalizing" | "succeeded" | "failed" | string;
  error_message: string | null;
  processed_rows: number | null;
  catalog_synced: number | null;
  catalog_sync_status: "pending" | "running" | "succeeded" | "failed" | string | null;
  catalog_sync_error_message: string | null;
};

type CatalogImportChunkResult = {
  staged_count?: number;
  error_count?: number;
  total_count?: number;
};

type CatalogImportRunResult = {
  run_id: string;
  status: string;
};

type CatalogImportValidationResult = {
  run_id: string;
  status: "validated" | "validation_failed" | string;
  total_count: number;
  insert_count: number;
  update_count: number;
  skip_count: number;
  error_count: number;
  duplicate_count: number;
  conflict_count: number;
};

type CatalogImportFinalizeResult = {
  run_id: string;
  status: string;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
};

type SupplierRollupRefreshOutcome = {
  run: SupplierPriceRollupRefreshRun | null;
  pending: boolean;
  message: string | null;
};

const SUPPLIER_IMPORT_MAX_BATCH_ROWS = 100;
const SUPPLIER_IMPORT_TARGET_BATCH_BYTES = 48000;
const SUPPLIER_IMPORT_CHUNK_RETRY_LIMIT = 2;
const SUPPLIER_IMPORT_CHUNK_RETRY_BACKOFF_MS = 1000;
const SUPPLIER_IMPORT_POLL_INTERVAL_MS = 1500;
const SUPPLIER_IMPORT_FINALIZE_CONFIRM_RETRY_LIMIT = 5;
const SUPPLIER_IMPORT_REFRESH_CONFIRM_RETRY_LIMIT = 3;
const SUPPLIER_IMPORT_LOOKBACK_MS = 10000;
const CATALOG_IMPORT_MAX_BATCH_ROWS = 100;
const CATALOG_IMPORT_TARGET_BATCH_BYTES = 48000;
const CATALOG_IMPORT_CHUNK_RETRY_LIMIT = 2;
const CATALOG_IMPORT_CHUNK_RETRY_BACKOFF_MS = 1000;
const CATALOG_IMPORT_POLL_INTERVAL_MS = 1500;
const CATALOG_IMPORT_FINALIZE_CONFIRM_RETRY_LIMIT = 5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateJsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function buildAdaptiveSupplierImportBatches(payload: Array<Record<string, unknown>>) {
  const batches: Array<{ rows: Array<Record<string, unknown>>; startRowIndex: number }> = [];
  let currentRows: Array<Record<string, unknown>> = [];
  let currentBytes = 2;
  let currentStartRowIndex = 0;

  function flushCurrentBatch() {
    if (!currentRows.length) return;
    batches.push({ rows: currentRows, startRowIndex: currentStartRowIndex });
    currentRows = [];
    currentBytes = 2;
  }

  payload.forEach((row, rowIndex) => {
    const rowBytes = Math.max(estimateJsonBytes(row), 1);
    const wouldExceedRowCount = currentRows.length >= SUPPLIER_IMPORT_MAX_BATCH_ROWS;
    const wouldExceedByteTarget = currentRows.length > 0 && currentBytes + rowBytes + 1 > SUPPLIER_IMPORT_TARGET_BATCH_BYTES;

    if (wouldExceedRowCount || wouldExceedByteTarget) {
      flushCurrentBatch();
      currentStartRowIndex = rowIndex;
    }

    currentRows.push(row);
    currentBytes += rowBytes + 1;
  });

  flushCurrentBatch();
  return batches;
}

function normalizeCatalogImportProductCode(row: Record<string, unknown>, fallbackBrand = "") {
  const brand = String(row.brand ?? row.Brand ?? row.brand_name ?? fallbackBrand ?? "");
  return formatCanonicalProductCode(String(row.product_code || ""), brand);
}

function isTimeoutLikeMessage(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timed out") ||
    normalized.includes("statement timeout") ||
    normalized.includes("canceling statement due to statement timeout") ||
    normalized.includes("the request took too long") ||
    normalized.includes("aborted")
  );
}

function contextualizeImportError(error: unknown, context: string) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message) {
    return new Error(`${context} failed. Please try again.`);
  }

  const normalized = message.toLowerCase();
  if (isTimeoutLikeMessage(message)) {
    return new Error(`${context} timed out. Please try again.`);
  }
  if (normalized === "the request could not be completed right now." || normalized.includes("app rpc failed")) {
    return new Error(`${context} failed. Please try again.`);
  }
  return new Error(message);
}

async function callImportRpc<T>(name: string, args: Record<string, unknown>, context: string) {
  try {
    return await callAppRpc<T>(name, args);
  } catch (error) {
    throw contextualizeImportError(error, context);
  }
}

async function fetchSupplierPriceImportRun(runId: string) {
  const { data, error } = await supabaseClient
    .from("supplier_price_import_runs")
    .select("status,error_message,processed_rows,catalog_synced,catalog_sync_status,catalog_sync_error_message")
    .eq("id", runId)
    .limit(1);

  if (error) {
    throw new Error(sanitizeUserFacingMessage(error.message, "Supplier import status could not be confirmed."));
  }

  const rows = (data || []) as SupplierPriceImportRunState[];
  return rows[0] || null;
}

async function confirmSupplierPriceImportRun(runId: string) {
  let latestRun: SupplierPriceImportRunState | null = null;

  for (let attempt = 0; attempt < SUPPLIER_IMPORT_FINALIZE_CONFIRM_RETRY_LIMIT; attempt += 1) {
    latestRun = await fetchSupplierPriceImportRun(runId);
    if (!latestRun || latestRun.status === "running" || latestRun.status === "finalizing") {
      await sleep(SUPPLIER_IMPORT_POLL_INTERVAL_MS);
      continue;
    }
    return latestRun;
  }

  return latestRun;
}

async function confirmSupplierPriceCatalogSyncRun(runId: string) {
  let latestRun: SupplierPriceImportRunState | null = null;

  for (let attempt = 0; attempt < SUPPLIER_IMPORT_REFRESH_CONFIRM_RETRY_LIMIT; attempt += 1) {
    latestRun = await fetchSupplierPriceImportRun(runId);
    const syncStatus = String(latestRun?.catalog_sync_status || "pending");
    if (!latestRun || syncStatus === "pending" || syncStatus === "running") {
      await sleep(SUPPLIER_IMPORT_POLL_INTERVAL_MS);
      continue;
    }
    return latestRun;
  }

  return latestRun;
}

async function confirmSupplierPriceRollupRun(startedAfter: string) {
  let latestRun: SupplierPriceRollupRefreshRun | null = null;

  for (let attempt = 0; attempt < SUPPLIER_IMPORT_REFRESH_CONFIRM_RETRY_LIMIT; attempt += 1) {
    latestRun = await callImportRpc<SupplierPriceRollupRefreshRun | null>(
      "get_latest_supplier_price_rollup_refresh_run",
      { started_after: startedAfter },
      "Rollup refresh status check",
    );
    if (!latestRun || latestRun.status === "running") {
      await sleep(SUPPLIER_IMPORT_POLL_INTERVAL_MS);
      continue;
    }
    return latestRun;
  }

  return latestRun;
}

export function describeSupplierImportStatus(status: SupplierImportStatus) {
  switch (status.phase) {
    case "upload_progressing":
      return "Upload progressing…";
    case "upload_completed":
      return "Upload completed.";
    case "finalizing":
      return "Finalizing supplier import.";
    case "rollup_refresh_queued":
      return "Rollup refresh queued.";
    case "rollup_refresh_pending":
      return "Rollup refresh is still processing in the background.";
    case "rollup_refresh_completed":
      return "Rollup refresh completed.";
    case "rollup_refresh_failed_retrying":
      return "Rollup refresh failed (retrying…).";
    default:
      return "";
  }
}

function buildAdaptiveCatalogImportBatches(payload: Array<Record<string, unknown>>) {
  const batches: Array<{ rows: Array<Record<string, unknown>>; startRowIndex: number }> = [];
  let currentRows: Array<Record<string, unknown>> = [];
  let currentBytes = 2;
  let currentStartRowIndex = 0;

  function flushCurrentBatch() {
    if (!currentRows.length) return;
    batches.push({ rows: currentRows, startRowIndex: currentStartRowIndex });
    currentRows = [];
    currentBytes = 2;
  }

  payload.forEach((row, rowIndex) => {
    const rowBytes = Math.max(estimateJsonBytes(row), 1);
    const wouldExceedRowCount = currentRows.length >= CATALOG_IMPORT_MAX_BATCH_ROWS;
    const wouldExceedByteTarget = currentRows.length > 0 && currentBytes + rowBytes + 1 > CATALOG_IMPORT_TARGET_BATCH_BYTES;

    if (wouldExceedRowCount || wouldExceedByteTarget) {
      flushCurrentBatch();
      currentStartRowIndex = rowIndex;
    }

    currentRows.push(row);
    currentBytes += rowBytes + 1;
  });

  flushCurrentBatch();
  return batches;
}

async function importCatalogChunkWithRetry(input: {
  chunk: Array<Record<string, unknown>>;
  chunkNumber: number;
  totalChunks: number;
  processedRowsBeforeFailure: number;
  runId: string;
}): Promise<CatalogImportChunkResult> {
  let lastError: Error | null = null;
  const context = `Catalog upload batch ${input.chunkNumber}/${input.totalChunks}`;

  for (let attempt = 0; attempt <= CATALOG_IMPORT_CHUNK_RETRY_LIMIT; attempt += 1) {
    try {
      return await callImportRpc<CatalogImportChunkResult>(
        "stage_catalog_import_chunk",
        { input_run_id: input.runId, payload: input.chunk },
        context,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || ""));
      if (!isTimeoutLikeMessage(lastError.message) || attempt >= CATALOG_IMPORT_CHUNK_RETRY_LIMIT) {
        break;
      }
      await sleep(CATALOG_IMPORT_CHUNK_RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  const reason = lastError?.message ? ` ${lastError.message}` : "";
  throw new Error(
    `${context} failed after ${CATALOG_IMPORT_CHUNK_RETRY_LIMIT + 1} attempts. ` +
      `${input.processedRowsBeforeFailure} rows were processed before this failed chunk.${reason}`,
  );
}

async function importCatalogChunkWithAdaptiveRetry(input: {
  chunk: Array<Record<string, unknown>>;
  chunkNumber: number;
  totalChunks: number;
  processedRowsBeforeFailure: number;
  runId: string;
}): Promise<CatalogImportChunkResult> {
  try {
    return await importCatalogChunkWithRetry(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!isTimeoutLikeMessage(message) || input.chunk.length <= 1) {
      throw error;
    }

    const midpoint = Math.max(1, Math.floor(input.chunk.length / 2));
    const firstHalf = input.chunk.slice(0, midpoint);
    const secondHalf = input.chunk.slice(midpoint);
    const firstResult: CatalogImportChunkResult = await importCatalogChunkWithAdaptiveRetry({
      chunk: firstHalf,
      chunkNumber: input.chunkNumber,
      totalChunks: input.totalChunks,
      processedRowsBeforeFailure: input.processedRowsBeforeFailure,
      runId: input.runId,
    });
    const secondResult: CatalogImportChunkResult = await importCatalogChunkWithAdaptiveRetry({
      chunk: secondHalf,
      chunkNumber: input.chunkNumber,
      totalChunks: input.totalChunks,
      processedRowsBeforeFailure: input.processedRowsBeforeFailure + midpoint,
      runId: input.runId,
    });

    return {
      staged_count: Number(firstResult?.staged_count || firstHalf.length) + Number(secondResult?.staged_count || secondHalf.length),
      error_count: Number(firstResult?.error_count || 0) + Number(secondResult?.error_count || 0),
      total_count: Number(firstResult?.total_count || firstHalf.length) + Number(secondResult?.total_count || secondHalf.length),
    };
  }
}

async function beginCatalogImport(input: { brandName?: string; marketSegment?: string }) {
  return callImportRpc<CatalogImportRunResult>(
    "begin_catalog_import",
    {
      input_scope: {
        source: "catalog_csv",
        brand: input.brandName || null,
        market_segment: input.marketSegment || null,
      },
      input_mode: "upsert",
    },
    "Catalog import start",
  );
}

async function validateCatalogImport(runId: string) {
  return callImportRpc<CatalogImportValidationResult>(
    "validate_catalog_import",
    { input_run_id: runId },
    "Catalog import validation",
  );
}

async function finalizeCatalogImport(runId: string) {
  return callImportRpc<CatalogImportFinalizeResult>(
    "finalize_catalog_import",
    { input_run_id: runId },
    "Catalog import finalization",
  );
}

async function failCatalogImport(runId: string, message: string) {
  return callImportRpc(
    "fail_catalog_import",
    { input_run_id: runId, message },
    "Catalog import failure recording",
  );
}

export async function bulkImportCatalog(
  payload: Array<Record<string, unknown>>,
  options?: {
    brandName?: string;
    marketSegment?: string;
    onProgress?: (input: { processedChunks: number; totalChunks: number; processedRows: number; totalRows: number }) => void;
  },
): Promise<CatalogImportResult> {
  const totalRows = payload.length;

  if (!totalRows) {
    return {
      runId: null,
      totalRows: 0,
      totalChunks: 0,
      stagedRows: 0,
      insertCount: 0,
      updateCount: 0,
      skipCount: 0,
      errorCount: 0,
      duplicateCount: 0,
      conflictCount: 0,
      validationStatus: "validated",
      finalized: false,
      message: "Catalog import did not contain any rows.",
    };
  }

  const normalizedPayload = payload.map((row, rowIndex) => ({
    ...row,
    row_index: Number.isFinite(Number(row.row_index)) ? Number(row.row_index) : rowIndex,
    product_code: normalizeCatalogImportProductCode(row, options?.brandName),
    description: row.description == null ? null : normalizeCatalogDescription(String(row.description || "")),
    vehicle: row.vehicle == null ? null : String(row.vehicle || "").trim() || null,
    market_segment: normalizeCatalogMarketSegment(String(row.market_segment || "")),
  }));
  const batches = buildAdaptiveCatalogImportBatches(normalizedPayload);
  const totalChunks = Math.max(1, batches.length);
  const importRun = await beginCatalogImport({
    brandName: options?.brandName,
    marketSegment: options?.marketSegment,
  });
  const runId = importRun.run_id;
  let stagedRows = 0;

  try {
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const chunk = batch.rows;
      const chunkNumber = index + 1;
      const progress = {
        processedChunks: chunkNumber,
        totalChunks,
        processedRows: Math.min(batch.startRowIndex + chunk.length, totalRows),
        totalRows,
      };

      const data = await importCatalogChunkWithAdaptiveRetry({
        chunk,
        chunkNumber,
        totalChunks,
        processedRowsBeforeFailure: batch.startRowIndex,
        runId,
      });

      stagedRows += Number((data as { staged_count?: number } | null)?.staged_count || chunk.length);
      options?.onProgress?.(progress);
    }

    const validation = await validateCatalogImport(runId);
    const validationStatus = validation.status === "validated" ? "validated" : "validation_failed";
    const validationMessage =
      validationStatus === "validated"
        ? null
        : validation.error_count > 0
          ? "Catalog import validation failed. Fix the blocked rows and try again."
          : "Catalog import could not be validated.";

    if (validationStatus === "validation_failed") {
      return {
        runId,
        totalRows,
        totalChunks,
        stagedRows,
        insertCount: Number(validation.insert_count || 0),
        updateCount: Number(validation.update_count || 0),
        skipCount: Number(validation.skip_count || 0),
        errorCount: Number(validation.error_count || 0),
        duplicateCount: Number(validation.duplicate_count || 0),
        conflictCount: Number(validation.conflict_count || 0),
        validationStatus,
        finalized: false,
        message: validationMessage,
      };
    }

    const finalized = await finalizeCatalogImport(runId);

    return {
      runId,
      totalRows,
      totalChunks,
      stagedRows,
      insertCount: Number(finalized.inserted_count || 0),
      updateCount: Number(finalized.updated_count || 0),
      skipCount: Number(finalized.skipped_count || 0),
      errorCount: Number(finalized.error_count || 0),
      duplicateCount: Number(validation.duplicate_count || 0),
      conflictCount: Number(validation.conflict_count || 0),
      validationStatus: "finalized",
      finalized: true,
      message: "Catalog import finalized successfully.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Catalog import failed");
    await failCatalogImport(runId, message).catch(() => undefined);
    throw error;
  }
}

async function waitForSupplierPriceRollupRefresh(
  startedAfter: string,
) {
  const latestRun = await confirmSupplierPriceRollupRun(startedAfter);
  if (latestRun && latestRun.status !== "running") {
    return latestRun;
  }

  return null;
}

async function queueAndCheckSupplierPriceRollupRefresh(
  onStatus?: (status: SupplierImportStatus) => void,
): Promise<SupplierRollupRefreshOutcome> {
  const startedAfter = new Date(Date.now() - SUPPLIER_IMPORT_LOOKBACK_MS).toISOString();

  try {
    await callImportRpc("queue_supplier_price_rollups_refresh", {}, "Rollup refresh queue");
    onStatus?.({ phase: "rollup_refresh_queued" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return {
      run: null,
      pending: true,
      message: message || "Rollup refresh is still processing in the background.",
    };
  }

  try {
    const refreshRun = await waitForSupplierPriceRollupRefresh(startedAfter);
    if (refreshRun?.status === "succeeded") {
      onStatus?.({ phase: "rollup_refresh_completed" });
      return { run: refreshRun, pending: false, message: null };
    }

    if (refreshRun && refreshRun.status === "failed") {
      return {
        run: refreshRun,
        pending: false,
        message: refreshRun.error_message || "Rollup refresh failed.",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return {
      run: null,
      pending: true,
      message: message || "Rollup refresh is still processing in the background.",
    };
  }

  onStatus?.({ phase: "rollup_refresh_pending" });
  return {
    run: null,
    pending: true,
    message: "Rollup refresh is still processing in the background.",
  };
}

async function queueSupplierPriceCatalogSync(runId: string) {
  return callImportRpc<{ queued?: boolean; status?: string; catalog_sync_status?: string; run_id?: string }>(
    "queue_supplier_price_catalog_sync",
    { input_run_id: runId },
    "Catalog sync queue",
  );
}

async function importSupplierPriceChunkWithRetry(input: {
  chunk: Array<Record<string, unknown>>;
  chunkNumber: number;
  totalChunks: number;
  processedRowsBeforeFailure: number;
  runId?: string | null;
}): Promise<SupplierImportChunkResult> {
  let lastError: Error | null = null;
  const context = `Supplier upload batch ${input.chunkNumber}/${input.totalChunks}`;

  for (let attempt = 0; attempt <= SUPPLIER_IMPORT_CHUNK_RETRY_LIMIT; attempt += 1) {
    try {
      return await callImportRpc<{ processed?: number; catalog_synced?: number }>(
        input.runId ? "stage_supplier_price_import_chunk" : "bulk_import_supplier_prices",
        input.runId ? { input_run_id: input.runId, payload: input.chunk } : { payload: input.chunk },
        context,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || ""));
      if (!isTimeoutLikeMessage(lastError.message) || attempt >= SUPPLIER_IMPORT_CHUNK_RETRY_LIMIT) {
        break;
      }
      await sleep(SUPPLIER_IMPORT_CHUNK_RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  const reason = lastError?.message ? ` ${lastError.message}` : "";
  throw new Error(
    `${context} failed after ${SUPPLIER_IMPORT_CHUNK_RETRY_LIMIT + 1} attempts. ` +
      `${input.processedRowsBeforeFailure} rows were processed before this failed chunk.${reason}`,
  );
}

async function importSupplierPriceChunkWithAdaptiveRetry(input: {
  chunk: Array<Record<string, unknown>>;
  chunkNumber: number;
  totalChunks: number;
  processedRowsBeforeFailure: number;
  runId?: string | null;
}): Promise<SupplierImportChunkResult> {
  try {
    return await importSupplierPriceChunkWithRetry(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (!isTimeoutLikeMessage(message) || input.chunk.length <= 1) {
      throw error;
    }

    const midpoint = Math.max(1, Math.floor(input.chunk.length / 2));
    const firstHalf = input.chunk.slice(0, midpoint);
    const secondHalf = input.chunk.slice(midpoint);
    const firstResult: SupplierImportChunkResult = await importSupplierPriceChunkWithAdaptiveRetry({
      chunk: firstHalf,
      chunkNumber: input.chunkNumber,
      totalChunks: input.totalChunks,
      processedRowsBeforeFailure: input.processedRowsBeforeFailure,
      runId: input.runId,
    });
    const secondResult: SupplierImportChunkResult = await importSupplierPriceChunkWithAdaptiveRetry({
      chunk: secondHalf,
      chunkNumber: input.chunkNumber,
      totalChunks: input.totalChunks,
      processedRowsBeforeFailure: input.processedRowsBeforeFailure + midpoint,
      runId: input.runId,
    });

    return {
      processed: Number(firstResult?.processed || firstHalf.length) + Number(secondResult?.processed || secondHalf.length),
      catalog_synced: Number(firstResult?.catalog_synced || 0) + Number(secondResult?.catalog_synced || 0),
    };
  }
}

async function beginSupplierPriceImport(input: {
  supplierName: string;
  brandName: string;
  mode: SupplierImportMode;
}) {
  return callImportRpc<SupplierImportRunResult>(
    "begin_supplier_price_import",
    {
      input_supplier_name: input.supplierName,
      input_brand: input.brandName,
      input_mode: input.mode,
    },
    "Supplier import start",
  );
}

async function finalizeSupplierPriceImport(runId: string) {
  return callImportRpc<SupplierImportFinalizeResult>(
    "finalize_supplier_price_import",
    { input_run_id: runId },
    "Supplier import finalization",
  );
}

async function failSupplierPriceImport(runId: string, message: string) {
  return callImportRpc(
    "fail_supplier_price_import",
    { input_run_id: runId, input_error_message: message },
    "Supplier import failure recording",
  );
}

export async function bulkImportSupplierPrices(
  payload: Array<Record<string, unknown>>,
  options?: {
    mode?: SupplierImportMode;
    supplierName?: string;
    brandName?: string;
    onProgress?: (input: { processedChunks: number; totalChunks: number; processedRows: number; totalRows: number }) => void;
    onStatus?: (status: SupplierImportStatus) => void;
  },
): Promise<SupplierImportResult> {
  let processed = 0;
  let catalogSynced = 0;
  let catalogSyncStatus: SupplierImportResult["catalogSyncStatus"] = "pending";
  let catalogSyncPending = true;
  let catalogSyncMessage: string | null = "Catalog sync is processing in the background.";
  const totalRows = payload.length;

  if (!totalRows) {
    return {
      processed: 0,
      catalogSynced: 0,
      totalRows: 0,
      totalChunks: 0,
      catalogSyncStatus: "succeeded",
      catalogSyncPending: false,
      catalogSyncMessage: null,
      rollupRefreshRun: null,
      rollupRefreshPending: false,
      rollupRefreshMessage: null,
    };
  }

  const batches = buildAdaptiveSupplierImportBatches(payload);
  const totalChunks = Math.max(1, batches.length);
  const shouldUseStagedImport = options?.mode === "replace" || options?.mode === "merge";
  let runId: string | null = null;

  if (shouldUseStagedImport) {
    const supplierName = String(options?.supplierName || "").trim();
    const brandName = String(options?.brandName || "").trim();
    if (!supplierName || !brandName || !options?.mode) {
      throw new Error("Supplier, brand, and import mode are required for supplier list import.");
    }
    const importRun = await beginSupplierPriceImport({
      supplierName,
      brandName,
      mode: options.mode,
    });
    runId = importRun.run_id;
  }

  options?.onStatus?.({
    phase: "upload_progressing",
    progress: {
      processedChunks: 0,
      totalChunks,
      processedRows: 0,
      totalRows,
    },
  });

  let finalizedImport = false;

  try {
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const chunk = batch.rows;
      const chunkNumber = index + 1;
      const progress = {
        processedChunks: chunkNumber,
        totalChunks,
        processedRows: Math.min(batch.startRowIndex + chunk.length, totalRows),
        totalRows,
      };

      const data = await importSupplierPriceChunkWithAdaptiveRetry({
        chunk,
        chunkNumber,
        totalChunks,
        processedRowsBeforeFailure: batch.startRowIndex,
        runId,
      });

      processed += Number((data as { processed?: number } | null)?.processed || chunk.length);
      catalogSynced += Number((data as { catalog_synced?: number } | null)?.catalog_synced || 0);
      options?.onProgress?.(progress);
    }

    options?.onStatus?.({
      phase: "upload_completed",
      progress: {
        processedChunks: totalChunks,
        totalChunks,
        processedRows: totalRows,
        totalRows,
      },
    });

    if (runId) {
      options?.onStatus?.({ phase: "finalizing" });
      try {
        const finalized = await finalizeSupplierPriceImport(runId);
        processed = Number(finalized?.processed ?? processed);
        catalogSynced = Number(finalized?.catalog_synced ?? catalogSynced);
        finalizedImport = true;
        catalogSyncStatus = String(finalized?.catalog_sync_status || "pending") as SupplierImportResult["catalogSyncStatus"];
        catalogSyncPending = catalogSyncStatus === "pending" || catalogSyncStatus === "running";
        catalogSyncMessage = catalogSyncPending ? "Catalog sync is processing in the background." : null;
      } catch (error) {
        const confirmedRun = await confirmSupplierPriceImportRun(runId);
        if (confirmedRun?.status === "succeeded") {
          processed = Number(confirmedRun.processed_rows ?? processed);
          catalogSynced = Number(confirmedRun.catalog_synced ?? catalogSynced);
          finalizedImport = true;
          catalogSyncStatus = String(confirmedRun.catalog_sync_status || "pending") as SupplierImportResult["catalogSyncStatus"];
          catalogSyncPending = catalogSyncStatus === "pending" || catalogSyncStatus === "running";
          catalogSyncMessage = catalogSyncPending
            ? "Catalog sync is processing in the background."
            : confirmedRun.catalog_sync_error_message || null;
        } else if (confirmedRun?.status === "failed") {
          throw new Error(
            confirmedRun.error_message ||
              (error instanceof Error ? error.message : "Supplier import finalization failed. Please try again."),
          );
        } else {
          throw error;
        }
      }

      if (finalizedImport) {
        try {
          const catalogSyncQueued = await queueSupplierPriceCatalogSync(runId);
          const confirmedCatalogSync = await confirmSupplierPriceCatalogSyncRun(runId);
          const latestCatalogSyncStatus = String(confirmedCatalogSync?.catalog_sync_status || catalogSyncQueued?.catalog_sync_status || "pending") as SupplierImportResult["catalogSyncStatus"];
          catalogSyncStatus = latestCatalogSyncStatus;
          if (latestCatalogSyncStatus === "succeeded") {
            catalogSyncPending = false;
            catalogSyncMessage = null;
            catalogSynced = Number(confirmedCatalogSync?.catalog_synced ?? catalogSynced);
          } else if (latestCatalogSyncStatus === "failed") {
            catalogSyncPending = false;
            catalogSyncMessage =
              confirmedCatalogSync?.catalog_sync_error_message ||
              "Catalog sync failed in the background. Retry catalog synchronization from the supplier import run.";
          } else {
            catalogSyncPending = true;
            catalogSyncMessage = "Catalog sync is processing in the background.";
          }
        } catch (error) {
          catalogSyncStatus = "pending";
          catalogSyncPending = true;
          catalogSyncMessage = error instanceof Error ? error.message : "Catalog sync is processing in the background.";
        }
      }
    }
  } catch (error) {
    if (runId) {
      const message = error instanceof Error ? error.message : String(error || "Supplier import failed");
      await failSupplierPriceImport(runId, message).catch(() => undefined);
    }
    throw error;
  }

  let rollupRefresh: SupplierRollupRefreshOutcome = { run: null, pending: false, message: null };
  if (finalizedImport || !runId) {
    try {
      rollupRefresh = await queueAndCheckSupplierPriceRollupRefresh(options?.onStatus);
    } catch (error) {
      rollupRefresh = {
        run: null,
        pending: true,
        message: error instanceof Error ? error.message : String(error || "Rollup refresh is still processing in the background."),
      };
    }
  }

  return {
    processed,
    catalogSynced,
    totalRows,
    totalChunks,
    catalogSyncStatus,
    catalogSyncPending,
    catalogSyncMessage,
    rollupRefreshRun: rollupRefresh?.run ?? null,
    rollupRefreshPending: rollupRefresh?.pending ?? false,
    rollupRefreshMessage: rollupRefresh?.message ?? null,
  };
}
