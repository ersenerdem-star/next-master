#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function runCommand(command, args) {
  return String(execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return runCommand("npx", ["netlify", "env:get", name]);
}

function parseArgs(argv) {
  const options = {
    brand: "",
    organizationId: "",
    apply: false,
  };
  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (arg.startsWith("--brand=")) {
      options.brand = arg.slice("--brand=".length).trim();
      continue;
    }
    if (arg.startsWith("--organization-id=")) {
      options.organizationId = arg.slice("--organization-id=".length).trim();
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
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

async function fetchBrands(supabaseUrl, serviceRoleKey, brand) {
  const response = await fetch(
    buildRestUrl(supabaseUrl, "brands", {
      select: "id,organization_id,name,created_at",
      order: "name.asc",
      limit: "5000",
      ...(brand ? { name: `ilike.${brand}` } : {}),
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.brand) {
    throw new Error("Usage: node scripts/ensure-brand-record.mjs --brand=<name> [--organization-id=<uuid>] [--apply]");
  }

  const supabaseUrl = resolveEnvValue("SUPABASE_URL");
  const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const allBrands = await fetchBrands(supabaseUrl, serviceRoleKey, "");
  const organizationIds = [...new Set(allBrands.map((row) => String(row.organization_id || "").trim()).filter(Boolean))];
  const targetOrganizationId =
    String(options.organizationId || "").trim() || (organizationIds.length === 1 ? organizationIds[0] : "");

  if (!targetOrganizationId) {
    throw new Error(
      `Could not infer a single organization_id. Found ${organizationIds.length}. Re-run with --organization-id=<uuid>.`,
    );
  }

  const existing = allBrands.find(
    (row) =>
      String(row.organization_id || "").trim() === targetOrganizationId &&
      String(row.name || "").trim().toLowerCase() === String(options.brand || "").trim().toLowerCase(),
  );

  const summary = {
    brand: options.brand,
    organization_id: targetOrganizationId,
    existing: existing
      ? {
          id: String(existing.id || ""),
          name: String(existing.name || ""),
        }
      : null,
    inserted: null,
    organization_brand_count: allBrands.filter((row) => String(row.organization_id || "").trim() === targetOrganizationId).length,
    apply: options.apply,
  };

  if (!existing && options.apply) {
    summary.inserted = await insertBrand(supabaseUrl, serviceRoleKey, {
      organization_id: targetOrganizationId,
      name: String(options.brand || "").trim(),
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
