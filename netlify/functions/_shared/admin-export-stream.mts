import ExcelJS from "exceljs";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { finished as streamFinished } from "node:stream/promises";

export type StreamingExportWriter = {
  append(rows: readonly (readonly unknown[])[]): Promise<void>;
  finish(): Promise<Buffer>;
  cleanup(): Promise<void>;
};

function escapeCsv(value: unknown) {
  const text = value == null ? "" : String(value);
  const safeText = typeof value === "string" && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

export async function createCsvExportStream(headers: readonly string[], options: { bom?: boolean } = {}): Promise<StreamingExportWriter> {
  const directory = await mkdtemp(join(tmpdir(), "nm-admin-export-"));
  const filePath = join(directory, "export.csv");
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  let streamError: Error | null = null;
  stream.on("error", (error) => { streamError = error; });
  const closed = new Promise<void>((resolve) => stream.once("close", () => resolve()));
  // Attach lifecycle observation before the first write. Keep a rejection
  // handler live until finish/cleanup so a failure during an append cannot
  // become an unhandled stream error while the caller unwinds.
  const completion = streamFinished(stream).catch((error) => {
    streamError = error instanceof Error ? error : new Error(String(error));
    throw streamError;
  });
  void completion.catch(() => {});
  const write = async (chunk: string) => {
    if (streamError) throw streamError;
    if (!stream.write(chunk)) await Promise.race([once(stream, "drain"), completion]);
    if (streamError) throw streamError;
  };
  try {
    await write(`${options.bom ? "\uFEFF" : ""}${headers.map(escapeCsv).join(",")}\n`);
  } catch (error) {
    if (!stream.writableEnded && !stream.destroyed) stream.end();
    await Promise.allSettled([completion, closed]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let finished = false;
  return {
    async append(rows) {
      if (finished) throw new Error("EXPORT_STREAM_FINISHED");
      for (const row of rows) await write(`${row.map(escapeCsv).join(",")}\n`);
    },
    async finish() {
      if (!finished) { finished = true; stream.end(); await completion; await closed; }
      return readFile(filePath);
    },
    async cleanup() {
      if (!stream.writableEnded && !stream.destroyed) stream.end();
      await Promise.allSettled([completion, closed]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function createXlsxExportStream(headers: readonly string[], sheetName: string): Promise<StreamingExportWriter> {
  const directory = await mkdtemp(join(tmpdir(), "nm-admin-export-"));
  const filePath = join(directory, "export.xlsx");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true, useSharedStrings: false });
  const safeSheetName = String(sheetName || "Export").replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Export";
  const worksheet = workbook.addWorksheet(safeSheetName);
  const header = worksheet.addRow([...headers]);
  header.font = { bold: true };
  header.commit();
  let finished = false;
  return {
    async append(rows) {
      if (finished) throw new Error("EXPORT_STREAM_FINISHED");
      for (const row of rows) worksheet.addRow([...row]).commit();
    },
    async finish() {
      if (!finished) { finished = true; worksheet.commit(); await workbook.commit(); }
      return readFile(filePath);
    },
    async cleanup() {
      // ExcelJS owns an open file stream until workbook.commit() settles.
      // Close it before removing the temp directory on any early failure.
      if (!finished) {
        finished = true;
        try { worksheet.commit(); await workbook.commit(); } catch { /* preserve the original export error */ }
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
