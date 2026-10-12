import { multiplyMoney, sumMoney, roundMoney, requireQuantity, requireUnitPrice } from "../../../../shared/order-money.mjs";
import type { ExportRows } from "./xlsxCore";

export type DocumentKind = "sales-order" | "invoice" | "purchase-order" | "bill";
export type DocumentExportLine = {
  code: string; brand?: string; description?: string; qty: number; unitPrice: number;
  amount?: number; origin?: string; weight?: number | null; tariff?: string; orderNo?: string;
};
export type DocumentExportInput = {
  kind: DocumentKind; audience: "admin" | "customer" | "supplier"; number: string; party: string;
  currency: string; date?: string; status?: string; lines: DocumentExportLine[];
  discount?: number; shipping?: number; total?: number;
};

export function documentAmounts(lines: Array<Pick<DocumentExportLine, "qty" | "unitPrice" | "amount">>, shipping = 0, discount = 0, total?: number) {
  if (!lines.length) throw new Error("Line details are not loaded. Reload the document before exporting.");
  const amounts = lines.map((line) => {
    const amount = multiplyMoney(requireUnitPrice(line.unitPrice), requireQuantity(line.qty));
    if (line.amount != null && roundMoney(line.amount) !== amount) throw new Error("Document line totals are inconsistent. Refresh or correct the document before exporting.");
    return amount;
  });
  if (!Number.isFinite(shipping) || !Number.isFinite(discount) || shipping < 0 || discount < 0) throw new Error("Invalid document shipping or discount.");
  const subtotal = sumMoney(amounts);
  const calculatedTotal = sumMoney([subtotal, roundMoney(shipping), -roundMoney(discount)]);
  if (calculatedTotal < 0 || (total != null && roundMoney(total) !== calculatedTotal)) throw new Error("Document total is inconsistent. Refresh or correct the document before exporting.");
  return { amounts, subtotal, total: calculatedTotal };
}

// Explicit whitelist: never serialize supplier notes, costs, OEMs, photos or email
// from arbitrary source objects into customer-facing commercial documents.
export function buildDocumentWorksheet(input: DocumentExportInput) {
  const buying = input.kind === "purchase-order" || input.kind === "bill";
  if ((input.audience === "customer" && buying) || (input.audience === "supplier" && !buying)) throw new Error("This document is not available for this audience.");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("Document currency is invalid.");
  const totals = documentAmounts(input.lines, input.shipping, input.discount, input.total);
  const sourceOrder = input.kind === "invoice" || input.kind === "bill";
  const headers = ["Code", "Brand", "Description", "Qty", "Origin", "Weight kg", "Tariff", ...(sourceOrder ? ["Source Order"] : []), `${buying ? "Buy" : "Unit"} Price ${input.currency}`, `Line Total ${input.currency}`];
  const priceColumn = headers.length - 2;
  const rows: ExportRows = [
    [input.kind, input.number], ["Party", input.party], ["Currency", input.currency],
    ["Date", input.date || ""], ["Status", input.status || ""], [], headers,
    ...input.lines.map((line, i) => [line.code, line.brand || "", line.description || "", line.qty, line.origin || "", line.weight ?? "", line.tariff || "", ...(sourceOrder ? [line.orderNo || ""] : []), line.unitPrice, totals.amounts[i]]),
  ];
  const dataEndRow = rows.length - 1;
  rows.push([]);
  for (const [label, amount] of [["Subtotal", totals.subtotal], ["Discount", input.discount || 0], ["Shipping", input.shipping || 0], ["Total Amount", totals.total]] as const) {
    const row: (string | number)[] = Array(headers.length).fill("");
    row[0] = label; row[headers.length - 1] = amount; rows.push(row);
  }
  return { rows, numericColumns: [3, 5, priceColumn, priceColumn + 1], options: { headerRow: 6, dataEndRow, expectedRows: input.lines.length, dataRows: input.lines.length, fullWidthTextColumns: [2], numberFormats: { 3: "General", [priceColumn]: "0.00####", [priceColumn + 1]: "0.00" } }, totals };
}
