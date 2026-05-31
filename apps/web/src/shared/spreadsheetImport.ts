import { read, utils } from "xlsx";

const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;

function normalizeMatrixCell(value: unknown) {
  return String(value ?? "");
}

export function assertSpreadsheetFile(file: File, allowedExtensions: string[]) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!allowedExtensions.includes(extension)) {
    throw new Error(`Upload ${allowedExtensions.map((value) => value.toUpperCase()).join(", ")} files only.`);
  }
  if (file.size <= 0) {
    throw new Error("The uploaded file is empty.");
  }
  if (file.size > MAX_SPREADSHEET_BYTES) {
    throw new Error("Spreadsheet imports are limited to 10 MB.");
  }
  return extension;
}

export async function readSpreadsheetMatrix(file: File) {
  const extension = assertSpreadsheetFile(file, ["xlsx", "xlsm", "xls"]);
  const buffer = await file.arrayBuffer();
  const workbook = read(buffer, {
    type: "array",
    dense: true,
    raw: false,
    cellFormula: false,
    bookVBA: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
  });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [] as string[][];
  const sheet = workbook.Sheets[firstSheetName];
  const rows = utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: false,
  });
  return rows.map((row) => row.map((cell) => normalizeMatrixCell(cell)));
}

export function isSpreadsheetTextExtension(extension: string) {
  return ["csv", "tsv", "txt"].includes(extension);
}
