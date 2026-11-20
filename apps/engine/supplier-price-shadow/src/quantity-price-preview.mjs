import { parseNormalizedSupplierPriceRows } from './streaming-csv.mjs';

// Explicit preview path for quantity-priced lists. The regular upload workflow
// keeps its existing duplicate checks and continues using its own parser.
export async function previewQuantityPriceList(readable, { sourceDate } = {}) {
  const products = new Map();
  const issues = [];
  let rowCount = 0;
  for await (const row of parseNormalizedSupplierPriceRows(readable, { sourceDate, commercialFields: true })) {
    rowCount++;
    const line = row.source_row_number;
    if (row.row_status !== 'accepted') {
      issues.push({ line, code: row.error_code ?? row.error_message });
      continue;
    }
    if (!Number.isInteger(row.moq) || row.moq < 1 || row.moq > 2147483647) {
      issues.push({ line, code: 'INVALID_PRICE_THRESHOLD' });
      continue;
    }
    let item = products.get(row.normalized_code);
    if (!item) {
      item = { code: row.product_code, currency: row.currency, prices: new Map() };
      products.set(row.normalized_code, item);
    }
    if (item.currency !== row.currency) {
      issues.push({ line, code: 'PRODUCT_CURRENCY_MISMATCH' });
      continue;
    }
    if (item.prices.has(row.moq)) {
      issues.push({ line, code: 'DUPLICATE_PRICE_THRESHOLD' });
      continue;
    }
    item.prices.set(row.moq, {
      minQuantity: row.moq,
      unitPrice: row.buy_price,
      orderMultiple: row.order_multiple,
      availableQuantity: row.stock_qty,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      sourceRow: line,
    });
  }
  const items = [...products.values()].map(({ code, currency, prices }) => ({
    code,
    currency,
    tiers: [...prices.values()].sort((a, b) => a.minQuantity - b.minQuantity),
  }));
  return {
    rowCount,
    productCount: items.length,
    tieredProductCount: items.filter(item => item.tiers.length > 1).length,
    items,
    issues,
  };
}
