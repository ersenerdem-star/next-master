/**
 * Canonical Import Engine types and helpers.
 * See docs/runtime/platform/IMPORT_ENGINE_BLUEPRINT.md for the platform contract.
 */

export type ImportEngineStatus =
  | "idle"
  | "started"
  | "staging"
  | "staged"
  | "validating"
  | "validated"
  | "validation_failed"
  | "finalizing"
  | "finalized"
  | "background_processing"
  | "completed"
  | "failed"
  | "cancelled";

export type ImportEngineBackgroundState = "idle" | "pending" | "running" | "completed" | "failed";

export type ImportEngineReadiness = "ready" | "waiting" | "processing" | "failed";

export interface ImportEngineCounts {
  stagedRows: number;
  processedRows: number;
  errorCount: number;
  warningCount: number;
  insertedCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  conflictCount?: number;
}

export interface ImportEngineError {
  message: string;
  code?: string | null;
  details?: string | null;
  rowIndex?: number | null;
  field?: string | null;
}

export interface ImportEngineBackgroundStatus {
  status: ImportEngineBackgroundState;
  message: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: number | null;
}

export interface ImportEngineOperationStatus {
  status: ImportEngineStatus;
  readiness: ImportEngineReadiness;
  backgroundStatus: ImportEngineBackgroundStatus;
}

export interface ImportEngineSummary {
  runId: string;
  organizationId: string;
  ownerDomain: string;
  sourceType: string;
  status: ImportEngineStatus;
  counts: ImportEngineCounts;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
  finalizedBy: string | null;
  backgroundStatus: ImportEngineBackgroundStatus;
  errorMessage: string | null;
  error: ImportEngineError | null;
  conflictSummary: string | null;
}

const TERMINAL_IMPORT_STATUSES = new Set<ImportEngineStatus>([
  "validated",
  "validation_failed",
  "finalized",
  "completed",
  "failed",
  "cancelled",
]);

const FAILED_IMPORT_STATUSES = new Set<ImportEngineStatus>(["validation_failed", "failed"]);

const ACTIVE_IMPORT_STATUSES = new Set<ImportEngineStatus>([
  "started",
  "staging",
  "staged",
  "validating",
  "finalizing",
  "background_processing",
]);

export function isImportTerminalStatus(status: ImportEngineStatus) {
  return TERMINAL_IMPORT_STATUSES.has(status);
}

export function isImportFailedStatus(status: ImportEngineStatus) {
  return FAILED_IMPORT_STATUSES.has(status);
}

export function isImportActiveStatus(status: ImportEngineStatus) {
  return ACTIVE_IMPORT_STATUSES.has(status);
}

export function getImportReadiness(status: ImportEngineStatus, backgroundStatus: ImportEngineBackgroundStatus) {
  if (isImportFailedStatus(status) || backgroundStatus.status === "failed") {
    return "failed";
  }

  if (status === "validated" || status === "finalized" || status === "completed") {
    if (backgroundStatus.status === "idle" || backgroundStatus.status === "completed") {
      return "ready";
    }
    return "processing";
  }

  if (status === "background_processing" || backgroundStatus.status === "pending" || backgroundStatus.status === "running") {
    return "processing";
  }

  if (isImportActiveStatus(status) || status === "idle") {
    return "waiting";
  }

  return "waiting";
}

export function mapImportStatusToTone(status: ImportEngineStatus) {
  switch (status) {
    case "finalized":
    case "completed":
      return "success";
    case "validated":
      return "accent";
    case "started":
    case "staging":
    case "staged":
    case "validating":
    case "finalizing":
    case "background_processing":
      return "info";
    case "validation_failed":
    case "failed":
      return "danger";
    case "cancelled":
      return "muted";
    case "idle":
    default:
      return "muted";
  }
}

