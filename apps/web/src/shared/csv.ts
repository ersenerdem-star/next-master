export function detectDelimiter(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
  const candidates = [",", ";", "\t", "\x1b"];
  const scored = candidates
    .map((delimiter) => {
      const counts = lines.map((line) => line.split(delimiter).length);
      const min = counts.length ? Math.min(...counts) : 0;
      const avg = counts.length ? counts.reduce((sum, count) => sum + count, 0) / counts.length : 0;
      const consistent = counts.length && counts.every((count) => count === counts[0]) ? 1 : 0;
      return { delimiter, min, avg, consistent };
    })
    .sort((a, b) => {
      if (b.min !== a.min) return b.min - a.min;
      if (b.consistent !== a.consistent) return b.consistent - a.consistent;
      if (b.avg !== a.avg) return b.avg - a.avg;
      return 0;
    });
  const best = scored[0]?.delimiter || ",";
  const hasDecimalComma = lines.some((line) => /\d,\d/.test(line));
  const hasSemicolon = lines.some((line) => line.includes(";"));
  if (best === "," && hasDecimalComma && hasSemicolon) return ";";
  return best;
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
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
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
