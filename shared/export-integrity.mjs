export function assertCompleteExport(actual, expected, limit = 1_048_575) {
  if (!Number.isSafeInteger(actual) || actual < 1 || !Number.isSafeInteger(expected) || expected < 1) throw new Error("Export row count could not be verified. No complete file is available.");
  if (expected > limit) throw new Error(`Export requires partitioning: ${expected} rows exceed the ${limit} row limit. No partial file will be offered.`);
  if (actual !== expected) throw new Error(`Export is incomplete: prepared ${actual} of ${expected} rows. No partial file will be offered.`);
}

export function advanceExportPage(rows, previousCursor, previousTotal) {
  const keys = rows.map((row) => row.normalizedCode);
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length || keys.includes(previousCursor)) throw new Error("Export cursor did not advance uniquely. Refresh the export snapshot.");
  const totals = rows.filter((row) => row.totalCount != null).map((row) => row.totalCount);
  const total = totals[0] ?? previousTotal;
  if (totals.some((value) => value !== total) || (previousTotal != null && total !== previousTotal)) throw new Error("Export data changed while preparing. Retry with a fresh snapshot.");
  return { cursor: keys.at(-1), total };
}
