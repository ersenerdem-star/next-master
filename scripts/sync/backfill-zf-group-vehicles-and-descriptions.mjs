#!/usr/bin/env node

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const TARGET_BRANDS = ["ZF", "Sachs", "Lemforder", "TRW", "Boge"];
const KNOWN_MANUFACTURER_PATTERNS = [
  { label: "Mercedes-Benz", pattern: /\bMERCEDES(?:-BENZ)?\b/ },
  { label: "Volkswagen", pattern: /\b(?:VW|VOLKSWAGEN)\b/ },
  { label: "Audi", pattern: /\bAUDI\b/ },
  { label: "MAN", pattern: /\bMAN\b/ },
  { label: "Volvo", pattern: /\bVOLVO\b/ },
  { label: "DAF", pattern: /\bDAF\b/ },
  { label: "Scania", pattern: /\bSCANIA\b/ },
  { label: "Iveco", pattern: /\bIVECO\b/ },
  { label: "Renault", pattern: /\bRENAULT\b/ },
  { label: "Renault Trucks", pattern: /\bRENAULT\s+TRUCKS\b/ },
  { label: "Ford", pattern: /\bFORD\b/ },
  { label: "BMW", pattern: /\bBMW\b/ },
  { label: "Opel", pattern: /\bOPEL\b/ },
  { label: "Skoda", pattern: /\bSKODA\b/ },
  { label: "Nissan", pattern: /\bNISSAN\b/ },
  { label: "Chevrolet", pattern: /\bCHEVROLET\b/ },
  { label: "Vauxhall", pattern: /\bVAUXHALL\b/ },
  { label: "Cupra", pattern: /\bCUPRA\b/ },
  { label: "Ashok Leyland", pattern: /\bASHOK\s+LEYLAND\b/ },
  { label: "Land Rover", pattern: /\bLAND\s+ROVER\b/ },
  { label: "Toyota", pattern: /\bTOYOTA\b/ },
  { label: "Peugeot", pattern: /\bPEUGEOT\b/ },
  { label: "Citroen", pattern: /\bCITROE?N\b/ },
  { label: "Fiat", pattern: /\bFIAT\b/ },
];

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const brands = await fetchJson(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id`);
const brandRows = brands.filter((row) => TARGET_BRANDS.includes(String(row.name || "").trim()));
const brandMap = new Map(brandRows.map((row) => [String(row.id), String(row.name || "").trim()]));

const changedRows = [];
for (const brand of brandRows) {
  const rows = await fetchAllCatalogRows(String(brand.id));
  for (const row of rows) {
    const brandName = String(brand.name || "").trim();
    const nextDescription = formatDescription(brandName, row.description);
    const nextVehicle = row.vehicle || extractVehicleList(`${row.oem_no || ""} | ${row.description || ""} | ${row.lifecycle_note || ""}`);
    if (
      normalizeText(row.description) === normalizeText(nextDescription) &&
      normalizeText(row.vehicle) === normalizeText(nextVehicle)
    ) {
      continue;
    }
    changedRows.push({
      organization_id: row.organization_id,
      brand_id: row.brand_id,
      product_code: row.product_code,
      description: nextDescription,
      vehicle: nextVehicle,
      updated_at: new Date().toISOString(),
    });
  }
}

const deduped = dedupeBy(changedRows, (row) => `${row.organization_id}::${row.brand_id}::${normalizeCode(row.product_code)}`);
for (let index = 0; index < deduped.length; index += 250) {
  const batch = deduped.slice(index, index + 250);
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
  }
}

const summary = TARGET_BRANDS.map((brandName) => ({
  brand: brandName,
  changed_rows: deduped.filter((row) => brandMap.get(String(row.brand_id)) === brandName).length,
}));

console.log(
  JSON.stringify(
    {
      total_changed_rows: deduped.length,
      summary,
    },
    null,
    2,
  ),
);

async function fetchAllCatalogRows(brandId) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const page = await fetchJson(
      `${supabaseUrl}/rest/v1/catalog_products?select=organization_id,brand_id,product_code,description,oem_no,vehicle,lifecycle_note&brand_id=eq.${encodeURIComponent(brandId)}&limit=${limit}&offset=${offset}`,
    );
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return rows;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`Supabase fetch failed: ${response.status} ${text}`);
  }
  return payload;
}

function formatDescription(brandName, value) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  const stripped = stripBrandPrefix(cleaned, brandName);
  if (!stripped) return "";
  if (isMostlyUppercase(stripped) || stripped === stripped.toLowerCase()) {
    return toTitleCase(stripped);
  }
  return stripped.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

function stripBrandPrefix(value, brandName) {
  const aliases = [brandName, brandName.toUpperCase()];
  let result = value;
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
  }
  return result;
}

function extractVehicleList(raw) {
  const text = cleanText(raw);
  if (!text) return "";
  const hits = [];
  const normalized = ` ${text.toUpperCase()} `;
  for (const entry of KNOWN_MANUFACTURER_PATTERNS) {
    const matchIndex = normalized.search(entry.pattern);
    if (matchIndex < 0) continue;
    hits.push({ label: entry.label, index: matchIndex });
  }
  return dedupeBy(hits.sort((left, right) => left.index - right.index), (item) => item.label.toLowerCase())
    .map((item) => item.label)
    .join(", ");
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function normalizeCode(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function isMostlyUppercase(value) {
  const letters = value.match(/[A-Za-z]/g) || [];
  if (!letters.length) return false;
  const uppercase = letters.filter((letter) => letter === letter.toUpperCase()).length;
  return uppercase / letters.length >= 0.75;
}

function toTitleCase(value) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bZf\b/g, "ZF")
    .replace(/\bTrw\b/g, "TRW");
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
