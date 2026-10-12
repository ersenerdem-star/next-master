import * as XLSX from "xlsx";

export type ExportCell = string | number | null | undefined;
export type ExportRows = ExportCell[][];
export type WorkbookOptions = { headerRow?: number; dataEndRow?: number; expectedRows?: number; dataRows?: number; numberFormats?: Record<number, string>; fullWidthTextColumns?: number[] };

// Application writer, shared by the UI fallback and its dedicated worker.
// Identifiers stay text; only declared numeric columns accept numeric strings.
export function buildWorkbookBytes(sheetName: string, rows: ExportRows, numericColumns: number[] = [], options: WorkbookOptions = {}) {
  if (!rows.length || rows.length > 1_048_576) throw new Error("Excel row limit exceeded or export is empty. Use a partitioned export.");
  if (options.expectedRows != null && options.dataRows !== options.expectedRows) throw new Error("Export is incomplete. No file was downloaded.");
  const numeric = new Set(numericColumns);
  const headerRow = options.headerRow ?? 0;
  const values = rows.map((row, r) => {
    if (row.length > 16_384) throw new Error("Excel column limit exceeded.");
    return row.map((cell, c) => {
      if (cell == null || cell === "") return "";
      if (typeof cell === "number") {
        if (!Number.isFinite(cell)) throw new Error(`Invalid number at row ${r + 1}, column ${c + 1}.`);
        return cell;
      }
      if (r > headerRow && numeric.has(c) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cell.trim())) {
        const value = Number(cell);
        if (!Number.isFinite(value)) throw new Error("Invalid numeric export value.");
        return value;
      }
      if (cell.length > 32_767) throw new Error(`Excel cell limit exceeded at row ${r + 1}, column ${c + 1}.`);
      return cell; // No formula inference, including =, +, -, @ prefixes.
    });
  });
  const sheet = XLSX.utils.aoa_to_sheet(values);
  for (const address of Object.keys(sheet)) {
    if (address.startsWith("!")) continue;
    const cell = sheet[address];
    if (cell.t === "s") cell.z = "@";
    else if (cell.t === "n") cell.z = options.numberFormats?.[XLSX.utils.decode_cell(address).c] || "0.######";
  }
  const width = Math.max(...rows.slice(0, 100).map((row) => row.length));
  sheet["!cols"] = Array.from({ length: width }, (_, col) => ({ wch: Math.min(48, Math.max(14, ...rows.slice(0, 100).map((row) => String(row[col] ?? "").length + 2))) }));
  // Only explicitly requested text columns scan the full document. Keep other
  // downloads compact and avoid spreading a large row array into Math.max.
  for (const col of options.fullWidthTextColumns || []) {
    if (!Number.isInteger(col) || col < 0 || col >= width) throw new Error("Invalid export width column.");
    let chars = 48;
    for (let r = headerRow; r <= (options.dataEndRow ?? rows.length - 1); r++) {
      const text = String(rows[r]?.[col] ?? "");
      for (const line of text.split(/\r?\n/)) chars = Math.max(chars, line.length + 2);
    }
    sheet["!cols"][col] = { wch: Math.min(255, chars) }; // Excel's column-width limit.
  }
  if (rows[headerRow]?.length) {
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: options.dataEndRow ?? rows.length - 1, c: rows[headerRow].length - 1 } }) };
  }
  const workbook = XLSX.utils.book_new();
  const name = sheetName.replace(/[\\/?*\[\]:]/g, "-").replace(/^'+|'+$/g, "").slice(0, 31) || "Export";
  XLSX.utils.book_append_sheet(workbook, sheet, name);
  return XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
}
