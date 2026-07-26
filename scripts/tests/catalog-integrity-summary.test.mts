import assert from "node:assert/strict";
import test from "node:test";
import {
  mapCatalogIntegritySummary,
  shouldDisplayCatalogIntegrityCounts,
} from "../../apps/web/src/shared/catalogIntegritySummary.ts";

test("queued summary without evaluation activity still exposes the direct catalog snapshot", () => {
  const summary = mapCatalogIntegritySummary({
    backfill_status: "queued",
    projected_products: 0,
    total_products: 421_367,
    clear_count: 279_714,
    incomplete_count: 141_653,
  });

  assert.equal(summary.initialization_state, "not_initialized");
  assert.equal(summary.total_products, 421_367);
  assert.equal(summary.clear_count, 279_714);
  assert.equal(summary.incomplete_count, 141_653);
  assert.equal(shouldDisplayCatalogIntegrityCounts(summary.initialization_state), true);
});

test("queued summary with projected rows is partial while catalog counters stay visible", () => {
  const summary = mapCatalogIntegritySummary({ backfill_status: "queued", projected_products: 3, total_products: 10 });

  assert.equal(summary.initialization_state, "partial");
  assert.equal(summary.total_products, 10);
  assert.equal(shouldDisplayCatalogIntegrityCounts(summary.initialization_state), true);
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

test("maps operational coverage and missing-field counters", () => {
  const summary = mapCatalogIntegritySummary({
    evaluated_products: 30_440,
    evaluation_coverage_percent: 7.2,
    data_completeness_percent: 66.4,
    queue_depth: 5_499,
    missing_ean_count: 387_862,
    missing_oem_count: 201_402,
    missing_vehicle_count: 352_926,
    missing_image_count: 214_339,
    last_catalog_change_at: "2026-07-26T14:37:19Z",
  });

  assert.equal(summary.evaluated_products, 30_440);
  assert.equal(summary.evaluation_coverage_percent, 7.2);
  assert.equal(summary.data_completeness_percent, 66.4);
  assert.equal(summary.queue_depth, 5_499);
  assert.equal(summary.missing_ean_count, 387_862);
  assert.equal(summary.missing_oem_count, 201_402);
  assert.equal(summary.missing_vehicle_count, 352_926);
  assert.equal(summary.missing_image_count, 214_339);
  assert.equal(summary.last_catalog_change_at, "2026-07-26T14:37:19Z");
});
