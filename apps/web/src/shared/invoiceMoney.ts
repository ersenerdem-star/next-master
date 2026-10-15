import { multiplyMoney, sumMoney, requireUnitPrice, requireQuantity, roundMoney, marginPercent, salesOrderTotals } from "../../../../shared/order-money.mjs";
import type { LocalInvoice, LocalBill } from "../types/orders";

// Same decimal contract as order conversion. Pure calculation: neither input
// mutation nor timestamps, persistence, receiving or payment side effects.
export function recomputeInvoiceTotals(input: LocalInvoice): LocalInvoice {
  const totals = salesOrderTotals(input.lines, input.shipping_cost, input.discount_amount);
  const lines = input.lines.map((line) => {
    const qty = requireQuantity(line.qty);
    const buy_price = requireUnitPrice(line.buy_price);
    const sell_price = requireUnitPrice(line.sell_price);
    const purchase_total = multiplyMoney(buy_price, qty);
    const sales_total = multiplyMoney(sell_price, qty);
    const profit_total = sumMoney([sales_total, -purchase_total]);
    return { ...line, qty, buy_price, sell_price, purchase_total, sales_total, profit_total, margin_percent: marginPercent(profit_total, sales_total) };
  });
  return { ...input, lines, shipping_cost: roundMoney(input.shipping_cost), discount_amount: roundMoney(input.discount_amount),
    subtotal: totals.subtotal, total_amount: totals.sales_total, purchase_total: totals.purchase_total,
    profit_total: totals.profit_total, margin_percent: totals.margin_percent };
}

export function recomputeBillTotals(input: LocalBill): LocalBill {
  if (!Array.isArray(input.lines) || input.lines.length > 10000) throw new Error("Invoice must contain valid lines.");
  const lines = input.lines.map((line) => {
    const qty = requireQuantity(line.qty);
    const buy_price = requireUnitPrice(line.buy_price);
    return { ...line, qty, buy_price, line_total: multiplyMoney(buy_price, qty) };
  });
  requireUnitPrice(input.shipping_cost);
  requireUnitPrice(input.discount_amount);
  const subtotal = sumMoney(lines.map((line) => line.line_total));
  const shipping_cost = roundMoney(input.shipping_cost);
  const discount_amount = roundMoney(input.discount_amount);
  const total_amount = sumMoney([subtotal, shipping_cost, -discount_amount]);
  if (total_amount < 0) throw new Error("Discount cannot exceed the invoice total.");
  return { ...input, lines, subtotal, shipping_cost, discount_amount, total_amount };
}

// Invalid intermediate editor input is not coerced into a plausible total and
// must not throw during React rendering. Save/export still use strict functions.
export function previewInvoiceMoney<T>(calculate: (input: T) => T, input: T | null): { value: T | null; error: string | null } {
  if (!input) return { value: null, error: null };
  try { return { value: calculate(input), error: null }; }
  catch (error) { return { value: null, error: error instanceof Error ? error.message : "Invalid invoice amounts." }; }
}
