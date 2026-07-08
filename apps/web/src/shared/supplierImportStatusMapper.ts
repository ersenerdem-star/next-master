import {
  getImportReadiness,
  isImportFailedStatus,
  type ImportEngineBackgroundState,
  type ImportEngineBackgroundStatus,
  type ImportEngineReadiness,
  type ImportEngineStatus,
  type ImportEngineSummary,
} from "./importEngine";

export type SupplierImportRunStatusInput = {
  run_id?: string | null;
  id?: string | null;
  organization_id?: string | null;
  status?: string | null;
  staged_rows?: number | null;
  processed_rows?: number | null;
  error_message?: string | null;
  catalog_sync_status?: string | null;
  catalog_synced?: number | null;
  catalog_sync_error_message?: string | null;
  catalog_sync_started_at?: string | null;
  catalog_sync_finished_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_by?: string | null;
  finalized_by?: string | null;
};

function normalizeSupplierImportStatus(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

function mapSupplierBackgroundStatus(value: string | null | undefined): ImportEngineBackgroundState {
  switch (normalizeSupplierImportStatus(value)) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export function mapSupplierImportStatusToCanonicalStatus(input: SupplierImportRunStatusInput): ImportEngineStatus {
  switch (normalizeSupplierImportStatus(input.status)) {
    case "running":
      return "staging";
    case "finalizing":
      return "finalizing";
    case "finalized":
    case "succeeded":
      return "finalized";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "":
      return "idle";
    default:
      return "started";
  }
}

function buildSupplierImportBackgroundStatus(input: SupplierImportRunStatusInput): ImportEngineBackgroundStatus {
  const status = mapSupplierBackgroundStatus(input.catalog_sync_status);
  return {
    status,
    message:
      status === "failed"
        ? input.catalog_sync_error_message || "Catalog sync failed."
        : input.catalog_sync_error_message || null,
    startedAt: input.catalog_sync_started_at || null,
    finishedAt: input.catalog_sync_finished_at || null,
    progress: typeof input.catalog_synced === "number" && Number.isFinite(input.catalog_synced)
      ? input.catalog_synced
      : null,
  };
}

export function getSupplierImportReadiness(input: SupplierImportRunStatusInput): ImportEngineReadiness {
  const status = mapSupplierImportStatusToCanonicalStatus(input);

  if (isImportFailedStatus(status)) {
    return "failed";
  }

  // Supplier price finalize success means customer pricing may proceed.
  // Catalog sync pending/failed is an operations warning, not necessarily a
  // business blocker for customer price generation.
  if (status === "finalized" || status === "completed") {
    return "ready";
  }

  return getImportReadiness(status, {
    ...buildSupplierImportBackgroundStatus(input),
    status: "idle",
  });
}

export function mapSupplierImportRunToImportSummary(input: SupplierImportRunStatusInput): ImportEngineSummary {
  const status = mapSupplierImportStatusToCanonicalStatus(input);
  const backgroundStatus = buildSupplierImportBackgroundStatus(input);
  const stagedRows = Number(input.staged_rows || 0);
  const processedRows = Number(input.processed_rows ?? 0);

  return {
    runId: input.run_id || input.id || "",
    organizationId: input.organization_id || "",
    ownerDomain: "Supplier",
    sourceType: "supplier_price_import",
    status,
    counts: {
      stagedRows,
      processedRows,
      errorCount: status === "failed" ? 1 : 0,
      warningCount: backgroundStatus.status === "failed" ? 1 : 0,
      updatedCount: processedRows || undefined,
      skippedCount: stagedRows > processedRows ? stagedRows - processedRows : undefined,
      conflictCount: undefined,
    },
    startedAt: input.started_at || null,
    finishedAt: input.finished_at || null,
    createdBy: input.created_by || null,
    finalizedBy: input.finalized_by || null,
    backgroundStatus,
    errorMessage: input.error_message || null,
    error: input.error_message
      ? {
          message: input.error_message,
          code: "supplier_import_failed",
        }
      : null,
    conflictSummary: null,
  };
}
