export function normalizeCatalogDisplayCode(value: string, brandName = ""): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  if (!text) return "";

  const normalizedBrand = String(brandName || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (normalizedBrand === "hengst") {
    return normalizeHengstDisplayCode(text);
  }

  return text;
}

function normalizeHengstDisplayCode(value: string): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  if (!text) return "";

  // Hengst aftermarket codes use the visible title code, such as
  // "E340H D247". Pure numeric material numbers are internal references and
  // should not be reformatted into a primary catalog code.
  if (/^\d+$/.test(text)) {
    return text;
  }

  const compact = text.replace(/\s+/g, "");
  const spacedMatch = compact.match(/^([A-Z]+\d+[A-Z]*)(D\d+[A-Z0-9]*)$/);
  if (spacedMatch) {
    return `${spacedMatch[1]} ${spacedMatch[2]}`.trim();
  }

  return text;
}

export function normalizeCatalogDescription(value: string): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

const DISCONTINUED_LIFECYCLE_PATTERN =
  /discontinued|obsolete|replaced|replacement only|superceded|superseded|production ended|production end|production stopped|not in production|no longer deliverable|no longer available|not supplied|end of life|article ended|ended|unavailable|not available|teslim edilemiyor|sunulmuyor|artik sunulmuyor|uretimden|kaldirilacak/i;

export function normalizeLifecycleStatus(value: unknown): "active" | "discontinued" {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!text) return "active";
  return DISCONTINUED_LIFECYCLE_PATTERN.test(text) ? "discontinued" : "active";
}

export function sanitizeCatalogOemNumbers(value: unknown): string {
  const raw = String(value || "").replace(/\r/g, "\n").trim();
  if (!raw) return "";

  const parts = raw
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  const values = new Set<string>();
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
