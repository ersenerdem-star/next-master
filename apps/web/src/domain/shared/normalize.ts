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
