function normalizeBrandKey(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatBoschDisplayCode(value: string): string {
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

const ORIGIN_CODES: Record<string, string> = {
  ARGENTINA: "AR",
  AUSTRALIA: "AU",
  AUSTRIA: "AT",
  BELGIUM: "BE",
  BOSNIAANDHERZEGOVINA: "BA",
  BRAZIL: "BR",
  BULGARIA: "BG",
  CANADA: "CA",
  CHINA: "CN",
  CROATIA: "HR",
  CZECHIA: "CZ",
  CZECHREPUBLIC: "CZ",
  DENMARK: "DK",
  EGYPT: "EG",
  ESTONIA: "EE",
  FINLAND: "FI",
  FRANCE: "FR",
  GERMANY: "DE",
  GREECE: "GR",
  HUNGARY: "HU",
  INDIA: "IN",
  INDONESIA: "ID",
  IRELAND: "IE",
  ISRAEL: "IL",
  ITALY: "IT",
  JAPAN: "JP",
  KOREA: "KR",
  LATVIA: "LV",
  LITHUANIA: "LT",
  LUXEMBOURG: "LU",
  MALAYSIA: "MY",
  MEXICO: "MX",
  NETHERLANDS: "NL",
  NORWAY: "NO",
  POLAND: "PL",
  PORTUGAL: "PT",
  ROMANIA: "RO",
  SERBIA: "RS",
  SINGAPORE: "SG",
  SLOVAKIA: "SK",
  SLOVENIA: "SI",
  SOUTHAFRICA: "ZA",
  SOUTHKOREA: "KR",
  SPAIN: "ES",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
  TAIWAN: "TW",
  THAILAND: "TH",
  TURKEY: "TR",
  UNITEDKINGDOM: "GB",
  UNITEDSTATES: "US",
  USA: "US",
  VIETNAM: "VN",
};

export function normalizeCatalogDisplayCode(value: string, brand?: string): string {
  const canonicalBrand = normalizeBrandKey(brand || "");
  if (canonicalBrand === "BOSCH") {
    return formatBoschDisplayCode(value);
  }
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

export function normalizeCatalogOrigin(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const compact = raw
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z]/g, "");
  if (ORIGIN_CODES[compact]) return ORIGIN_CODES[compact];
  if (/^[A-Z]{2,3}$/.test(raw.toUpperCase())) return raw.toUpperCase();
  return raw.replace(/\s+/g, " ").trim();
}
