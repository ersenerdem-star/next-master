export function parseManualMarginPercent(input) {
  const text = input.trim().replace(',', '.');
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) return null;
  return Number(text) / 100;
}

export function isManualMargin(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && parseManualMarginPercent((value * 100).toFixed(2)) === value;
}

export function adminPriceListFileLabel(priceListType, margin) {
  return priceListType === 'Manual' ? `Manual-${Number((margin * 100).toFixed(2))}pct` : priceListType;
}
