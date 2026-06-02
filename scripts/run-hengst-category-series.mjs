#!/usr/bin/env node

import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const runImportScript = path.join(repoRoot, "scripts", "run-hengst-safari-import.mjs");

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

const categoryUrl = String(
  args.get("category-url") ||
    "https://www.hengstconnect.com/en/hengst-connect/automotive-aftermarket/oil-filter/oil-filter-insert/c/74943",
).trim();
const startPage = Math.max(0, Number.parseInt(String(args.get("start-page") || "0"), 10) || 0);
const endPage = Math.max(startPage, Number.parseInt(String(args.get("end-page") || String(startPage)), 10) || startPage);
const delayMs = Math.max(1500, Number.parseInt(String(args.get("delay-ms") || "3500"), 10) || 3500);
const productCaptureDelayMs = Math.max(delayMs, Number.parseInt(String(args.get("product-delay-ms") || "3000"), 10) || 3000);

async function main() {
  const summaries = [];
  for (let pageIndex = startPage; pageIndex <= endPage; pageIndex += 1) {
    closeHengstProductTabs();
    const pageUrl = buildCategoryUrl(categoryUrl, pageIndex);
    const links = extractCategoryProductLinks(pageUrl, delayMs);
    if (!links.length) {
      summaries.push({
        page_index: pageIndex,
        page_url: pageUrl,
        opened_links: 0,
        import: null,
        note: "No product links found on category page.",
      });
      continue;
    }

    openProductTabs(links);
    const importSummary = JSON.parse(
      execNode(runImportScript, ["--all-tabs", `--delay-ms=${productCaptureDelayMs}`, "--import"]),
    );
    summaries.push({
      page_index: pageIndex,
      page_url: pageUrl,
      opened_links: links.length,
      import: importSummary.import || null,
      capture: importSummary.capture || null,
    });
  }

  closeHengstProductTabs();
  console.log(
    JSON.stringify(
      {
        category_url: categoryUrl,
        start_page: startPage,
        end_page: endPage,
        summaries,
      },
      null,
      2,
    ),
  );
}

function buildCategoryUrl(baseUrl, pageIndex) {
  if (pageIndex <= 0) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("currentPage", String(pageIndex));
  return url.toString();
}

function extractCategoryProductLinks(pageUrl, waitMs) {
  const raw = runOsaScript([
    'tell application "Safari"',
    'if (count of windows) is 0 then error "Safari has no open windows"',
    'set targetWindow to front window',
    `set URL of current tab of targetWindow to "${escapeAppleScript(pageUrl)}"`,
    'activate',
    `delay ${Math.max(waitMs / 1000, 1.5)}`,
    'set linksText to do JavaScript "Array.from(document.querySelectorAll(\\"a[href*=\\\\\\"/product/\\\\\\"]\\")).map(a => a.href).filter(Boolean).join(String.fromCharCode(10))" in current tab of targetWindow',
    'return linksText',
    'end tell',
  ]);

  return [...new Set(
    String(raw || "")
      .split(/\r?\n/)
      .map((value) => normalizeProductUrl(value))
      .filter(Boolean),
  )];
}

function openProductTabs(links) {
  const script = [
    'tell application "Safari"',
    'if (count of windows) is 0 then error "Safari has no open windows"',
    'tell front window',
  ];
  for (const link of links) {
    script.push(`make new tab with properties {URL:"${escapeAppleScript(link)}"}`);
  }
  script.push('end tell');
  script.push('activate');
  script.push('end tell');
  runOsaScript(script);
}

function closeHengstProductTabs() {
  runOsaScript([
    'tell application "Safari"',
    'repeat with w in windows',
    'set i to (count of tabs of w)',
    'repeat while i > 0',
    'set t to tab i of w',
    'set tabUrl to URL of t',
    'if tabUrl is not missing value and tabUrl contains "hengstconnect.com" and tabUrl contains "/product/" then close t',
    'set i to i - 1',
    'end repeat',
    'end repeat',
    'end tell',
  ]);
}

function execNode(scriptPath, scriptArgs) {
  return execFileSync(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: process.env,
  });
}

function runOsaScript(lines) {
  const osaArgs = [];
  for (const line of lines) {
    osaArgs.push("-e", line);
  }
  return execFileSync("osascript", osaArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function normalizeProductUrl(value) {
  const trimmed = String(value || "")
    .replace(/(?:%0D|%0A)+/gi, "")
    .replace(/[\r\n]+/g, "")
    .trim();
  if (!trimmed) return "";
  const url = trimmed.startsWith("http") ? trimmed : `https://www.hengstconnect.com${trimmed}`;
  return url.replace(/\/+$/, "/");
}

function escapeAppleScript(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
