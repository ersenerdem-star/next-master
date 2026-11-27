import { callAppRpc } from "./appRpcApi";

export type SupplierComparisonOffer = {
  supplier_id: string;
  supplier_name: string;
  buy_price: number;
  price_date: string | null;
  moq: number | null;
  order_multiple: number | null;
  stock_qty: number | null;
  valid_to: string | null;
  notes: string | null;
};

/** Read-only details for the exact brand and displayed product code. */
export async function fetchSupplierComparisonOffers(input: { brandId: string; productCode: string }): Promise<SupplierComparisonOffer[]> {
  const data = await callAppRpc<unknown>("report_supplier_comparison_offers", {
    input_brand_id: input.brandId,
    input_product_code: input.productCode,
  });
  if (!Array.isArray(data)) throw new Error("Supplier offers could not be verified.");
  return data.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Supplier offers could not be verified.");
    const row = value as Record<string, unknown>;
    const price = Number(row.buy_price);
    if (!String(row.supplier_id || "").trim() || !String(row.supplier_name || "").trim()
      || row.buy_price == null || !Number.isFinite(price) || price <= 0) {
      throw new Error("Supplier offers could not be verified.");
    }
    const optionalNumber = (item: unknown) => item == null ? null : Number(item);
    const numericFields = [row.moq, row.order_multiple, row.stock_qty].map(optionalNumber);
    if (numericFields.some((item) => item != null && (!Number.isInteger(item) || item < 0))) {
      throw new Error("Supplier offers could not be verified.");
    }
    return {
      supplier_id: String(row.supplier_id), supplier_name: String(row.supplier_name), buy_price: price,
      price_date: row.price_date == null ? null : String(row.price_date),
      moq: numericFields[0], order_multiple: numericFields[1], stock_qty: numericFields[2],
      valid_to: row.valid_to == null ? null : String(row.valid_to), notes: row.notes == null ? null : String(row.notes),
    };
  });
}
