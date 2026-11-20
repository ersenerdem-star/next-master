import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { resolveQuantityPrice } from '../../shared/quantity-pricing.mjs';
import { previewQuantityPriceList } from '../../apps/engine/supplier-price-shadow/src/quantity-price-preview.mjs';

const csv = (...rows) => Readable.from(['Product_Code;MOQ; Buy_Price_Eur \n', rows.join('\n')]);

test('Wahler has one product with three prices and a tier applies to the whole line', async () => {
  const preview = await previewQuantityPriceList(csv(
    '411471.103D;1;30,58',
    '411471.103D;256;28,82',
    '411471.103D;16;29,68',
  ), { sourceDate: '2026-11-12' });
  assert.equal(preview.rowCount, 3);
  assert.equal(preview.productCount, 1);
  assert.equal(preview.tieredProductCount, 1);
  assert.deepEqual(preview.issues, []);
  const { code, currency, tiers } = preview.items[0];
  assert.equal(code, '411471.103D');
  assert.equal(currency, 'EUR');
  for (const [quantity, minQuantity, total] of [
    [1, 1, 30.58], [15, 1, 458.70], [16, 16, 474.88], [17, 16, 504.56],
    [255, 16, 7568.40], [256, 256, 7377.92], [257, 256, 7406.74],
  ]) {
    const quote = resolveQuantityPrice(tiers, quantity);
    assert.equal(quote.current.quantity, quantity);
    assert.equal(quote.current.minQuantity, minQuantity);
    assert.equal(quote.current.total, total);
  }
});

test('amount comparisons suggest extra units only when the total decreases', () => {
  const tiers = [{ minQuantity: 1, unitPrice: 1.20 }, { minQuantity: 100, unitPrice: 1.16 }];
  const quote = resolveQuantityPrice(tiers, 99);
  assert.equal(quote.current.quantity, 99);
  assert.equal(quote.current.total, 118.80);
  assert.equal(quote.suggestion.quantity, 100);
  assert.equal(quote.suggestion.total, 116);
  assert.equal(quote.suggestion.savings, 2.80);
  assert.equal(resolveQuantityPrice(tiers, 90).suggestion, null);
  assert.equal(resolveQuantityPrice(tiers, 101).current.total, 117.16);
  assert.equal(resolveQuantityPrice([{ ...tiers[1], availableQuantity: 99 }, tiers[0]], 99).suggestion, null);
});

test('preview reports repeated thresholds and invalid quantities without combining distinct codes', async () => {
  const preview = await previewQuantityPriceList(csv('ABC-1;16;29,68', 'ABC-1;16;28,82', 'ABC1;1;30,58', 'Z;0;2,00'));
  assert.deepEqual(preview.items.map(item => item.code), ['ABC-1', 'ABC1']);
  assert.deepEqual(preview.issues, [{ line: 2, code: 'DUPLICATE_PRICE_THRESHOLD' }, { line: 4, code: 'INVALID_PRICE_THRESHOLD' }]);
});

test('explicit pack multiples and expiry are independent of the minimum price threshold', () => {
  const base = { minQuantity: 1, unitPrice: 30.58 };
  const tier = { minQuantity: 16, unitPrice: 29.68, orderMultiple: 16, validTo: '2026-11-30' };
  assert.equal(resolveQuantityPrice([base, tier], 17).current.minQuantity, 1);
  assert.equal(resolveQuantityPrice([base, tier], 32, { date: '2026-11-30' }).current.minQuantity, 16);
  assert.equal(resolveQuantityPrice([base, tier], 32, { date: '2026-12-01' }).current.minQuantity, 1);
  assert.throws(() => resolveQuantityPrice([base, base], 1), /Duplicate price threshold/);
  assert.throws(() => resolveQuantityPrice([base], 1.5), /whole number/);
});
