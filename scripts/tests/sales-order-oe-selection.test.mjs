import test from "node:test";
import assert from "node:assert/strict";
import { hasAmbiguousSku, selectExactOeCandidates } from "../../apps/web/src/shared/salesOrderOeSelection.ts";

test("shared OE yields every distinct matched SKU, never a partial or unrelated result", () => {
  const rows = [
    { product_id: "a", product_code: "CD119002", brand: "TITANX", oem_no: "9405000454, A 123 45" },
    { product_id: "b", product_code: "CX119002", brand: "TITANX", oem_no: "940 500 04 54" },
    { product_id: "c", product_code: "OTHER", brand: "TITANX", oem_no: "19405000454" },
    { product_id: "d", product_code: "PREFIX", brand: "TITANX", oem_no: "A9405000454" },
    { product_id: "a", product_code: "CD119002", brand: "TITANX", oem_no: "9405000454" },
  ];
  assert.deepEqual(selectExactOeCandidates(rows, "9405000454").map((row) => row.product_code), ["CD119002", "CX119002"]);
});

test("OE matching preserves leading zeroes and does not infer a missing manufacturer prefix", () => {
  const rows = [
    { product_id: "a", product_code: "0001", brand: "TITANX", oem_no: "A0002343111" },
    { product_id: "b", product_code: "0002", brand: "TITANX", oem_no: "0002343111" },
  ];
  assert.deepEqual(selectExactOeCandidates(rows, "A0002343111").map((row) => row.product_code), ["0001"]);
  assert.deepEqual(selectExactOeCandidates(rows, "2343111"), []);
  assert.deepEqual(selectExactOeCandidates(rows, ""), []);
});

test("rows without a complete product identity cannot be offered for selection", () => {
  const rows = [
    { product_id: "", product_code: "123", brand: "TITANX", oem_no: "456" },
    { product_id: "a", product_code: "", brand: "TITANX", oem_no: "456" },
    { product_id: "b", product_code: "123", brand: "", oem_no: "456" },
  ];
  assert.deepEqual(selectExactOeCandidates(rows, "456"), []);
});

test("duplicate catalog identities cannot be chosen by SKU-only price resolver", () => {
  const rows = [
    { product_id: "a", product_code: "313.739", brand: "Sachs" },
    { product_id: "b", product_code: "313739", brand: "Sachs" },
    { product_id: "c", product_code: "313739", brand: "TITANX" },
  ];
  assert.equal(hasAmbiguousSku(rows, rows[0]), true);
  assert.equal(hasAmbiguousSku(rows, rows[1]), true);
  assert.equal(hasAmbiguousSku(rows, rows[2]), false);
});
