#!/usr/bin/env node

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const brandId = String(process.argv[2] || "").trim();

if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
if (!brandId) throw new Error("brandId is required");

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  Prefer: "return=representation",
};

async function getJson(path) {
  const response = await fetch(`${supabaseUrl}${path}`, { headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return payload;
}

async function removeByIds(table, ids) {
  let deleted = 0;
  for (let index = 0; index < ids.length; index += 20) {
    const batch = ids.slice(index, index + 20);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/${table}?id=in.(${batch.map((id) => encodeURIComponent(id)).join(",")})`,
      {
        method: "DELETE",
        headers: {
          ...headers,
          Prefer: "return=minimal",
        },
      },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text}`);
    deleted += batch.length;
  }
  return deleted;
}

const catalogRows = await getJson(`/rest/v1/catalog_products?select=id&brand_id=eq.${encodeURIComponent(brandId)}&limit=10000`);
const referenceRows = await getJson(`/rest/v1/item_code_references?select=id&brand_id=eq.${encodeURIComponent(brandId)}&limit=10000`);

const deletedCatalogRows = await removeByIds(
  "catalog_products",
  catalogRows.map((row) => String(row.id || "")).filter(Boolean),
);
const deletedReferenceRows = await removeByIds(
  "item_code_references",
  referenceRows.map((row) => String(row.id || "")).filter(Boolean),
);

console.log(JSON.stringify({ brandId, deletedCatalogRows, deletedReferenceRows }, null, 2));
