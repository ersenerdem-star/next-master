function normalizeBrandKey(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

const SPACE_ONLY_CODE_BRANDS = new Set([
  "BOSCH",
  "SACHS",
  "LEMFORDER",
  "WABCO",
  "MAHLE",
  "KNORR",
  "KNORRBREMSE",
  "MANN",
  "MANNFILTER",
]);
const DOT_AND_SPACE_CODE_BRANDS = new Set(["ZF"]);

function formatSpaceOnlyDisplayCode(value: string): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function formatDotAndSpaceDisplayCode(value: string): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s.]+/g, "");
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
  if (SPACE_ONLY_CODE_BRANDS.has(canonicalBrand)) {
    return formatSpaceOnlyDisplayCode(value);
  }
  if (DOT_AND_SPACE_CODE_BRANDS.has(canonicalBrand)) {
    return formatDotAndSpaceDisplayCode(value);
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
  const translated = translateTechnicalDescriptionToEnglish(text);
  return translated.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

const TECHNICAL_PHRASE_REPLACEMENTS: Array<[string, string]> = [
  ["diskli fren balatasi seti", "disc brake pad set"],
  ["fren balatasi seti", "brake pad set"],
  ["fren balatasi", "brake pad"],
  ["fren diski", "brake disc"],
  ["hava filtresi", "air filter"],
  ["yag filtresi", "oil filter"],
  ["yakit filtresi", "fuel filter"],
  ["kabin filtresi", "cabin filter"],
  ["polen filtresi", "cabin filter"],
  ["su pompasi", "water pump"],
  ["sicaklik sensoru", "temperature sensor"],
  ["tekerlek hiz sensoru", "wheel speed sensor"],
  ["lambda sensoru", "lambda sensor"],
  ["basinc sensoru", "pressure sensor"],
  ["yag basinc salteri", "oil pressure switch"],
  ["yag basinc anahtari", "oil pressure switch"],
  ["debriyaj alt merkezi", "clutch slave cylinder"],
  ["debriyaj ust merkezi", "clutch master cylinder"],
  ["debriyaj ana merkezi", "clutch master cylinder"],
  ["tamir takimi", "repair kit"],
  ["kayis gergisi", "belt tensioner"],
  ["gergi rulmani", "tensioner pulley"],
  ["triger kayisi", "timing belt"],
  ["v kayisi", "v-belt"],
  ["klima kompresoru", "a/c compressor"],
  ["atesleme bobini", "ignition coil"],
  ["kizdirma bujisi", "glow plug"],
  ["solenoid valfi", "solenoid valve"],
  ["solenoid valf", "solenoid valve"],
  ["silecek supurgesi", "wiper blade"],
  ["silecek kolu", "wiper arm"],
  ["amortisor", "shock absorber"],
  ["direksiyon kutusu", "steering gear"],
];

const TECHNICAL_WORD_REPLACEMENTS: Array<[string, string]> = [
  ["on", "front"],
  ["arka", "rear"],
  ["sol", "left"],
  ["sag", "right"],
  ["ic", "inner"],
  ["dis", "outer"],
  ["ust", "upper"],
  ["alt", "lower"],
  ["takimi", "kit"],
  ["kiti", "kit"],
  ["seti", "set"],
  ["filtre", "filter"],
  ["sensoru", "sensor"],
  ["sensor", "sensor"],
  ["pompa", "pump"],
  ["supap", "valve"],
  ["valfi", "valve"],
  ["silindiri", "cylinder"],
  ["hortumu", "hose"],
];

function translateTechnicalDescriptionToEnglish(value: string): string {
  const compact = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  if (!looksTurkishTechnical(compact)) return compact;

  let normalized = compact
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .replace(/ş/g, "s")
    .replace(/Ş/g, "S")
    .replace(/ğ/g, "g")
    .replace(/Ğ/g, "G")
    .replace(/ç/g, "c")
    .replace(/Ç/g, "C")
    .replace(/ö/g, "o")
    .replace(/Ö/g, "O")
    .replace(/ü/g, "u")
    .replace(/Ü/g, "U")
    .toLowerCase();

  for (const [source, target] of TECHNICAL_PHRASE_REPLACEMENTS) {
    normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(source)}\\b`, "g"), target);
  }
  for (const [source, target] of TECHNICAL_WORD_REPLACEMENTS) {
    normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(source)}\\b`, "g"), target);
  }

  normalized = normalized
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();

  return normalized
    .split(/(\s+|[,;/()-]+)/)
    .map((part) => titleCaseEnglishToken(part))
    .join("")
    .replace(/\bA\/c\b/g, "A/C")
    .replace(/\bAbs\b/g, "ABS");
}

function looksTurkishTechnical(value: string): boolean {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/[çğıöşüÇĞİÖŞÜ]/.test(text)) return true;
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ç/g, "c")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .toLowerCase();
  return /\b(fren|balatasi|diski|yag|yakit|hava|kabin|polen|pompa|sensoru|sicaklik|debriyaj|tamir|takimi|triger|kayisi|amortisor|silecek|direksiyon|solenoid|valfi|supurgesi|tekerlek|hiz)\b/.test(
    normalized,
  );
}

function titleCaseEnglishToken(value: string): string {
  if (!/^[a-z]+$/i.test(value)) return value;
  if (value.length <= 2) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function escapeRegExp(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
