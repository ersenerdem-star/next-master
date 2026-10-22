import { offerPreparedDownload } from "./preparedDownload";
export function detectDelimiter(text: string) {
  const candidates = [",", ";", "\t", "\x1b"];
  const scored = candidates
    .map((delimiter) => {
      const scanner = createCsvStreamScanner(delimiter);
      let rows = scanner.push(text);
      try {
        rows = rows.concat(scanner.finish());
      } catch {
        // A bounded sniff sample may end inside a quoted field. Rows already
        // emitted are still sufficient to identify the delimiter.
      }
      const fieldCounts = rows
        .filter((row) => row.some((value) => value.trim()))
        .slice(0, 5)
        .map((row) => row.length);
      const headerFields = fieldCounts[0] || 0;
      const dataCounts = fieldCounts.slice(1);
      const matchingDataRows = dataCounts.filter((count) => count === headerFields).length;
      const consistent = dataCounts.length > 0 && matchingDataRows === dataCounts.length ? 1 : 0;
      const totalFields = fieldCounts.reduce((sum, count) => sum + count, 0);
      return { delimiter, headerFields, matchingDataRows, consistent, totalFields };
    })
    .sort((a, b) => {
      if (b.headerFields !== a.headerFields) return b.headerFields - a.headerFields;
      if (b.matchingDataRows !== a.matchingDataRows) return b.matchingDataRows - a.matchingDataRows;
      if (b.consistent !== a.consistent) return b.consistent - a.consistent;
      return b.totalFields - a.totalFields;
    });
  return scored[0]?.delimiter || ",";
}

function createCsvStreamScanner(delimiter: string) {
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let pendingQuote = false;
  let skipLf = false;
  let firstCell = true;

  function emitRow(rows: string[][]) {
    const emitted = row.map((value, index) => index === 0 && firstCell ? value.replace(/^\uFEFF/, "") : value);
    if (emitted.some((value) => value.trim())) {
      rows.push(emitted);
      firstCell = false;
    }
    row = [];
    cell = "";
  }

  return {
    push(input: string) {
      const rows: string[][] = [];
      for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const next = input[index + 1];

        if (pendingQuote) {
          pendingQuote = false;
          if (char === '"') {
            cell += '"';
            continue;
          }
          quoted = false;
        }

        if (skipLf) {
          skipLf = false;
          if (char === "\n") continue;
        }

        if (char === '"' && quoted && next === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"' && quoted && next === undefined) {
          pendingQuote = true;
        } else if (char === '"') {
          quoted = !quoted;
        } else if (quoted) {
          cell += char;
        } else if (char === delimiter) {
          row.push(cell);
          cell = "";
        } else if (char === "\r" || char === "\n") {
          row.push(cell);
          if (char === "\r") skipLf = true;
          emitRow(rows);
        } else {
          cell += char;
        }
      }
      return rows;
    },
    finish() {
      if (pendingQuote) {
        pendingQuote = false;
        quoted = false;
      }
      if (quoted) throw new Error("CSV_UNTERMINATED_QUOTE");
      const rows: string[][] = [];
      if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        emitRow(rows);
      }
      return rows;
    },
  };
}

/**
 * Read CSV rows from a Blob without materializing the whole file or all rows
 * in browser memory. The scanner preserves quoted delimiters/newlines and
 * handles UTF-8 characters split across stream chunks.
 */
export async function* streamCsvRows(source: Blob): AsyncGenerator<string[]> {
  const reader = source.stream().getReader();
  const decoder = new TextDecoder();
  let sample = "";
  let scanner: ReturnType<typeof createCsvStreamScanner> | null = null;
  let bufferedInput = "";

  const initializeScanner = () => {
    if (scanner) return;
    scanner = createCsvStreamScanner(detectDelimiter(sample || bufferedInput || ","));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!scanner) {
        sample += chunk;
        bufferedInput += chunk;
        // Five complete physical lines or 64 KiB is enough to identify the
        // delimiter without retaining the rest of a large upload.
        const lineCount = (sample.match(/[\r\n]/g) || []).length;
        if (lineCount >= 5 || sample.length >= 64 * 1024) initializeScanner();
      } else {
        bufferedInput += chunk;
      }
      const activeScanner = scanner as ReturnType<typeof createCsvStreamScanner> | null;
      if (activeScanner) {
        const input = bufferedInput;
        bufferedInput = "";
        for (const row of activeScanner.push(input)) yield row;
      }
    }

    const tail = decoder.decode();
    if (!scanner) {
      sample += tail;
      bufferedInput += tail;
      initializeScanner();
    } else if (tail) {
      bufferedInput += tail;
    }
    const activeScanner = scanner as ReturnType<typeof createCsvStreamScanner> | null;
    if (!activeScanner) throw new Error("CSV_SCANNER_NOT_INITIALIZED");
    for (const row of activeScanner.push(bufferedInput)) yield row;
    for (const row of activeScanner.finish()) yield row;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function parseCsv(text: string) {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const text = String(cell ?? "");
          return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join(","),
    )
    .join("\n");
}

export function downloadCsv(name: string, content: string, type = "text/csv;charset=utf-8") {
  offerPreparedDownload(name, new Blob([content], { type }));
}

export function normalizeText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function normalizeNumber(value: string | number | null | undefined) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalise the date formats commonly found in supplier spreadsheets before
 * they reach the Postgres `date` column.  The API accepts ISO dates; supplier
 * files often use the Turkish/European DD.MM.YYYY form instead.
 */
export function normalizeImportDate(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  let year: number;
  let month: number;
  let day: number;
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const europeanMatch = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
  if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else if (europeanMatch) {
    day = Number(europeanMatch[1]);
    month = Number(europeanMatch[2]);
    year = Number(europeanMatch[3]);
  } else {
    return null;
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** Parse a value that must be stored in an integer database column. */
export function normalizeInteger(value: string | number | null | undefined) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!text) return null;

  if (/^[+-]?\d+$/.test(text)) {
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  // Spreadsheet thousands separators (for example, 1.000 or 1,000) are
  // safe to remove only when every group after the first has three digits.
  if (/^[+-]?\d{1,3}(?:[.,]\d{3})+$/.test(text)) {
    const parsed = Number(text.replace(/[.,]/g, ""));
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Stock quantities from some supplier files use a dot as a thousands
 * separator even for values below 1,000 ("1.64" means 164 in that export).
 * Keep this opt-in so prices and MOQ values are never silently rewritten.
 */
export function normalizeStockQuantity(value: string | number | null | undefined) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!text) return null;
  if (/^\d+[.,]\d{2}$/.test(text)) {
    const parsed = Number(text.replace(/[.,]/g, ""));
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return normalizeInteger(text);
}
