export type SupplierOrderQuantityRule = {
  moq?: number | null;
  order_multiple?: number | null;
};

export type OrderQuantityAdjustment = {
  requested: number;
  corrected: number;
  moq: number;
  orderMultiple: number;
  adjusted: boolean;
  kind: "none" | "moq" | "multiple" | "moq_and_multiple";
};

function positiveInteger(value: number | null | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback;
}

export function normalizeOrderQuantity(requestedQty: number, rule: SupplierOrderQuantityRule = {}): OrderQuantityAdjustment {
  const requested = Math.max(1, Math.floor(Number(requestedQty) || 1));
  const moq = positiveInteger(rule.moq, 1);
  const orderMultiple = positiveInteger(rule.order_multiple, 1);
  const minimum = Math.max(requested, moq);
  const corrected = orderMultiple > 1 ? Math.ceil(minimum / orderMultiple) * orderMultiple : minimum;
  const adjusted = corrected !== requested;
  const kind = !adjusted
    ? "none"
    : orderMultiple > 1 && moq > 1
      ? "moq_and_multiple"
      : orderMultiple > 1
        ? "multiple"
        : "moq";
  return { requested, corrected, moq, orderMultiple, adjusted, kind };
}

export function orderQuantityAdjustmentMessage(
  adjustment: OrderQuantityAdjustment,
  translate: (key: string, params: Record<string, string | number>) => string,
) {
  if (!adjustment.adjusted) return "";
  const params = {
    requested: adjustment.requested,
    corrected: adjustment.corrected,
    moq: adjustment.moq,
    multiple: adjustment.orderMultiple,
  };
  if (adjustment.kind === "moq_and_multiple") return translate("sales.warnings.moqAndPackMultipleAdjusted", params);
  if (adjustment.kind === "multiple") return translate("sales.warnings.packMultipleAdjusted", params);
  return translate("sales.warnings.moqAdjusted", params);
}
