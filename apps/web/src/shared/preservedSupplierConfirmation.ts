import type { QuoteBuilderLine } from "../types/quoteBuilder";

type PreservationRequest = {
  input_order_id: string | null;
  input_lines: QuoteBuilderLine[];
  input_currency: string;
  input_customer_type: string;
  input_customer_id: string | null;
  input_customer_name: string;
};

// Eligibility is proved against the persisted order and supplier disable time
// by the server. A cached order or supplier option is never sufficient proof.
export async function fetchPreservedSupplierConfirmationLines(
  input: { orderId?: string; lines: QuoteBuilderLine[]; currency: string; customerType: string; customerId: string | null; customerName: string },
  prove: (request: PreservationRequest) => Promise<unknown>,
): Promise<Set<number>> {
  if (!input.lines.length) return new Set();
  const result = await prove({
    input_order_id: input.orderId?.trim() || null,
    input_lines: input.lines,
    input_currency: input.currency,
    input_customer_type: input.customerType,
    input_customer_id: input.customerId,
    input_customer_name: input.customerName,
  });
  const policy = result as { preserved_indices?: unknown; disabled_indices?: unknown } | null;
  const validIndices = (indices: unknown): indices is number[] => Array.isArray(indices)
    && indices.every((index) => Number.isInteger(index) && index >= 0 && index < input.lines.length)
    && new Set(indices).size === indices.length;
  if (!policy || !validIndices(policy.preserved_indices) || !validIndices(policy.disabled_indices)) {
    throw new Error("Saved supplier prices could not be verified. Reload the order before confirming it.");
  }
  if (policy.disabled_indices.length) {
    const line = input.lines[policy.disabled_indices[0]];
    throw new Error(`Supplier ${line.supplier_name} is closed to new prices for ${line.brand} ${line.resolvedCode || line.requestedCode}. Select an active supplier before confirming this line.`);
  }
  return new Set(policy.preserved_indices);
}
