import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHellaOfficialProductUrl, parseHellaOfficialProductPage } from "../../netlify/functions/_shared/catalog/hella-official-page.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const docsDir = path.join(repoRoot, "docs", "hella-imports");

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  const value = String(
    execFileSync("npx", ["netlify", "env:get", name, "--context", "production"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }) || "",
  ).trim();
  if (!value || value.startsWith("No value set")) {
    return "";
  }
  return value;
}

function parseIntegerArg(name, fallback) {
  const arg = process.argv.find((value) => value.startsWith(`${name}=`));
  const parsed = Number.parseInt(String(arg || "").split("=")[1] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanArg(name) {
  return process.argv.includes(name);
}

async function fetchJson(url, headers, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text}`);
  }
  return payload;
}

function escapeAppleScript(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runAppleScript(lines) {
  const args = [];
  for (const line of lines) {
    args.push("-e", line);
  }
  return execFileSync("osascript", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function findHellaSafariTab() {
  const raw = runAppleScript([
    'tell application "Safari"',
    'set outputLines to {}',
    'repeat with windowIndex from 1 to count of windows',
    'repeat with tabIndex from 1 to count of tabs of window windowIndex',
    'set t to tab tabIndex of window windowIndex',
    'set tabUrl to URL of t',
    'if tabUrl is not missing value and tabUrl contains "shop.hella.com" then',
    'set end of outputLines to (windowIndex as string) & "|||" & (tabIndex as string) & "|||" & tabUrl & "|||" & (name of t)',
    'end if',
    'end repeat',
    'end repeat',
    'return outputLines as text',
    'end tell',
  ]);
  const rows = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, tabIndex, url, title] = line.split("|||");
      return {
        windowIndex: Number.parseInt(windowIndex || "0", 10),
        tabIndex: Number.parseInt(tabIndex || "0", 10),
        url: String(url || "").trim(),
        title: String(title || "").trim(),
      };
    })
    .filter((row) => row.windowIndex > 0 && row.tabIndex > 0 && row.url);
  return rows[0] || null;
}

async function captureHellaHtmlFromSafari(targetUrl, waitMs, fallbackTab) {
  const quotedUrl = escapeAppleScript(targetUrl);
  const windowIndex = Number.isFinite(fallbackTab?.windowIndex) ? fallbackTab.windowIndex : 1;
  const tabIndex = Number.isFinite(fallbackTab?.tabIndex) ? fallbackTab.tabIndex : 1;
  const raw = runAppleScript([
    'tell application "Safari"',
    `set targetWindow to window ${windowIndex}`,
    `set targetTab to tab ${tabIndex} of targetWindow`,
    `set URL of targetTab to "${quotedUrl}"`,
    'set current tab of targetWindow to targetTab',
    'set index of targetWindow to 1',
    `delay ${Math.max(waitMs / 1000, 0.5)}`,
    'set pageHtml to do JavaScript "document.documentElement.outerHTML" in current tab of front window',
    'set pageUrl to URL of current tab of front window',
    'set pageTitle to name of current tab of front window',
    'return pageUrl & linefeed & pageTitle & linefeed & pageHtml',
    'end tell',
  ]);

  const lines = String(raw || "").split(/\r?\n/);
  const pageUrl = lines.shift() || targetUrl;
  const pageTitle = lines.shift() || "";
  const html = lines.join("\n");
  return { url: pageUrl, title: pageTitle, html };
}

async function readCurrentHellaHtmlFromSafari(waitMs) {
  const raw = runAppleScript([
    'tell application "Safari"',
    `delay ${Math.max(waitMs / 1000, 0.2)}`,
    'set pageHtml to do JavaScript "document.documentElement.outerHTML" in current tab of front window',
    'set pageUrl to URL of current tab of front window',
    'set pageTitle to name of current tab of front window',
    'return pageUrl & linefeed & pageTitle & linefeed & pageHtml',
    'end tell',
  ]);

  const lines = String(raw || "").split(/\r?\n/);
  const pageUrl = lines.shift() || "";
  const pageTitle = lines.shift() || "";
  const html = lines.join("\n");
  return { url: pageUrl, title: pageTitle, html };
}

async function captureMatchingHellaDetail(row, waitMs, fallbackTab) {
  const expectedNormalizedCode = normalizeCode(row.normalized_code || row.product_code);
  const targetUrl = buildHellaOfficialProductUrl(row.product_code);
  let page = await captureHellaHtmlFromSafari(targetUrl, waitMs, fallbackTab);
  let lastError = "";

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const detail = parseHellaOfficialProductPage(page.html, page.url || targetUrl);
      if (detail.normalized_code === expectedNormalizedCode) {
        return detail;
      }
      lastError = `Loaded ${detail.product_code || detail.normalized_code}, expected ${row.product_code}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    page = await readCurrentHellaHtmlFromSafari(Math.min(2000, Math.max(600, waitMs)));
  }

  throw new Error(lastError || `HELLA page did not load expected product ${row.product_code}`);
}

async function fetchMissingHellaRows(supabaseUrl, headers, brandId, limit, skipCodes = new Set()) {
  const results = [];
  const pageLimit = limit ? Math.min(1000, Math.max(limit * 2, 100)) : 1000;
  let offset = 0;

  while (true) {
    const remaining = limit ? Math.max(0, limit - results.length) : pageLimit;
    if (limit && remaining <= 0) break;
    const currentLimit = limit ? Math.min(pageLimit, Math.max(remaining * 2, remaining)) : pageLimit;
    const batch = await fetchJson(
      `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code,ean,description,image_url&brand_id=eq.${encodeURIComponent(brandId)}&or=(ean.is.null,ean.eq.)&order=product_code.asc&limit=${currentLimit}&offset=${offset}`,
      headers,
    );
    const rows = Array.isArray(batch) ? batch : [];
    for (const row of rows) {
      const normalizedCode = normalizeCode(row.normalized_code || row.product_code);
      if (!skipCodes.has(normalizedCode)) {
        results.push(row);
      }
      if (limit && results.length >= limit) {
        break;
      }
    }
    if (rows.length < currentLimit) break;
    offset += currentLimit;
  }

  return limit ? results.slice(0, limit) : results;
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

function loadKnownOfficialNoEanSkips(minFailures = 2) {
  const counts = new Map();
  let checkpointCount = 0;
  try {
    for (const fileName of readdirSync(docsDir)) {
      if (!fileName.startsWith("hella-ean-backfill-") || !fileName.endsWith(".json")) {
        continue;
      }
      checkpointCount += 1;
      const payload = JSON.parse(readFileSync(path.join(docsDir, fileName), "utf8"));
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      for (const error of errors) {
        const message = String(error?.error || "");
        const isPersistentOfficialMiss =
          message.includes("HELLA official EAN could not be parsed") ||
          message.includes("HELLA official product code could not be parsed");
        const isTransientBlock =
          message.includes("human verification") ||
          message.includes("503 Service Unavailable") ||
          message.startsWith("Loaded ");
        if (!isPersistentOfficialMiss || isTransientBlock) {
          continue;
        }
        const normalizedCode = normalizeCode(error?.normalized_code || error?.product_code);
        if (!normalizedCode) continue;
        counts.set(normalizedCode, (counts.get(normalizedCode) || 0) + 1);
      }
    }
  } catch {
    return { checkpointCount, skipCodes: new Set() };
  }

  return {
    checkpointCount,
    skipCodes: new Set([...counts].filter(([, count]) => count >= minFailures).map(([code]) => code)),
  };
}

async function main() {
  const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
  const batchSize = parseIntegerArg("--batch-size", 10);
  const delayMs = parseIntegerArg("--delay-ms", 3500);
  const limit = parseIntegerArg("--limit", 0);
  const dryRun = parseBooleanArg("--dry-run");
  const includeKnownErrors = parseBooleanArg("--include-known-errors");
  const maxErrors = parseIntegerArg("--max-errors", 50);

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  mkdirSync(docsDir, { recursive: true });
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const brandRows = await fetchJson(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=eq.Hella&limit=1`, headers);
  const brand = Array.isArray(brandRows) ? brandRows[0] : null;
  if (!brand?.id || !brand?.organization_id) {
    throw new Error("Hella brand not found");
  }

  const tab = findHellaSafariTab();
  if (!tab) {
    throw new Error("No Hella Safari tab found. Open any Hella product page first.");
  }

  const skipState = includeKnownErrors ? { checkpointCount: 0, skipCodes: new Set() } : loadKnownOfficialNoEanSkips();
  const rows = await fetchMissingHellaRows(supabaseUrl, headers, brand.id, limit, skipState.skipCodes);
  if (!rows.length) {
    console.log(JSON.stringify({ status: "ok", message: "No missing Hella EAN rows found", brand: brand.name }, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  const checkpointPath = path.join(docsDir, `hella-ean-backfill-${startedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
  const results = [];
  const errors = [];
  let processed = 0;

  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const parsedRowsByCode = new Map();
    for (const row of batch) {
      try {
        const detail = await captureMatchingHellaDetail(row, delayMs, tab);
        parsedRowsByCode.set(detail.normalized_code, {
          organization_id: brand.organization_id,
          brand_id: brand.id,
          product_code: detail.product_code,
          ean: detail.ean,
        });
        results.push({
          product_code: row.product_code,
          normalized_code: row.normalized_code,
          ean: detail.ean,
          source_url: detail.source_url,
          status: "parsed",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          product_code: row.product_code,
          normalized_code: row.normalized_code,
          error: message,
        });
        results.push({
          product_code: row.product_code,
          normalized_code: row.normalized_code,
          status: "error",
          error: message,
        });
        if (errors.length >= maxErrors) {
          break;
        }
      }
      processed += 1;
      console.log(JSON.stringify({ processed, total: rows.length, last: results.at(-1) }, null, 2));
    }

    const parsedRows = [...parsedRowsByCode.values()];
    if (!dryRun && parsedRows.length) {
      await fetchJson(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, headers, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(parsedRows),
      });
    }

    if (errors.length >= maxErrors) break;
  }

  const summary = {
    status: "ok",
    brand: brand.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCandidates: rows.length,
    processed,
    parsedCount: results.filter((item) => item.status === "parsed").length,
    errorCount: errors.length,
    dryRun,
    batchSize,
    delayMs,
    skippedKnownNoEanCount: skipState.skipCodes.size,
    checkpointCount: skipState.checkpointCount,
    tab,
    checkpointPath,
    sample: results.slice(0, 10),
    errors: errors.slice(0, 20),
  };

  writeFileSync(checkpointPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

await main();
