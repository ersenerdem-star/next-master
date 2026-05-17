import { read, utils } from "xlsx";
import { parseCsv } from "./csv";

type ImportedOrderRow = {
  code: string;
  brand: string;
  qty: number;
};

function normalizeHeader(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function normalizeQty(value: unknown) {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function mapRows(rawRows: Array<Record<string, unknown>>, fallbackBrand = "") {
  return rawRows
    .map((row) => {
      const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
      const code = String(
        normalized.part_no ||
          normalized.part_number ||
          normalized.product_code ||
          normalized.code ||
          normalized.item_code ||
          "",
      ).trim();
      const brand = String(normalized.brand || fallbackBrand || "").trim();
      const qty = normalizeQty(normalized.qty || normalized.quantity || normalized.amount || 1);
      return { code, brand, qty };
    })
    .filter((row) => row.code);
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
  if (["csv", "tsv", "txt"].includes(extension)) {
    const text = await file.text();
    return mapRows(rowsFromCsv(text), fallbackBrand);
  }

  if (["xlsx", "xlsm", "xls"].includes(extension)) {
    const buffer = await file.arrayBuffer();
    const workbook = read(buffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    const sheet = workbook.Sheets[firstSheetName];
    const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });
    return mapRows(rows, fallbackBrand);
  }

  throw new Error("Upload CSV, TSV, TXT, XLSX or XLS files.");
}
