#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ORIGIN = "https://b4b.genckaya.com";
const DEFAULT_DELAY_MS = 1_200;

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(value = "") {
  return decodeHtml(String(value).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(value = "") {
  return String(value).toLocaleUpperCase("tr-TR").replace(/[^A-Z0-9]/g, "");
}

function normalizeLabel(value = "") {
  return cleanText(value).toLocaleLowerCase("tr-TR");
}

function extractTable(html, tableId) {
  const escapedId = tableId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(html).match(new RegExp(`<table[^>]*id=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/table>`, "i"));
  return match?.[1] || "";
}

function parseRows(tableHtml) {
  return [...String(tableHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) => {
    const raw = rowMatch[0];
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanText(cell[1]));
    return { raw, cells };
  });
}

function extractReference(raw = "") {
  return raw.match(/[?&](?:amp;)?ref=(\d+)/i)?.[1] || null;
}

export function parseSearchResults(html) {
  return parseRows(extractTable(html, "element_3"))
    .filter(({ cells }) => cells.length >= 4 && /^\d+$/.test(cells[0]))
    .map(({ raw, cells }) => ({
      source_product_ref: extractReference(raw),
      product_code: cells[2],
      normalized_code: normalizeCode(cells[2]),
      description: cells[3],
      group: cells[5] || null,
    }))
    .filter((row) => row.source_product_ref && row.normalized_code);
}

export function parseProductDetail(html) {
  const fields = new Map();
  for (const { cells } of parseRows(extractTable(html, "element_3"))) {
    if (cells.length >= 2) fields.set(normalizeLabel(cells[0]), cells[1]);
  }

  return {
    product_code: fields.get("ürün kodu") || null,
    normalized_code: normalizeCode(fields.get("ürün kodu") || ""),
    description: fields.get("açıklama") || null,
    brand: fields.get("marka") || null,
  };
}

export function parseAlternativeRows(html) {
  return parseRows(extractTable(html, "element_1"))
    .filter(({ cells }) => cells.length >= 4 && /^\d+$/.test(cells[0]))
    .map(({ raw, cells }) => ({
      source_product_ref: extractReference(raw),
      displayed_code: cells[1],
      description: cells[2],
    }))
    .filter((row) => row.source_product_ref && row.displayed_code);
}

export function classifyAlternative(source, candidate) {
  const sameBrand = normalizeLabel(source.brand) === normalizeLabel(candidate.brand);
  return {
    observed_relation: sameBrand ? "same_brand_alternative" : "cross_brand_equivalent",
    replacement_asserted: false,
    apply_eligible: false,
    review_reason: sameBrand
      ? "Kaynak aynı marka alternatifi gösteriyor; yönlü supersession/replacement beyanı bulunmuyor."
      : "Kaynak farklı marka eşdeğeri gösteriyor; replacement olarak yazılamaz.",
  };
}

class CookieJar {
  #cookies = new Map();

  ingest(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")]
        : [];
    for (const value of values) {
      const pair = String(value).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

function createAuthenticatedClient(fetchImpl = fetch) {
  const jar = new CookieJar();

  async function request(input, init = {}, redirectCount = 0) {
    const url = new URL(input, SOURCE_ORIGIN);
    if (url.origin !== SOURCE_ORIGIN) throw new Error(`Blocked cross-origin request: ${url.origin}`);
    if (redirectCount > 5) throw new Error("Too many redirects");

    const headers = new Headers(init.headers || {});
    headers.set("accept", "text/html,application/xhtml+xml");
    headers.set("user-agent", "Next-Master governed replacement review/1.0");
    const cookie = jar.header();
    if (cookie) headers.set("cookie", cookie);

    const response = await fetchImpl(url, { ...init, headers, redirect: "manual" });
    jar.ingest(response.headers);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} without location`);
      const method = response.status === 303 || ([301, 302].includes(response.status) && init.method === "POST") ? "GET" : init.method;
      return request(new URL(location, url), method === "GET" ? { method } : { ...init, method }, redirectCount + 1);
    }

    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    return response.text();
  }

  return { request };
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function login(client) {
  const customer = requiredEnvironment("GENCKAYA_CUSTOMER_CODE");
  const username = requiredEnvironment("GENCKAYA_USERNAME");
  const password = requiredEnvironment("GENCKAYA_PASSWORD");
  const body = new URLSearchParams({ __action: "login", customer, username, userpass: password });
  const html = await client.request("/index.php?sayfa=arama", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!/sayfa=logout|Çıkış|Oturumu Kapat/i.test(html)) throw new Error("Source login was not accepted");
}

async function fetchSearch(client, code) {
  const query = new URLSearchParams({ sayfa: "arama2", formsent: "1", search: code });
  query.append("marka[]", "2");
  return client.request(`/index.php?${query}`);
}

async function fetchDetail(client, sourceProductRef) {
  return client.request(`/index.php?sayfa=urun_detay&ref=${encodeURIComponent(sourceProductRef)}`);
}

async function fetchAlternatives(client, sourceProductRef) {
  return client.request(`/index.php?sayfa=urun_detay&ref=${encodeURIComponent(sourceProductRef)}&detay=alternatif2`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value) {
  const stringValue = value == null ? "" : String(value);
  return /[",\n\r]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
}

function toCsv(rows) {
  const fields = [
    "requested_code", "source_product_code", "source_brand", "candidate_code", "candidate_brand",
    "candidate_description", "observed_relation", "replacement_asserted", "apply_eligible", "review_reason", "evidence_url",
  ];
  return [fields.join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n") + "\n";
}

async function collectOne(client, requestedCode, delayMs) {
  const searchResults = parseSearchResults(await fetchSearch(client, requestedCode));
  const exact = searchResults.find((row) => row.normalized_code === normalizeCode(requestedCode));
  if (!exact) return { requested_code: requestedCode, status: "not_found", relations: [] };

  const source = parseProductDetail(await fetchDetail(client, exact.source_product_ref));
  if (normalizeLabel(source.brand) !== "bosch") {
    return { requested_code: requestedCode, status: "exact_result_not_bosch", relations: [] };
  }

  await sleep(delayMs);
  const alternatives = parseAlternativeRows(await fetchAlternatives(client, exact.source_product_ref));
  const relations = [];
  for (const alternative of alternatives) {
    await sleep(delayMs);
    const candidate = parseProductDetail(await fetchDetail(client, alternative.source_product_ref));
    const classification = classifyAlternative(source, candidate);
    relations.push({
      requested_code: requestedCode,
      source_product_code: source.product_code,
      source_brand: source.brand,
      candidate_code: candidate.product_code || alternative.displayed_code,
      candidate_brand: candidate.brand,
      candidate_description: candidate.description || alternative.description,
      ...classification,
      evidence_url: `${SOURCE_ORIGIN}/index.php?sayfa=urun_detay&ref=${exact.source_product_ref}&detay=alternatif2`,
    });
  }

  return { requested_code: requestedCode, status: "review_ready", relations };
}

export async function runReview({ codes, artifactDir, requestDelayMs = DEFAULT_DELAY_MS, fetchImpl = fetch }) {
  if (!Array.isArray(codes) || codes.length < 1 || codes.length > 100) throw new Error("codes must contain 1 to 100 items");
  if (!Number.isInteger(requestDelayMs) || requestDelayMs < 500) throw new Error("requestDelayMs must be at least 500");

  const client = createAuthenticatedClient(fetchImpl);
  await login(client);
  const items = [];
  for (let index = 0; index < codes.length; index += 1) {
    if (index > 0) await sleep(requestDelayMs);
    items.push(await collectOne(client, codes[index], requestDelayMs));
  }

  const relations = items.flatMap((item) => item.relations);
  const report = {
    mode: "review_only",
    source: "Gençkaya B4B authenticated catalog",
    generated_at: new Date().toISOString(),
    requested_count: codes.length,
    review_ready_count: items.filter((item) => item.status === "review_ready").length,
    relation_count: relations.length,
    items,
    guarantees: {
      database_write: false,
      catalog_write: false,
      item_code_reference_write: false,
      price_data_collected: false,
      credentials_persisted: false,
    },
  };

  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "review.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(artifactDir, "review.csv"), toCsv(relations), "utf8");
  return report;
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const separator = token.indexOf("=");
    if (separator > 2) args.set(token.slice(2, separator), token.slice(separator + 1));
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) args.set(token.slice(2), argv[++index]);
    else args.set(token.slice(2), "true");
  }
  return args;
}

async function readCodes(args) {
  const direct = String(args.get("code") || "").trim();
  const inputFile = String(args.get("input-file") || "").trim();
  if (direct && inputFile) throw new Error("Use either --code or --input-file");
  if (direct) return [direct];
  if (!inputFile) throw new Error("--code or --input-file is required");
  const content = await fs.readFile(path.resolve(inputFile), "utf8");
  return content.split(/[\r\n,;]+/).map((value) => value.trim()).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codes = await readCodes(args);
  const maxItems = Number.parseInt(args.get("max-items") || "100", 10);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new Error("--max-items must be between 1 and 100");
  const requestDelayMs = Number.parseInt(args.get("request-delay-ms") || String(DEFAULT_DELAY_MS), 10);
  const runId = `genckaya-bosch-review-${Date.now()}`;
  const artifactDir = path.resolve(args.get("artifact-dir") || path.join("artifacts", "genckaya-bosch-replacement", runId));
  const report = await runReview({ codes: codes.slice(0, maxItems), artifactDir, requestDelayMs });
  console.log(JSON.stringify({ artifact_dir: artifactDir, ...report }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
