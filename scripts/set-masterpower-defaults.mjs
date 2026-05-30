const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const TARGET_BRAND = "Master Power";
const TARGET_ORIGIN = "BR";
const TARGET_HS_CODE = "8414801190";

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const brandUrl = new URL("/rest/v1/brands", supabaseUrl);
brandUrl.searchParams.set("select", "id,name");
brandUrl.searchParams.set("name", `eq.${TARGET_BRAND}`);
brandUrl.searchParams.set("limit", "1");

const brandResponse = await fetch(brandUrl, { headers });
const brandText = await brandResponse.text();
if (!brandResponse.ok) {
  throw new Error(`Brand fetch failed (${brandResponse.status}): ${brandText}`);
}
const brandRows = brandText ? JSON.parse(brandText) : [];
const brandId = String(brandRows[0]?.id || "").trim();
if (!brandId) {
  throw new Error(`Brand not found: ${TARGET_BRAND}`);
}

const rowsUrl = new URL("/rest/v1/catalog_products", supabaseUrl);
rowsUrl.searchParams.set("select", "id,product_code,origin,hs_code");
rowsUrl.searchParams.set("brand_id", `eq.${brandId}`);
rowsUrl.searchParams.set("limit", "5000");

const rowsResponse = await fetch(rowsUrl, { headers });
const rowsText = await rowsResponse.text();
if (!rowsResponse.ok) {
  throw new Error(`Catalog fetch failed (${rowsResponse.status}): ${rowsText}`);
}
const rows = rowsText ? JSON.parse(rowsText) : [];

const changedRows = rows.filter((row) => {
  const origin = String(row.origin || "").trim().toUpperCase();
  const hsCode = String(row.hs_code || "").trim();
  return origin !== TARGET_ORIGIN || hsCode !== TARGET_HS_CODE;
});

const patchUrl = new URL("/rest/v1/catalog_products", supabaseUrl);
patchUrl.searchParams.set("brand_id", `eq.${brandId}`);

const patchResponse = await fetch(patchUrl, {
  method: "PATCH",
  headers: {
    ...headers,
    Prefer: "return=minimal",
  },
  body: JSON.stringify({
    origin: TARGET_ORIGIN,
    hs_code: TARGET_HS_CODE,
  }),
});

const patchText = await patchResponse.text();
if (!patchResponse.ok) {
  throw new Error(`Catalog update failed (${patchResponse.status}): ${patchText}`);
}

console.log(
  JSON.stringify(
    {
      brand: TARGET_BRAND,
      brandId,
      targetOrigin: TARGET_ORIGIN,
      targetHsCode: TARGET_HS_CODE,
      totalRows: rows.length,
      changedRows: changedRows.length,
      status: patchResponse.status,
    },
    null,
    2,
  ),
);
