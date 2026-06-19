#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const limit = 1000;
const candidateRows = new Map();
await collectCandidateRows(
  `${supabaseUrl}/rest/v1/catalog_products?select=id,organization_id,brand_id,product_code,oem_no,lifecycle_status,lifecycle_note&oem_no=not.is.null`,
  candidateRows,
);
await collectCandidateRows(
  `${supabaseUrl}/rest/v1/catalog_products?select=id,organization_id,brand_id,product_code,oem_no,lifecycle_status,lifecycle_note&lifecycle_note=not.is.null`,
  candidateRows,
);
await collectCandidateRows(
  `${supabaseUrl}/rest/v1/catalog_products?select=id,organization_id,brand_id,product_code,oem_no,lifecycle_status,lifecycle_note&lifecycle_status=not.eq.active`,
  candidateRows,
);

const allRows = [...candidateRows.values()];

const brands = await fetchJson(`${supabaseUrl}/rest/v1/brands?select=id,name`);
const brandMap = new Map((brands || []).map((row) => [String(row.id || ""), String(row.name || "").trim()]));

const changedRows = [];
const brandSummary = new Map();
for (const row of allRows) {
  const currentOem = String(row.oem_no || "").trim();
  const nextOem = sanitizeCatalogOemNumbers(currentOem);
  const nextLifecycle = normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`);
  const rawLifecycleStatus = String(row.lifecycle_status || "").trim();
  const currentLifecycle = normalizeLifecycleStatus(rawLifecycleStatus);
  let nextLifecycleNote = String(row.lifecycle_note || "").trim();

  if (
    nextLifecycle === "discontinued" &&
    !nextLifecycleNote &&
    rawLifecycleStatus &&
    !/^active$/i.test(rawLifecycleStatus) &&
    !/^discontinued$/i.test(rawLifecycleStatus)
  ) {
    nextLifecycleNote = `Official status: ${rawLifecycleStatus}.`;
  }

  const nextRecord = {
    id: String(row.id || ""),
    organization_id: String(row.organization_id || ""),
    brand_id: String(row.brand_id || ""),
    product_code: String(row.product_code || ""),
    oem_no: nextOem || null,
    lifecycle_status: nextLifecycle,
    lifecycle_note: nextLifecycleNote || null,
    updated_at: new Date().toISOString(),
  };

  const oemChanged = currentOem !== nextOem;
  const lifecycleChanged =
    currentLifecycle !== nextLifecycle ||
    String(row.lifecycle_note || "").trim() !== String(nextRecord.lifecycle_note || "").trim();

  if (!oemChanged && !lifecycleChanged) continue;

  changedRows.push({
    ...nextRecord,
    brand: brandMap.get(String(row.brand_id || "")) || "",
    product_code: String(row.product_code || ""),
    previous_oem_no: currentOem,
    next_oem_no: nextOem,
    previous_lifecycle_status: String(row.lifecycle_status || ""),
    next_lifecycle_status: nextLifecycle,
    previous_lifecycle_note: String(row.lifecycle_note || ""),
    next_lifecycle_note: nextLifecycleNote,
    oem_changed: oemChanged,
    lifecycle_changed: lifecycleChanged,
  });

  const brandName = brandMap.get(String(row.brand_id || "")) || "Unknown";
  const entry = brandSummary.get(brandName) || { rows_changed: 0, oem_changed: 0, lifecycle_changed: 0 };
  entry.rows_changed += 1;
  if (oemChanged) entry.oem_changed += 1;
  if (lifecycleChanged) entry.lifecycle_changed += 1;
  brandSummary.set(brandName, entry);
}

for (let index = 0; index < changedRows.length; index += 250) {
  const batch = changedRows.slice(index, index + 250).map((row) => ({
    id: row.id,
    organization_id: row.organization_id,
    brand_id: row.brand_id,
    product_code: row.product_code,
    oem_no: row.oem_no,
    lifecycle_status: row.lifecycle_status,
    lifecycle_note: row.lifecycle_note,
    updated_at: row.updated_at,
  }));
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`catalog_products cleanup upsert failed: ${response.status} ${text}`);
  }
  console.error(`cleanup batch ${index / 250 + 1}/${Math.ceil(changedRows.length / 250)} applied`);
}

const summary = {
  total_rows_scanned: allRows.length,
  total_rows_changed: changedRows.length,
  oem_changed_rows: changedRows.filter((row) => row.oem_changed).length,
  lifecycle_changed_rows: changedRows.filter((row) => row.lifecycle_changed).length,
  brands: [...brandSummary.entries()]
    .map(([brand, value]) => ({ brand, ...value }))
    .sort((left, right) => right.rows_changed - left.rows_changed),
};

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(
  "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp",
  "docs",
  "catalog-standardization",
);
await fs.mkdir(outputDir, { recursive: true });
const summaryPath = path.join(outputDir, `catalog-oem-lifecycle-cleanup-summary-${timestamp}.json`);
const csvPath = path.join(outputDir, `catalog-oem-lifecycle-cleanup-changes-${timestamp}.csv`);
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
await fs.writeFile(
  csvPath,
  [
    [
      "brand",
      "product_code",
      "previous_oem_no",
      "next_oem_no",
      "previous_lifecycle_status",
      "next_lifecycle_status",
      "previous_lifecycle_note",
      "next_lifecycle_note",
      "oem_changed",
      "lifecycle_changed",
    ].join(","),
    ...changedRows.map((row) =>
      [
        row.brand,
        row.product_code,
        row.previous_oem_no,
        row.next_oem_no,
        row.previous_lifecycle_status,
        row.next_lifecycle_status,
        row.previous_lifecycle_note,
        row.next_lifecycle_note,
        row.oem_changed ? "yes" : "no",
        row.lifecycle_changed ? "yes" : "no",
      ]
        .map(toCsvCell)
        .join(","),
    ),
  ].join("\n"),
);

console.log(
  JSON.stringify(
    {
      ...summary,
      summary_path: summaryPath,
      csv_path: csvPath,
    },
    null,
    2,
  ),
);

async function fetchJson(url) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`Supabase fetch failed: ${response.status} ${text}`);
  }
  return payload;
}

async function collectCandidateRows(baseUrl, map) {
  for (let offset = 0; ; offset += limit) {
    const page = await fetchJson(`${baseUrl}&limit=${limit}&offset=${offset}`);
    if (!Array.isArray(page) || !page.length) break;
    for (const row of page) {
      map.set(String(row.id || ""), row);
    }
    console.error(`candidate fetch ${offset + page.length} rows from ${baseUrl.split("?")[1]?.split("&")[1] || "query"}`);
    if (page.length < limit) break;
  }
}

function normalizeLifecycleStatus(value) {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!text) return "active";
  return /discontinued|obsolete|replaced|replacement only|superceded|superseded|production ended|production end|production stopped|not in production|no longer deliverable|no longer available|not supplied|end of life|article ended|ended|unavailable|not available|teslim edilemiyor|sunulmuyor|artik sunulmuyor|uretimden|kaldirilacak/.test(text)
    ? "discontinued"
    : "active";
}

function sanitizeCatalogOemNumbers(value) {
  const raw = String(value || "").replace(/\r/g, "\n").trim();
  if (!raw) return "";
  const parts = raw
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const values = new Set();
  for (const part of parts.length ? parts : [raw]) {
    const digitGroups = part.match(/\d+/g) || [];
    if (!digitGroups.length) continue;
    const longGroups = digitGroups.filter((group) => group.length >= 4);
    if (longGroups.length >= 2) {
      for (const group of longGroups) values.add(group);
      continue;
    }
    const compact = digitGroups.join("");
    if (compact.length >= 4) values.add(compact);
  }
  return [...values].join(", ");
}

function toCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/["\n,]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}
