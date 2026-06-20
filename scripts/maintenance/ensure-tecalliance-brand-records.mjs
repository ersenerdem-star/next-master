#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTecAllianceBrandEntries } from "../../netlify/functions/_shared/catalog/tecalliance-brand-registry.mts";

function normalizeBrandKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const outputDir = path.join(repoRoot, "docs", "security");

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(
    execFileSync("npx", ["netlify", "env:get", name, "--context", "production"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    }) || "",
  ).trim();
}

function parseArgs(argv) {
  const options = {
    apply: false,
    organizationId: "",
  };
  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg.startsWith("--organization-id=")) {
      options.organizationId = arg.slice("--organization-id=".length).trim();
    }
  }
  return options;
}

function serviceRoleHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function buildRestUrl(supabaseUrl, table, params = {}) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchBrands(supabaseUrl, serviceRoleKey) {
  const response = await fetch(
    buildRestUrl(supabaseUrl, "brands", {
      select: "id,organization_id,name,created_at",
      order: "name.asc",
      limit: "5000",
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new Error(`Brand lookup failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Brand lookup returned unexpected payload.");
  return rows;
}

async function hasCatalogProductsForBrand(supabaseUrl, serviceRoleKey, organizationId, brandId) {
  const response = await fetch(
    buildRestUrl(supabaseUrl, "catalog_products", {
      select: "id",
      organization_id: `eq.${organizationId}`,
      brand_id: `eq.${brandId}`,
      limit: "1",
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new Error(`Catalog coverage lookup failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Catalog coverage lookup returned unexpected payload.");
  return Boolean(rows[0]?.id);
}

async function insertBrand(supabaseUrl, serviceRoleKey, payload) {
  const response = await fetch(buildRestUrl(supabaseUrl, "brands", { select: "id,organization_id,name" }), {
    method: "POST",
    headers: {
      ...serviceRoleHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Brand insert failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows[0]?.id) throw new Error("Brand insert returned unexpected payload.");
  return rows[0];
}

function canonicalBrandRows() {
  const seen = new Map();
  for (const entry of listTecAllianceBrandEntries()) {
    for (const rawName of entry.managedBrandNames || []) {
      const name = String(rawName || "").trim();
      if (!name) continue;
      const key = normalizeBrandKey(name);
      if (!seen.has(key)) {
        seen.set(key, {
          name,
          registryKey: entry.key,
          providerKey: entry.preferredProviderKey,
          sourceUrl: entry.preferredSourceUrl,
        });
      }
    }
  }
  return [...seen.values()];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const brands = await fetchBrands(supabaseUrl, serviceRoleKey);
  const organizationIds = [...new Set(brands.map((row) => String(row.organization_id || "").trim()).filter(Boolean))];
  const targetOrganizationId =
    String(options.organizationId || "").trim() || (organizationIds.length === 1 ? organizationIds[0] : "");

  if (!targetOrganizationId) {
    throw new Error(
      `Could not infer a single organization_id. Found ${organizationIds.length}. Re-run with --organization-id=<uuid>.`,
    );
  }

  const targetBrands = brands.filter((row) => String(row.organization_id || "").trim() === targetOrganizationId);
  const existingByKey = new Map(
    targetBrands.map((row) => [normalizeBrandKey(String(row.name || "")), row]).filter(([key]) => Boolean(key)),
  );
  const registryBrands = canonicalBrandRows();
  const missing = registryBrands.filter((row) => !existingByKey.has(normalizeBrandKey(row.name)));
  const created = [];
  const emptyCatalogBrands = [];

  for (const brand of registryBrands) {
    const existingRow = existingByKey.get(normalizeBrandKey(brand.name));
    if (!existingRow?.id) continue;
    const hasCatalog = await hasCatalogProductsForBrand(supabaseUrl, serviceRoleKey, targetOrganizationId, String(existingRow.id));
    if (!hasCatalog) {
      emptyCatalogBrands.push({
        id: String(existingRow.id),
        name: String(existingRow.name || brand.name),
        registryKey: brand.registryKey,
        providerKey: brand.providerKey,
        sourceUrl: brand.sourceUrl,
      });
    }
  }

  if (options.apply) {
    for (const brand of missing) {
      const row = await insertBrand(supabaseUrl, serviceRoleKey, {
        organization_id: targetOrganizationId,
        name: brand.name,
      });
      created.push({
        id: String(row.id || ""),
        name: String(row.name || brand.name),
      });
    }
  }

  mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const summaryPath = path.join(outputDir, `guardian-tecalliance-brands-${stamp}.json`);
  const summary = {
    mode: options.apply ? "apply" : "plan",
    organization_id: targetOrganizationId,
    registry_brand_count: registryBrands.length,
    existing_brand_count: targetBrands.length,
    missing_brand_count: missing.length,
    created_brand_count: created.length,
    empty_catalog_brand_count: emptyCatalogBrands.length,
    missing_brands: missing,
    created_brands: created,
    empty_catalog_brands: emptyCatalogBrands,
    checked_at: new Date().toISOString(),
  };

  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...summary, summary_path: summaryPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
