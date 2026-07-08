/**
 * Supplier Import facade for future Import Engine integration.
 * See docs/runtime/platform/IMPORT_ENGINE_BLUEPRINT.md and
 * docs/runtime/platform/SUPPLIER_IMPORT_ADAPTER_ASSESSMENT.md.
 */

import { callAppRpc } from "./appRpcApi";
import { mapSupplierImportRunToImportSummary, type SupplierImportRunStatusInput } from "../../shared/supplierImportStatusMapper";

export type SupplierImportMode = "replace" | "merge";

export type SupplierImportBeginInput = {
  supplierName: string;
  brandName: string;
  mode: SupplierImportMode;
};

export type SupplierImportChunkInput = {
  runId: string;
  payload: Array<Record<string, unknown>>;
};

export type SupplierImportFinalizeInput = {
  runId: string;
};

export type SupplierImportFinalizeBatchInput = {
  runId: string;
  batchSize?: number;
};

export type SupplierImportFinalizeResult = {
  processed?: number;
  catalog_synced?: number;
  deactivated?: number;
  catalog_sync_status?: "pending" | "running" | "succeeded" | "failed" | string;
  catalog_sync_error_message?: string | null;
};

export type SupplierImportBatchFinalizeResult = SupplierImportFinalizeResult & {
  status?: "finalizing" | "finalized" | "succeeded" | "failed" | string;
  staged_rows?: number;
  batch_processed?: number;
  batch_deactivated?: number;
  source_total?: number;
  finalize_phase?: "merge" | "cleanup" | "done" | string;
  has_more?: boolean;
};

export function mapSupplierImportStatus(input: SupplierImportRunStatusInput) {
  return mapSupplierImportRunToImportSummary(input);
}

export function beginSupplierImport(input: SupplierImportBeginInput) {
  return callAppRpc<{ run_id: string; supplier_id: string; brand_id: string; mode: SupplierImportMode; status: string }>(
    "begin_supplier_price_import",
    {
      input_supplier_name: input.supplierName,
      input_brand: input.brandName,
      input_mode: input.mode,
    },
  );
}

export function stageSupplierImportChunk(input: SupplierImportChunkInput) {
  return callAppRpc<{ processed?: number; catalog_synced?: number; staged_rows?: number }>(
    "stage_supplier_price_import_chunk",
    {
      input_run_id: input.runId,
      payload: input.payload,
    },
  );
}

export function finalizeSupplierImport(input: SupplierImportFinalizeInput) {
  return callAppRpc<SupplierImportFinalizeResult>("finalize_supplier_price_import", {
    input_run_id: input.runId,
  });
}

export function finalizeSupplierImportBatch(input: SupplierImportFinalizeBatchInput) {
  return callAppRpc<SupplierImportBatchFinalizeResult>("finalize_supplier_price_import_batch", {
    input_run_id: input.runId,
    input_batch_size: input.batchSize ?? 2000,
  });
}

export function failSupplierImport(runId: string, message: string) {
  return callAppRpc("fail_supplier_price_import", {
    input_run_id: runId,
    input_error_message: message,
  });
}

