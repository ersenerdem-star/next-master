import test from "node:test";
import assert from "node:assert/strict";
import { portalUpdateDate, portalUpdateText } from "../../apps/web/src/modules/portal/portalUpdates.ts";

test("seller updates show the useful message once, with a title fallback", () => {
  assert.equal(portalUpdateText("New Bosch price list", "Bosch list is ready", true), "Bosch list is ready");
  assert.equal(portalUpdateText("Seller deleted order", "   ", true), "Seller deleted order");
  assert.equal(portalUpdateText("Order updated", "New information available", false), "Order updated");
});

test("dates use the recorded instant and never invent a missing date", () => {
  assert.ok(portalUpdateDate("2026-11-17T08:50:00Z", "tr"));
  assert.equal(portalUpdateDate("invalid", "tr"), null);
  assert.equal(portalUpdateDate("", "en"), null);
});
