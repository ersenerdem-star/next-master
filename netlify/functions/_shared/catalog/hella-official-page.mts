import {
  normalizeCatalogDescription,
  normalizeCatalogDisplayCode,
  normalizeCatalogEan,
} from "./catalog-standardization.mts";

export type HellaOfficialProductDetail = {
  product_code: string;
  normalized_code: string;
  ean: string;
  normalized_ean: string;
  description: string;
  image_url: string;
  source_url: string;
};

export function buildHellaOfficialProductUrl(productCode: string, categoryId = "4054") {
  const code = normalizeCatalogDisplayCode(productCode, "Hella");
  const encodedCode = encodeURIComponent(code).replace(/%20/g, "%20");
  return `https://shop.hella.com/hbvnlshop/hbvnl/en_NL/UNIVERSAL/${encodeURIComponent(categoryId)}/na/2/${encodedCode}/universalSearch.xhtml`;
}

export function parseHellaOfficialProductPage(html: string, sourceUrl = ""): HellaOfficialProductDetail {
  const body = String(html || "");
  if (!body.trim()) {
    throw new Error("HELLA official page HTML is empty");
  }
  if (/Human Verification|awswaf|captcha-container/i.test(body)) {
    throw new Error("HELLA official page returned human verification instead of product HTML");
  }

  const productCode =
    extractFirst(body, /<h2[^>]*>\s*Article\s+number:\s*([^<]+?)\s*<\/h2>/i) ||
    extractFirst(body, /name=["']product["']\s+value=["']([^"']+)["']/i) ||
    extractProductCodeFromUrl(sourceUrl);
  const ean =
    extractFirst(body, /<h2[^>]*>\s*EAN:\s*(\d{8,14})\s*<\/h2>/i) ||
    extractLabelValue(body, "EAN") ||
    extractFirst(body, /\bEAN\s*:\s*(\d{8,14})\b/i);
  const title =
    extractFirst(body, /<h1[^>]*class=["'][^"']*\banteros\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
    extractFirst(body, /<title[^>]*>HELLA\s+Aftermarket\s+Catalog,\s*Product:\s*([\s\S]*?)<\/title>/i) ||
    extractJsonString(body, "name");
  const imageUrl =
    extractFirst(body, /<a[^>]+href=["'](https:\/\/shop\.hella\.com\/media\/[^"']+\/bigweb\/[^"']+)["'][^>]*class=["'][^"']*product-images/i) ||
    extractJsonString(body, "image");

  const displayCode = normalizeCatalogDisplayCode(cleanText(productCode), "Hella");
  const normalizedEan = normalizeCatalogEan(ean);
  if (!displayCode) {
    throw new Error("HELLA official product code could not be parsed");
  }
  if (!normalizedEan) {
    throw new Error(`HELLA official EAN could not be parsed for ${displayCode}`);
  }

  return {
    product_code: displayCode,
    normalized_code: normalizeCode(displayCode),
    ean: normalizedEan,
    normalized_ean: normalizedEan,
    description: normalizeCatalogDescription(cleanText(title)),
    image_url: cleanUrl(imageUrl),
    source_url: cleanUrl(sourceUrl) || buildHellaOfficialProductUrl(displayCode),
  };
}

function extractLabelValue(html: string, label: string) {
  const pattern = new RegExp(
    `<span[^>]*class=["'][^"']*propertyName[^"']*["'][^>]*>[\\s\\S]*?<span[^>]*class=["'][^"']*name[^"']*["'][^>]*>\\s*${escapeRegExp(label)}\\s*<\\/span>[\\s\\S]*?<span[^>]*class=["'][^"']*propertyValue[^"']*["'][^>]*>\\s*([^<]+?)\\s*<\\/span>`,
    "i",
  );
  return extractFirst(html, pattern);
}

function extractProductCodeFromUrl(value: string) {
  const match = String(value || "").match(/\/2\/([^/?#]+)\//i);
  return match ? decodeURIComponent(match[1]) : "";
}

function extractJsonString(html: string, key: string) {
  const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
  const raw = extractFirst(html, pattern);
  if (!raw) return "";
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\"/g, '"');
  }
}

function extractFirst(html: string, pattern: RegExp) {
  const match = String(html || "").match(pattern);
  return match ? cleanText(match[1]) : "";
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanUrl(value: unknown) {
  return String(value || "").replace(/&amp;/g, "&").trim();
}

function normalizeCode(value: unknown) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

function escapeRegExp(value: string) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
