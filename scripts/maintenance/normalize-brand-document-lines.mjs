#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "brand-code-normalization");

const brandName = String(getArgValue("--brand=", "Sachs")).trim();
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
const batchSize = Math.max(25, Number.parseInt(getArgValue("--batch-size=", "200"), 10) || 200);
const COMPACT_DOCUMENT_CODE_BRANDS = new Set(["bosch", "sachs"]);

const tableConfigs = [
  { table: "sales_orders", labelField: "sales_order_no", lineFields: ["requestedCode", "resolvedCode"] },
  { table: "invoices", labelField: "sales_order_no", lineFields: ["product_code", "old_code"] },
  { table: "purchase_orders", labelField: "sales_order_no", lineFields: ["product_code", "old_code"] },
  { table: "bills", labelField: "purchase_order_no", lineFields: ["product_code", "old_code"] },
];

await mkdir(outputDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const summaryPath = path.join(outputDir, `${normalizeBrandKey(brandName)}-document-line-normalization-summary-${timestamp}.json`);
const csvPath = path.join(outputDir, `${normalizeBrandKey(brandName)}-document-line-normalization-changes-${timestamp}.csv`);

const tableSummaries = [];
const allChanges = [];

for (const config of tableConfigs) {
  const rows = await fetchAllRows(config);
  const updates = [];
  let changedLineCount = 0;

  for (const row of rows) {
    const normalized = normalizeLines(row.lines, config.lineFields);
    if (!normalized.changed) continue;
    changedLineCount += normalized.changedLineCount;
    updates.push({
      id: row.id,
      label: row.label,
      lines: normalized.lines,
      changedLineCount: normalized.changedLineCount,
      examples: normalized.examples,
    });
    for (const example of normalized.examples) {
      allChanges.push({
        table: config.table,
        document_id: row.id,
        document_label: row.label,
        field: example.field,
        from: example.from,
        to: example.to,
      });
    }
  }

  const batches = [];
  if (apply && updates.length) {
    for (let index = 0; index < updates.length; index += batchSize) {
      const batch = updates.slice(index, index + batchSize);
      for (const row of batch) {
        const response = await fetch(`${supabaseUrl}/rest/v1/${config.table}?id=eq.${encodeURIComponent(row.id)}`, {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            lines: row.lines,
            updated_at: new Date().toISOString(),
          }),
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`${config.table} ${brandName} document line update failed for ${row.id}: ${response.status} ${text}`);
        }
      }
      batches.push({ batch: index / batchSize + 1, rows: batch.length, status: 204 });
    }
  }

  tableSummaries.push({
    table: config.table,
    scannedDocuments: rows.length,
    changedDocuments: updates.length,
    changedLines: changedLineCount,
    batches,
    sampleDocuments: updates.slice(0, 25).map((row) => ({
      id: row.id,
      label: row.label,
      changedLineCount: row.changedLineCount,
      examples: row.examples.slice(0, 5),
    })),
  });
}

const summary = {
  mode: apply ? "apply" : "plan",
  brand: brandName,
  tables: tableSummaries,
  changedDocuments: tableSummaries.reduce((sum, row) => sum + row.changedDocuments, 0),
  changedLines: tableSummaries.reduce((sum, row) => sum + row.changedLines, 0),
  csvPath,
};

await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(
  csvPath,
  [
    "table,document_id,document_label,field,from,to",
    ...allChanges.map((row) => toCsvRow([row.table, row.document_id, row.document_label, row.field, row.from, row.to])),
  ].join("\n") + "\n",
  "utf8",
);

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

async function fetchAllRows(config) {
  const pageLimit = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageLimit) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/${config.table}?select=id,${config.labelField},lines&order=id.asc&limit=${pageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${config.table} fetch failed: ${response.status} ${text}`);
    }
    const page = JSON.parse(text || "[]");
    if (!Array.isArray(page) || !page.length) break;
    rows.push(
      ...page.map((row) => ({
        id: String(row.id || "").trim(),
        label: String(row[config.labelField] || "").trim(),
        lines: Array.isArray(row.lines) ? row.lines : [],
      })),
    );
    if (page.length < pageLimit) break;
  }
  return rows;
}

function normalizeLines(lines, fields) {
  let changed = false;
  let changedLineCount = 0;
  const examples = [];
  const nextLines = lines.map((line) => {
    if (!shouldCompactDocumentCode(line?.brand || "")) return line;
    let lineChanged = false;
    const nextLine = { ...line };
    for (const field of fields) {
      const current = String(nextLine[field] || "").trim();
      if (!current) continue;
      const next = normalizeCompactCode(current);
      if (!next || next === current) continue;
      nextLine[field] = next;
      changed = true;
      lineChanged = true;
      if (examples.length < 50) {
        examples.push({ field, from: current, to: next });
      }
    }
    if (lineChanged) changedLineCount += 1;
    return nextLine;
  });
  return { changed, changedLineCount, lines: nextLines, examples };
}

function shouldCompactDocumentCode(brand) {
  return COMPACT_DOCUMENT_CODE_BRANDS.has(normalizeBrandKey(brand || ""));
}

function normalizeCompactCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeBrandKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
