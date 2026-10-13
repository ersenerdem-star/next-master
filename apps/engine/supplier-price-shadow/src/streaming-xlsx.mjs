import ExcelJS from "exceljs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import archiver from "archiver";
import unzipper from "unzipper";
import {
  canonicalizeHeader,
  inferCurrencyFromHeaders,
  normalizeSupplierPriceRow,
} from "./streaming-csv.mjs";

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if ("text" in value) return String(value.text ?? "");
    if ("result" in value) return String(value.result ?? "");
    if ("hyperlink" in value) return String(value.hyperlink ?? "");
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function isBlank(values) {
  return values.every((value) => cellText(value).trim() === "");
}

async function needsArchiveReorder(inputPath) {
  const archive = await unzipper.Open.file(inputPath);
  const names = archive.files.map((entry) => entry.path);
  const firstWorksheet = names.findIndex((name) => /^xl\/worksheets\/sheet\d+[.]xml$/.test(name));
  const workbook = names.indexOf("xl/workbook.xml");
  // ExcelJS 4.4 can emit a worksheet before workbook.xml. In that order the
  // streaming reader may expose shared-string indices instead of cell text.
  return firstWorksheet >= 0 && (workbook < 0 || workbook > firstWorksheet);
}

async function reorderArchive(inputPath, outputPath) {
  const archive = await unzipper.Open.file(inputPath);
  const priority = [
    "xl/_rels/workbook.xml.rels",
    "xl/sharedStrings.xml",
    "xl/styles.xml",
    "xl/workbook.xml",
  ];
  const rank = new Map(priority.map((name, index) => [name, index]));
  const files = archive.files
    .filter((entry) => !entry.path.endsWith("/"))
    .sort((left, right) => {
      const leftRank = rank.has(left.path) ? rank.get(left.path) : priority.length;
      const rightRank = rank.has(right.path) ? rank.get(right.path) : priority.length;
      return leftRank - rightRank;
    });
  const output = createWriteStream(outputPath);
  const pack = archiver("zip", { zlib: { level: 6 } });
  const finished = new Promise((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    pack.once("error", reject);
  });
  pack.pipe(output);
  for (const entry of files) pack.append(entry.stream(), { name: entry.path });
  await pack.finalize();
  await finished;
}

/**
 * Stream normalized supplier-price rows from the first non-empty worksheet.
 * The workbook reader disposes rows as they are consumed; no workbook-wide
 * object model is retained in memory.
 */
export async function* parseNormalizedSupplierPriceRowsFromXlsx(input, options = {}) {
  let inputPath = typeof input === "string" ? input : null;
  let tempDir = null;
  if (!inputPath) {
    tempDir = await mkdtemp(join(tmpdir(), "supplier-price-xlsx-"));
    inputPath = join(tempDir, "source.xlsx");
    const readable = input instanceof Uint8Array ? Readable.from([input]) : input;
    await pipeline(readable, createWriteStream(inputPath));
  }
  if (await needsArchiveReorder(inputPath)) {
    if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), "supplier-price-xlsx-"));
    const reorderedPath = join(tempDir, "reordered.xlsx");
    await reorderArchive(inputPath, reorderedPath);
    inputPath = reorderedPath;
  }
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(inputPath, {
    // ExcelJS 4.4 requires workbook entry events while resolving worksheet
    // metadata; callers do not receive them because we iterate worksheets.
    entries: "emit",
    sharedStrings: "cache",
    worksheets: "emit",
  });
  // Some valid XLSX producers (including ExcelJS itself) place worksheet XML
  // entries before xl/workbook.xml in the ZIP stream. ExcelJS 4.4 then tries
  // to read `this.model.sheets` before the workbook metadata has arrived. A
  // temporary model lets the reader create a worksheet reader; ExcelJS will
  // replace it with the real model when workbook.xml is parsed.
  if (!workbookReader.model) workbookReader.model = { sheets: [] };
  let selectedWorksheet = false;
  try {
    for await (const worksheetReader of workbookReader) {
    const worksheetName = String(worksheetReader.name || "");
      if (options.worksheetName && worksheetName !== options.worksheetName) continue;
      if (selectedWorksheet) break;
      selectedWorksheet = true;
      let headers = null;
      let inferredCurrency = null;
      let sourceRowNumber = 0;
      for await (const row of worksheetReader) {
        const values = row.values?.slice(1) || [];
        if (isBlank(values)) continue;
        if (!headers) {
          const rawHeaders = values.map(cellText);
          inferredCurrency = inferCurrencyFromHeaders(rawHeaders);
          headers = rawHeaders.map(canonicalizeHeader);
          continue;
        }
        sourceRowNumber += 1;
        const record = Object.fromEntries(headers.map((name, index) => [name, cellText(values[index] ?? "")]));
        if (inferredCurrency && !String(record.currency || "").trim()) record.currency = inferredCurrency;
        yield normalizeSupplierPriceRow({ sourceRowNumber, row: record });
        if (options.maxRows && sourceRowNumber >= options.maxRows) return;
      }
      if (!headers) throw new Error("XLSX_MISSING_HEADER");
    }
    if (!selectedWorksheet) throw new Error("XLSX_MISSING_WORKSHEET");
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
