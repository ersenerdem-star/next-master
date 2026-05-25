export function normalizePartCode(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeSearchText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const BRAND_ALIAS_MAP: Record<string, string> = {
  bosch: "Bosch",
  donaldson: "Donaldson",
  lemforder: "Lemforder",
  lmi: "Lemforder",
  mann: "Mann",
  mannfilter: "Mann",
  nrf: "NRF",
  sachs: "Sachs",
  trw: "TRW",
  wabco: "WABCO",
};

export function normalizeBrandKey(value: string): string {
  return normalizeSearchText(value);
}

export function canonicalizeBrandName(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return BRAND_ALIAS_MAP[normalizeBrandKey(raw)] || raw;
}

export function isCodeLikeSearch(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  return /\d/.test(raw) || /[^A-Za-z\s]/.test(raw);
}

export function includesLooseText(haystack: string, needle: string): boolean {
  const rawNeedle = String(needle || "").trim().toLowerCase();
  if (!rawNeedle) return true;
  const rawHaystack = String(haystack || "").toLowerCase();
  if (rawHaystack.includes(rawNeedle)) return true;

  const normalizedNeedle = normalizeSearchText(needle);
  if (!normalizedNeedle) return false;
  return normalizeSearchText(haystack).includes(normalizedNeedle);
}

export function normalizeOrigin(value: string): string {
  const raw = String(value || "").trim().toUpperCase();
  return raw;
}

export function splitOriginalNumberCandidates(value: string): string[] {
  const raw = String(value || "").replace(/\r/g, "\n").trim();
  if (!raw) return [];
  const pieces = raw
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return pieces.length ? pieces : [raw];
}

export function matchesOriginalNumberSearch(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizePartCode(needle);
  if (!normalizedNeedle) return false;
  const candidates = splitOriginalNumberCandidates(haystack);
  if (
    candidates.some((candidate) => {
      const normalizedCandidate = normalizePartCode(candidate);
      if (!normalizedCandidate) return false;
      return normalizedCandidate === normalizedNeedle || normalizedCandidate.includes(normalizedNeedle);
    })
  ) {
    return true;
  }
  return normalizePartCode(haystack).includes(normalizedNeedle);
}
