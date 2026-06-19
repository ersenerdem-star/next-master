#!/usr/bin/env node

import path from "node:path";
import XLSX from "xlsx";

const defaultFiles = [
  "/Users/ersen/Library/CloudStorage/OneDrive-Personal/ee/JuventaAsia/PanaromaInvest/Brands-2026/Bosch/Bosch-PL-Master/Bosch-1-Replacement-Work.xlsx",
  "/Users/ersen/Library/CloudStorage/OneDrive-Personal/ee/JuventaAsia/PanaromaInvest/Brands-2026/Bosch/Bosch-PL-Master/Bosch-2-Replacement-Work.xlsx",
];

const inputPaths = process.argv.slice(2);
const filesToProcess = inputPaths.length ? inputPaths : defaultFiles;
const results = [];

for (const inputPath of filesToProcess) {
  results.push(processWorkbook(inputPath));
}

console.log(JSON.stringify(results, null, 2));

function processWorkbook(inputPath) {
  const outputPath = buildOutputPath(inputPath);
  const workbook = XLSX.readFile(inputPath, { cellDates: false, cellText: true, raw: true });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1:A1");
  const header = [];

  for (let column = range.s.c; column <= range.e.c; column += 1) {
    header.push(getDisplayValue(worksheet, range.s.r, column));
  }

  const newPartIndex = header.findIndex((value) => /^new(?: part nr| code|code)$/i.test(value));
  const oldPartIndexes = header
    .map((value, index) => ({ value, index }))
    .filter((entry) => /^old(?: part nr| code|code)$/i.test(entry.value))
    .map((entry) => entry.index);

  if (newPartIndex < 0 || !oldPartIndexes.length) {
    throw new Error(`Could not find New/Old code columns in ${inputPath}`);
  }

  const flattenedRows = [["Old Part Nr", "New Part Nr"]];

  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    const newPart = getDisplayValue(worksheet, row, newPartIndex);
    if (!newPart) continue;

    for (const oldIndex of oldPartIndexes) {
      const oldPart = getDisplayValue(worksheet, row, oldIndex);
      if (!oldPart) continue;
      flattenedRows.push([oldPart, newPart]);
    }
  }

  const outBook = XLSX.utils.book_new();
  const outSheet = XLSX.utils.aoa_to_sheet(flattenedRows);
  outSheet["!cols"] = [{ wch: 18 }, { wch: 18 }];
  outSheet["!autofilter"] = { ref: `A1:B${flattenedRows.length}` };
  markTextCells(outSheet, flattenedRows.length);

  XLSX.utils.book_append_sheet(outBook, outSheet, "Flattened");
  XLSX.writeFile(outBook, outputPath);

  return {
    input: inputPath,
    output: outputPath,
    rows: flattenedRows.length - 1,
  };
}

function buildOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}-flattened.xlsx`);
}

function getDisplayValue(worksheet, row, column) {
  const cellAddress = XLSX.utils.encode_cell({ r: row, c: column });
  const cell = worksheet[cellAddress];
  if (!cell) return "";

  const text =
    typeof cell.w === "string" && cell.w.trim()
      ? cell.w.trim()
      : typeof cell.v === "string"
        ? cell.v.trim()
          : cell.v == null
          ? ""
          : String(cell.v).trim();

  return normalizeBoschCode(text);
}

function markTextCells(worksheet, rowCount) {
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = worksheet[cellAddress];
      if (!cell) continue;
      cell.t = "s";
      cell.z = "@";
      cell.v = String(cell.v ?? "");
      cell.w = String(cell.v);
    }
  }
}

function normalizeBoschCode(text) {
  if (!text) return "";
  return /^\d+$/.test(text) && text.length < 10 ? text.padStart(10, "0") : text;
}
