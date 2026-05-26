export function normalizeCatalogDisplayCode(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function normalizeCatalogDescription(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

