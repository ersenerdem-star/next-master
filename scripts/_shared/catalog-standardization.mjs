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

const DISCONTINUED_LIFECYCLE_PATTERN =
  /discontinued|obsolete|replaced|replacement only|superceded|superseded|production ended|production end|production stopped|not in production|no longer deliverable|no longer available|not supplied|end of life|article ended|ended|unavailable|not available|teslim edilemiyor|sunulmuyor|artik sunulmuyor|uretimden|kaldirilacak/i;

export function normalizeLifecycleStatus(value) {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!text) return "active";
  return DISCONTINUED_LIFECYCLE_PATTERN.test(text) ? "discontinued" : "active";
}

export function sanitizeCatalogOemNumbers(value) {
  const raw = String(value || "").replace(/\r/g, "\n").trim();
  if (!raw) return "";

  const parts = raw
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  const values = new Set();
  for (const part of parts.length ? parts : [raw]) {
    const digitGroups = part.match(/\d+/g) || [];
    if (!digitGroups.length) continue;
    const longGroups = digitGroups.filter((group) => group.length >= 4);
    if (longGroups.length >= 2) {
      for (const group of longGroups) values.add(group);
      continue;
    }
    const compact = digitGroups.join("");
    if (compact.length >= 4) values.add(compact);
  }

  return [...values].join(", ");
}
