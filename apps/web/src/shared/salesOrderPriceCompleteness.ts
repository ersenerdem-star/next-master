type PriceLine = { buy_price?: number | null; sell_price?: number | null };

export function isMissingDocumentPrice(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "") || !Number.isFinite(Number(value));
}

export function hasMissingSalesPrice(lines: readonly PriceLine[]): boolean {
  return lines.some((line) => isMissingDocumentPrice(line.sell_price));
}

export function hasMissingPurchasePrice(lines: readonly PriceLine[]): boolean {
  return lines.some((line) => isMissingDocumentPrice(line.buy_price));
}

export function assertInvoiceSourcePrices(lines: readonly PriceLine[]): void {
  if (!lines.length || lines.some((line) => isMissingDocumentPrice(line.sell_price) || isMissingDocumentPrice(line.buy_price))) {
    throw new Error("INVOICE_SOURCE_PRICE_MISSING");
  }
}
