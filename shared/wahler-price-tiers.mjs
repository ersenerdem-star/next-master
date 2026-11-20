import { markupMoney } from './order-money.mjs';

export function isWahlerBrand(brand) {
  return typeof brand === 'string' && brand.trim().toLowerCase() === 'wahler';
}

// Convert only price and quantity. Supplier identity and costs are excluded
// from the selling-price rows before workbook data is persisted.
export function quantityTierLabels(rows, marginPercent = null) {
  const grouped = new Map();
  for (const row of rows) {
    const price = Number(row.unit_buy_price);
    if (typeof row.code !== 'string' || !Number.isInteger(row.minimum_quantity) ||
      row.minimum_quantity < 2 || !Number.isFinite(price) || price <= 0) {
      throw new Error('Invalid quantity tier in price list.');
    }
    const unitPrice = marginPercent == null ? price : markupMoney(price, marginPercent);
    const tiers = grouped.get(row.code) || [];
    tiers.push({ quantity:row.minimum_quantity, unitPrice });
    grouped.set(row.code,tiers);
  }
  return new Map([...grouped].map(([code, tiers]) => [code,tiers
    .sort((a,b) => a.quantity-b.quantity)
    .map(t => `${t.quantity}+: ${t.unitPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6,useGrouping:false})}`)
    .join(' | ')]));
}
