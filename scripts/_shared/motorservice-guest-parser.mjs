const SECURITY_QUERY_PATTERN = /security\s+query|enter\s+characters|human\s+verification|captcha|verification\s+required/i;

export function parseMotorserviceGuestSnapshot(snapshot, { brandName = "", requestedCode = "" } = {}) {
  const bodyText = cleanText(snapshot?.bodyText);
  const sourceUrl = cleanText(snapshot?.url);
  const links = Array.isArray(snapshot?.links) ? snapshot.links : [];
  const images = Array.isArray(snapshot?.images) ? snapshot.images : [];
  const requested = cleanText(requestedCode);

  if (!bodyText) {
    return {
      status: "rejected",
      reason: "EMPTY_VISIBLE_PAGE",
      source_url: sourceUrl,
    };
  }

  if (SECURITY_QUERY_PATTERN.test(bodyText)) {
    return {
      status: "blocked",
      reason: "SECURITY_QUERY_REQUIRES_MANUAL_COMPLETION",
      source_url: sourceUrl,
    };
  }

  const productCode = extractProductCode(bodyText, sourceUrl, requested) || requested;
  const ean = extractEan(bodyText);
  const description = extractDescription(bodyText, productCode);
  const oemNo = extractReferenceNumbers(bodyText);
  const weightKg = extractWeightKg(bodyText);
  const hsCode = extractHsCode(bodyText);
  const originResult = extractOrigin(bodyText);
  const replacementCodes = extractLabeledCodes(bodyText, [
    "replacement",
    "replacement code",
    "replaces",
  ]);
  const supersededByCodes = extractLabeledCodes(bodyText, [
    "replaced by",
    "superseded by",
    "superceded by",
    "successor",
  ]);
  const alternativeCodes = extractLabeledCodes(bodyText, [
    "alternative",
    "alternatives",
    "alternative product",
  ]);
  const fitmentLinks = links
    .map((link) => ({
      text: cleanText(link?.text),
      href: cleanText(link?.href),
    }))
    .filter((link) => /suitable\s+for\s+(vehicles|engines)|\b(vehicles|engines)\b/i.test(link.text))
    .filter((link) => /^https:\/\/onlineshop\.ms-motorservice\.com\//i.test(link.href));
  const imageUrl =
    images
      .map((image) => cleanText(image?.src))
      .find((src) => isProductImage(src, imageForSource(images, src))) ||
    links
      .map((link) => cleanText(link?.href))
      .find((href) => /^https?:\/\/.+\.(?:png|jpe?g|webp)(?:[?#].*)?$/i.test(href)) ||
    "";

  if (!productCode) {
    return {
      status: "rejected",
      reason: "PRODUCT_CODE_NOT_FOUND",
      source_url: sourceUrl,
    };
  }

  const missingFields = [];
  for (const [field, value] of [
    ["ean", ean],
    ["description", description],
    ["oem_no", oemNo],
    ["image_url", imageUrl],
    ["weight_kg", weightKg],
    ["hs_code", hsCode],
    ["origin", originResult.code],
    ["vehicle_model", ""],
  ]) {
    if (value == null || value === "") missingFields.push(field);
  }

  return {
    status: "accepted",
    source_type: "official_motorservice_guest",
    source_publisher: "MS Motorservice International GmbH",
    source_url: sourceUrl,
    brand: cleanText(brandName),
    product_code: productCode,
    // Preserve punctuation and only remove whitespace, per catalog normalization policy.
    normalized_code: removeWhitespace(productCode),
    ean,
    description,
    oem_no: oemNo,
    vehicle: "",
    vehicle_model: "",
    vehicle_applications: [],
    engine_applications: [],
    hs_code: hsCode,
    origin: originResult.code,
    origin_source_value: originResult.sourceValue,
    weight_kg: weightKg,
    image_url: imageUrl,
    replacement_codes: replacementCodes,
    superseded_by_codes: supersededByCodes,
    alternative_codes: alternativeCodes,
    fitment_links: dedupeLinks(fitmentLinks),
    missing_fields: missingFields,
    raw_capture_retained: false,
  };
}

export function parseMotorserviceFitmentSnapshot(snapshot, { kind = "" } = {}) {
  const bodyText = cleanText(snapshot?.bodyText);
  const sourceUrl = cleanText(snapshot?.url);
  if (!bodyText) {
    return {
      status: "rejected",
      reason: "EMPTY_VISIBLE_PAGE",
      kind: cleanText(kind),
      source_url: sourceUrl,
      entries: [],
    };
  }
  if (SECURITY_QUERY_PATTERN.test(bodyText)) {
    return {
      status: "blocked",
      reason: "SECURITY_QUERY_REQUIRES_MANUAL_COMPLETION",
      kind: cleanText(kind),
      source_url: sourceUrl,
      entries: [],
    };
  }

  const tables = Array.isArray(snapshot?.tables) ? snapshot.tables : [];
  const entries = [];
  const seen = new Set();
  for (const table of tables) {
    if (!Array.isArray(table)) continue;
    for (const row of table) {
      const cells = (Array.isArray(row) ? row : [])
        .map((cell) => cleanText(cell))
        .filter(Boolean);
      if (cells.length < 2 || isFitmentHeader(cells)) continue;
      const value = cells.join(" | ");
      if (seen.has(value)) continue;
      seen.add(value);
      entries.push(value);
      if (entries.length >= 1000) break;
    }
    if (entries.length >= 1000) break;
  }

  return {
    status: entries.length ? "accepted" : "rejected",
    reason: entries.length ? "" : "FITMENT_TABLE_ROWS_NOT_FOUND",
    kind: cleanText(kind),
    source_url: sourceUrl,
    entries,
    truncated: entries.length >= 1000,
    raw_capture_retained: false,
  };
}

function extractProductCode(bodyText, sourceUrl, requestedCode) {
  const urlMatch = String(sourceUrl || "").match(/[?&]ksnr=([^&#]+)/i);
  const urlCode = urlMatch?.[1] ? decodeURIComponent(urlMatch[1]) : "";
  const expectedCode = urlCode || cleanText(requestedCode);
  const groupLine = bodyText
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .find((line) => /^Product group\b/i.test(line));
  if (groupLine) {
    const withoutPrefix = groupLine.replace(/^Product group\s+/i, "");
    if (expectedCode) {
      const words = withoutPrefix.split(/\s+/);
      for (let start = words.length - 1; start >= 0; start -= 1) {
        const suffix = words.slice(start).join(" ");
        if (removeWhitespace(suffix).toUpperCase() === removeWhitespace(expectedCode).toUpperCase()) {
          return cleanText(suffix);
        }
      }
    }
  }

  return expectedCode;
}

function extractEan(bodyText) {
  const match = bodyText.match(/\bEAN\b\s*[:\s]+(\d{8,14})\b/i);
  return match?.[1] || "";
}

function extractDescription(bodyText, productCode) {
  const groupLine = bodyText
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .find((line) => /^Product group\b/i.test(line));
  if (!groupLine) return "";

  const withoutPrefix = groupLine.replace(/^Product group\s+/i, "");
  if (productCode) {
    const escaped = escapeRegExp(productCode);
    const withoutCode = withoutPrefix.replace(new RegExp(`\\s+${escaped}\\s*$`, "i"), "");
    if (withoutCode !== withoutPrefix) return cleanText(withoutCode);
  }
  return cleanText(withoutPrefix);
}

function extractReferenceNumbers(bodyText) {
  const start = bodyText.search(/\bReference numbers\b/i);
  if (start < 0) return "";
  const tail = bodyText.slice(start + "Reference numbers".length);
  const end = tail.search(/\bFurther product information\b/i);
  const section = end >= 0 ? tail.slice(0, end) : tail;
  return section
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter((line) => line && !/^(Reference numbers|Product description)$/i.test(line))
    .filter((line) => /\d/.test(line))
    .slice(0, 100)
    .join(" | ");
}

function extractWeightKg(bodyText) {
  const line = bodyText
    .split(/\r?\n/)
    .map((value) => cleanText(value))
    .find((value) => /^(?:net\s+)?weight\b/i.test(value));
  if (!line) return null;
  const valueMatch = line.match(/(\d+(?:[.,]\d+)?)/);
  if (!valueMatch) return null;
  const numeric = Number(valueMatch[1].replace(",", "."));
  if (!Number.isFinite(numeric)) return null;
  const grams = /(?:\[\s*g\s*\]|\(\s*g\s*\)|\d\s*g\b)/i.test(line);
  return Number((grams ? numeric / 1000 : numeric).toFixed(6));
}

function extractHsCode(bodyText) {
  const line = bodyText
    .split(/\r?\n/)
    .map((value) => cleanText(value))
    .find((value) => /^(?:hs(?:\s+code)?|customs(?:\s+tariff)?(?:\s+number)?|commodity\s+code)\b/i.test(value));
  if (!line) return "";
  const match = line.match(/(?:code|number)?\s*:?\s*([0-9][0-9 .-]{3,})$/i);
  return match?.[1] ? removeWhitespace(match[1]) : "";
}

function extractOrigin(bodyText) {
  const line = bodyText
    .split(/\r?\n/)
    .map((value) => cleanText(value))
    .find((value) => /^(?:country\s+of\s+origin|origin)\b/i.test(value));
  if (!line) return { code: "", sourceValue: "" };
  const sourceValue = cleanText(
    line.replace(/^(?:country\s+of\s+origin|origin)\s*:?\s*/i, ""),
  );
  const aliases = new Map([
    ["austria", "AT"],
    ["belgium", "BE"],
    ["brazil", "BR"],
    ["china", "CN"],
    ["czech republic", "CZ"],
    ["czechia", "CZ"],
    ["france", "FR"],
    ["germany", "DE"],
    ["hungary", "HU"],
    ["india", "IN"],
    ["italy", "IT"],
    ["japan", "JP"],
    ["mexico", "MX"],
    ["poland", "PL"],
    ["portugal", "PT"],
    ["romania", "RO"],
    ["slovakia", "SK"],
    ["south korea", "KR"],
    ["spain", "ES"],
    ["sweden", "SE"],
    ["turkey", "TR"],
    ["türkiye", "TR"],
    ["united kingdom", "GB"],
    ["united states", "US"],
  ]);
  const normalized = sourceValue.toLocaleLowerCase("en-US");
  const code =
    aliases.get(normalized) ||
    (/^[A-Za-z]{2}$/.test(sourceValue) ? sourceValue.toUpperCase() : "");
  return { code, sourceValue };
}

function extractLabeledCodes(bodyText, labels) {
  const labelPattern = labels.map((label) => escapeRegExp(label)).join("|");
  const pattern = new RegExp(`^(?:${labelPattern})\\s*:?\\s*(.+)$`, "i");
  const values = [];
  for (const rawLine of bodyText.split(/\r?\n/)) {
    const match = cleanText(rawLine).match(pattern);
    if (!match?.[1]) continue;
    values.push(
      ...match[1]
        .split(/\s*[|,;]\s*/)
        .map((value) => cleanText(value))
        .filter((value) => /[A-Z0-9]/i.test(value))
        .slice(0, 50),
    );
  }
  return [...new Set(values)];
}

function imageForSource(images, src) {
  return images.find((image) => cleanText(image?.src) === src) || {};
}

function isProductImage(src, image) {
  if (!/^https?:\/\//i.test(src)) return false;
  const evidence = `${cleanText(image?.alt)} ${cleanText(image?.title)} ${src}`;
  if (
    /logo|icon|flag|spacer|pixel|spinner|arrow|button|claim|basket|help/i.test(evidence) ||
    /\/msi\/html\/page\//i.test(src) ||
    /\/static_content\/msicd\/schaftendeform\//i.test(src)
  ) {
    return false;
  }
  return /\.(?:png|jpe?g|webp)(?:[?#].*)?$/i.test(src) || /image|picture|product/i.test(evidence);
}

function isFitmentHeader(cells) {
  const value = cells.join(" ").toLocaleLowerCase("en-US");
  const isLegendRow =
    cells.length === 2 &&
    /^(?:d|g|na|la|p|c|t)$/i.test(cells[0]) &&
    /^(?:diesel|other types? of gas engines?|not charged|charge intercooling|petrol|compressor|turbo(?:charged|charger)?)$/i.test(
      cells[1],
    );
  const knownHeaderCells = new Set([
    "pos",
    "manufacturer",
    "model",
    "model series",
    "vehicle",
    "model years",
    "engine",
    "designation",
    "type of fuel",
    "type of charging",
    "cyl.",
    "valves",
    "kw",
    "ps",
  ]);
  const headerMatches = cells.filter((cell) =>
    knownHeaderCells.has(cell.toLocaleLowerCase("en-US")),
  ).length;
  return (
    (headerMatches >= 2 && !/\d/.test(value)) ||
    /^type of (fuel|charging)\b/.test(value) ||
    isLegendRow
  );
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    const key = `${link.text}::${link.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removeWhitespace(value) {
  return String(value || "").replace(/\s+/g, "");
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
