import ExcelJS from "exceljs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { finished as streamFinished } from "node:stream/promises";
import { createInterface } from "node:readline";

export type StreamingExportWriter = {
  append(rows: readonly (readonly unknown[])[]): Promise<void>;
  appendAdditional?(rows: readonly (readonly unknown[])[]): Promise<void>;
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

export async function createXlsxExportStream(headers: readonly string[], sheetName: string, additional?: { headers: readonly string[]; sheetName: string; maxRows?: number }): Promise<StreamingExportWriter> {
  const directory = await mkdtemp(join(tmpdir(), "nm-admin-export-"));
  const filePath = join(directory, "export.xlsx");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true, useSharedStrings: false });
  const safeSheetName = String(sheetName || "Export").replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Export";
  const worksheet = workbook.addWorksheet(safeSheetName);
  const header = worksheet.addRow([...headers]);
  header.font = { bold: true };
  header.commit();
  const maxAdditionalRows = additional?.maxRows ?? 1_048_575;
  if (!Number.isSafeInteger(maxAdditionalRows) || maxAdditionalRows < 1 || maxAdditionalRows > 1_048_575) throw new Error("INVALID_XLSX_SHEET_LIMIT");
  // ExcelJS cannot stream several worksheets in parallel: archiver buffers
  // later sheets until the first closes. Spool details to disk, then write
  // them in worksheet order after committing the main sheet.
  const spoolPath = join(directory, "supplier-offers.jsonl");
  const spool = additional ? createWriteStream(spoolPath, { encoding: "utf8" }) : null;
  let spoolError: Error | null = null;
  spool?.on("error", (error) => { spoolError = error; });
  const spoolCompletion = spool ? streamFinished(spool).catch((error) => {
    spoolError = error instanceof Error ? error : new Error(String(error));
    throw spoolError;
  }) : null;
  void spoolCompletion?.catch(() => {});
  let extraSheet: ExcelJS.Worksheet | null = null;
  let extraRows = 0;
  let extraSheetCount = 0;
  const nextExtraSheet = () => {
    extraSheet?.commit();
    extraSheetCount += 1;
    const base = String(additional?.sheetName || "Supplier offers").replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim() || "Supplier offers";
    const suffix = ` ${extraSheetCount}`;
    extraSheet = workbook.addWorksheet(`${base.slice(0, 31 - suffix.length)}${suffix}`);
    const extraHeader = extraSheet.addRow([...(additional?.headers || [])]);
    extraHeader.font = { bold: true };
    extraHeader.commit();
    extraRows = 0;
  };
  let finished = false;
  return {
    async append(rows) {
      if (finished) throw new Error("EXPORT_STREAM_FINISHED");
      for (const row of rows) worksheet.addRow([...row]).commit();
    },
    async appendAdditional(rows) {
      if (finished) throw new Error("EXPORT_STREAM_FINISHED");
      if (!additional || !spool || !spoolCompletion) throw new Error("EXPORT_ADDITIONAL_SHEET_UNAVAILABLE");
      for (const row of rows) {
        if (spoolError) throw spoolError;
        if (!spool.write(`${JSON.stringify(row)}\n`)) await Promise.race([once(spool, "drain"), spoolCompletion]);
      }
      if (spoolError) throw spoolError;
    },
    async finish() {
      if (!finished) {
        if (spool && spoolCompletion) { spool.end(); await spoolCompletion; }
        worksheet.commit();
        if (additional) {
          nextExtraSheet();
          const input = createInterface({ input: createReadStream(spoolPath, { encoding: "utf8" }), crlfDelay: Infinity });
          for await (const line of input) {
            if (extraRows === maxAdditionalRows) nextExtraSheet();
            extraSheet!.addRow(JSON.parse(line)).commit();
            extraRows += 1;
          }
          extraSheet?.commit();
        }
        await workbook.commit();
        finished = true;
      }
      return readFile(filePath);
    },
    async cleanup() {
      // ExcelJS owns an open file stream until workbook.commit() settles.
      // Close it before removing the temp directory on any early failure.
      if (!finished) {
        finished = true;
        if (spool && !spool.writableEnded && !spool.destroyed) spool.end();
        if (spoolCompletion) await Promise.allSettled([spoolCompletion]);
        try { worksheet.commit(); extraSheet?.commit(); await workbook.commit(); } catch { /* preserve the original export error */ }
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
