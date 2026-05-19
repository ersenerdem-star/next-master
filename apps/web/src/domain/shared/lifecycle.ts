export type CatalogLifecycleStatus = "active" | "discontinued";

export function normalizeCatalogLifecycleStatus(value: string | null | undefined): CatalogLifecycleStatus {
  return String(value || "").trim().toLowerCase() === "discontinued" ? "discontinued" : "active";
}

export function buildDiscontinuedWarning(input: {
  resolvedCode: string;
  note?: string | null;
}) {
  const resolvedCode = String(input.resolvedCode || "").trim();
  const note = String(input.note || "").trim();
  const base = resolvedCode ? `Production ended for ${resolvedCode}.` : "Production ended for this item.";
  return note ? `${base} ${note}` : base;
}
