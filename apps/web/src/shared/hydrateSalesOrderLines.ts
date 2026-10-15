import type { QuoteBuilderLine } from "../types/quoteBuilder";

// Read-only presentation hydration. Never recompute persisted quantities/prices.
export function hydrateSalesOrderLines(lines: QuoteBuilderLine[], orderId: string): QuoteBuilderLine[] {
  return lines.map((line, index) => ({
    ...line,
    lineId: line.lineId || `stored-${encodeURIComponent(orderId)}-${index + 1}`,
    requestedCode: line.requestedCode ?? line.resolvedCode ?? "",
    resolvedCode: line.resolvedCode ?? line.requestedCode ?? "",
    brand: line.brand ?? "",
    description: line.description ?? "",
    oem_no: line.oem_no ?? "",
    hs_code: line.hs_code ?? "",
    origin: line.origin ?? "",
    weight_kg: line.weight_kg ?? null,
    price_date: line.price_date ?? "",
    notes: line.notes ?? "",
    supplierOptions: line.supplierOptions ?? [],
    selectedSupplierKey: line.selectedSupplierKey ?? "",
    codeChangeWarning: line.codeChangeWarning ?? "",
  }));
}
