import { normalizeCatalogDescription, normalizeCatalogDisplayCode } from "../../domain/shared/catalogFormatting";
import { normalizeCatalogMarketSegment } from "../../domain/shared/catalogSegments";
import { callAppRpc } from "./appRpcApi";

export type SupplierImportProgress = {
  processedChunks: number;
  totalChunks: number;
  processedRows: number;
  totalRows: number;
};

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
  | { phase: "rollup_refresh_queued" }
  | { phase: "rollup_refresh_completed" }
  | { phase: "rollup_refresh_failed_retrying" };

export type SupplierImportResult = {
  processed: number;
  catalogSynced: number;
  totalRows: number;
  totalChunks: number;
  rollupRefreshRun: SupplierPriceRollupRefreshRun | null;
};

type SupplierImportChunkResult = {
  processed?: number;
  catalog_synced?: number;
};

const SUPPLIER_IMPORT_MAX_BATCH_ROWS = 100;
const SUPPLIER_IMPORT_TARGET_BATCH_BYTES = 48000;
const SUPPLIER_IMPORT_CHUNK_RETRY_LIMIT = 2;
const SUPPLIER_IMPORT_CHUNK_RETRY_BACKOFF_MS = 1000;
const SUPPLIER_IMPORT_POLL_INTERVAL_MS = 1500;
const SUPPLIER_IMPORT_POLL_TIMEOUT_MS = 120000;
const SUPPLIER_IMPORT_REFRESH_RETRY_LIMIT = 2;
const SUPPLIER_IMPORT_LOOKBACK_MS = 10000;

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

export function describeSupplierImportStatus(status: SupplierImportStatus) {
  switch (status.phase) {
    case "upload_progressing":
      return "Upload progressing…";
    case "upload_completed":
      return "Upload completed.";
    case "rollup_refresh_queued":
      return "Rollup refresh queued.";
    case "rollup_refresh_completed":
      return "Rollup refresh completed.";
    case "rollup_refresh_failed_retrying":
      return "Rollup refresh failed (retrying…).";
    default:
      return "";
  }
}

export async function bulkImportCatalog(payload: Array<Record<string, unknown>>) {
  const normalizedPayload = payload.map((row) => ({
    ...row,
    product_code: normalizeCatalogDisplayCode(
      String(row.product_code || ""),
      String(row.brand || row.Brand || row.brand_name || ""),
    ),
    description: row.description == null ? null : normalizeCatalogDescription(String(row.description || "")),
    vehicle: row.vehicle == null ? null : String(row.vehicle || "").trim() || null,
    market_segment: normalizeCatalogMarketSegment(String(row.market_segment || "")),
  }));
  await callAppRpc("bulk_import_catalog", { payload: normalizedPayload });
}

async function waitForSupplierPriceRollupRefresh(
  startedAfter: string,
) {
  const deadline = Date.now() + SUPPLIER_IMPORT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const latestRun = await callImportRpc<SupplierPriceRollupRefreshRun | null>(
      "get_latest_supplier_price_rollup_refresh_run",
      { started_after: startedAfter },
      "Rollup refresh status check",
    );
    if (latestRun && latestRun.status !== "running") {
      return latestRun;
    }
    await sleep(SUPPLIER_IMPORT_POLL_INTERVAL_MS);
  }

  throw new Error("Rollup refresh timed out. Please try again.");
}

async function queueAndWaitForSupplierPriceRollupRefresh(
  onStatus?: (status: SupplierImportStatus) => void,
): Promise<SupplierPriceRollupRefreshRun> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= SUPPLIER_IMPORT_REFRESH_RETRY_LIMIT; attempt += 1) {
    const startedAfter = new Date(Date.now() - SUPPLIER_IMPORT_LOOKBACK_MS).toISOString();

    try {
      await callImportRpc("queue_supplier_price_rollups_refresh", {}, "Rollup refresh queue");
      onStatus?.({ phase: "rollup_refresh_queued" });

      const refreshRun = await waitForSupplierPriceRollupRefresh(startedAfter);
      if (refreshRun.status === "succeeded") {
        onStatus?.({ phase: "rollup_refresh_completed" });
        return refreshRun;
      }

      lastError = new Error(refreshRun.error_message || "Rollup refresh failed.");
    } catch (error) {
      lastError = error instanceof Error ? error : contextualizeImportError(error, "Rollup refresh");
    }

    if (attempt < SUPPLIER_IMPORT_REFRESH_RETRY_LIMIT) {
      onStatus?.({ phase: "rollup_refresh_failed_retrying" });
      await sleep(1000);
      continue;
    }
  }

  throw lastError || new Error("Rollup refresh failed. Please try again.");
}

async function importSupplierPriceChunkWithRetry(input: {
  chunk: Array<Record<string, unknown>>;
  chunkNumber: number;
  totalChunks: number;
  processedRowsBeforeFailure: number;
}): Promise<SupplierImportChunkResult> {
  let lastError: Error | null = null;
  const context = `Supplier upload batch ${input.chunkNumber}/${input.totalChunks}`;

  for (let attempt = 0; attempt <= SUPPLIER_IMPORT_CHUNK_RETRY_LIMIT; attempt += 1) {
    try {
      return await callImportRpc<{ processed?: number; catalog_synced?: number }>(
        "bulk_import_supplier_prices",
        { payload: input.chunk },
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
    });
    const secondResult: SupplierImportChunkResult = await importSupplierPriceChunkWithAdaptiveRetry({
      chunk: secondHalf,
      chunkNumber: input.chunkNumber,
      totalChunks: input.totalChunks,
      processedRowsBeforeFailure: input.processedRowsBeforeFailure + midpoint,
    });

    return {
      processed: Number(firstResult?.processed || firstHalf.length) + Number(secondResult?.processed || secondHalf.length),
      catalog_synced: Number(firstResult?.catalog_synced || 0) + Number(secondResult?.catalog_synced || 0),
    };
  }
}

export async function bulkImportSupplierPrices(
  payload: Array<Record<string, unknown>>,
  options?: {
    onProgress?: (input: { processedChunks: number; totalChunks: number; processedRows: number; totalRows: number }) => void;
    onStatus?: (status: SupplierImportStatus) => void;
  },
): Promise<SupplierImportResult> {
  let processed = 0;
  let catalogSynced = 0;
  const totalRows = payload.length;

  if (!totalRows) {
    return {
      processed: 0,
      catalogSynced: 0,
      totalRows: 0,
      totalChunks: 0,
      rollupRefreshRun: null,
    };
  }

  const batches = buildAdaptiveSupplierImportBatches(payload);
  const totalChunks = Math.max(1, batches.length);
  options?.onStatus?.({
    phase: "upload_progressing",
    progress: {
      processedChunks: 0,
      totalChunks,
      processedRows: 0,
      totalRows,
    },
  });

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

  const rollupRefreshRun = await queueAndWaitForSupplierPriceRollupRefresh(options?.onStatus);

  return {
    processed,
    catalogSynced,
    totalRows,
    totalChunks,
    rollupRefreshRun,
  };
}
