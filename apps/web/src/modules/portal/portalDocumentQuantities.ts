import { multiplyMoney } from "../../../../../shared/order-money.mjs";

// Export the quantities currently visible in the draft editor. The resulting
// document is a preview; it does not persist the edits to the order.
export function applyDocumentQuantityEdits<T extends { qty: number; unitPrice: number | null; amount?: number | null }>(
  lines: T[], edits: Record<string, number>, orderId: string,
) {
  let changed = false;
  const result = lines.map((line, index) => {
    const next = edits[`${orderId}:${index}`];
    if (next == null || next === line.qty) return line;
    if (!Number.isSafeInteger(next) || next < 1) throw new Error("Quantity must be a positive whole number.");
    changed = true;
    return { ...line, qty: next, amount: line.unitPrice == null ? null : multiplyMoney(line.unitPrice, next) };
  });
  return { lines: result, changed };
}
