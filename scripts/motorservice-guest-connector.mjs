#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseMotorserviceFitmentSnapshot,
  parseMotorserviceGuestSnapshot,
} from "./_shared/motorservice-guest-parser.mjs";

const args = parseArgs(process.argv.slice(2));
const brandName = String(args.brand || "").trim();
const codesFile = String(args.codes || "").trim();
const codesList = String(args["codes-list"] || "").trim();
const outputPath = path.resolve(
  String(args.output || `motorservice-guest-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
);
const delayMs = Math.max(1000, Number.parseInt(args["delay-ms"] || "1800", 10) || 1800);
const maxItems = Math.max(1, Number.parseInt(args.max || "250", 10) || 250);

if (!brandName) {
  throw new Error(
    "Usage: node scripts/motorservice-guest-connector.mjs --brand='BF' --codes=parts.txt [--output=out.json]",
  );
}
if (!codesFile && !codesList) {
  throw new Error("Provide a finite part-number file via --codes=<file> or a comma-separated list via --codes-list=<a,b,c>.");
}

const requestedCodes = (codesList
  ? codesList.split(",")
  : fs.readFileSync(path.resolve(codesFile), "utf8").split(/\r?\n/))
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean)
  .slice(0, maxItems);

if (!requestedCodes.length) throw new Error("The part-number file contains no usable codes.");

const chromeTab = findMotorserviceChromeTab();
ensureChromeJavaScriptEnabled(chromeTab);
const results = [];

for (const [index, productCode] of requestedCodes.entries()) {
  try {
    const snapshot = searchMotorserviceCode(chromeTab, productCode, delayMs);
    const detailUrl = chooseDetailUrl(snapshot.links, productCode);
    if (!detailUrl) {
      const parsedSearch = parseMotorserviceGuestSnapshot(snapshot, { brandName, requestedCode: productCode });
      const blocked = parsedSearch.status === "blocked";
      results.push({
        ...parsedSearch,
        status: blocked ? "blocked" : "rejected",
        reason: parsedSearch.reason || "DETAIL_LINK_NOT_FOUND",
        requested_code: productCode,
        captured_at: new Date().toISOString(),
      });
      console.log(
        JSON.stringify({
          index: index + 1,
          total: requestedCodes.length,
          product_code: productCode,
          status: blocked ? "blocked" : "rejected",
          reason: parsedSearch.reason || "DETAIL_LINK_NOT_FOUND",
        }),
      );
      if (blocked) break;
      continue;
    }
    const detailSnapshot = detailUrl
      ? captureChromeTab(chromeTab, detailUrl, delayMs)
      : snapshot;
    const parsed = parseMotorserviceGuestSnapshot(detailSnapshot, { brandName, requestedCode: productCode });
    const enriched = parsed.status === "accepted"
      ? captureFitmentEvidence(chromeTab, parsed, delayMs)
      : parsed;
    results.push({
      ...enriched,
      requested_code: productCode,
      captured_at: new Date().toISOString(),
    });

    console.log(
      JSON.stringify({
        index: index + 1,
        total: requestedCodes.length,
        product_code: productCode,
        status: enriched.status,
        reason: enriched.reason || null,
      }),
    );

    if (enriched.status === "blocked") break;
  } catch (error) {
    results.push({
      status: "error",
      requested_code: productCode,
      reason: error instanceof Error ? error.message : String(error),
      captured_at: new Date().toISOString(),
    });
  }
}

const output = {
  connector: "motorservice-guest-browser-assisted-v1",
  source: "https://onlineshop.ms-motorservice.com/msi/MSICD",
  source_mode: "visible_guest_browser_session",
  brand: brandName,
  requested_count: requestedCodes.length,
  result_count: results.length,
  accepted_count: results.filter((row) => row.status === "accepted").length,
  blocked_count: results.filter((row) => row.status === "blocked").length,
  raw_capture_retained: false,
  database_write: false,
  results,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, accepted_count: output.accepted_count, result_count: output.result_count }, null, 2));

function findMotorserviceChromeTab() {
  const raw = runAppleScript([
    'tell application "Google Chrome"',
    "set outputLines to {}",
    "repeat with windowIndex from 1 to count of windows",
    "set tabIndex to 0",
    "repeat with t in tabs of window windowIndex",
    "set tabIndex to tabIndex + 1",
    "set tabUrl to URL of t",
    'if tabUrl is not missing value and tabUrl contains "onlineshop.ms-motorservice.com/msi/MSICD" and tabUrl does not contain "createSessionKilled" then',
    `set end of outputLines to (windowIndex as string) & "|||MOTOR|||" & (tabIndex as string) & "|||" & tabUrl`,
    "end if",
    "end repeat",
    "end repeat",
    'if (count of outputLines) is 0 then error "No open Motorservice guest tab found in Google Chrome."',
    'return item 1 of outputLines',
    "end tell",
  ]);

  const [windowIndex, marker, tabIndex, url] = String(raw || "").trim().split("|||");
  if (marker?.trim() !== "MOTOR" || !windowIndex || !tabIndex || !url) {
    throw new Error("Could not identify the Motorservice Chrome tab.");
  }
  return { windowIndex: Number(windowIndex), tabIndex: Number(tabIndex), url };
}

function searchMotorserviceCode(tab, productCode, waitMs) {
  const script = [
    'tell application "Google Chrome"',
    `set targetWindow to window ${tab.windowIndex}`,
    `set targetTab to tab ${tab.tabIndex} of targetWindow`,
    'set URL of targetTab to "https://onlineshop.ms-motorservice.com/msi/MSICD"',
    `delay ${Math.max(waitMs / 1000, 1)}`,
    `set openSearchJs to ${appleScriptString(buildOpenItemNumberSearchJavaScript())}`,
    "set ignored to execute targetTab javascript openSearchJs",
    `delay ${Math.max(waitMs / 1000, 1)}`,
    `set jsCode to ${appleScriptString(buildSearchJavaScript(productCode))}`,
    "set ignored to execute targetTab javascript jsCode",
    `delay ${Math.max(waitMs / 1000, 1)}`,
    "set resultJson to execute targetTab javascript " + appleScriptString(buildCaptureJavaScript()),
    "return resultJson",
    "end tell",
  ];
  return parseSnapshot(runAppleScript(script));
}

function ensureChromeJavaScriptEnabled(tab) {
  const raw = runAppleScript([
    'tell application "Google Chrome"',
    `set targetWindow to window ${tab.windowIndex}`,
    `set targetTab to tab ${tab.tabIndex} of targetWindow`,
    "set resultJson to execute targetTab javascript " + appleScriptString("JSON.stringify({ ok: true })"),
    "return resultJson",
    "end tell",
  ]);
  if (String(raw || "").trim() !== '{"ok":true}') {
    throw new Error("Chrome JavaScript automation capability check failed.");
  }
}

function captureChromeTab(tab, targetUrl, waitMs) {
  const script = [
    'tell application "Google Chrome"',
    `set targetWindow to window ${tab.windowIndex}`,
    `set targetTab to tab ${tab.tabIndex} of targetWindow`,
    `set URL of targetTab to ${appleScriptString(targetUrl)}`,
    `delay ${Math.max(waitMs / 1000, 1)}`,
    `set expandFitmentJs to ${appleScriptString(buildExpandFitmentJavaScript())}`,
    "set ignored to execute targetTab javascript expandFitmentJs",
    `delay ${Math.max(waitMs / 1000, 1)}`,
    "set resultJson to execute targetTab javascript " + appleScriptString(buildCaptureJavaScript()),
    "return resultJson",
    "end tell",
  ];
  return parseSnapshot(runAppleScript(script));
}

function buildOpenItemNumberSearchJavaScript() {
  return `(() => {
    const existingInput = document.querySelector('input[name="nummer"]') ||
      [...document.querySelectorAll('input')].find((el) => /text|search/i.test(el.type || '') && !/csrf|token/i.test(el.name || ''));
    if (existingInput) return JSON.stringify({ status: 'ready' });
    const itemNumberLink = [...document.querySelectorAll('a')].find((link) =>
      (link.innerText || link.querySelector('img')?.alt || '').trim() === 'Item number' &&
      /[?&]page=searchartnr(?:&|$)/i.test(link.href || '')
    );
    if (!itemNumberLink) return JSON.stringify({ status: 'item_number_link_not_found' });
    location.href = itemNumberLink.href;
    return JSON.stringify({ status: 'opening_item_number_search' });
  })()`;
}

function buildSearchJavaScript(productCode) {
  return `(() => {
    const code = ${JSON.stringify(productCode)};
    const input = document.querySelector('input[name="nummer"]') ||
      [...document.querySelectorAll('input')].find((el) => /text|search/i.test(el.type || '') && !/csrf|token/i.test(el.name || ''));
    const button = [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].find((el) => /search/i.test((el.innerText || el.value || '').trim()));
    if (!input || !button) return JSON.stringify({ url: location.href, title: document.title, bodyText: document.body?.innerText || '', links: [] });
    input.focus();
    input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    button.click();
    return JSON.stringify({ url: location.href, title: document.title, bodyText: document.body?.innerText || '', links: [] });
  })()`;
}

function buildExpandFitmentJavaScript() {
  return `(() => {
    if (!/[?&]page=show(?:Veh|Mot)ToNum(?:&|$)/i.test(location.href)) {
      return JSON.stringify({ status: 'not_fitment' });
    }
    const rowCount = document.querySelector('select[name="setrownum"]');
    if (!rowCount || ![...rowCount.options].some((option) => option.value === '50')) {
      return JSON.stringify({ status: 'row_count_control_not_found' });
    }
    if (rowCount.value === '50') return JSON.stringify({ status: 'already_expanded' });
    rowCount.value = '50';
    rowCount.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ status: 'expanding_to_50' });
  })()`;
}

function buildCaptureJavaScript() {
  return `JSON.stringify({
    url: location.href,
    title: document.title,
    bodyText: document.body ? document.body.innerText : '',
    links: [...document.querySelectorAll('a')].map((a) => ({ text: a.innerText || '', href: a.href || '' })),
    images: [...document.querySelectorAll('img')].map((img) => ({ alt: img.alt || '', title: img.title || '', src: img.currentSrc || img.src || '' })),
    tables: [...document.querySelectorAll('table')].slice(0, 50).map((table) =>
      [...table.querySelectorAll('tr')].slice(0, 1200).map((row) =>
        [...row.querySelectorAll('th,td')].map((cell) => (cell.innerText || '').trim())
      )
    )
  })`;
}

function captureFitmentEvidence(tab, parsed, waitMs) {
  const outcomes = [];
  const vehicleEntries = [];
  const engineEntries = [];

  for (const link of parsed.fitment_links || []) {
    const kind = /engine/i.test(link.text || "") ? "engines" : "vehicles";
    try {
      const snapshot = captureChromeTab(tab, link.href, waitMs);
      const outcome = parseMotorserviceFitmentSnapshot(snapshot, { kind });
      outcomes.push(outcome);
      if (outcome.status === "blocked") {
        return {
          ...parsed,
          status: "blocked",
          reason: outcome.reason,
          fitment_outcomes: outcomes,
        };
      }
      if (kind === "engines") engineEntries.push(...outcome.entries);
      else vehicleEntries.push(...outcome.entries);
    } catch (error) {
      outcomes.push({
        status: "error",
        kind,
        source_url: link.href,
        reason: error instanceof Error ? error.message : String(error),
        entries: [],
      });
    }
  }

  const missingFields = new Set(parsed.missing_fields || []);
  if (vehicleEntries.length) missingFields.delete("vehicle_model");
  else missingFields.add("vehicle_model");

  return {
    ...parsed,
    vehicle: vehicleEntries.join(" ; "),
    vehicle_model: vehicleEntries.join(" ; "),
    vehicle_applications: [...new Set(vehicleEntries)],
    engine_applications: [...new Set(engineEntries)],
    fitment_outcomes: outcomes,
    missing_fields: [...missingFields],
  };
}

function chooseDetailUrl(links, productCode) {
  const normalized = removeWhitespace(productCode).toUpperCase();
  return (
    links.find((link) => {
      const text = removeWhitespace(link.text || "").toUpperCase();
      const href = String(link.href || "");
      const hrefCode = new URL(href, "https://onlineshop.ms-motorservice.com/").searchParams.get("ksnr") || "";
      return /show[A-Z]+Detail/i.test(href) && (
        text.includes(normalized) ||
        removeWhitespace(hrefCode).toUpperCase() === normalized ||
        !normalized
      );
    })?.href || ""
  );
}

function parseSnapshot(raw) {
  const text = String(raw || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Motorservice browser response was not JSON: ${text.slice(0, 200)}`);
  }
}

function runAppleScript(lines) {
  try {
    return execFileSync("osascript", lines.flatMap((line) => ["-e", line]), {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : String(error?.message || error);
    if (/Executing JavaScript through AppleScript is turned off/i.test(detail)) {
      throw new Error(
        "Chrome JavaScript automation is disabled. In Chrome, enable View > Developer > Allow JavaScript from Apple Events, then rerun.",
      );
    }
    throw error;
  }
}

function parseArgs(tokens) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 2) {
      values[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    values[key] = next && !next.startsWith("--") ? next : "true";
    if (values[key] !== "true") index += 1;
  }
  return values;
}

function appleScriptString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

function removeWhitespace(value) {
  return String(value || "").replace(/\s+/g, "");
}
