import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const supabaseUrl = process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const ORIGIN_CODES = {
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

function normalizeCatalogOrigin(value) {
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

async function fetchCatalogOriginsPage(offset, limit) {
  const url = new URL(`${supabaseUrl}/rest/v1/catalog_products`);
  url.searchParams.set("select", "id,origin");
  url.searchParams.set("origin", "not.is.null");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("order", "id.asc");
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Catalog origin fetch failed (${response.status})`);
  }
  return response.json();
}

async function patchCatalogOrigin(origin, ids) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?id=in.(${ids.join(",")})`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ origin }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Catalog origin update failed (${response.status}): ${details}`);
  }
}

function chunk(rows, size) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

async function main() {
  const pageSize = 1000;
  const updates = [];
  let offset = 0;
  let scannedRows = 0;

  while (true) {
    const rows = await fetchCatalogOriginsPage(offset, pageSize);
    if (!rows.length) break;
    scannedRows += rows.length;
    for (const row of rows) {
      const currentOrigin = String(row.origin || "").trim();
      const nextOrigin = normalizeCatalogOrigin(currentOrigin);
      if (nextOrigin && nextOrigin !== currentOrigin) {
        updates.push({
          id: row.id,
          origin: nextOrigin,
        });
      }
    }
    console.log(`scanned ${scannedRows} rows, queued ${updates.length} updates`);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  const updatesByOrigin = new Map();
  for (const row of updates) {
    const ids = updatesByOrigin.get(row.origin) || [];
    ids.push(row.id);
    updatesByOrigin.set(row.origin, ids);
  }

  let appliedRows = 0;
  for (const [origin, ids] of updatesByOrigin.entries()) {
    for (const batchIds of chunk(ids, 200)) {
      await patchCatalogOrigin(origin, batchIds);
      appliedRows += batchIds.length;
      console.log(`applied ${appliedRows} / ${updates.length} updates`);
    }
  }

  const summary = {
    checked_at: new Date().toISOString(),
    updated_rows: updates.length,
    examples: updates.slice(0, 25),
  };
  const outputDir = path.join(process.cwd(), "docs", "catalog-standardization");
  await mkdir(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, `origin-normalization-summary-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: true, updated_rows: updates.length, summary_path: summaryPath }, null, 2));
}

await main();
