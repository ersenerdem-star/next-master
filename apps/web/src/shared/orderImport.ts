import { parseCsv } from "./csv";
import { assertSpreadsheetFile, isSpreadsheetTextExtension, readSpreadsheetMatrix } from "./spreadsheetImport";

type ImportedOrderRow = {
  code: string;
  brand: string;
  qty: number;
};

function normalizeOrderCode(value: unknown) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function normalizeHeader(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function normalizeQty(value: unknown, code: string) {
  const text = String(value ?? "").trim();
  if (!text) return 1;
  const parsed = Number(text.replace(",", "."));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2147483647) {
    throw new Error(`Invalid quantity for ${code}. Enter a whole number between 1 and 2147483647.`);
  }
  return parsed;
}

function mapRows(rawRows: Array<Record<string, unknown>>, fallbackBrand = "") {
  return rawRows
    .map((row) => {
      const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
      const code = normalizeOrderCode(
        normalized.part_no ||
          normalized.part_number ||
          normalized.product_code ||
          normalized.code ||
          normalized.item_code ||
          "",
      );
      const brand = String(normalized.brand || fallbackBrand || "").trim();
      if (!code) return null;
      const qty = normalizeQty(normalized.qty ?? normalized.quantity ?? normalized.amount, code);
      return { code, brand, qty };
    })
    .filter((row): row is ImportedOrderRow => row !== null);
}

function rowsFromCsv(text: string) {
  const parsed = parseCsv(text);
  if (!parsed.length) return [];
  const [headerRow, ...bodyRows] = parsed;
  const headers = headerRow.map((cell) => normalizeHeader(cell));
  return bodyRows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

export async function parseOrderImportFile(file: File, fallbackBrand = ""): Promise<ImportedOrderRow[]> {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (isSpreadsheetTextExtension(extension)) {
    assertSpreadsheetFile(file, ["csv", "tsv", "txt", "xlsx", "xlsm", "xls"]);
    const text = await file.text();
    return mapRows(rowsFromCsv(text), fallbackBrand);
  }

  if (["xlsx", "xlsm", "xls"].includes(extension)) {
    const [headerRow = [], ...bodyRows] = await readSpreadsheetMatrix(file);
    if (!headerRow.length) return [];
    const headers = headerRow.map((cell) => normalizeHeader(cell));
    const rows = bodyRows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
    return mapRows(rows, fallbackBrand);
  }

  throw new Error("Upload CSV, TSV, TXT, XLSX or XLS files.");
}
