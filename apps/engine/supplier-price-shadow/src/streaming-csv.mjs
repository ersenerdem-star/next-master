import { createHash } from "node:crypto";

export const SUPPLIER_SOURCE_COMPATIBILITY_POLICY = "supplier-price-commercial-fields-v1";
export const SUPPLIER_SOURCE_COMMERCIAL_POLICY = "supplier-price-commercial-fields-v2";
// V1 release rows cannot store these fields. V2 opts into their complete contract;
// historical callers still reject nonempty values instead of discarding them.
const UNSUPPORTED_COMMERCIAL_HEADERS = {
  stock_qty: ["stock_qty", "stock_quantity", "stock", "qty_in_stock", "quantity_in_stock", "available_stock", "available_quantity"],
  order_multiple: ["order_multiple", "order_qty_multiple", "pack_multiple", "case_qty", "case_quantity"],
  valid_to: ["valid_to", "valid_until", "valid_through", "price_valid_to", "expiry_date", "expiration_date", "end_date"],
};
const UNSUPPORTED_HEADER_TO_FIELD = new Map(Object.entries(UNSUPPORTED_COMMERCIAL_HEADERS)
  .flatMap(([field, aliases]) => aliases.map((alias) => [normalizeHeader(alias), field])));

const HEADER_ALIASES = {
  brand: ["brand", "make_brand", "manufacturer", "marque"],
  product_code: ["product_code", "part_no", "part_number", "partno", "code", "sku", "article_number", "article_no"],
  description: ["description", "product_description", "product_name", "name"],
  description_tr: ["description_tr", "turkish_description", "description_turkish"],
  oem_no: ["oem_no", "oem", "oem_number", "oem_no_1"],
  ean: ["ean", "ean13", "barcode", "gtin"],
  vehicle: ["vehicle", "vehicle_make", "make"],
  vehicle_model: ["vehicle_model", "model", "vehiclemodel"],
  market_segment: ["market_segment", "segment"],
  dimensions: ["dimensions", "dimension", "size"],
  weight: ["weight", "weight_kg", "weightkg"],
  origin: ["origin", "country_of_origin", "made_in"],
  tariff: ["tariff", "hs_code", "hs", "customs_code"],
  image_url: ["image_url", "image", "image_url_1", "photo"],
  buy_price: [
    "buy_price",
    "buy_price_eur",
    "buy_price_usd",
    "buy_price_gbp",
    "buy_price_try",
    "supplier_price",
    "price",
    "net_price",
    "purchase_price",
  ],
  currency: ["currency", "ccy"],
  moq: ["moq", "minimum_order_quantity", "min_order_qty"],
  lead_time_days: ["lead_time_days", "lead_time", "delivery_days"],
  notes: ["notes", "note", "supplier_notes"],
  valid_from: ["valid_from", "price_date", "date", "effective_date"],
};

const ALIAS_TO_CANONICAL = new Map(
  Object.entries(HEADER_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [normalizeHeader(alias), canonical])),
);

export function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function canonicalizeHeader(value) {
  const normalized = normalizeHeader(value);
  return ALIAS_TO_CANONICAL.get(normalized) || UNSUPPORTED_HEADER_TO_FIELD.get(normalized) || normalized;
}

export function requireSupplierPriceHeaders(headers,format="CSV") {
  const nonempty=headers.filter(Boolean);
  if(new Set(nonempty).size!==nonempty.length)throw Error(`${format}_DUPLICATE_HEADER`);
  if(!nonempty.includes('product_code')||!nonempty.includes('buy_price'))
    throw Error(`${format}_REQUIRED_HEADER_MISSING`);
}

export function inferCurrencyFromHeaders(headers) {
  const currencyHeader = headers.find((value) => /^buy_price_(eur|usd|gbp|try)$/.test(normalizeHeader(value)));
  return currencyHeader ? normalizeHeader(currencyHeader).split("_").at(-1).toUpperCase() : null;
}

export function detectDelimiter(sample) {
  const candidates = [",", ";", "\t"];
  const scores = candidates.map((delimiter) => ({ delimiter, score: countOutsideQuotes(sample, delimiter) }));
  scores.sort((left, right) => right.score - left.score);
  return scores[0]?.score > 0 ? scores[0].delimiter : ",";
}

function countOutsideQuotes(text, delimiter) {
  let quoted = false;
  let count = 0;
  for (const char of String(text ?? "")) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === delimiter) count += 1;
    else if (!quoted && (char === "\n" || char === "\r")) break;
  }
  return count;
}

function parseRecord(text, delimiter) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error("CSV_UNCLOSED_QUOTE");
  values.push(value);
  return values;
}

async function* recordsFromStream(readable, delimiter, maxRecordBytes) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let record = "";
  let quoted = false;
  let pendingCarriageReturn = false;
  for await (const chunk of readable) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const char of text) {
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        if (char === "\n") continue;
      }
      if (char === '"') quoted = !quoted;
      if (!quoted && char === "\r") {
        pendingCarriageReturn = true;
        yield record;
        record = "";
      } else if (!quoted && char === "\n") {
        yield record;
        record = "";
      } else {
        record += char;
        if (record.length > maxRecordBytes) throw new Error("CSV_RECORD_TOO_LARGE");
      }
    }
  }
  const tail = decoder.decode();
  if (tail) record += tail;
  if (record.length > 0) yield record;
}

export async function* parseCsvRows(readable, options = {}) {
  const maxRecordBytes = options.maxRecordBytes ?? 4 * 1024 * 1024;
  let delimiter = options.delimiter;
  let header = null;
  let inferredCurrency = null;
  let sourceRowNumber = 0;
  let sample = "";
  const bufferedRecords = [];

  for await (const record of recordsFromStream(readable, delimiter ?? ",", maxRecordBytes)) {
    if (header === null) {
      sample = record;
      delimiter ??= detectDelimiter(sample);
      const rawHeaders = parseRecord(record, delimiter).map((value) => normalizeHeader(value));
      inferredCurrency = inferCurrencyFromHeaders(rawHeaders);
      header = rawHeaders.map(canonicalizeHeader);
      requireSupplierPriceHeaders(header);
      continue;
    }
    if (!record.trim()) continue;
    sourceRowNumber += 1;
    const values = parseRecord(record, delimiter);
    if (values.length > header.length) throw new Error(`CSV_TOO_MANY_COLUMNS:${sourceRowNumber}`);
    const row = Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""]));
    if (inferredCurrency && !String(row.currency ?? "").trim()) row.currency = inferredCurrency;
    bufferedRecords.push({ sourceRowNumber, row });
    if (bufferedRecords.length >= 1) yield bufferedRecords.shift();
  }
  if (header === null) throw new Error("CSV_MISSING_HEADER");
}

export function normalizeSupplierPriceRow({ sourceRowNumber, row, buyPriceIsNumeric = false }, { commercialFields = false, sourceDate = null } = {}) {
  const unsupportedFields = [...new Set(Object.entries(row)
    .filter(([header, value]) => UNSUPPORTED_HEADER_TO_FIELD.has(normalizeHeader(header))
      && String(value ?? "").trim() !== "")
    .map(([header]) => UNSUPPORTED_HEADER_TO_FIELD.get(normalizeHeader(header))))].sort();
  if (!commercialFields && unsupportedFields.length) {
    throw Object.assign(new Error(`SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD:${unsupportedFields.join(",")}:row=${sourceRowNumber}`), {
      code: "SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD", fields: unsupportedFields, sourceRowNumber,
    });
  }
  const value = (name) => String(row[name] ?? "").trim();
  const productCode = value("product_code");
  // Keep supplier punctuation significant: 61/1 and 611 are distinct SKUs.
  const normalizedCode = productCode.replace(/\s+/g, "").toUpperCase();
  const errors = [];
  const warnings = [];
  if (!/[A-Z0-9]/.test(normalizedCode)) errors.push("MISSING_PRODUCT_CODE");
  const parsedBuyPrice = parseSupplierPriceAmount(value("buy_price"), { typedNumeric: buyPriceIsNumeric });
  const buyPrice = parsedBuyPrice.value;
  if (!value("buy_price")) errors.push("MISSING_BUY_PRICE");
  else if (parsedBuyPrice.ambiguous) errors.push("AMBIGUOUS_BUY_PRICE_FORMAT");
  else if (buyPrice === null || buyPrice <= 0) errors.push("INVALID_BUY_PRICE");
  const weight = parseDecimal(value("weight"));
  if (value("weight") && weight === null) warnings.push("INVALID_WEIGHT");
  const moq = parseInteger(value("moq"));
  if (value("moq") && moq === null) warnings.push("INVALID_MOQ");
  const leadTimeDays = parseInteger(value("lead_time_days"));
  if (value("lead_time_days") && leadTimeDays === null) warnings.push("INVALID_LEAD_TIME");
  let validFrom = normalizeDate(value("valid_from"));
  if (value("valid_from") && validFrom === null) errors.push("INVALID_VALID_FROM");
  if (commercialFields && !value("valid_from")) validFrom = normalizeDate(sourceDate);
  const commercial = commercialFields ? normalizeCommercialFields(row, sourceRowNumber, validFrom) : null;
  const currency = value("currency").toUpperCase();
  if (!currency) errors.push("MISSING_CURRENCY");
  else if (!/^[A-Z]{3}$/.test(currency)) errors.push("INVALID_CURRENCY");
  const normalized = {
    source_row_number: sourceRowNumber,
    brand: value("brand") || null,
    normalized_code: normalizedCode,
    product_code: productCode,
    description: value("description") || null,
    description_tr: value("description_tr") || null,
    oem_no: value("oem_no") || null,
    ean: value("ean") || null,
    vehicle: value("vehicle") || null,
    vehicle_model: value("vehicle_model") || null,
    market_segment: value("market_segment") || null,
    dimensions: value("dimensions") || null,
    weight,
    origin: value("origin") || null,
    tariff: value("tariff") || null,
    image_url: value("image_url") || null,
    buy_price: buyPrice,
    currency: currency || null,
    moq,
    lead_time_days: leadTimeDays,
    notes: value("notes") || null,
    valid_from: validFrom,
    row_status: errors.length ? "rejected" : warnings.length ? "warning" : "accepted",
    error_code: errors[0] || null,
    error_message: errors.length
      ? `${errors.join(",")}${errors.includes("AMBIGUOUS_BUY_PRICE_FORMAT") ? ": write 1234 for a whole amount or 1.2340 for a fractional amount" : ""}`
      : warnings.length ? warnings.join(",") : null,
  };
  // v1 callers keep the exact historical key order, values and row hashes.
  // v2 includes every commercial key, including NULL, in the immutable hash.
  if (commercialFields) Object.assign(normalized, commercial);
  normalized.row_hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return normalized;
}

export async function* parseNormalizedSupplierPriceRows(readable, options = {}) {
  for await (const record of parseCsvRows(readable, options)) yield normalizeSupplierPriceRow(record, options);
}

function invalidCommercial(field, sourceRowNumber) {
  throw Object.assign(new Error(`SUPPLIER_INVALID_COMMERCIAL_FIELD:${field}:row=${sourceRowNumber}`), {
    code: "SUPPLIER_INVALID_COMMERCIAL_FIELD", fields: [field], sourceRowNumber,
  });
}

function normalizeCommercialFields(row, sourceRowNumber, validFrom) {
  const text = field => String(row[field] ?? "").trim();
  const quantity = (field, minimum) => {
    const value = text(field);
    if (!value) return null;
    if (!/^\d+$/.test(value)) invalidCommercial(field, sourceRowNumber);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > 2147483647) invalidCommercial(field, sourceRowNumber);
    return number;
  };
  const stock_qty = quantity("stock_qty", 0);
  const order_multiple = quantity("order_multiple", 1);
  const valid_to = normalizeDate(text("valid_to"));
  if (text("valid_to") && (!valid_to || !validFrom || valid_to < validFrom)) invalidCommercial("valid_to", sourceRowNumber);
  return { stock_qty, order_multiple, valid_to };
}

export function requireNormalizedCommercialFields(row) {
  if (!row || !["stock_qty", "order_multiple", "valid_to"].every(key => Object.hasOwn(row, key))
    || row.stock_qty !== null && (!Number.isInteger(row.stock_qty) || row.stock_qty < 0 || row.stock_qty > 2147483647)
    || row.order_multiple !== null && (!Number.isInteger(row.order_multiple) || row.order_multiple < 1 || row.order_multiple > 2147483647)
    || row.valid_to !== null && (typeof row.valid_to !== "string" || normalizeDate(row.valid_to) !== row.valid_to
      || !row.valid_from || normalizeDate(row.valid_from) !== row.valid_from || row.valid_to < row.valid_from)) throw Error("PREPARED_COMMERCIAL_ROW_INVALID");
  return row;
}

export async function* chunkRows(rows, batchSize = 1000) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw new Error("INVALID_BATCH_SIZE");
  let batch = [];
  let batchNumber = 0;
  for await (const row of rows) {
    batch.push(row);
    if (batch.length < batchSize) continue;
    yield buildBatch(batch, ++batchNumber);
    batch = [];
  }
  if (batch.length) yield buildBatch(batch, ++batchNumber);
}

function buildBatch(rows, batchNumber) {
  const checksum = createHash("sha256");
  for (const row of rows) checksum.update(`${row.source_row_number}:${row.row_hash}\n`);
  return {
    batchNumber,
    cursorStart: rows[0].source_row_number,
    cursorEnd: rows.at(-1).source_row_number,
    rowCount: rows.length,
    checksum: checksum.digest("hex"),
    rows,
  };
}

function parseDecimal(value) {
  if (!value) return null;
  const text = value.replace(/\s+/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/\.(?=\d{3}(?:\D|$))/g, "");
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// A single separator followed by exactly three digits has two valid locale
// meanings: 1.234 may be 1.234 or 1234. Never guess a supplier buy price.
// An XLSX numeric cell is already typed by the workbook and has no ambiguity.
export function parseSupplierPriceAmount(value, { typedNumeric = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return { value: null, ambiguous: false };
  if (typedNumeric) {
    const number = Number(text);
    return { value: Number.isFinite(number) ? number : null, ambiguous: false };
  }

  const plainNumber = /^[+-]?\d+$/;
  const leadingDecimal = /^[+-]?[.,]\d+$/;
  const singleSeparator = /^([+-]?\d+)([.,])(\d+)$/;
  const spaceGrouped = /^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/;
  const commaGrouped = /^[+-]?\d{1,3}(?:,\d{3}){2,}$/;
  const dotGrouped = /^[+-]?\d{1,3}(?:\.\d{3}){2,}$/;
  const commaGroupsDotDecimal = /^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/;
  const dotGroupsCommaDecimal = /^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/;
  let canonical = null;
  if (plainNumber.test(text)) canonical = text;
  else if (leadingDecimal.test(text)) canonical = text.replace(",", ".");
  else if (spaceGrouped.test(text)) canonical = text.replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  else if (commaGrouped.test(text)) canonical = text.replaceAll(",", "");
  else if (dotGrouped.test(text)) canonical = text.replaceAll(".", "");
  else if (commaGroupsDotDecimal.test(text)) canonical = text.replaceAll(",", "");
  else if (dotGroupsCommaDecimal.test(text)) canonical = text.replaceAll(".", "").replace(",", ".");
  else {
    const match = text.match(singleSeparator);
    if (match) {
      const integerDigits = match[1].replace(/^[+-]/, "");
      if (integerDigits.length <= 3 && match[3].length === 3) {
        return { value: null, ambiguous: true };
      }
      canonical = `${match[1]}.${match[3]}`;
    }
  }
  if (canonical === null) return { value: null, ambiguous: false };
  const number = Number(canonical);
  return { value: Number.isFinite(number) ? number : null, ambiguous: false };
}

function parseInteger(value) {
  if (!value) return null;
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      date.getUTCFullYear() === Number(year)
      && date.getUTCMonth() === Number(month) - 1
      && date.getUTCDate() === Number(day)
    ) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return null;
  }
  match = text.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      date.getUTCFullYear() === Number(year)
      && date.getUTCMonth() === Number(month) - 1
      && date.getUTCDate() === Number(day)
    ) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return null;
  }
  return null;
}
