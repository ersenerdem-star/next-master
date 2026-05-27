function normalizeBrandKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatBoschDisplayCode(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  const compact = raw.replace(/[^A-Z0-9]/g, "");
  if (/^\d{10}$/.test(compact)) {
    return `${compact.slice(0, 1)} ${compact.slice(1, 4)} ${compact.slice(4, 7)} ${compact.slice(7, 10)}`;
  }
  return raw
    .replace(/[-_/.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCatalogDisplayCode(value, brand = "") {
  const canonicalBrand = normalizeBrandKey(brand);
  if (canonicalBrand === "BOSCH") {
    return formatBoschDisplayCode(value);
  }
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
