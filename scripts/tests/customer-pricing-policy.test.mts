import test from "node:test";
import assert from "node:assert/strict";
import { markupMoney } from "../../shared/order-money.mjs";
import { normalizeCustomerPricingType, requireActiveCustomerPricing } from "../../netlify/functions/_shared/pricing/pricing-policy.mts";

test("only A, B, and account-margin pricing are active", () => {
  for (const type of ["A", "B", "Other"] as const) {
    assert.equal(normalizeCustomerPricingType(type), type);
  }
  assert.doesNotThrow(() => requireActiveCustomerPricing("A", null));
  assert.doesNotThrow(() => requireActiveCustomerPricing("B", 12.5));
  assert.doesNotThrow(() => requireActiveCustomerPricing("Other", 0));
  assert.throws(() => requireActiveCustomerPricing("Other", null), /custom margin/);
  assert.throws(() => requireActiveCustomerPricing("A", Number.NaN), /valid number/);
  assert.equal(normalizeCustomerPricingType("C"), "C"); // Preserve legacy identity for a clear error.
  assert.throws(() => requireActiveCustomerPricing("C", null), /retired C/);
  assert.throws(() => normalizeCustomerPricingType("unexpected"), /invalid/);
});

test("account markup agrees with decimal export rounding", () => {
  assert.equal(markupMoney(1.15, 10), 1.27);
  assert.equal(markupMoney(1.15, 12.5), 1.29);
  assert.equal(markupMoney(1.15, 0), 1.15);
});
