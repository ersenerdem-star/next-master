import { callAppRpc } from "./appRpcApi";

/** Return whether any eligible supplier has a note for each exact product code. */
export async function fetchSupplierComparisonNoteIndicators(brandId: string, productCodes: string[]): Promise<Record<string, boolean>> {
  const codes = [...new Set(productCodes)];
  if (!codes.length) return {};
  if (!brandId || codes.length > 50 || codes.some((code) => !code || code.length > 256)) {
    throw new Error("Supplier note request could not be verified.");
  }
  const data = await callAppRpc<unknown>("report_supplier_comparison_note_indicators", {
    input_brand_id: brandId,
    input_product_codes: codes,
  });
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Supplier notes could not be verified.");
  }
  const result = data as Record<string, unknown>;
  if (Object.keys(result).length !== codes.length || codes.some((code) => typeof result[code] !== "boolean")) {
    throw new Error("Supplier notes could not be verified.");
  }
  return Object.fromEntries(codes.map((code) => [code, result[code] as boolean]));
}
