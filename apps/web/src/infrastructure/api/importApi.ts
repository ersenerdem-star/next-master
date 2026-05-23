import { supabaseClient } from "./supabaseClient";

export async function bulkImportCatalog(payload: Array<Record<string, unknown>>) {
  const { error } = await supabaseClient.rpc("bulk_import_catalog", { payload });
  if (error) throw new Error(error.message || "Catalog import failed");
}

const SUPPLIER_IMPORT_CHUNK_SIZE = 250;

export async function bulkImportSupplierPrices(
  payload: Array<Record<string, unknown>>,
  options?: {
    onProgress?: (input: { processedChunks: number; totalChunks: number; processedRows: number; totalRows: number }) => void;
  },
) {
  let processed = 0;
  let catalogSynced = 0;
  const totalRows = payload.length;
  const totalChunks = Math.max(1, Math.ceil(totalRows / SUPPLIER_IMPORT_CHUNK_SIZE));

  for (let index = 0; index < totalRows; index += SUPPLIER_IMPORT_CHUNK_SIZE) {
    const chunk = payload.slice(index, index + SUPPLIER_IMPORT_CHUNK_SIZE);
    const chunkNumber = Math.floor(index / SUPPLIER_IMPORT_CHUNK_SIZE) + 1;
    const { data, error } = await supabaseClient.rpc("bulk_import_supplier_prices", { payload: chunk });
    if (error) throw new Error(error.message || "Supplier import failed");

    processed += Number((data as { processed?: number } | null)?.processed || chunk.length);
    catalogSynced += Number((data as { catalog_synced?: number } | null)?.catalog_synced || 0);
    options?.onProgress?.({
      processedChunks: chunkNumber,
      totalChunks,
      processedRows: Math.min(index + chunk.length, totalRows),
      totalRows,
    });
  }

  return {
    processed,
    catalogSynced,
    totalRows,
    totalChunks,
  };
}
