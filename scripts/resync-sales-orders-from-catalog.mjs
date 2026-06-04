#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(
    execFileSync("npx", ["netlify", "env:get", name, "--context", "production"], {
      cwd: "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp",
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }) || "",
  ).trim();
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const [rawKey, rawValue] = token.slice(2).split("=", 2);
  if (rawValue != null) {
    args.set(rawKey, rawValue);
    continue;
  }
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(rawKey, next);
    index += 1;
  } else {
    args.set(rawKey, "true");
  }
}

const applyMode = args.has("apply");
const onlyFillBlanks = args.has("only-fill-blanks");
const salesOrderId = String(args.get("sales-order-id") || "").trim();
const organizationId = String(args.get("organization-id") || "").trim();
const limit = Number.parseInt(String(args.get("limit") || "0"), 10) || 0;
const catalogChunkSize = Math.max(25, Number.parseInt(String(args.get("catalog-chunk-size") || "60"), 10) || 60);
const requestedBrands = String(args.get("brands") || "")
  .split(",")
  .map((value) => String(value || "").trim().toLowerCase())
  .filter(Boolean);
const requestedBrandSet = new Set(requestedBrands);

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

function normalizePartCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

function isBlankText(value) {
  return !String(value || "").trim();
}

function isBlankNumber(value) {
  return value == null || Number.isNaN(Number(value));
}

function fillText(current, next) {
  if (!onlyFillBlanks) return String(next || current || "");
  return isBlankText(current) ? String(next || current || "") : String(current || "");
}

function fillNumber(current, next) {
  if (!onlyFillBlanks) return next ?? current ?? null;
  return isBlankNumber(current) ? next ?? current ?? null : current ?? null;
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function buildLifecycleWarning(productCode, lifecycleStatus, lifecycleNote) {
  if (String(lifecycleStatus || "").toLowerCase() !== "discontinued") return null;
  return `Production ended for ${productCode}.${lifecycleNote ? ` ${lifecycleNote}` : ""}`;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function main() {
  const brands = await fetchJson(`${supabaseUrl}/rest/v1/brands?select=id,name&limit=50000`);
  const brandIdByName = new Map(
    (brands || []).map((row) => [String(row.name || "").trim().toLowerCase(), String(row.id || "")]),
  );
  const brandNameById = new Map(
    (brands || []).map((row) => [String(row.id || ""), String(row.name || "").trim().toLowerCase()]),
  );

  const salesOrders = await fetchSalesOrders();
  if (!salesOrders.length) {
    console.log(JSON.stringify({ apply: applyMode, scanned_orders: 0, updated_orders: 0, updated_lines: 0 }, null, 2));
    return;
  }

  const candidates = [];
  for (const order of salesOrders) {
    for (const line of Array.isArray(order.lines) ? order.lines : []) {
      const normalizedBrand = String(line.brand || "").trim().toLowerCase();
      if (requestedBrandSet.size && !requestedBrandSet.has(normalizedBrand)) continue;
      const brandId = brandIdByName.get(String(line.brand || "").trim().toLowerCase()) || "";
      const normalizedCode = normalizePartCode(line.resolvedCode || line.requestedCode || "");
      if (!brandId || !normalizedCode) continue;
      candidates.push({ brandId, normalizedCode });
    }
  }

  const catalogByKey = await fetchCatalogMap(candidates, brandNameById);

  let updatedOrderCount = 0;
  let updatedLineCount = 0;
  const touched = [];

  for (const order of salesOrders) {
    let orderChanged = false;
    const nextLines = (Array.isArray(order.lines) ? order.lines : []).map((line) => {
      const normalizedBrand = String(line.brand || "").trim().toLowerCase();
      if (requestedBrandSet.size && !requestedBrandSet.has(normalizedBrand)) return line;
      const brandId = brandIdByName.get(String(line.brand || "").trim().toLowerCase()) || "";
      const normalizedCode = normalizePartCode(line.resolvedCode || line.requestedCode || "");
      const metadata = catalogByKey.get(`${String(line.brand || "").trim().toLowerCase()}::${normalizedCode}`);
      if (!metadata) return line;

      const nextLine = {
        ...line,
        resolvedCode: onlyFillBlanks ? line.resolvedCode || metadata.product_code : metadata.product_code || line.resolvedCode,
        description: fillText(line.description, metadata.description),
        oem_no: fillText(line.oem_no, metadata.oem_no),
        hs_code: fillText(line.hs_code, metadata.hs_code),
        origin: fillText(line.origin, metadata.origin),
        weight_kg: fillNumber(line.weight_kg ?? null, metadata.weight_kg ?? null),
        lifecycle_status: metadata.lifecycle_status ?? line.lifecycle_status ?? "active",
        lifecycle_note: metadata.lifecycle_note ?? line.lifecycle_note ?? null,
        lifecycle_warning: buildLifecycleWarning(
          metadata.product_code || line.resolvedCode || line.requestedCode,
          metadata.lifecycle_status,
          metadata.lifecycle_note,
        ),
        found: line.found || Boolean(metadata.product_code || metadata.description || metadata.oem_no),
      };

      const changed = JSON.stringify(nextLine) !== JSON.stringify(line);
      if (changed) {
        orderChanged = true;
        updatedLineCount += 1;
      }
      return nextLine;
    });

    if (!orderChanged) continue;
    updatedOrderCount += 1;
    touched.push({
      id: order.id,
      sales_order_no: order.sales_order_no,
      updated_lines: nextLines.length,
    });

    if (applyMode) {
      await fetchJson(`${supabaseUrl}/rest/v1/sales_orders?id=eq.${encodeURIComponent(order.id)}`, {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          lines: nextLines,
          updated_at: new Date().toISOString(),
        }),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        apply: applyMode,
        only_fill_blanks: onlyFillBlanks,
        filtered_brands: [...requestedBrandSet],
        scanned_orders: salesOrders.length,
        updated_orders: updatedOrderCount,
        updated_lines: updatedLineCount,
        touched_orders: touched.slice(0, 50),
      },
      null,
      2,
    ),
  );
}

async function fetchSalesOrders() {
  const filters = [];
  if (organizationId) filters.push(`organization_id=eq.${encodeURIComponent(organizationId)}`);
  if (salesOrderId) filters.push(`id=eq.${encodeURIComponent(salesOrderId)}`);
  const query = [`select=id,organization_id,sales_order_no,lines`, ...filters];
  if (limit > 0) query.push(`limit=${limit}`);
  return await fetchJson(`${supabaseUrl}/rest/v1/sales_orders?${query.join("&")}`);
}

async function fetchCatalogMap(candidates, brandNameById) {
  const result = new Map();
  const groupedBrandIds = [...new Set(candidates.map((item) => item.brandId).filter(Boolean))];
  const groupedCodes = [...new Set(candidates.map((item) => item.normalizedCode).filter(Boolean))];

  for (const codeChunk of chunk(groupedCodes, catalogChunkSize)) {
    const [exactRows, oemRows] = await Promise.all([
      fetchJson(
        `${supabaseUrl}/rest/v1/catalog_products?select=brand_id,product_code,normalized_code,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note&brand_id=in.(${groupedBrandIds.join(",")})&normalized_code=in.(${codeChunk.join(",")})&limit=50000`,
      ),
      fetchJson(
        `${supabaseUrl}/rest/v1/catalog_products?select=brand_id,product_code,normalized_oem,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note&brand_id=in.(${groupedBrandIds.join(",")})&normalized_oem=in.(${codeChunk.join(",")})&limit=50000`,
      ),
    ]);

    for (const row of exactRows || []) {
      const brandName = brandNameById.get(String(row.brand_id || "")) || "";
      const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || "")));
      if (!brandName || !normalizedCode) continue;
      result.set(`${brandName}::${normalizedCode}`, {
        product_code: String(row.product_code || ""),
        description: String(row.description || ""),
        oem_no: String(row.oem_no || ""),
        hs_code: String(row.hs_code || ""),
        origin: String(row.origin || ""),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        lifecycle_status: String(row.lifecycle_status || "").trim().toLowerCase() || null,
        lifecycle_note: String(row.lifecycle_note || "").trim() || null,
      });
    }

    for (const row of oemRows || []) {
      const brandName = brandNameById.get(String(row.brand_id || "")) || "";
      const normalizedCode = String(row.normalized_oem || normalizePartCode(String(row.oem_no || "")));
      if (!brandName || !normalizedCode || result.has(`${brandName}::${normalizedCode}`)) continue;
      result.set(`${brandName}::${normalizedCode}`, {
        product_code: String(row.product_code || ""),
        description: String(row.description || ""),
        oem_no: String(row.oem_no || ""),
        hs_code: String(row.hs_code || ""),
        origin: String(row.origin || ""),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        lifecycle_status: String(row.lifecycle_status || "").trim().toLowerCase() || null,
        lifecycle_note: String(row.lifecycle_note || "").trim() || null,
      });
    }
  }

  return result;
}

await main();
