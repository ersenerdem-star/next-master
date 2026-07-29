#!/usr/bin/env node

/*
 * Bilstein Group PartsFinder observation prototype.
 *
 * Scope: FEBI, SWAG and BLUE_PRINT use the same official list endpoint.
 * This script is read-only: it does not write to Supabase, catalog_products,
 * or catalog_import_stage. It prints normalized observations to stdout so the
 * field coverage can be reviewed before a staging adapter is introduced.
 *
 * Required:
 *   ALLOW_EXTERNAL_OBSERVATION=1
 *
 * Safe defaults:
 *   BRANDS=FEBI,SWAG,BLUE_PRINT
 *   MAX_PER_BRAND=10
 *   START_PAGE=0
 *   PAGE_SIZE=10
 *   COUNTRY=TR
 *   VEHICLE_TYPE=CAR
 */

const API_URL = "https://partsfinder.bilsteingroup.com/api/articles";
const SUPPORTED_BRANDS = new Set(["FEBI", "SWAG", "BLUE_PRINT"]);

const brands = readBrands(process.env.BRANDS || "FEBI,SWAG,BLUE_PRINT");
const maxPerBrand = readPositiveInteger("MAX_PER_BRAND", 10);
const startPage = readNonNegativeInteger("START_PAGE", 0);
const pageSize = readPositiveInteger("PAGE_SIZE", 10);
const country = String(process.env.COUNTRY || "TR").trim().toUpperCase();
const vehicleType = String(process.env.VEHICLE_TYPE || "CAR").trim().toUpperCase();
const requestDelayMs = readNonNegativeInteger("REQUEST_DELAY_MS", 500);

if (process.env.ALLOW_EXTERNAL_OBSERVATION !== "1") {
  fail("Set ALLOW_EXTERNAL_OBSERVATION=1 to run the approved read-only prototype.");
}

console.log("BILSTEIN GROUP OBSERVATION PROTOTYPE START");
console.log(`brands=${brands.join(",")}`);
console.log(`limit_per_brand=${maxPerBrand}`);
console.log(`page=${startPage}; page_size=${pageSize}; country=${country}; vehicle_type=${vehicleType}`);

const summary = [];

for (const brand of brands) {
  const articles = await fetchBrandPage({ brand, pageNumber: startPage, pageSize, country, vehicleType });
  const observations = articles.slice(0, maxPerBrand).map((article) => normalizeObservation({ article, brand, country, vehicleType }));

  for (const observation of observations) {
    console.log(JSON.stringify(observation));
  }

  summary.push({
    brand,
    fetched: articles.length,
    observed: observations.length,
    oem_coverage: observations.filter((item) => item.oem_numbers.length > 0).length,
    technical_attribute_coverage: observations.filter((item) => item.technical_attributes.length > 0).length
  });

  await sleep(requestDelayMs);
}

console.log("BILSTEIN GROUP OBSERVATION PROTOTYPE FINISHED");
console.log(JSON.stringify(summary, null, 2));
console.log("No database table was read or written.");

async function fetchBrandPage({ brand, pageNumber, pageSize: size, country: countryCode, vehicleType: type }) {
  const url = new URL(API_URL);
  url.searchParams.set("page[number]", String(pageNumber));
  url.searchParams.set("page[size]", String(size));
  url.searchParams.set("filter[brands]", brand);
  url.searchParams.set("filter[country]", countryCode);
  url.searchParams.set("filter[vehicleType]", type);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.api+json",
      "User-Agent": "Next-Master Bilstein Group observation prototype"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Bilstein API ${response.status} for ${brand}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

function normalizeObservation({ article, brand, country: countryCode, vehicleType: type }) {
  const attributes = article?.attributes || {};
  const sourceBrand = normalizeBrand(attributes.bgBrand || brand);
  const productCode = cleanText(article?.id);

  if (!productCode) {
    throw new Error(`Bilstein ${sourceBrand} observation is missing article id.`);
  }

  const oemNumbers = normalizeOemNumbers(attributes.oeNumbers);
  const technicalAttributes = normalizeTechnicalAttributes(attributes.articleAttributes);

  return {
    source_key: "bilstein_group_partsfinder_observation",
    source_brand: sourceBrand,
    product_code: productCode,
    description: cleanText(attributes.articleDescription),
    vehicle_type: cleanText(attributes.vehicleType) || type,
    fitting_side: cleanText(attributes.fittingSide),
    packaging_quantity: finiteNumber(attributes.packagingQty),
    oem_numbers: oemNumbers,
    technical_attributes: technicalAttributes,
    // The list endpoint occasionally returns a malformed `links.self` value.
    // Build our own canonical API URL rather than carrying that value forward.
    source_url: buildArticleApiUrl({ productCode, brand: sourceBrand, country: countryCode, vehicleType: type }),
    observed_at: new Date().toISOString(),
    field_coverage: {
      ean: "not_supplied_by_list_endpoint",
      replacement: "not_supplied_by_list_endpoint",
      vehicle_applications: "not_supplied_by_list_endpoint",
      engine_codes: "not_supplied_by_list_endpoint",
      weight: attributeValue(technicalAttributes, ["weight", "net weight", "gross weight"]),
      origin: "not_supplied_by_list_endpoint",
      hs_code: "not_supplied_by_list_endpoint"
    }
  };
}

function normalizeOemNumbers(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => ({
      make: cleanText(entry?.make),
      numbers: unique((Array.isArray(entry?.numbers) ? entry.numbers : []).map(cleanText).filter(Boolean))
    }))
    .filter((entry) => entry.make || entry.numbers.length > 0);
}

function normalizeTechnicalAttributes(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => ({
      type_id: finiteNumber(entry?.typeId),
      name: cleanText(entry?.type),
      value: cleanText(entry?.value),
      unit: cleanText(entry?.unit)
    }))
    .filter((entry) => entry.name && entry.value);
}

function buildArticleApiUrl({ productCode, brand, country: countryCode, vehicleType: type }) {
  const url = new URL(API_URL);
  url.pathname = `/api/articles/${productCode}`;
  url.searchParams.set("filter[brands]", brand);
  url.searchParams.set("filter[country]", countryCode);
  url.searchParams.set("filter[vehicleType]", type);
  return url.toString();
}

function attributeValue(attributes, names) {
  const lookup = new Set(names.map((name) => name.toLowerCase()));
  const match = attributes.find((entry) => lookup.has(String(entry.name || "").toLowerCase()));
  return match ? { value: match.value, unit: match.unit } : null;
}

function normalizeBrand(value) {
  const brand = String(value || "").trim().toUpperCase().replace(/[ -]/g, "_");
  if (!SUPPORTED_BRANDS.has(brand)) {
    throw new Error(`Unsupported Bilstein Group brand returned by API: ${value}`);
  }
  return brand;
}

function readBrands(value) {
  const requested = unique(
    String(value)
      .split(",")
      .map((item) => normalizeBrand(item))
  );

  if (requested.length === 0) {
    fail("BRANDS must contain at least one supported Bilstein Group brand.");
  }

  return requested;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer.`);
  }
  return value;
}

function readNonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer.`);
  }
  return value;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(values)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}
