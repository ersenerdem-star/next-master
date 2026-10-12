export type DecimalInput = number | string;
export function roundMoney(value: DecimalInput): number;
export function multiplyMoney(price: DecimalInput, quantity: DecimalInput): number;
export function sumMoney(values: DecimalInput[]): number;
export function marginPercent(profit: DecimalInput, total: DecimalInput): number;
export function markupMoney(price: DecimalInput, percent: DecimalInput): number;
export function requireUnitPrice(value: unknown, positive?: boolean): number;
export function requireQuantity(value: unknown): number;
export function salesOrderTotals(lines: Array<{ buy_price: DecimalInput | null; sell_price: DecimalInput | null; qty: DecimalInput }>, shipping?: DecimalInput, discount?: DecimalInput, confirmed?: boolean): { purchase_total: number; subtotal: number; sales_total: number; profit_total: number; margin_percent: number };
