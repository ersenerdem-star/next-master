#!/usr/bin/env node

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function main() {
  const catalogRows = await fetchAll("/rest/v1/catalog_products?select=id,product_code,lifecycle_note&or=(lifecycle_note.ilike.*Spareto*,lifecycle_note.ilike.*Replacement%20shown%20by%20Spareto*)");
  const codeReferenceRows = await fetchAll("/rest/v1/item_code_references?select=id,reason&reason=ilike.*Spareto*");

  let updatedCatalog = 0;
  for (const row of catalogRows) {
    const nextNote = sanitizeLifecycleNote(row.lifecycle_note);
    if (nextNote === String(row.lifecycle_note || "").trim()) continue;
    await patchRow("catalog_products", row.id, { lifecycle_note: nextNote || null, updated_at: new Date().toISOString() });
    updatedCatalog += 1;
  }

  let updatedReferences = 0;
  for (const row of codeReferenceRows) {
    const nextReason = sanitizeReferenceReason(row.reason);
    if (nextReason === String(row.reason || "").trim()) continue;
    await patchRow("item_code_references", row.id, { reason: nextReason || null, updated_at: new Date().toISOString() });
    updatedReferences += 1;
  }

  console.log(
    JSON.stringify(
      {
        catalog_rows_found: catalogRows.length,
        catalog_rows_updated: updatedCatalog,
        code_reference_rows_found: codeReferenceRows.length,
        code_reference_rows_updated: updatedReferences,
      },
      null,
      2,
    ),
  );
}

function sanitizeLifecycleNote(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const replacementMatch = raw.match(/replacement(?:\s+shown\s+by\s+spareto)?(?:\s+code)?\s*:\s*([^\s.,;]+)/i);
  if (replacementMatch?.[1]) {
    return `Replacement code: ${String(replacementMatch[1]).trim()}.`;
  }
  return raw
    .replace(/\bsource:\s*spareto\.?/gi, "")
    .replace(/\bshown by spareto:?/gi, "")
    .replace(/\bspareto\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function sanitizeReferenceReason(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/production stopped/i.test(raw)) {
    return "Automatic replacement. Production stopped by manufacturer.";
  }
  return "Automatic replacement.";
}

async function fetchAll(initialPath) {
  const results = [];
  const restPageLimit = 1000;
  let offset = 0;

  while (true) {
    const separator = initialPath.includes("?") ? "&" : "?";
    const pathWithRange = `${initialPath}${separator}limit=${restPageLimit}&offset=${offset}`;
    const response = await fetch(`${supabaseUrl}${pathWithRange}`, { headers });
    const text = await response.text();
    const data = text ? JSON.parse(text) : [];
    if (!response.ok) {
      throw new Error(`${response.status} ${text}`);
    }
    results.push(...(Array.isArray(data) ? data : []));
    if (!Array.isArray(data) || data.length < restPageLimit) break;
    offset += restPageLimit;
  }

  return results;
}

async function patchRow(table, id, payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      ...headers,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${table} patch failed for ${id}: ${response.status} ${text}`);
  }
}

await main();
