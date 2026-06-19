#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const docsDir = path.join(repoRoot, "docs", "juventa-catalog-fill");
const summaryPath = path.join(docsDir, "juventa-fill-import-final-2026-05-18-summary.json");
const unmatchedPath = path.join(docsDir, "juventa-fill-unmatched-2026-05-18T12-42-40-090Z.csv");
const outputPath = "/Users/ersen/Desktop/missing-part-definitions-2026-05-18.xlsx";

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const unmatched = parseCsv(fs.readFileSync(unmatchedPath, "utf8"));

const workbook = XLSX.utils.book_new();

const summaryRows = [
  ["Metric", "Value"],
  ["Candidate Rows", summary.candidate_rows ?? ""],
  ["Updated Rows", summary.updated_rows ?? ""],
  ["Remaining Missing Total", summary.remaining_missing_total ?? ""],
  [],
  ["Imported Brand", "Rows"],
  ...Object.entries(summary.import_by_brand || {}),
  [],
  ["Remaining Brand", "Rows"],
  ...Object.entries(summary.remaining_missing_by_brand || {}),
];

const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
summarySheet["!cols"] = [{ wch: 28 }, { wch: 14 }];

const unmatchedRows = [
  ["Brand", "Product_Code", "Normalized_Code"],
  ...unmatched.map((row) => [row.Brand, row.Product_Code, row.Normalized_Code]),
];

const unmatchedSheet = XLSX.utils.aoa_to_sheet(unmatchedRows);
unmatchedSheet["!cols"] = [{ wch: 16 }, { wch: 20 }, { wch: 20 }];
unmatchedSheet["!autofilter"] = { ref: `A1:C${Math.max(unmatchedRows.length, 1)}` };
unmatchedSheet["!freeze"] = { xSplit: 0, ySplit: 1 };

XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");
XLSX.utils.book_append_sheet(workbook, unmatchedSheet, "Unmatched Items");
XLSX.writeFile(workbook, outputPath);

console.log(outputPath);

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (insideQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }

  const header = rows[0] || [];
  return rows.slice(1).map((cells) =>
    Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])),
  );
}
