import type { SalesBrandDetail, SalesBrandSummary } from "../infrastructure/api/salesBrandReportApi";

const summaryKey = (r: SalesBrandSummary) => JSON.stringify([r.brand, r.currency]);
const canonical = (rows: SalesBrandSummary[]) => rows.map((r) => [summaryKey(r), Number(r.order_count), Number(r.line_count), Number(r.detail_count), r.content_hash, Number(r.missing_price_count), Number(r.missing_quantity_count), r.quantity == null ? null : Number(r.quantity), r.amount == null ? null : Number(r.amount)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
export function expectedSalesBrandRows(summary: SalesBrandSummary[]) {
  return summary.reduce((sum, row) => {
    if (!row.content_hash) throw new Error("Rapor bütünlük bilgisi eksik. Lütfen tekrar deneyin.");
    const count = Number(row.detail_count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Rapor satır sayısı geçersiz.");
    return sum + count;
  }, 0);
}
export function verifySalesBrandExport(before: SalesBrandSummary[], after: SalesBrandSummary[], details: SalesBrandDetail[]) {
  if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))) throw new Error("Rapor hazırlanırken siparişler değişti. Güncel raporu tekrar yükleyin.");
  if (details.length !== expectedSalesBrandRows(before)) throw new Error("Excel için tüm satırlar alınamadı. Lütfen tekrar deneyin.");
  const seen = new Set<string>();
  const groups = new Map<string, { count: number; missing: number; missingQuantity: number; quantity: number | null; amount: number | null; orders: Set<string> }>();
  for (const row of details) {
    const identity = JSON.stringify([row.order_id, row.line_index]);
    if (seen.has(identity)) throw new Error("Excel verisinde tekrarlanan bir satır bulundu. Lütfen tekrar deneyin.");
    seen.add(identity);
    const key = JSON.stringify([row.brand, row.currency]);
    const group = groups.get(key) || { count: 0, missing: 0, missingQuantity: 0, quantity: null, amount: null, orders: new Set<string>() };
    group.count++; if (Number(row.line_index) !== 0 && row.unit_price == null) group.missing++;
    if (Number(row.line_index) !== 0 && row.quantity == null) group.missingQuantity++;
    if (row.quantity != null) group.quantity = (group.quantity ?? 0) + Number(row.quantity);
    if (row.amount != null) group.amount = (group.amount ?? 0) + Number(row.amount);
    group.orders.add(row.order_id);
    groups.set(key, group);
  }
  for (const row of before) {
    const g = groups.get(summaryKey(row));
    const close = (a: number | null, b: number | null) => a == null || b == null ? a == null && b == null : Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= Math.max(0.000001, Math.abs(Number(b)) * 1e-10);
    if (!g || g.count !== Number(row.detail_count) || g.missing !== Number(row.missing_price_count) || g.missingQuantity !== Number(row.missing_quantity_count) || g.orders.size !== Number(row.order_count) || !close(g.quantity, row.quantity) || !close(g.amount, row.amount)) throw new Error("Excel satırları rapor özetiyle uyuşmuyor. Lütfen tekrar deneyin.");
  }
  if (groups.size !== before.length) throw new Error("Excel verisi rapor özetiyle uyuşmuyor. Lütfen tekrar deneyin.");
}

// The same filters are used for every request. Never return a partial workbook.
export async function collectSalesBrandExport(
  summary: () => Promise<SalesBrandSummary[]>,
  page: (offset: number, limit: number) => Promise<SalesBrandDetail[]>,
  progress: (received: number, total: number) => void = () => {},
) {
  const before = await summary();
  const count = expectedSalesBrandRows(before);
  if (count + before.length + 8 > 1_048_576) throw new Error("Excel satır sınırı aşılıyor. Daha dar tarih veya marka filtresi seçin.");
  const all: SalesBrandDetail[] = [];
  for (let offset = 0; offset < count; offset += 500) {
    const rows = await page(offset, 500);
    if (rows.length !== Math.min(500, count - offset)) throw new Error("Tüm satırlar alınamadı. Tekrar deneyin.");
    all.push(...rows);
    progress(all.length, count);
  }
  const after = await summary();
  verifySalesBrandExport(before, after, all);
  return { summary: before, details: all, count };
}
