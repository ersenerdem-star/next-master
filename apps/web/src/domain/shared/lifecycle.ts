export type CatalogLifecycleStatus = "active" | "discontinued";

export function normalizeCatalogLifecycleStatus(value: string | null | undefined): CatalogLifecycleStatus {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!text) return "active";
  return /discontinued|obsolete|replaced|replacement only|superceded|superseded|production ended|production end|production stopped|not in production|no longer deliverable|no longer available|not supplied|end of life|article ended|ended|unavailable|not available|teslim edilemiyor|sunulmuyor|artik sunulmuyor|uretimden|kaldirilacak/.test(text)
    ? "discontinued"
    : "active";
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
