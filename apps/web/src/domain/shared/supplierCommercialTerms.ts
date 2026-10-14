export type SupplierCommercialTerms = {
  moq: number | null;
  order_multiple: number | null;
  stock_qty: number | null;
  valid_to: string | null;
};

const MAX_INTEGER = 2147483647;

/** Read the authoritative commercial RPC contract without converting unknown stock to zero. */
export function readSupplierCommercialTerms(value: unknown): SupplierCommercialTerms {
  if (!value || typeof value !== "object") throw new Error("Supplier commercial rules could not be verified.");
  const row = value as Record<string, unknown>;
  const integer = (field: string, minimum: number) => {
    if (!Object.hasOwn(row, field)) throw new Error("Supplier commercial rules could not be verified.");
    const v = row[field];
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < minimum || v > MAX_INTEGER) {
      throw new Error("Supplier commercial rules could not be verified.");
    }
    return v;
  };
  // Legacy MOQ=0 continues to mean no additional minimum in the existing quantity helper.
  const moq = integer("moq", 0);
  const order_multiple = integer("order_multiple", 1);
  const stock_qty = integer("stock_qty", 0);
  if (!Object.hasOwn(row, "valid_to")) throw new Error("Supplier price validity could not be verified.");
  const valid_to = row.valid_to;
  if (valid_to !== null && (typeof valid_to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valid_to) || valid_to.startsWith("0000-")
    || !Number.isFinite(Date.parse(`${valid_to}T00:00:00Z`))
    || new Date(`${valid_to}T00:00:00Z`).toISOString().slice(0, 10) !== valid_to)) {
    throw new Error("Supplier price validity could not be verified.");
  }
  return { moq, order_multiple, stock_qty, valid_to };
}
