import type { MasterRow } from "../../types/master";
import { callAppRpc } from "./appRpcApi";

/** Enrich only the visible priced page, without changing any commercial fields. */
export async function enrichSupplierReportCatalog<T extends MasterRow>(brandId: string, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows;
  const codes = [...new Set(rows.map((row) => row.product_code))];
  const requested = new Set(codes);
  const data = await callAppRpc<unknown>("report_supplier_catalog_metadata", {
    input_brand_id: brandId,
    input_product_codes: codes,
  });
  if (!Array.isArray(data)) throw new Error("Catalog details could not be verified.");
  const catalog = new Map<string, Record<string, unknown>>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Catalog details could not be verified.");
    const row = item as Record<string, unknown>;
    const code = String(row.input_code ?? "");
    if (!requested.has(code) || catalog.has(code) || typeof row.product_id !== "string" || !row.product_id.trim()) {
      throw new Error("Catalog details could not be verified.");
    }
    if (row.weight_kg != null && (!Number.isFinite(Number(row.weight_kg)) || Number(row.weight_kg) < 0)) {
      throw new Error("Catalog details could not be verified.");
    }
    catalog.set(code, row);
  }
  const text = (value: unknown, fallback: string | null) =>
    value == null || String(value).trim() === "" ? fallback : String(value);
  return rows.map((row) => {
    const item = catalog.get(row.product_code);
    if (!item) return row;
    return {
      ...row,
      product_id: String(item.product_id),
      description: text(item.description, row.description),
      oem_no: text(item.oem_no, row.oem_no),
      hs_code: text(item.hs_code, row.hs_code),
      origin: text(item.origin, row.origin),
      weight_kg: item.weight_kg == null ? row.weight_kg : Number(item.weight_kg),
      catalog_status: "In Catalog",
    } as T;
  });
}
