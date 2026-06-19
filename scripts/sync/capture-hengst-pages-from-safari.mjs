#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const defaultOutputDir = path.join(repoRoot, "docs", "hengst-imports", "captures");

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

const outputDir = path.resolve(String(args.get("output-dir") || defaultOutputDir));
const captureAllTabs = args.has("all-tabs");
const delayMs = Math.max(300, Number.parseInt(args.get("delay-ms") || "900", 10) || 900);
const fieldDelimiter = "|||";
const rowDelimiter = "<<<ROW>>>";

fs.mkdirSync(outputDir, { recursive: true });

async function main() {
  const targets = captureAllTabs ? listHengstTabs() : [getFrontHengstTab()];
  if (!targets.length) {
    throw new Error("No Hengst tab found in Safari");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(outputDir, timestamp);
  fs.mkdirSync(runDir, { recursive: true });

  const captured = [];
  for (const target of targets) {
    const payload = captureSafariTab(target, delayMs);
    const html = String(payload.html || "").trim();
    if (!html) continue;

    const fileBase = sanitizeFileSegment(payload.title || target.title || target.url || `hengst-${captured.length + 1}`);
    const fileName = `${String(captured.length + 1).padStart(3, "0")}-${fileBase}.html`;
    const filePath = path.join(runDir, fileName);
    fs.writeFileSync(filePath, `${html}\n`, "utf8");

    captured.push({
      ...target,
      title: payload.title || target.title || "",
      url: payload.url || target.url || "",
      file_name: fileName,
      file_path: filePath,
    });
  }

  const summary = {
    output_dir: runDir,
    captured_count: captured.length,
    captured,
    note: "Use scripts/import-brand-from-hengst-pages.mjs with this output directory to parse or import official Hengst pages.",
  };

  const summaryPath = path.join(runDir, "capture-summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...summary, summary_path: summaryPath }, null, 2));
}

function listHengstTabs() {
  const result = runOsaScript([
    'tell application "Safari"',
    'set outputLines to {}',
    'repeat with windowIndex from 1 to count of windows',
    'set tabIndex to 0',
    'repeat with t in tabs of window windowIndex',
    'set tabIndex to tabIndex + 1',
    'set tabUrl to URL of t',
    'if tabUrl is not missing value and tabUrl contains "hengstconnect.com" and tabUrl contains "/product/" then',
    'set tabName to name of t',
    `set end of outputLines to (windowIndex as string) & "${fieldDelimiter}" & (tabIndex as string) & "${fieldDelimiter}" & tabUrl & "${fieldDelimiter}" & tabName`,
    'end if',
    'end repeat',
    'end repeat',
    `set AppleScript's text item delimiters to "${rowDelimiter}"`,
    'set outputText to outputLines as text',
    'set AppleScript\'s text item delimiters to ""',
    'return outputText',
    'end tell',
  ]);

  return String(result || "")
    .split(rowDelimiter)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [windowIndex, tabIndex, url, title] = line.split(fieldDelimiter);
      return {
        windowIndex: Number.parseInt(windowIndex || "0", 10),
        tabIndex: Number.parseInt(tabIndex || "0", 10),
        url: normalizeProductUrl(String(url || "").trim()),
        title: String(title || "").trim(),
      };
    })
    .filter((row) => row.windowIndex > 0 && row.tabIndex > 0 && row.url);
}

function getFrontHengstTab() {
  const result = runOsaScript([
    'tell application "Safari"',
    'if (count of windows) is 0 then error "Safari has no open windows"',
    'set targetWindow to front window',
    'set frontWindowIndex to index of targetWindow',
    'set frontTabIndex to index of current tab of targetWindow',
    'set tabUrl to URL of current tab of targetWindow',
    'if tabUrl is missing value or tabUrl does not contain "hengstconnect.com" or tabUrl does not contain "/product/" then error "Front Safari tab is not a Hengst product page"',
    'set tabName to name of current tab of targetWindow',
    `return (frontWindowIndex as string) & "${fieldDelimiter}" & (frontTabIndex as string) & "${fieldDelimiter}" & tabUrl & "${fieldDelimiter}" & tabName`,
    'end tell',
  ]);

  const [windowIndex, tabIndex, url, title] = String(result || "").split(fieldDelimiter);
  return {
    windowIndex: Number.parseInt(windowIndex || "1", 10),
    tabIndex: Number.parseInt(tabIndex || "1", 10),
    url: String(url || "").trim(),
    title: String(title || "").trim(),
  };
}

function captureSafariTab(target, waitMs) {
  const targetUrlKey = normalizeProductUrl(target.url).replace(/\/+$/, "");
  const script = [
    'tell application "Safari"',
    'set targetWindow to missing value',
    'set matchedTabIndex to 0',
    `set targetUrlKey to "${escapeAppleScript(targetUrlKey)}"`,
    'repeat with windowIndex from 1 to count of windows',
    'repeat with t in tabs of window windowIndex',
    'set candidateUrl to URL of t',
    'if candidateUrl is not missing value and targetUrlKey is not "" and candidateUrl contains targetUrlKey then',
    'set targetWindow to window windowIndex',
    'set matchedTabIndex to index of t',
    'exit repeat',
    'end if',
    'end repeat',
    'if matchedTabIndex is not 0 then exit repeat',
    'end repeat',
    'if targetWindow is missing value then set targetWindow to window ' + String(target.windowIndex || 1),
    'if matchedTabIndex is 0 then set matchedTabIndex to ' + String(target.tabIndex || 1),
    'set current tab of targetWindow to tab matchedTabIndex of targetWindow',
    'set index of targetWindow to 1',
    `delay ${Math.max(waitMs / 1000, 0.3)}`,
    'set tabUrl to URL of current tab of front window',
    'set tabName to name of current tab of front window',
    'set htmlSource to do JavaScript "document.documentElement.outerHTML" in current tab of front window',
    'return tabUrl & linefeed & tabName & linefeed & htmlSource',
    'end tell',
  ];
  const raw = runOsaScript(script);
  const lines = String(raw || "").split(/\r?\n/);
  const url = lines.shift() || target.url || "";
  const title = lines.shift() || target.title || "";
  const html = lines.join("\n");
  return { url, title, html };
}

function runOsaScript(lines) {
  const args = [];
  for (const line of lines) {
    args.push("-e", line);
  }
  const previousFrontApp = getFrontmostAppName();
  try {
    return execFileSync("osascript", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    restoreFrontmostApp(previousFrontApp);
  }
}

function sanitizeFileSegment(value) {
  return String(value || "")
    .replace(/\.[A-Z0-9]{2,6}$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 120) || "hengst-page";
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

function getFrontmostAppName() {
  try {
    return execFileSync(
      "osascript",
      [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    ).trim();
  } catch {
    return "";
  }
}

function restoreFrontmostApp(appName) {
  const target = String(appName || "").trim();
  if (!target || target === "Safari") return;
  try {
    execFileSync("osascript", ["-e", `tell application "${escapeAppleScript(target)}" to activate`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Ignore focus-restore failures; they should not abort capture.
  }
}

function escapeAppleScript(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
