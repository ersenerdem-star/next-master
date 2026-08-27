import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalogDescription, stripCatalogItemNumberPrefix } from "../shared/catalog/catalog-standardization.mjs";

test("strips explicit item-number labels", () => {
  assert.equal(stripCatalogItemNumberPrefix("Item No: 20080350106 - Cylinder Head"), "Cylinder Head");
  assert.equal(normalizeCatalogDescription("ITEMS NO 20191410004 - Oil Cooler, engine oil"), "Oil Cooler, engine oil");
  assert.equal(normalizeCatalogDescription("Items code 74170414 Housing, differential"), "Housing, differential");
  assert.equal(normalizeCatalogDescription("ITEMS 74170419 | Ring gear"), "Ring gear");
});

test("strips long supplier-code prefixes but preserves ordinary dimensions", () => {
  assert.equal(normalizeCatalogDescription("20080350106 - Cylinder Head"), "Cylinder Head");
  assert.equal(normalizeCatalogDescription("95570622 - Synchromesh cone"), "Synchromesh cone");
  assert.equal(normalizeCatalogDescription("5W-30 Engine Oil"), "5W-30 Engine Oil");
});
