// Shared browser/server contract: decimal arithmetic; round each line once,
// half away from zero (Postgres numeric), then sum cents. No binary products.
const MAX_CENTS = 99999999999999n; // numeric(14,2), existing order totals
function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid monetary value.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid monetary value.');
  const text = String(value).trim();
  if (text.length > 128) throw new Error('Monetary value is out of range.');
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new Error('Invalid monetary value.');
  const exponent = Number(match[4] || 0);
  if (Math.abs(exponent) > 24) throw new Error('Monetary value is out of range.');
  let scale = (match[3] || '').length - exponent;
  let coefficient = BigInt(match[2] + (match[3] || '')) * (match[1] === '-' ? -1n : 1n);
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  if (scale > 12) throw new Error('A maximum of 12 decimal places is supported.');
  return { coefficient, scale };
}
function divideRound(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator * sign;
  return sign * ((magnitude + denominator / 2n) / denominator);
}
function centsFromDecimal({ coefficient, scale }) {
  return scale <= 2 ? coefficient * 10n ** BigInt(2 - scale)
    : divideRound(coefficient, 10n ** BigInt(scale - 2));
}
function fromCents(cents) {
  if (cents > MAX_CENTS || cents < -MAX_CENTS) throw new Error('Order total is out of range.');
  return Number(cents) / 100;
}
export function roundMoney(value) { return fromCents(centsFromDecimal(decimal(value))); }
export function multiplyMoney(price, quantity) {
  const a = decimal(price), b = decimal(quantity);
  return fromCents(centsFromDecimal({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale }));
}
export function sumMoney(values) {
  return fromCents(values.reduce((sum, value) => sum + centsFromDecimal(decimal(value)), 0n));
}
export function marginPercent(profit, total) {
  const denominator = centsFromDecimal(decimal(total));
  if (denominator <= 0n) return 0;
  return fromCents(divideRound(centsFromDecimal(decimal(profit)) * 10000n, denominator));
}
export function markupMoney(price, percent) {
  const a = decimal(price), b = decimal(percent);
  const multiplier = 100n * 10n ** BigInt(b.scale) + b.coefficient;
  return fromCents(centsFromDecimal({ coefficient: a.coefficient * multiplier, scale: a.scale + b.scale + 2 }));
}
export function requireUnitPrice(value, positive = false) {
  const parsed = decimal(value);
  if (parsed.coefficient < 0n || (positive && parsed.coefficient === 0n)) throw new Error('A positive price is required before confirming the order.');
  // Range check without discarding unit precision.
  if (parsed.coefficient * 100n > MAX_CENTS * 10n ** BigInt(parsed.scale)) throw new Error('Order price is out of range.');
  return Number(value);
}
export function requireQuantity(value) {
  const parsed = decimal(value);
  if (parsed.coefficient <= 0n || parsed.scale > 6 || Number(value) > 1000000000) throw new Error('Quantity must be positive and within the supported range.');
  return Number(value);
}
export function salesOrderTotals(lines, shipping = 0, discount = 0, confirmed = false) {
  if (!Array.isArray(lines) || lines.length > 10000 || (confirmed && !lines.length)) throw new Error('Order must contain valid lines.');
  const purchaseLines = [], salesLines = [];
  for (const line of lines) {
    const qty = requireQuantity(line.qty);
    const buy = line.buy_price == null && !confirmed ? 0 : line.buy_price;
    const sell = line.sell_price == null && !confirmed ? 0 : line.sell_price;
    requireUnitPrice(buy, confirmed); requireUnitPrice(sell, confirmed);
    purchaseLines.push(multiplyMoney(buy, qty)); salesLines.push(multiplyMoney(sell, qty));
  }
  requireUnitPrice(shipping); requireUnitPrice(discount);
  const purchase_total = sumMoney(purchaseLines), subtotal = sumMoney(salesLines);
  const sales_total = sumMoney([subtotal, roundMoney(shipping), -roundMoney(discount)]);
  if (sales_total < 0) throw new Error('Discount cannot exceed the order total.');
  const profit_total = sumMoney([sales_total, -purchase_total]);
  return { purchase_total, subtotal, sales_total, profit_total, margin_percent: marginPercent(profit_total, sales_total) };
}
