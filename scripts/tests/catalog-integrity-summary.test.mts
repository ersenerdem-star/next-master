import assert from "node:assert/strict";
import test from "node:test";
import {
  mapCatalogIntegritySummary,
  shouldDisplayCatalogIntegrityCounts,
} from "../../apps/web/src/shared/catalogIntegritySummary.ts";

test("queued summary without backfill activity remains unknown", () => {
  const summary = mapCatalogIntegritySummary({ backfill_status: "queued", projected_products: 0, total_products: 0 });

  assert.equal(summary.initialization_state, "not_initialized");
  assert.equal(summary.total_products, null);
  assert.equal(shouldDisplayCatalogIntegrityCounts(summary.initialization_state), false);
});

test("queued summary with projected rows is partial, not complete", () => {
  const summary = mapCatalogIntegritySummary({ backfill_status: "queued", projected_products: 3, total_products: 0 });

  assert.equal(summary.initialization_state, "partial");
  assert.equal(summary.total_products, null);
  assert.equal(shouldDisplayCatalogIntegrityCounts(summary.initialization_state), false);
});

test("running summary exposes truthful progress", () => {
  const summary = mapCatalogIntegritySummary({ backfill_status: "running", projected_products: 3, total_products: 10 });

  assert.equal(summary.initialization_state, "running");
  assert.equal(summary.total_products, 10);
  assert.equal(shouldDisplayCatalogIntegrityCounts(summary.initialization_state), true);
});

test("completed summary exposes normal totals", () => {
  const summary = mapCatalogIntegritySummary({ backfill_status: "completed", projected_products: 10, total_products: 10 });

  assert.equal(summary.initialization_state, "completed");
  assert.equal(summary.total_products, 10);
  assert.equal(shouldDisplayCatalogIntegrityCounts(summary.initialization_state), true);
});

test("failed summary preserves failure state", () => {
  const summary = mapCatalogIntegritySummary({ backfill_status: "failed", projected_products: 3, total_products: 10, backfill_error: "worker failed" });

  assert.equal(summary.initialization_state, "failed");
  assert.equal(summary.backfill_error, "worker failed");
  assert.equal(summary.total_products, 10);
});
