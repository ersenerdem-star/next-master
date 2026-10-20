import { multiplyMoney } from "../../../../shared/order-money.mjs";
import { exactPurchaseCode, offerBlockReason, type PurchaseSupplierOffer } from "./purchaseSourcing";
import type { ExportRows, WorkbookOptions } from "./xlsxCore";

export type SalesPurchaseAnalysisLine = {
  code: string; brand: string; description: string; qty: number;
  supplier: string; buyPrice: number | null; sellPrice: number | null;
};
type PriceBatch = Array<{ request_index: number; options: PurchaseSupplierOffer[] }>;
export async function loadSalesPurchaseAnalysisOffers(
  lines: SalesPurchaseAnalysisLine[],
  request: (args: { input_requests: Array<{ code: string; brand: string }> }) => Promise<PriceBatch>,
  progress?: (count: number) => void,
) {
  if (!lines.length) throw new Error("Add order lines before exporting.");
  if (lines.some(l => !l.code.trim() || !l.brand.trim())) throw new Error("Every line needs a part number and brand before exporting purchase alternatives.");
  const rows: PurchaseSupplierOffer[][] = [];
  for (let offset = 0; offset < lines.length; offset += 25) {
    const batch = lines.slice(offset, offset + 25);
    const result = await request({ input_requests: batch.map(l => ({ code: l.code, brand: l.brand })) });
    if (!Array.isArray(result) || result.length !== batch.length) throw new Error("Supplier price response incomplete. No file was downloaded.");
    for (let i = 0; i < batch.length; i++) {
      const matches = result.filter(r => r.request_index === i);
      if (matches.length !== 1 || !Array.isArray(matches[0].options)) throw new Error("Supplier price response incomplete. No file was downloaded.");
      rows.push(matches[0].options);
    }
    progress?.(rows.length);
  }
  return rows;
}

// A supplier always occupies the same column across the order. Prices come
// from the current EUR reader, never from cached quote supplierOptions.
export function buildSalesPurchaseAnalysis(input: {
  number: string; currency: string; lines: SalesPurchaseAnalysisLine[];
  offers: PurchaseSupplierOffer[][]; generatedAt: string;
}) {
  if (!input.lines.length || input.offers.length !== input.lines.length) throw new Error("Purchase analysis is incomplete.");
  const prices = input.lines.map((line, index) => {
    const bySupplier = new Map<string, PurchaseSupplierOffer>();
    for (const offer of input.offers[index]) {
      if (exactPurchaseCode(offer.product_code) !== exactPurchaseCode(line.code) || offer.brand.trim().toLowerCase() !== line.brand.trim().toLowerCase()) continue;
      if (!offer.supplier_id || !offer.supplier_name.trim() || !Number.isFinite(offer.buy_price) || offer.buy_price <= 0) continue;
      if (bySupplier.has(offer.supplier_id)) throw new Error("Ambiguous supplier prices. Refresh prices before exporting.");
      bySupplier.set(offer.supplier_id, offer);
    }
    return bySupplier;
  });
  const suppliers = [...new Map(prices.flatMap(p => [...p.values()]).map(o => [o.supplier_id, o])).values()]
    .sort((a,b) => a.supplier_name.localeCompare(b.supplier_name) || a.supplier_id.localeCompare(b.supplier_id));
  const rows: ExportRows = [
    ["Sales Order purchase analysis · internal / superadmin", input.number],
    ["Price snapshot (UTC)", input.generatedAt],
    ["Supplier columns: current unit buy prices in EUR. Blank = no exact current offer. Order prices are snapshots; alternatives do not update the order."],
    ["Check MOQ, order multiples, stock and payment / logistics terms before ordering. This file does not assign or send purchase orders."],
    ["Part number", "Brand", "Description", "Quantity", "Order supplier", `Order unit buy (${input.currency})`, `Sales unit price (${input.currency})`, `Sales line total (${input.currency})`,
      ...suppliers.map(s => `${s.supplier_name}${suppliers.filter(o => o.supplier_name === s.supplier_name).length > 1 ? ` [${s.supplier_id}]` : ""} buy (EUR)`), "Supplier conditions / price dates"],
    ...input.lines.map((l,index) => [l.code,l.brand,l.description,l.qty,l.supplier,l.buyPrice,l.sellPrice,l.sellPrice == null ? null : multiplyMoney(l.sellPrice,l.qty),
      ...suppliers.map(s => prices[index].get(s.supplier_id)?.buy_price ?? null),
      [...prices[index].values()].map(o => `${o.supplier_name}: ${o.price_date || "date unspecified"}; MOQ ${o.moq ?? "—"}; multiple ${o.order_multiple ?? 1}; stock ${o.stock_qty ?? "—"}; valid to ${o.valid_to || "—"}${offerBlockReason(o,l.qty) ? `; CHECK ${offerBlockReason(o,l.qty)}` : ""}${o.notes ? `; ${o.notes}` : ""}`).join("\n")]),
  ];
  const numericColumns = [3,5,6,7,...suppliers.map((_,i) => 8+i)];
  const options: WorkbookOptions = { headerRow:4,dataEndRow:rows.length-1,expectedRows:input.lines.length,dataRows:input.lines.length,
    numberFormats:Object.fromEntries(numericColumns.filter(c => c !== 3).map(c => [c,"0.00####"])) };
  return {rows,numericColumns,options};
}
