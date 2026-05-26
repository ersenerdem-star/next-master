export function normalizePartCode(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeOriginalNumberSearch(value: string): string {
  const normalized = normalizePartCode(value);
  if (!normalized) return "";
  const stripped = normalized.replace(/^[A-Z]{1,3}(?=\d{6,}$)/, "");
  return stripped || normalized;
}

export function buildLooseOriginalNumberPattern(value: string, wildcard = "%"): string {
  const normalized = normalizeOriginalNumberSearch(value);
  if (!normalized) return "";
  return normalized.split("").join(wildcard);
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

function buildOriginalNumberVariants(value: string): string[] {
  const variants = new Set<string>();
  const normalized = normalizePartCode(value);
  if (normalized) variants.add(normalized);
  const normalizedOriginal = normalizeOriginalNumberSearch(value);
  if (normalizedOriginal) variants.add(normalizedOriginal);
  return [...variants];
}

export function matchesOriginalNumberSearch(haystack: string, needle: string): boolean {
  const needleVariants = buildOriginalNumberVariants(needle);
  if (!needleVariants.length) return false;
  const candidates = splitOriginalNumberCandidates(haystack);
  if (
    candidates.some((candidate) => {
      const candidateVariants = buildOriginalNumberVariants(candidate);
      if (!candidateVariants.length) return false;
      return candidateVariants.some((candidateVariant) =>
        needleVariants.some(
          (needleVariant) =>
            candidateVariant === needleVariant ||
            candidateVariant.includes(needleVariant) ||
            needleVariant.includes(candidateVariant),
        ),
      );
    })
  ) {
    return true;
  }
  const haystackVariants = buildOriginalNumberVariants(haystack);
  return haystackVariants.some((haystackVariant) =>
    needleVariants.some(
      (needleVariant) =>
        haystackVariant === needleVariant ||
        haystackVariant.includes(needleVariant) ||
        needleVariant.includes(haystackVariant),
    ),
  );
}
