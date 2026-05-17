import { supabaseClient } from "./supabaseClient";

export async function bulkImportCatalog(payload: Array<Record<string, unknown>>) {
  const { error } = await supabaseClient.rpc("bulk_import_catalog", { payload });
  if (error) throw new Error(error.message || "Catalog import failed");
}

export async function bulkImportSupplierPrices(payload: Array<Record<string, unknown>>) {
  const { error } = await supabaseClient.rpc("bulk_import_supplier_prices", { payload });
  if (error) throw new Error(error.message || "Supplier import failed");
}
