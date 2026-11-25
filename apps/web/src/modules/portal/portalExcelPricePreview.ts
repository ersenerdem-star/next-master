import type { PortalOrderInputRow, PortalPreparedLine } from "../../infrastructure/api/portalOrderApi";

// This workflow intentionally has no access to order state or order writes.
export async function priceExcelPreview(
  rows: PortalOrderInputRow[],
  prepare: (rows: PortalOrderInputRow[], signal: AbortSignal) => Promise<{ lines: PortalPreparedLine[]; pricingProfile?: { currency?: string } | null }>,
  signal: AbortSignal,
  onProgress: (processed: number, total: number) => void,
) {
  if (!rows.length) throw new Error("No part rows found in upload.");
  const lines: PortalPreparedLine[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const brand = row.brand.trim().toLowerCase();
    if (!brand) throw new Error("Brand is required on every row.");
    const key = `${brand}::${row.code.trim().toUpperCase().replace(/\s+/g, "")}`;
    if (seen.has(key)) throw new Error(`Duplicate part and brand: ${row.code} / ${row.brand}. Combine the quantities before checking.`);
    seen.add(key);
  }
  let currency = "";
  for (let start = 0; start < rows.length; start += 200) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const chunk = rows.slice(start, start + 200);
    const result = await prepare(chunk, signal);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const nextCurrency = result.pricingProfile?.currency || "";
    if (currency && nextCurrency && currency !== nextCurrency) throw new Error("Currency changed during the lookup. Retry the file.");
    if (nextCurrency) currency = nextCurrency;
    lines.push(...result.lines);
    onProgress(Math.min(start + chunk.length, rows.length), rows.length);
  }
  return { lines, currency };
}
