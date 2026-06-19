import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import Tesseract from "tesseract.js";

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const targetBrandName = "Brembo";
const pageLimit = 1000;
const concurrency = Math.max(1, Number.parseInt(String(process.argv.find((arg) => arg.startsWith("--concurrency=")) || "").split("=")[1] || "2", 10) || 2);
const limit = Math.max(0, Number.parseInt(String(process.argv.find((arg) => arg.startsWith("--limit=")) || "").split("=")[1] || "0", 10) || 0);
const codesFilter = String(process.argv.find((arg) => arg.startsWith("--codes=")) || "")
  .split("=")[1] || "";
const requestedCodes = new Set(
  codesFilter
    .split(",")
    .map((value) => normalizeText(value).toUpperCase())
    .filter(Boolean),
);
const missingOnly = !process.argv.includes("--all");

const BREMBO_HOME_URL = "https://www.bremboparts.com/europe/en";
const BREMBO_SEARCH_CODE_URL = `${BREMBO_HOME_URL}/catalogue/search/searchcode`;
const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const startedAt = new Date();
const outputDir = path.join(process.cwd(), "docs", "brembo-weight-fill");
await fs.mkdir(outputDir, { recursive: true });

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const brand = await resolveBrand();
const allRows = await fetchCatalogRows(brand.id);
const scopedRows = allRows
  .filter((row) => (!missingOnly ? true : row.weight_kg == null || Number.isNaN(Number(row.weight_kg))))
  .filter((row) => (requestedCodes.size ? requestedCodes.has(normalizeText(row.product_code).toUpperCase()) : true));
const workRows = limit > 0 ? scopedRows.slice(0, limit) : scopedRows;

const tessdataDir = path.join(process.cwd(), ".cache", "tessdata");
await ensureLanguageData(tessdataDir);
const worker = await Tesseract.createWorker("eng", 1, { langPath: tessdataDir });
await worker.setParameters({
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  tessedit_char_whitelist: "0123456789.kgKG ",
});

const session = await createBremboSessionContext(20000);
const changedRows = [];
const errorRows = [];
let resolvedRows = 0;

await runPool(workRows, concurrency, async (row, index) => {
  try {
    const weightKg = await resolveBremboWeightKg(worker, session, row.product_code, 20000);
    if (weightKg == null || Number.isNaN(weightKg)) return;
    resolvedRows += 1;
    if (Number(row.weight_kg ?? null) === Number(weightKg)) return;
    changedRows.push({
      id: row.id,
      product_code: row.product_code,
      old_weight_kg: row.weight_kg == null ? "" : String(row.weight_kg),
      new_weight_kg: String(weightKg),
      detail_url: await resolveBremboDetailUrl(session, row.product_code, 20000),
    });
    if ((index + 1) % 50 === 0) {
      console.log(`resolved ${index + 1}/${workRows.length}`);
    }
  } catch (error) {
    errorRows.push({
      product_code: row.product_code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

await worker.terminate();

if (changedRows.length) {
  for (let index = 0; index < changedRows.length; index += 100) {
    const batch = changedRows.slice(index, index + 100);
    await Promise.all(
      batch.map(async (row) => {
        const patchResponse = await fetch(`${supabaseUrl}/rest/v1/catalog_products?id=eq.${row.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            weight_kg: Number(row.new_weight_kg),
            updated_at: new Date().toISOString(),
          }),
        });
        if (!patchResponse.ok) {
          const text = await patchResponse.text();
          throw new Error(`Weight patch failed for ${row.product_code}: ${patchResponse.status} ${text}`);
        }
      }),
    );
  }
}

const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
const summaryPath = path.join(outputDir, `brembo-weight-fill-summary-${timestamp}.json`);
const changesPath = path.join(outputDir, `brembo-weight-fill-changes-${timestamp}.csv`);
const errorsPath = path.join(outputDir, `brembo-weight-fill-errors-${timestamp}.csv`);

const summary = {
  brand: targetBrandName,
  existingRows: allRows.length,
  candidateRows: workRows.length,
  resolvedRows,
  changedRows: changedRows.length,
  errorRows: errorRows.length,
  missingOnly,
  limit,
  requestedCodes: [...requestedCodes],
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
await fs.writeFile(
  changesPath,
  toCsv([
    ["Product_Code", "Old_Weight_kg", "New_Weight_kg", "Detail_URL"],
    ...changedRows.map((row) => [row.product_code, row.old_weight_kg, row.new_weight_kg, row.detail_url]),
  ]),
);
await fs.writeFile(
  errorsPath,
  toCsv([
    ["Product_Code", "Error"],
    ...errorRows.map((row) => [row.product_code, row.error]),
  ]),
);

console.log(JSON.stringify({ ...summary, summaryPath, changesPath, errorsPath }, null, 2));

async function resolveBrand() {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=ilike.${encodeURIComponent(targetBrandName)}&limit=1`,
    { headers },
  );
  if (!response.ok) throw new Error(`Brand fetch failed: ${response.status}`);
  const rows = await response.json();
  const brandRow = Array.isArray(rows) ? rows[0] : null;
  if (!brandRow?.id) throw new Error(`Brand not found: ${targetBrandName}`);
  return brandRow;
}

async function fetchCatalogRows(brandId) {
  const rows = [];
  for (let offset = 0; ; offset += pageLimit) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=id,product_code,weight_kg&brand_id=eq.${encodeURIComponent(brandId)}&order=product_code.asc&limit=${pageLimit}&offset=${offset}`,
      { headers },
    );
    if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status}`);
    const page = await response.json();
    rows.push(...page);
    if (!Array.isArray(page) || page.length < pageLimit) break;
  }
  return rows;
}

async function ensureLanguageData(tessdataDir) {
  await fs.mkdir(tessdataDir, { recursive: true });
  const targetPath = path.join(tessdataDir, "eng.traineddata.gz");
  try {
    await fs.access(targetPath);
    return targetPath;
  } catch {}
  const response = await fetch("https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz");
  if (!response.ok) throw new Error(`Failed to download OCR model: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}

async function resolveBremboWeightKg(worker, session, productCode, requestTimeoutMs) {
  const detailUrl = await resolveBremboDetailUrl(session, productCode, requestTimeoutMs);
  if (!detailUrl) return null;
  const detailHtml = await fetchText(detailUrl, requestTimeoutMs);
  const drawingUrl = asAbsoluteBremboUrl(
    firstMatch(
      detailHtml,
      /<div id="ProductDrawingZoomImage_[^"]+" class="image">\s*<img[^>]+src="([^"]*\/media\/product\/images\/1920-1920-[^"]+)"/i,
    ),
  );
  if (!drawingUrl) return null;
  const drawingBuffer = await fetchBuffer(drawingUrl, requestTimeoutMs);
  const metadata = await sharp(drawingBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) return null;
  const crop = {
    left: Math.max(0, Math.round(width * 0.0885)),
    top: Math.max(0, Math.round(height * 0.416)),
    width: Math.max(40, Math.round(width * 0.1095)),
    height: Math.max(20, Math.round(height * 0.0405)),
  };
  const ocrBuffer = await sharp(drawingBuffer)
    .extract(crop)
    .grayscale()
    .normalise()
    .resize({ width: Math.max(800, crop.width * 12) })
    .threshold(180)
    .png()
    .toBuffer();
  const result = await worker.recognize(ocrBuffer);
  return parseWeightFromText(result.data.text || "");
}

async function resolveBremboDetailUrl(session, productCode, requestTimeoutMs) {
  const searchResult = await postBremboJson(
    session,
    BREMBO_SEARCH_CODE_URL,
    { code: productCode },
    BREMBO_HOME_URL,
    requestTimeoutMs,
  );
  return asAbsoluteBremboUrl(normalizeText(searchResult?.url || ""));
}

async function createBremboSessionContext(requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(BREMBO_HOME_URL, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Brembo session bootstrap failed: ${response.status}`);
    const html = await response.text();
    const token = firstMatch(html, /name="__RequestVerificationToken"[^>]+value="([^"]+)"/i);
    const cookieHeader = extractCookieHeader(response);
    if (!token) throw new Error("Brembo session bootstrap missing RequestVerificationToken");
    if (!cookieHeader) throw new Error("Brembo session bootstrap missing cookies");
    return { token, cookieHeader };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function postBremboJson(session, url, payload, referrerUrl, requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...requestHeaders,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        RequestVerificationToken: session.token,
        Cookie: session.cookieHeader,
        Referer: referrerUrl,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Brembo request failed ${response.status} for ${url}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchText(url, requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchBuffer(url, requestTimeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function extractCookieHeader(response) {
  const headerBag = response.headers;
  const cookies = [];
  if (typeof headerBag.getSetCookie === "function") {
    cookies.push(...headerBag.getSetCookie());
  } else {
    const fallbackCookie = response.headers.get("set-cookie");
    if (fallbackCookie) cookies.push(fallbackCookie);
  }
  return cookies
    .map((value) => String(value || "").split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function parseWeightFromText(value) {
  const normalized = normalizeText(String(value || "").replace(/\s+/g, " "));
  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*k/i);
  if (!match) return null;
  const numeric = Number(String(match[1] || "").replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function asAbsoluteBremboUrl(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `https://www.bremboparts.com${text.startsWith("/") ? text : `/${text}`}`;
}

function firstMatch(value, pattern) {
  const match = String(value || "").match(pattern);
  return match?.[1] || "";
}

function toCsv(rows) {
  return `${rows
    .map((row) =>
      row
        .map((cell) => {
          const text = String(cell ?? "");
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    )
    .join("\n")}\n`;
}

async function runPool(items, limitCount, worker) {
  const queue = items.map((item, index) => ({ item, index }));
  await Promise.all(
    Array.from({ length: Math.min(limitCount, queue.length || 1) }, async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) return;
        await worker(next.item, next.index);
      }
    }),
  );
}
