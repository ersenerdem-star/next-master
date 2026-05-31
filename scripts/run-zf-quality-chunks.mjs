#!/usr/bin/env node

import { spawn } from "node:child_process";

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const brandArg = parseStringArg("--brands=", "Sachs,Lemforder,TRW,Wabco");
const brands = brandArg
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const chunkSize = parseIntArg("--chunk-size=", 12);
const maxPrefixes = parseIntArg("--max-prefixes=", 0);
const startChunk = parseIntArg("--start-chunk=", 1);
const endChunk = parseIntArg("--end-chunk=", 0);
const detailConcurrency = parseIntArg("--detail-concurrency=", 6);
const batchSize = parseIntArg("--batch-size=", 250);
const sleepMs = parseIntArg("--sleep-ms=", 10);
const missingOnly = !process.argv.includes("--all-existing");
const planOnly = process.argv.includes("--plan-only");

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};

const aggregate = [];

for (const brandName of brands) {
  const plan = await loadBrandPlan(brandName);
  console.error(
    JSON.stringify(
      {
        phase: "plan",
        brand: brandName,
        brandId: plan.brandId,
        organizationId: plan.organizationId,
        beforeRowCount: plan.beforeRowCount,
        scopedRowCount: plan.scopedRowCount,
        prefixCount: plan.prefixes.length,
        chunkSize,
      },
      null,
      2,
    ),
  );

  const chunks = [];
  for (let index = 0; index < plan.prefixes.length; index += chunkSize) {
    chunks.push(plan.prefixes.slice(index, index + chunkSize));
  }
  const effectiveStartChunk = Math.max(1, startChunk);
  const effectiveEndChunk = endChunk > 0 ? Math.min(endChunk, chunks.length) : chunks.length;
  const selectedChunks = chunks.slice(effectiveStartChunk - 1, effectiveEndChunk);

  if (planOnly) {
    aggregate.push({
      brand: brandName,
      brandId: plan.brandId,
      organizationId: plan.organizationId,
      beforeRowCount: plan.beforeRowCount,
      scopedRowCount: plan.scopedRowCount,
      prefixCount: plan.prefixes.length,
      chunkSize,
      totalChunks: chunks.length,
      startChunk: effectiveStartChunk,
      endChunk: effectiveEndChunk,
      selectedChunkCount: selectedChunks.length,
      chunkPreview: selectedChunks.slice(0, 5),
    });
    continue;
  }

  const chunkResults = [];
  for (let index = 0; index < selectedChunks.length; index += 1) {
    const prefixChunk = selectedChunks[index];
    const chunkNumber = effectiveStartChunk + index;
    console.error(
      JSON.stringify(
        {
          phase: "chunk-start",
          brand: brandName,
          chunk: chunkNumber,
          totalChunks: chunks.length,
          prefixChunk,
        },
        null,
        2,
      ),
    );

    const result = await runFillScript({
      brandName,
      prefixChunk,
      detailConcurrency,
      batchSize,
      sleepMs,
    });

    chunkResults.push({
      chunk: chunkNumber,
      totalChunks: chunks.length,
      prefixes: prefixChunk,
      result,
    });

    console.error(
      JSON.stringify(
        {
          phase: "chunk-complete",
          brand: brandName,
          chunk: chunkNumber,
          totalChunks: chunks.length,
          matchedRows: result.matched_rows,
          changedRows: result.changed_rows,
          oemRows: result.oem_rows,
          vehicleRows: result.vehicle_rows,
          imageRows: result.image_rows,
          hsRows: result.hs_rows,
          originRows: result.origin_rows,
          weightRows: result.weight_rows,
          discontinuedRows: result.discontinued_rows,
          replacementRows: result.replacement_rows,
          errorRows: result.error_rows,
        },
        null,
        2,
      ),
    );
  }

  const afterRowCount = await fetchBrandRowCount(plan.organizationId, plan.brandId);
  aggregate.push({
    brand: brandName,
    brandId: plan.brandId,
    organizationId: plan.organizationId,
    beforeRowCount: plan.beforeRowCount,
    scopedRowCount: plan.scopedRowCount,
    afterRowCount,
    prefixCount: plan.prefixes.length,
    chunkSize,
    totalChunks: chunks.length,
    startChunk: effectiveStartChunk,
    endChunk: effectiveEndChunk,
    selectedChunkCount: selectedChunks.length,
    aggregateMatchedRows: sum(chunkResults.map((entry) => entry.result.matched_rows || 0)),
    aggregateChangedRows: sum(chunkResults.map((entry) => entry.result.changed_rows || 0)),
    aggregateOemRows: sum(chunkResults.map((entry) => entry.result.oem_rows || 0)),
    aggregateVehicleRows: sum(chunkResults.map((entry) => entry.result.vehicle_rows || 0)),
    aggregateImageRows: sum(chunkResults.map((entry) => entry.result.image_rows || 0)),
    aggregateHsRows: sum(chunkResults.map((entry) => entry.result.hs_rows || 0)),
    aggregateOriginRows: sum(chunkResults.map((entry) => entry.result.origin_rows || 0)),
    aggregateWeightRows: sum(chunkResults.map((entry) => entry.result.weight_rows || 0)),
    aggregateDiscontinuedRows: sum(chunkResults.map((entry) => entry.result.discontinued_rows || 0)),
    aggregateReplacementRows: sum(chunkResults.map((entry) => entry.result.replacement_rows || 0)),
    aggregateErrorRows: sum(chunkResults.map((entry) => entry.result.error_rows || 0)),
    chunkResults,
  });
}

console.log(JSON.stringify({ brands: aggregate }, null, 2));

async function loadBrandPlan(brandName) {
  const brandsPayload = await fetchJson(
    `${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=ilike.${encodeURIComponent(brandName)}&limit=5`,
  );
  const brand = Array.isArray(brandsPayload)
    ? brandsPayload.find((row) => normalizeBrand(row.name) === normalizeBrand(brandName))
    : null;

  if (!brand?.id || !brand?.organization_id) {
    throw new Error(`Brand row not found for ${brandName}`);
  }

  const rows = await fetchAllCatalogRows(brand.organization_id, brand.id);
  const scopedRows = missingOnly ? rows.filter((row) => shouldProcessRow(row)) : rows;
  const prefixes = buildAdaptivePrefixes(
    scopedRows
      .map((row) => normalizeCode(row.normalized_code || row.product_code || ""))
      .filter((value) => value.length >= 3),
  );

  return {
    brandId: String(brand.id),
    organizationId: String(brand.organization_id),
    beforeRowCount: rows.length,
    scopedRowCount: scopedRows.length,
    prefixes: maxPrefixes > 0 ? prefixes.slice(0, maxPrefixes) : prefixes,
  };
}

async function fetchAllCatalogRows(organizationId, brandId) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchJson(
      `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code,oem_no,vehicle,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&organization_id=eq.${organizationId}&brand_id=eq.${brandId}&limit=${pageSize}&offset=${offset}`,
    );
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchBrandRowCount(organizationId, brandId) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/catalog_products?select=id&organization_id=eq.${organizationId}&brand_id=eq.${brandId}`,
    {
      method: "HEAD",
      headers: {
        ...headers,
        Prefer: "count=exact",
      },
    },
  );
  if (!response.ok) throw new Error(`Brand row count failed: ${response.status}`);
  const contentRange = response.headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function buildAdaptivePrefixes(normalizedCodes) {
  const firstLevel = countPrefixes(normalizedCodes, 3);
  const prefixes = [];

  for (const [prefix3, count3] of sortCounts(firstLevel)) {
    if (count3 <= 350) {
      prefixes.push(prefix3);
      continue;
    }

    const matching3 = normalizedCodes.filter((value) => value.startsWith(prefix3));
    const secondLevel = countPrefixes(matching3, 4);
    for (const [prefix4, count4] of sortCounts(secondLevel)) {
      if (count4 <= 180) {
        prefixes.push(prefix4);
        continue;
      }

      const matching4 = matching3.filter((value) => value.startsWith(prefix4));
      const thirdLevel = countPrefixes(matching4, 5);
      for (const [prefix5] of sortCounts(thirdLevel)) {
        prefixes.push(prefix5);
      }
    }
  }

  return [...new Set(prefixes)];
}

function countPrefixes(values, length) {
  const counts = new Map();
  for (const value of values) {
    if (value.length < length) continue;
    const prefix = value.slice(0, length);
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  return counts;
}

function sortCounts(counts) {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function runFillScript({ brandName, prefixChunk, detailConcurrency, batchSize, sleepMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      "scripts/fill-zf-aftermarket-details.mjs",
      "--apply",
      "--skip-discovery",
      `--brands=${brandName}`,
      `--existing-prefixes=${prefixChunk.join(",")}`,
      `--detail-concurrency=${detailConcurrency}`,
      `--batch-size=${batchSize}`,
      `--sleep-ms=${sleepMs}`,
    ];
    if (missingOnly) {
      args.push("--missing-only");
    } else {
      args.push("--refresh-existing");
    }

    const child = spawn(process.execPath, args, {
      cwd: "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`fill-zf-aftermarket-details exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse fill-zf-aftermarket-details output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${url}`);
  }
  return response.json();
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeBrand(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function shouldProcessRow(row) {
  if (!String(row.oem_no || "").trim()) return true;
  if (!String(row.vehicle || "").trim()) return true;
  if (!String(row.hs_code || "").trim()) return true;
  if (!String(row.origin || "").trim()) return true;
  if (!String(row.image_url || "").trim()) return true;
  if (row.weight_kg == null || Number.isNaN(Number(row.weight_kg))) return true;
  if (String(row.lifecycle_status || "").trim().toLowerCase() === "discontinued" && !String(row.lifecycle_note || "").trim()) return true;
  return false;
}

function parseStringArg(prefix, fallback) {
  const token = process.argv.find((entry) => entry.startsWith(prefix));
  return token ? token.slice(prefix.length) : fallback;
}

function parseIntArg(prefix, fallback) {
  const token = process.argv.find((entry) => entry.startsWith(prefix));
  if (!token) return fallback;
  const parsed = Number.parseInt(token.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dedupeStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}
