/**
 * Canonical Operations Engine mapping helpers.
 * See docs/runtime/platform/OPERATIONS_ENGINE_BLUEPRINT.md for the platform contract.
 */

import {
  canRetryOperation,
  type OperationError,
  type OperationProgress,
  type OperationReadiness,
  type OperationStatus,
  type OperationSummary,
  type OperationWarning,
} from "./operationsEngine";
import {
  getImportReadiness,
  type ImportEngineReadiness,
  type ImportEngineSummary,
} from "./importEngine";
import {
  getSupplierImportReadiness,
  mapSupplierImportRunToImportSummary,
  type SupplierImportRunStatusInput,
} from "./supplierImportStatusMapper";

function normalizeOperationId(input: string | null | undefined) {
  return String(input || "").trim();
}

function buildOperationProgress(input: Pick<ImportEngineSummary, "counts" | "backgroundStatus" | "status">): OperationProgress {
  const stagedRows = Number(input.counts.stagedRows || 0);
  const processedRows = Number(input.counts.processedRows || 0);
  const explicitProgress = typeof input.backgroundStatus.progress === "number" && Number.isFinite(input.backgroundStatus.progress)
    ? Math.max(0, Math.min(100, Math.round(input.backgroundStatus.progress)))
    : null;
  const derivedProgress =
    explicitProgress !== null
      ? explicitProgress
      : stagedRows > 0
        ? Math.max(0, Math.min(100, Math.round((processedRows / stagedRows) * 100)))
        : null;

  return {
    progressPercent: derivedProgress,
    stagedRows,
    processedRows,
    totalRows: stagedRows > 0 ? stagedRows : null,
    currentStep: input.status,
  };
}

function buildOperationError(
  errorMessage: string | null | undefined,
  status: OperationStatus,
  stage: string | null | undefined,
): OperationError | null {
  if (!errorMessage && status !== "failed") {
    return null;
  }

  return {
    message: errorMessage || "Operation failed.",
    code: status === "failed" ? "operation_failed" : null,
    details: null,
    stage: stage || null,
  };
}

function buildOperationWarning(
  warningMessage: string | null | undefined,
  status: OperationStatus,
  stage: string | null | undefined,
): OperationWarning | null {
  if (!warningMessage && status !== "warning") {
    return null;
  }

  return {
    message: warningMessage || "Operation warning.",
    code: status === "warning" ? "operation_warning" : null,
    details: null,
    stage: stage || null,
  };
}

function mapImportSummaryStatusToOperationStatus(input: ImportEngineSummary): OperationStatus {
  const status = input.status;
  const backgroundStatus = input.backgroundStatus.status;

  switch (status) {
    case "failed":
    case "validation_failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "completed":
    case "finalized":
      if (backgroundStatus === "pending" || backgroundStatus === "running" || backgroundStatus === "failed") {
        return "warning";
      }
      return "completed";
    case "validated":
      return "waiting";
    case "started":
    case "staging":
    case "staged":
    case "validating":
    case "finalizing":
    case "background_processing":
      return "processing";
    case "idle":
    default:
      return backgroundStatus === "pending" ? "waiting" : "waiting";
  }
}

function mapImportSummaryWarningCount(input: ImportEngineSummary, status: OperationStatus) {
  return Number(input.counts.warningCount || 0) + (status === "warning" ? 1 : 0);
}

function mapImportSummaryErrorCount(input: ImportEngineSummary, status: OperationStatus) {
  return Number(input.counts.errorCount || 0) + (status === "failed" ? 1 : 0);
}

function mapImportSummaryUpdatedAt(input: ImportEngineSummary) {
  return input.backgroundStatus.finishedAt || input.backgroundStatus.startedAt || input.finishedAt || input.startedAt;
}

export function mapOperationReadinessFromImportReadiness(input: ImportEngineReadiness): OperationReadiness {
  switch (input) {
    case "ready":
      return "ready";
    case "waiting":
      return "waiting";
    case "processing":
      return "waiting";
    case "failed":
      return "blocked";
    default:
      return "waiting";
  }
}

export function mapImportSummaryToOperationSummary(input: ImportEngineSummary): OperationSummary {
  const status = mapImportSummaryStatusToOperationStatus(input);
  const readiness = mapOperationReadinessFromImportReadiness(
    getImportReadiness(input.status, input.backgroundStatus),
  );
  const errorMessage = input.errorMessage || input.error?.message || input.backgroundStatus.message || null;
  const warningMessage =
    status === "warning"
      ? input.backgroundStatus.message || input.errorMessage || null
      : null;

  return {
    operationId: normalizeOperationId(input.runId),
    operationType: String(input.sourceType || "import"),
    domain: String(input.ownerDomain || "Unknown"),
    owner: String(input.ownerDomain || "Unknown"),
    status,
    readiness,
    progress: buildOperationProgress(input),
    warningCount: mapImportSummaryWarningCount(input, status),
    errorCount: mapImportSummaryErrorCount(input, status),
    startedAt: input.startedAt || null,
    updatedAt: mapImportSummaryUpdatedAt(input),
    finishedAt: input.finishedAt || null,
    retryCount: 0,
    retryAvailable: canRetryOperation(status),
    lastWarning: buildOperationWarning(warningMessage, status, input.sourceType || null),
    lastError: buildOperationError(errorMessage, status, input.sourceType || null),
  };
}

export function mapSupplierImportToOperationSummary(input: SupplierImportRunStatusInput): OperationSummary {
  const importSummary = mapSupplierImportRunToImportSummary(input);
  const readiness = mapOperationReadinessFromImportReadiness(getSupplierImportReadiness(input));
  const hasBackgroundIssue =
    importSummary.backgroundStatus.status === "pending" ||
    importSummary.backgroundStatus.status === "running" ||
    importSummary.backgroundStatus.status === "failed";
  const status: OperationStatus =
    importSummary.status === "failed"
      ? "failed"
      : importSummary.status === "cancelled"
        ? "cancelled"
        : importSummary.status === "validated"
          ? "waiting"
          : importSummary.status === "finalized" || importSummary.status === "completed"
            ? hasBackgroundIssue
              ? "warning"
              : "completed"
            : "processing";
  const warningCount = Number(importSummary.counts.warningCount || 0) + (status === "warning" ? 1 : 0);
  const errorCount = Number(importSummary.counts.errorCount || 0) + (status === "failed" ? 1 : 0);
  const warningMessage =
    status === "warning"
      ? importSummary.backgroundStatus.message || null
      : null;
  const errorMessage = importSummary.errorMessage || importSummary.error?.message || null;

  return {
    operationId: normalizeOperationId(importSummary.runId),
    operationType: String(importSummary.sourceType || "supplier_price_import"),
    domain: String(importSummary.ownerDomain || "Supplier"),
    owner: String(importSummary.ownerDomain || "Supplier"),
    status,
    readiness,
    progress: buildOperationProgress(importSummary),
    warningCount,
    errorCount,
    startedAt: importSummary.startedAt || null,
    updatedAt: mapImportSummaryUpdatedAt(importSummary),
    finishedAt: importSummary.finishedAt || null,
    retryCount: 0,
    retryAvailable: canRetryOperation(status),
    lastWarning: buildOperationWarning(warningMessage, status, importSummary.sourceType || null),
    lastError: buildOperationError(errorMessage, status, importSummary.sourceType || null),
  };
}
