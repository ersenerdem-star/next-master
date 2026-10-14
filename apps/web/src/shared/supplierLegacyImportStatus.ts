// The legacy finalizer persists business status and a cursor, but has no
// heartbeat, batch counters or finalize_worker_state column. Keep this read
// contract aligned with the stored schema instead of inventing telemetry.
export const SUPPLIER_LEGACY_IMPORT_COLUMNS = "id,supplier_id,brand_id,status,started_at,finished_at,error_message,staged_rows,processed_rows,finalize_error_message,finalized_at,catalog_synced,catalog_sync_status,catalog_sync_finished_at,catalog_sync_error_message,catalog_sync_cursor,catalog_sync_processed,catalog_sync_last_progress_at,catalog_sync_last_batch_processed,catalog_sync_batches,catalog_sync_worker_state,superseded_by,superseded_at";

type LegacyImportState = {
  status: string;
  error_message: string | null;
  finalize_error_message: string | null;
  finalized_at: string | null;
  finished_at: string | null;
  superseded_by: string | null;
};

export function legacySupplierImportTelemetry(run: LegacyImportState | null | undefined) {
  const completed = run?.status === "finalized" || run?.status === "succeeded";
  const error = run?.error_message || run?.finalize_error_message || (run?.status === "failed" ? "Supplier import failed." : null);
  // A stored running/finalizing status cannot prove that a worker is alive.
  const workerState = run?.superseded_by ? "superseded" : run?.status === "failed" ? "failed" : completed ? "completed" : "unknown";
  return {
    supplier_import_error_message: error,
    supplier_import_worker_state: workerState,
    supplier_import_last_heartbeat_at: null,
    supplier_import_last_progress_at: completed ? run?.finalized_at || run?.finished_at || null : null,
    supplier_import_last_batch_processed: null,
    supplier_import_batches: null,
  };
}
