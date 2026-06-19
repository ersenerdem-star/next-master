#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "bosch-code-normalization");

const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const apply = process.argv.includes("--apply");
const batchSize = Math.max(50, Number.parseInt(getArgValue("--batch-size=", "250"), 10) || 250);

await mkdir(outputDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const summaryPath = path.join(outputDir, `bosch-code-normalization-summary-${timestamp}.json`);
const csvPath = path.join(outputDir, `bosch-code-normalization-changes-${timestamp}.csv`);

const target = await resolveBoschTarget();
const rows = await fetchAllBoschRows(target.organizationId, target.brandId);

const changes = rows
  .map((row) => {
    const nextCode = normalizeBoschCode(row.product_code || row.normalized_code || "");
    return {
      ...row,
      nextCode,
    };
  })
  .filter((row) => row.nextCode && (row.nextCode !== row.product_code || row.nextCode !== row.normalized_code));

const batches = [];
if (apply && changes.length) {
  for (let index = 0; index < changes.length; index += batchSize) {
    const batch = changes.slice(index, index + batchSize).map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      brand_id: row.brand_id,
      product_code: row.nextCode,
      updated_at: new Date().toISOString(),
    }));
    const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=id`, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Bosch code normalization upsert failed: ${response.status} ${text}`);
    }
    batches.push({ batch: index / batchSize + 1, rows: batch.length, status: response.status });
  }
}

const summary = {
  mode: apply ? "apply" : "plan",
  brand: "Bosch",
  brandId: target.brandId,
  organizationId: target.organizationId,
  scannedRows: rows.length,
  changedRows: changes.length,
  batches,
  sampleChanges: changes.slice(0, 50).map((row) => ({
    id: row.id,
    fromProductCode: row.product_code,
    fromNormalizedCode: row.normalized_code,
    toCode: row.nextCode,
  })),
  csvPath,
};

await writeFile(
  csvPath,
  [
    "id,organization_id,brand_id,from_product_code,from_normalized_code,to_code",
    ...changes.map((row) => toCsvRow([row.id, row.organization_id, row.brand_id, row.product_code, row.normalized_code, row.nextCode])),
  ].join("\n") + "\n",
  "utf8",
);
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ summaryPath, csvPath, ...summary }, null, 2));

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(execFileSync("npx", ["netlify", "env:get", name, "--context", "production"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

function getArgValue(prefix, fallback) {
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length) || fallback;
}

async function resolveBoschTarget() {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands?select=id,organization_id&name=eq.Bosch&limit=1`, {
    headers,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Bosch brand lookup failed: ${response.status} ${text}`);
  }
  const rows = JSON.parse(text || "[]");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id || !row?.organization_id) {
    throw new Error("Bosch brand row was not found");
  }
  return {
    brandId: String(row.id).trim(),
    organizationId: String(row.organization_id).trim(),
  };
}

async function fetchAllBoschRows(organizationId, brandId) {
  const pageLimit = 1000;
  const results = [];
  for (let offset = 0; ; offset += pageLimit) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=id,organization_id,brand_id,product_code,normalized_code&organization_id=eq.${encodeURIComponent(organizationId)}&brand_id=eq.${encodeURIComponent(brandId)}&order=id.asc&limit=${pageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Bosch catalog fetch failed: ${response.status} ${text}`);
    }
    const page = JSON.parse(text || "[]");
    if (!Array.isArray(page) || !page.length) break;
    results.push(
      ...page.map((row) => ({
        id: String(row.id || "").trim(),
        organization_id: String(row.organization_id || "").trim(),
        brand_id: String(row.brand_id || "").trim(),
        product_code: String(row.product_code || "").trim(),
        normalized_code: String(row.normalized_code || "").trim(),
      })),
    );
    if (page.length < pageLimit) break;
  }
  return results;
}

function normalizeBoschCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function toCsvRow(values) {
  return values
    .map((value) => {
      const text = String(value ?? "");
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    })
    .join(",");
}
