#!/usr/bin/env node

import { resolveSyncEnvValue } from "../shared/load-sync-env.mjs";
import { normalizeCatalogDescription, normalizeCatalogEan } from "../shared/catalog/catalog-standardization.mjs";

const projectRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const supabaseUrl = resolveSyncEnvValue("SUPABASE_URL", { projectRoot }).replace(/\/+$/, "");
const serviceRoleKey = resolveSyncEnvValue("SUPABASE_SERVICE_ROLE_KEY", { projectRoot });

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const OVERRIDES = {
  VKBA1051: {
    description: "Wheel bearing kit",
    ean: "3663952069616",
    source_note: "123bearing exact product page",
  },
  VKBA1070: {
    description: "Wheel bearing kit",
    ean: "3663952069654",
    source_note: "123bearing exact product page",
  },
  VKBA3834: {
    description: "Wheel bearing kit",
    ean: "3663952076072",
    source_note: "123bearing exact product page",
  },
  VKBA4500: {
    description: "Wheel bearing kit",
    ean: "7316572871739",
    source_note: "Autodoc exact product result",
  },
  VKBA7155: {
    ean: "7316578246739",
    source_note: "catalog source exact product result",
  },
  VKBA7233: {
    ean: "7316572884753",
    source_note: "catalog source exact product result",
  },
  VKBA7234: {
    ean: "7316572884760",
    source_note: "catalog source exact product result",
  },
  VKBA7235: {
    ean: "7316572884777",
    source_note: "catalog source exact product result",
  },
};

const codes = Object.keys(OVERRIDES);
const rows = await fetchJson(
  `/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,description,ean,oem_no,vehicle,market_segment,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&or=(${codes.map((code) => `product_code.eq.${code}`).join(",")})`,
);

const payload = rows
  .map((row) => {
    const code = String(row.product_code || "").trim().toUpperCase();
    const override = OVERRIDES[code];
    if (!override) return null;
    return {
      organization_id: row.organization_id,
      brand_id: row.brand_id,
      product_code: row.product_code,
      description: normalizeCatalogDescription(String(row.description || "").trim()) || override.description || null,
      ean: normalizeCatalogEan(String(row.ean || "").trim()) || normalizeCatalogEan(override.ean || "") || null,
      oem_no: row.oem_no || null,
      vehicle: row.vehicle || null,
      market_segment: row.market_segment || null,
      hs_code: row.hs_code || null,
      origin: row.origin || null,
      weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
      image_url: row.image_url || null,
      lifecycle_status: row.lifecycle_status || "active",
      lifecycle_note: row.lifecycle_note || override.source_note || null,
      updated_at: new Date().toISOString(),
    };
  })
  .filter(Boolean);

if (!payload.length) {
  throw new Error("No SKF rows matched third-pass override codes");
}

const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
  method: "POST",
  headers: {
    ...headers,
    Prefer: "resolution=merge-duplicates,return=minimal",
  },
  body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) {
  throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
}

console.log(
  JSON.stringify(
    {
      updated_codes: payload.map((row) => row.product_code),
      updated_rows: payload.length,
    },
    null,
    2,
  ),
);

async function fetchJson(pathname) {
  const response = await fetch(`${supabaseUrl}${pathname}`, { headers });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${text}`);
  return Array.isArray(rows) ? rows : [];
}
