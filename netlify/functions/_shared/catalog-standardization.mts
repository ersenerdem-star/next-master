export function normalizeCatalogDisplayCode(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function normalizeCatalogDescription(value: string): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}
