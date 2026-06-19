#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { canonicalizeBrandName } from "../shared/brand/brand-standardization.mjs";

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(
    execFileSync("npx", ["netlify", "env:get", name], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }) || "",
  ).trim();
}

const brandArg = String(process.argv[2] || "").trim();
if (!brandArg) {
  throw new Error("Usage: node scripts/inspect-brand-footprint.mjs <brand-name>");
}

const brandName = canonicalizeBrandName(brandArg);
const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};

async function getJson(path, extraHeaders = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    headers: { ...headers, ...extraHeaders },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getCount(path) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    headers: { ...headers, Prefer: "count=exact" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${text}`);
  }
  const range = response.headers.get("content-range") || "";
  const total = Number.parseInt(String(range).split("/")[1] || "0", 10);
  return Number.isFinite(total) ? total : 0;
}

const brands = await getJson(
  `/rest/v1/brands?select=id,name,organization_id&name=eq.${encodeURIComponent(brandName)}`,
);
const brand = Array.isArray(brands) ? brands[0] : null;

if (!brand) {
  console.log(
    JSON.stringify(
      {
        brand_name: brandName,
        found: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const supplierSample = await getJson(
  `/rest/v1/supplier_prices?select=product_code&brand_id=eq.${encodeURIComponent(brand.id)}&order=product_code.asc&limit=10`,
);
const catalogSample = await getJson(
  `/rest/v1/catalog_products?select=product_code&brand_id=eq.${encodeURIComponent(brand.id)}&order=product_code.asc&limit=10`,
);

const payload = {
  brand_name: brandName,
  found: true,
  brand_id: brand.id,
  organization_id: brand.organization_id,
  supplier_price_rows: await getCount(
    `/rest/v1/supplier_prices?select=id&brand_id=eq.${encodeURIComponent(brand.id)}`,
  ),
  catalog_rows: await getCount(
    `/rest/v1/catalog_products?select=id&brand_id=eq.${encodeURIComponent(brand.id)}`,
  ),
  supplier_sample: Array.isArray(supplierSample) ? supplierSample.map((row) => row.product_code) : [],
  catalog_sample: Array.isArray(catalogSample) ? catalogSample.map((row) => row.product_code) : [],
};

console.log(JSON.stringify(payload, null, 2));
