import { multiplyMoney, requireUnitPrice, sumMoney } from './order-money.mjs';

const MAX_QUANTITY = 2147483647;

function wholeQuantity(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUANTITY) {
    throw new RangeError('Quantity must be a whole number between 1 and 2147483647.');
  }
  return value;
}

// A tier is a minimum for the entire line. Order multiples apply independently.
export function resolveQuantityPrice(tiers, requestedQuantity, { date } = {}) {
  const quantity = wholeQuantity(requestedQuantity);
  const seen = new Set();
  const offers = tiers.map(tier => {
    const minQuantity = wholeQuantity(tier.minQuantity);
    if (seen.has(minQuantity)) throw new Error('Duplicate price threshold.');
    seen.add(minQuantity);
    const orderMultiple = wholeQuantity(tier.orderMultiple ?? 1);
    const unitPrice = requireUnitPrice(tier.unitPrice, true);
    return { ...tier, minQuantity, orderMultiple, unitPrice };
  }).filter(offer => !date ||
    ((!offer.validFrom || offer.validFrom <= date) && (!offer.validTo || date <= offer.validTo))
  ).sort((a, b) => b.minQuantity - a.minQuantity);

  const priceAt = units => offers.find(offer =>
    offer.minQuantity <= units && units % offer.orderMultiple === 0 &&
    (offer.availableQuantity == null || units <= offer.availableQuantity)
  );

  const quote = (offer, units) => ({
    ...offer,
    quantity: units,
    total: multiplyMoney(offer.unitPrice, units),
  });
  const eligible = priceAt(quantity);
  if (!eligible) return { current: null, suggestion: null };

  const current = quote(eligible, quantity);
  let suggestion = null;
  for (const offer of offers) {
    if (offer.minQuantity <= current.minQuantity || offer.unitPrice >= current.unitPrice) continue;
    const orderQuantity = Math.ceil(Math.max(quantity + 1, offer.minQuantity) / offer.orderMultiple) * offer.orderMultiple;
    if (orderQuantity > MAX_QUANTITY) continue;
    const applicable = priceAt(orderQuantity);
    if (!applicable) continue;
    const alternative = quote(applicable, orderQuantity);
    if (alternative.total >= current.total) continue;
    if (!suggestion || alternative.total < suggestion.total ||
      (alternative.total === suggestion.total && alternative.quantity < suggestion.quantity)) {
      suggestion = {
        ...alternative,
        extraUnits: orderQuantity - quantity,
        savings: sumMoney([current.total, -alternative.total]),
      };
    }
  }
  return { current, suggestion };
}
