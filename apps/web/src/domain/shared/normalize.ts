export function normalizePartCode(value: string): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeOrigin(value: string): string {
  const raw = String(value || "").trim().toUpperCase();
  return raw;
}
