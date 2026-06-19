import { execFileSync } from "node:child_process";

const WEB_CAT_URL = "https://webservice.tecalliance.services/webcat30/v1/services/WebCat30WS.jsonEndpoint";
const TECDOC_URL = "https://webservice.tecalliance.services/pegasus-3-0/services/TecdocToCatDLB.jsonEndpoint";

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(
    execFileSync("npx", ["netlify", "env:get", name], {
      cwd: "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp",
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }) || "",
  ).trim();
}

function normalizeBrandKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function fetchJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
      origin: "https://web.tecalliance.net",
      referer: "https://web.tecalliance.net/",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function fetchCatalogAttributes(catalogKey) {
  const json = await fetchJson(
    WEB_CAT_URL,
    {
      getCatalogAttributes: {
        catalog: catalogKey,
        keys: [],
      },
    },
    { "x-anonymous": catalogKey },
  );
  return json?.getCatalogAttributes || json;
}

async function fetchCatalogBrands(providerId) {
  const langArg = process.argv.find((arg) => arg.startsWith("--lang="));
  const articleCountryArg = process.argv.find((arg) => arg.startsWith("--article-country="));
  const lang = String(langArg?.split("=")[1] || "en").trim();
  const articleCountry = String(articleCountryArg?.split("=")[1] || "GB").trim();
  const json = await fetchJson(TECDOC_URL, {
    getBrands: {
      articleCountry,
      provider: providerId,
      lang,
      dataSupplierIds: [],
      includeDataSupplierStatus: true,
      includeAddressDetails: false,
      includeDataSupplierLogo: false,
    },
  });
  return json?.data?.array || json?.getBrands?.dataSupplierFacets || [];
}

async function fetchExistingBrands() {
  const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${supabaseUrl}/rest/v1/brands?select=name&order=name.asc`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase brands fetch failed (${response.status}): ${text}`);
  }
  return JSON.parse(text);
}

const catalogArg = process.argv.find((arg) => arg.startsWith("--catalog="));
const catalogKey = String(catalogArg?.split("=")[1] || "mahle-catalog").trim();

const catalogAttributes = await fetchCatalogAttributes(catalogKey);
const providerId = Number(catalogAttributes.catalogTecDocId);
if (!Number.isFinite(providerId) || providerId <= 0) {
  throw new Error(`Catalog ${catalogKey} did not expose a valid catalogTecDocId`);
}

const [catalogBrands, existingBrandRows] = await Promise.all([fetchCatalogBrands(providerId), fetchExistingBrands()]);

const existingBrandKeys = new Set(existingBrandRows.map((row) => normalizeBrandKey(row.name)));
const rows = catalogBrands
  .map((item) => ({
    dataSupplierId: item.dataSupplierId,
    manufacturerName: String(item.mfrName || "").trim(),
    inSystem: existingBrandKeys.has(normalizeBrandKey(item.mfrName || "")),
  }))
  .filter((row) => row.manufacturerName)
  .sort((left, right) => left.manufacturerName.localeCompare(right.manufacturerName, "en"));

const missingBrands = rows.filter((row) => !row.inSystem);

console.log(
  JSON.stringify(
    {
      catalogKey,
      catalogId: catalogAttributes.catalogId || null,
      catalogTecDocId: providerId,
      totalCatalogBrands: rows.length,
      existingMatches: rows.length - missingBrands.length,
      missingBrands,
      allBrands: rows,
    },
    null,
    2,
  ),
);
