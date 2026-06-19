import { normalizeCatalogDescription, normalizeCatalogDisplayCode } from "../../domain/shared/catalogFormatting";
import { normalizeCatalogMarketSegment } from "../../domain/shared/catalogSegments";
import { callAppRpc } from "./appRpcApi";

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
    const data = await callAppRpc<{ processed?: number; catalog_synced?: number }>("bulk_import_supplier_prices", { payload: chunk });

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
