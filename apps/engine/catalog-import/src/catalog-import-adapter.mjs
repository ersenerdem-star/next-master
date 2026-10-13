import { createHash } from "node:crypto";

/**
 * Catalog imports intentionally have their own contract. Supplier price rows
 * contain commercial fields and have different validation rules; sharing that
 * parser would make catalog staging depend on price semantics.
 */
const HEADER_ALIASES = {
  brand: ["brand", "brand_name", "make", "manufacturer", "marka"],
  product_code: ["product_code", "product code", "part_no", "part number", "partno", "code", "sku", "article_number", "article_no", "urun_kodu", "ürün_kodu"],
  description: ["description", "product_name", "product name", "product_description", "name"],
  description_tr: ["description_tr", "description_turkish", "product_name_tr", "product_name_turkish", "name_tr"],
  ean: ["ean", "ean13", "barcode", "gtin"],
  oem_no: ["oem_no", "oem", "oem_number", "original_number"],
  vehicle: ["vehicle", "vehicles", "fit_vehicles", "fit vehicles", "application", "applications"],
  vehicle_model: ["vehicle_model", "vehicle model", "model"],
  hs_code: ["hs_code", "hs", "gtip", "tariff", "customs_code"],
  origin: ["origin", "country_of_origin", "country of origin", "made_in"],
  market_segment: ["market_segment", "market segment", "segment", "catalog_segment"],
  weight_kg: ["weight_kg", "weight kg", "weight", "net_weight", "net weight"],
  image_url: ["image_url", "image url", "image", "photo"],
  lifecycle_status: ["lifecycle_status", "lifecycle status", "lifecycle"],
  lifecycle_note: ["lifecycle_note", "lifecycle note", "discontinued_note", "discontinued note"],
  product_type: ["product_type", "product type"],
  source_url: ["source_url", "source url"],
  source_as_of: ["source_as_of", "source as of", "as_of"],
  source_retrieved_at: ["source_retrieved_at", "source retrieved at", "retrieved_at"],
  source_fingerprint: ["source_fingerprint", "source fingerprint", "payload_fingerprint"],
};

const text = (value) => String(value ?? "").trim();

const ALIAS_TO_CANONICAL = new Map(
  Object.entries(HEADER_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [normalizeCatalogHeader(alias), canonical])),
);

// Keep these aliases in parity with the browser catalog import contract.
const MARKET_SEGMENTS = {
  pc: "pc",
  pkw: "pc",
  passengercar: "pc",
  passenger_car: "pc",
  passenger_cars: "pc",
  passenger_vehicle: "pc",
  passengervehicle: "pc",
  passenger_vehicles: "pc",
  car: "pc",
  cv: "cv",
  truck: "cv",
  truckbus: "cv",
  truck_bus: "cv",
  truck_bus_commercial: "cv",
  truck_bus_light_commercial: "cv",
  commercial: "cv",
  commercial_vehicle: "cv",
  commercialvehicle: "cv",
  commercial_vehicles: "cv",
  lkw: "cv",
  lcv: "lcv",
  light_commercial: "lcv",
  lightcommercial: "lcv",
  light_commercial_vehicle: "lcv",
  lightcommercialvehicle: "lcv",
  light_commercial_vehicles: "lcv",
  van: "lcv",
  motorcycle: "motorcycle",
  motorbike: "motorcycle",
  motorcycles: "motorcycle",
  motorbikes: "motorcycle",
  bike: "motorcycle",
  engine: "engines",
  engines: "engines",
  powertrain: "engines",
  universal: "universal",
  marine: "marine",
  industrial: "industrial",
  agriculture: "agriculture",
  agricultural: "agriculture",
  agri: "agriculture",
  off_highway: "off_highway",
  offhighway: "off_highway",
  ohv: "off_highway",
  oh: "off_highway",
};

const BRAND_COMPACT_CODES = new Set(["bosch", "sachs", "mann", "lemforder", "hengst", "wabco", "knorrbremse"]);
const CANONICAL_BRAND_ALIASES = { lmi: "lemforder", mannfilter: "mann", knorr: "knorrbremse" };

const CATALOG_SOURCE_EXTENSIONS = new Map([
  [".csv", "csv"],
  [".tsv", "tsv"],
  [".txt", "txt"],
]);

export function normalizeCatalogHeader(value) {
  return text(value)
    .replace(/^\uFEFF/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function canonicalizeCatalogHeader(value) {
  const normalized = normalizeCatalogHeader(value);
  return ALIAS_TO_CANONICAL.get(normalized) || normalized;
}

export function detectCatalogDelimiter(sample) {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  let started = false;
  for (const char of String(sample ?? "").replace(/^\uFEFF/, "")) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (started) break;
      continue;
    } else if (!quoted && counts.has(char)) counts.set(char, counts.get(char) + 1);
    if (char.trim()) started = true;
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0][0];
}

export function requireCatalogImportHeaders(headers, { fallbackBrand = "" } = {}) {
  const normalized = headers.map(canonicalizeCatalogHeader);
  if (!normalized.length || normalized.every((header) => !header)) throw new Error("CATALOG_MISSING_HEADER");
  if (new Set(normalized.filter(Boolean)).size !== normalized.filter(Boolean).length) throw new Error("CATALOG_DUPLICATE_HEADER");
  if (!normalized.includes("product_code")) throw new Error("CATALOG_REQUIRED_HEADER_MISSING:product_code");
  if (!normalized.includes("brand") && !text(fallbackBrand)) throw new Error("CATALOG_REQUIRED_HEADER_MISSING:brand");
  return normalized;
}

function compactBrand(value) {
  return text(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function normalizeCatalogMarketSegment(value) {
  // Mirrors domain/shared/catalogSegments.ts, including legacy aliases.
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z_]/g, "").trim();
  return normalized ? MARKET_SEGMENTS[normalized] || null : null;
}

export function normalizeCatalogProductCode(value, brand = "") {
  // Mirrors formatCanonicalProductCode used by importApi, rather than the
  // broader display-only brand formatter. Preserve punctuation for all other
  // brands; 61/1 and 611 must not acquire the same catalog identity.
  const normalized = text(value).replace(/\s+/g, " ").toUpperCase();
  const brandKey = compactBrand(brand);
  const canonicalBrand = CANONICAL_BRAND_ALIASES[brandKey] || brandKey;
  return BRAND_COMPACT_CODES.has(canonicalBrand) ? normalized.replace(/[^A-Z0-9]/g, "") : normalized;
}

function parseCatalogWeight(value) {
  const raw = text(value).replace(/\s+/g, "");
  if (!raw) return null;
  // Reject JS-only numeric forms (hex, Infinity) and malformed grouping.
  if (!/^[+]?(?:\d+(?:[.,]\d+)*|[.,]\d+)$/.test(raw)) return null;
  let normalized = raw;
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const pattern = comma > dot ? /^[+]?\d{1,3}(?:\.\d{3})+,\d+$/ : /^[+]?\d{1,3}(?:,\d{3})+\.\d+$/;
    if (!pattern.test(raw)) return null;
    normalized = comma > dot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (comma >= 0) normalized = raw.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeCatalogLifecycle(value) {
  const raw = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return /discontinued|obsolete|replaced|replacement only|superceded|superseded|production ended|production end|production stopped|not in production|no longer deliverable|no longer available|not supplied|end of life|article ended|ended|unavailable|not available|teslim edilemiyor|sunulmuyor|artik sunulmuyor|uretimden|kaldirilacak/.test(raw) ? "discontinued" : "active";
}

// Description rules mirror importApi's domain/shared/catalogFormatting.ts.
export function normalizeCatalogDescription(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const translated = translateTechnicalDescriptionToEnglish(stripCatalogItemNumberPrefix(text));
  return translated.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

export function stripCatalogItemNumberPrefix(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const labeled = text.replace(/^(?:items?|item|article|part|product)\s*(?:no\.?|number|code)?\s*[:#-]?\s*(?=[A-Z0-9._\/-]*\d)[A-Z0-9][A-Z0-9._\/-]*\s*(?:[-:|]\s*|\s+)(?=[A-Za-z])/i, "");
  if (labeled !== text) return labeled.trim();
  return text.replace(/^(?=[A-Z0-9]*\d)(?:[A-Z]{0,4}\d{4,}[A-Z0-9._\/-]*)\s*[-:|]\s+(.+)$/i, "$1").trim();
}

const TECHNICAL_PHRASE_REPLACEMENTS = [
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

const TECHNICAL_WORD_REPLACEMENTS = [
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

function translateTechnicalDescriptionToEnglish(value) {
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

function looksTurkishTechnical(value) {
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

function titleCaseEnglishToken(value) {
  if (!/^[a-z]+$/i.test(value)) return value;
  if (value.length <= 2) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function catalogRowChecksum(row) {
  return createHash("sha256").update(stableValue(row)).digest("hex");
}

function catalogRowValidationError(sourceRowNumber, errors) {
  const error = new Error(`CATALOG_ROW_INVALID:${sourceRowNumber}:${errors.join(",")}`);
  error.code = "CATALOG_ROW_INVALID";
  error.sourceRowNumber = sourceRowNumber;
  error.validationErrors = [...errors];
  return error;
}

export function normalizeCatalogImportRow({ sourceRowNumber, row, fallbackBrand = "", fallbackMarketSegment = "" }) {
  if (!Number.isSafeInteger(sourceRowNumber) || sourceRowNumber < 1) throw new Error("CATALOG_SOURCE_ROW_INVALID");
  if (row?.row_index != null && String(row.row_index).trim() !== "") {
    const rowIndex = Number(row.row_index);
    if (!Number.isSafeInteger(rowIndex) || rowIndex !== sourceRowNumber - 1) throw new Error("CATALOG_ROW_INDEX_MISMATCH");
  }
  const value = (key) => text(row?.[key]);
  const optionalValue = (key) => {
    const raw = row?.[key];
    return raw == null ? null : String(raw || "").trim() || null;
  };
  const brand = value("brand") || text(fallbackBrand);
  const productCode = normalizeCatalogProductCode(value("product_code"), brand);
  const rawSegment = value("market_segment") || text(fallbackMarketSegment);
  const marketSegment = normalizeCatalogMarketSegment(rawSegment);
  const rawWeight = value("weight_kg");
  const weight = parseCatalogWeight(rawWeight);
  const sourceUrl = value("source_url");
  const fingerprint = value("source_fingerprint").toLowerCase();
  const sourceAsOf = value("source_as_of");
  const sourceRetrievedAt = value("source_retrieved_at");
  const errors = [];
  if (!brand) errors.push("MISSING_BRAND");
  if (!productCode || !/[A-Z0-9]/.test(productCode)) errors.push("MISSING_PRODUCT_CODE");
  if (rawWeight && weight === null) errors.push("INVALID_WEIGHT");
  if (rawSegment && marketSegment === null) errors.push("INVALID_MARKET_SEGMENT");
  if (sourceUrl && !/^https:\/\/[^\s]+$/i.test(sourceUrl)) errors.push("INVALID_SOURCE_URL");
  if (fingerprint && !/^[0-9a-f]{64}$/.test(fingerprint)) errors.push("INVALID_SOURCE_FINGERPRINT");
  if (sourceAsOf && !validCalendarDate(sourceAsOf)) errors.push("INVALID_SOURCE_AS_OF");
  if (sourceRetrievedAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(sourceRetrievedAt)
      || !validCalendarDate(sourceRetrievedAt.slice(0, 10)) || !Number.isFinite(Date.parse(sourceRetrievedAt)))) errors.push("INVALID_SOURCE_RETRIEVED_AT");
  if (errors.length) throw catalogRowValidationError(sourceRowNumber, errors);
  const result = {
    source_row_number: sourceRowNumber,
    row_index: sourceRowNumber - 1,
    brand,
    product_code: productCode,
    normalized_code: productCode,
    description: normalizeCatalogDescription(optionalValue("description")) || null,
    description_tr: optionalValue("description_tr"),
    ean: value("ean") || null,
    oem_no: value("oem_no") || null,
    vehicle: optionalValue("vehicle"),
    vehicle_model: value("vehicle_model") || null,
    hs_code: value("hs_code") || null,
    origin: value("origin") || null,
    market_segment: marketSegment,
    weight_kg: weight,
    image_url: value("image_url") || null,
    lifecycle_status: normalizeCatalogLifecycle(value("lifecycle_status")),
    lifecycle_note: value("lifecycle_note") || null,
    product_type: value("product_type") || null,
    source_url: sourceUrl || null,
    source_as_of: sourceAsOf || null,
    source_retrieved_at: sourceRetrievedAt || null,
    source_fingerprint: fingerprint || null,
    row_status: "accepted",
    error_code: null,
    error_message: null,
  };
  result.row_hash = catalogRowChecksum(result);
  return result;
}

export function toCatalogStagePayload(row) {
  if (!row || typeof row !== "object") throw new Error("CATALOG_ROW_REQUIRED");
  const sourceRowNumber = Number(row.source_row_number ?? (Number(row.row_index) + 1));
  if (!Number.isSafeInteger(sourceRowNumber) || sourceRowNumber < 1) throw new Error("CATALOG_SOURCE_ROW_INVALID");
  if (row.row_status === "rejected" || row.error_code || row.error_message) {
    throw catalogRowValidationError(sourceRowNumber, [row.error_code || row.error_message || "ROW_REJECTED"]);
  }
  // Revalidate at the payload boundary. A caller must not be able to turn a
  // rejected field into NULL and silently stage it as accepted.
  const normalized = normalizeCatalogImportRow({ sourceRowNumber, row });
  const { source_row_number, normalized_code, row_status, error_code, error_message, row_hash, ...payload } = normalized;
  return payload;
}

export function validateCatalogImportSource(source, { requireChecksum = false, maxBytes = 1_073_741_824 } = {}) {
  const metadata = typeof source === "string" ? { sourcePath: source } : source;
  const sourcePath = text(metadata?.sourcePath ?? metadata?.path);
  if (!sourcePath) throw new Error("CATALOG_SOURCE_PATH_REQUIRED");
  if (sourcePath.startsWith("/") || sourcePath.includes("\\") || sourcePath.includes("://") || sourcePath.split("/").some((segment) => !segment || segment === "." || segment === "..") || /[\x00-\x1f\x7f]/.test(sourcePath)) {
    throw new Error("CATALOG_SOURCE_PATH_INVALID");
  }
  const extension = sourcePath.slice(sourcePath.lastIndexOf(".")).toLowerCase();
  const format = CATALOG_SOURCE_EXTENSIONS.get(extension);
  if (!format) throw new Error("CATALOG_SOURCE_FORMAT_UNSUPPORTED");
  const bytes = metadata?.sourceBytes == null ? null : Number(metadata.sourceBytes);
  if (bytes != null && (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes)) throw new Error("CATALOG_SOURCE_SIZE_INVALID");
  const sha256 = text(metadata?.sourceSha256 ?? metadata?.checksum).toLowerCase();
  if (requireChecksum && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("CATALOG_SOURCE_CHECKSUM_REQUIRED");
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("CATALOG_SOURCE_CHECKSUM_INVALID");
  return { sourcePath, format, sourceBytes: bytes, sourceSha256: sha256 || null };
}

const DEFAULT_ROW_BYTES = 1024 * 1024;
const DEFAULT_FIELD_BYTES = 256 * 1024;
const MAX_PARSER_BYTES = 16 * 1024 * 1024;

function parserLimits(options) {
  const maxRowBytes = options.maxRowBytes ?? DEFAULT_ROW_BYTES;
  const maxFieldBytes = options.maxFieldBytes ?? Math.min(DEFAULT_FIELD_BYTES, maxRowBytes);
  const maxColumns = options.maxColumns ?? 256;
  if (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1 || maxRowBytes > MAX_PARSER_BYTES
      || !Number.isSafeInteger(maxFieldBytes) || maxFieldBytes < 1 || maxFieldBytes > maxRowBytes
      || !Number.isSafeInteger(maxColumns) || maxColumns < 1 || maxColumns > 1024) throw new Error("CATALOG_PARSER_LIMIT_INVALID");
  return { maxRowBytes, maxFieldBytes, maxColumns };
}

function splitCatalogRecord(record, delimiter, limits) {
  const values = [];
  let value = "";
  let fieldBytes = 0;
  let mode = "start";
  const append = (char) => {
    fieldBytes += Buffer.byteLength(char, "utf8");
    if (fieldBytes > limits.maxFieldBytes) throw new Error("CATALOG_FIELD_TOO_LARGE");
    value += char;
  };
  const emit = () => {
    values.push(value);
    if (values.length > limits.maxColumns) throw new Error("CATALOG_TOO_MANY_COLUMNS");
    value = ""; fieldBytes = 0; mode = "start";
  };
  for (const char of record) {
    if (mode === "quoted") {
      if (char === '"') mode = "closed";
      else append(char);
    } else if (mode === "closed") {
      if (char === '"') { append(char); mode = "quoted"; }
      else if (char === delimiter) emit();
      else throw new Error("CATALOG_INVALID_QUOTE");
    } else if (char === delimiter) emit();
    else if (char === '"') {
      if (mode !== "start") throw new Error("CATALOG_INVALID_QUOTE");
      mode = "quoted";
    } else { append(char); mode = "unquoted"; }
  }
  if (mode === "quoted") throw new Error("CATALOG_UNTERMINATED_QUOTE");
  emit();
  return values;
}

async function* sourceChunks(source) {
  const input = typeof source === "string" || source instanceof Uint8Array ? [source] : source;
  if (!input || (typeof input[Symbol.asyncIterator] !== "function" && typeof input[Symbol.iterator] !== "function")) throw new Error("CATALOG_SOURCE_NOT_READABLE");
  for await (const chunk of input) {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) throw new Error("CATALOG_SOURCE_CHUNK_INVALID");
    if (typeof chunk === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk)) throw new Error("CATALOG_INVALID_UTF8");
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024);
  }
}

async function* catalogRecords(source, limits) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let record = "";
  let recordBytes = 0;
  let quoted = false;
  let skipLf = false;
  function* scan(decoded) {
    for (const char of decoded) {
      if (skipLf) { skipLf = false; if (char === "\n") continue; }
      if (char === '"') {
        quoted = !quoted;
        recordBytes += 1;
        if (recordBytes > limits.maxRowBytes) throw new Error("CATALOG_ROW_TOO_LARGE");
        record += char;
        continue;
      }
      if (!quoted && (char === "\r" || char === "\n")) {
        if (record.trim()) yield record;
        record = ""; recordBytes = 0;
        skipLf = char === "\r";
        continue;
      }
      recordBytes += Buffer.byteLength(char, "utf8");
      if (recordBytes > limits.maxRowBytes) throw new Error("CATALOG_ROW_TOO_LARGE");
      record += char;
    }
  }
  const decode = (bytes, stream) => {
    try { return decoder.decode(bytes, { stream }); }
    catch { throw new Error("CATALOG_INVALID_UTF8"); }
  };
  for await (const chunk of sourceChunks(source)) yield* scan(decode(chunk, true));
  yield* scan(decode(undefined, false));
  if (quoted) throw new Error("CATALOG_UNTERMINATED_QUOTE");
  if (record.trim()) yield record;
}

export async function* parseCatalogImportRows(source, options = {}) {
  const limits = parserLimits(options);
  let delimiter = options.delimiter ?? null;
  if (delimiter !== null && ![",", ";", "\t"].includes(delimiter)) throw new Error("CATALOG_DELIMITER_INVALID");
  let headers = null;
  let sourceRowNumber = 0;
  const fallbackBrand = text(options.fallbackBrand);
  const fallbackMarketSegment = text(options.fallbackMarketSegment);
  for await (let record of catalogRecords(source, limits)) {
    if (!headers) {
      record = record.replace(/^\uFEFF/, "");
      delimiter ??= detectCatalogDelimiter(record);
      headers = requireCatalogImportHeaders(splitCatalogRecord(record, delimiter, limits), { fallbackBrand });
      continue;
    }
    const values = splitCatalogRecord(record, delimiter, limits);
    if (!values.some((value) => text(value))) continue;
    if (values.length > headers.length) throw new Error(`CATALOG_TOO_MANY_COLUMNS:${sourceRowNumber + 1}`);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    sourceRowNumber += 1;
    yield normalizeCatalogImportRow({ sourceRowNumber, row, fallbackBrand, fallbackMarketSegment });
  }
  if (!headers) throw new Error("CATALOG_MISSING_HEADER");
}

export function assertCatalogCursor(cursor) {
  if (!cursor || !Number.isSafeInteger(Number(cursor.lastSourceRowNumber)) || Number(cursor.lastSourceRowNumber) < 0) throw new Error("CATALOG_CURSOR_INVALID");
  if (cursor.sourceSha256 != null && !/^[0-9a-f]{64}$/i.test(String(cursor.sourceSha256))) throw new Error("CATALOG_CURSOR_CHECKSUM_INVALID");
  return { lastSourceRowNumber: Number(cursor.lastSourceRowNumber), sourceSha256: cursor.sourceSha256 ? String(cursor.sourceSha256).toLowerCase() : null };
}

export function cursorAfterCatalogBatch(batch, sourceSha256 = null) {
  if (!batch || !Number.isSafeInteger(Number(batch.cursorEnd)) || Number(batch.cursorEnd) < 1) throw new Error("CATALOG_BATCH_CURSOR_INVALID");
  return assertCatalogCursor({ lastSourceRowNumber: Number(batch.cursorEnd), sourceSha256: sourceSha256 ?? batch.sourceSha256 ?? null });
}

export async function* createCatalogImportBatches(rows, options = {}) {
  const maxRows = options.maxRows ?? 1000;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000) throw new Error("CATALOG_BATCH_ROW_LIMIT_INVALID");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 10 * 1024 * 1024) throw new Error("CATALOG_BATCH_BYTE_LIMIT_INVALID");
  const resume = assertCatalogCursor({ lastSourceRowNumber: options.resumeAfter ?? 0, sourceSha256: options.sourceSha256 });
  let batch = [];
  let bytes = 2;
  let batchNumber = 0;
  let previousSourceRow = null;
  let nextUnstagedRow = resume.lastSourceRowNumber + 1;
  const flush = () => {
    const checksum = createHash("sha256");
    for (const item of batch) checksum.update(`${item.sourceRowNumber}:${catalogRowChecksum(item.payload)}\n`);
    const result = { batchNumber: ++batchNumber, cursorStart: batch[0].sourceRowNumber, cursorEnd: batch.at(-1).sourceRowNumber,
      rowCount: batch.length, byteLength: bytes, checksum: checksum.digest("hex"), sourceSha256: resume.sourceSha256, rows: batch.map((item) => item.payload) };
    batch = []; bytes = 2;
    return result;
  };
  for await (const row of rows) {
    const sourceRow = Number(row?.source_row_number ?? (Number(row?.row_index) + 1));
    if (!Number.isSafeInteger(sourceRow) || sourceRow < 1) throw new Error("CATALOG_CURSOR_ROW_INVALID");
    if (previousSourceRow !== null && sourceRow !== previousSourceRow + 1) throw new Error("CATALOG_CURSOR_NOT_CONTIGUOUS");
    if (previousSourceRow === null && sourceRow !== 1 && sourceRow !== nextUnstagedRow) throw new Error("CATALOG_CURSOR_NOT_CONTIGUOUS");
    previousSourceRow = sourceRow;
    if (sourceRow <= resume.lastSourceRowNumber) continue;
    if (sourceRow !== nextUnstagedRow) throw new Error("CATALOG_CURSOR_NOT_CONTIGUOUS");
    nextUnstagedRow += 1;
    const payload = toCatalogStagePayload(row);
    const rowBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (rowBytes + 2 > maxBytes) throw new Error(`CATALOG_BATCH_ROW_TOO_LARGE:${sourceRow}`);
    if (batch.length && (batch.length >= maxRows || bytes + rowBytes + 1 > maxBytes)) yield flush();
    bytes += rowBytes + (batch.length ? 1 : 0);
    batch.push({ sourceRowNumber: sourceRow, payload });
  }
  if (previousSourceRow !== null && previousSourceRow < resume.lastSourceRowNumber) throw new Error("CATALOG_CURSOR_BEYOND_SOURCE");
  if (batch.length) yield flush();
}
