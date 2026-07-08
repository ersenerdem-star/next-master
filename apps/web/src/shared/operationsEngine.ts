/**
 * Canonical Operations Engine types and helpers.
 * See docs/runtime/platform/OPERATIONS_ENGINE_BLUEPRINT.md for the platform contract.
 */

export type OperationStatus =
  | "queued"
  | "started"
  | "processing"
  | "waiting"
  | "retrying"
  | "completed"
  | "warning"
  | "failed"
  | "cancelled";

export type OperationReadiness = "ready" | "blocked" | "waiting" | "warning";

export type OperationTone = "success" | "info" | "warning" | "danger" | "muted";

export interface OperationProgress {
  progressPercent: number | null;
  stagedRows: number | null;
  processedRows: number | null;
  totalRows?: number | null;
  currentStep?: string | null;
}

export interface OperationWarning {
  message: string;
  code?: string | null;
  details?: string | null;
  stage?: string | null;
}

export interface OperationError {
  message: string;
  code?: string | null;
  details?: string | null;
  stage?: string | null;
}

export interface OperationSummary {
  operationId: string;
  operationType: string;
  domain: string;
  owner: string;
  status: OperationStatus;
  readiness: OperationReadiness;
  progress: OperationProgress;
  warningCount: number;
  errorCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  retryCount: number;
  lastWarning?: OperationWarning | null;
  lastError?: OperationError | null;
}

const ACTIVE_OPERATION_STATUSES = new Set<OperationStatus>([
  "queued",
  "started",
  "processing",
  "waiting",
  "retrying",
]);

const TERMINAL_OPERATION_STATUSES = new Set<OperationStatus>([
  "completed",
  "warning",
  "failed",
  "cancelled",
]);

const FAILED_OPERATION_STATUSES = new Set<OperationStatus>(["failed"]);

export function isOperationActive(status: OperationStatus) {
  return ACTIVE_OPERATION_STATUSES.has(status);
}

export function isOperationTerminal(status: OperationStatus) {
  return TERMINAL_OPERATION_STATUSES.has(status);
}

export function isOperationFailed(status: OperationStatus) {
  return FAILED_OPERATION_STATUSES.has(status);
}

export function canRetryOperation(input: OperationStatus | Pick<OperationSummary, "status" | "readiness">) {
  const status = typeof input === "string" ? input : input.status;
  const readiness = typeof input === "string" ? null : input.readiness;

  if (status === "failed") return true;
  if (status === "warning" && readiness !== "ready") return true;
  return false;
}

export function getOperationTone(status: OperationStatus): OperationTone {
  switch (status) {
    case "completed":
      return "success";
    case "queued":
    case "started":
    case "processing":
    case "retrying":
      return "info";
    case "waiting":
    case "warning":
      return "warning";
    case "failed":
      return "danger";
    case "cancelled":
    default:
      return "muted";
  }
}
