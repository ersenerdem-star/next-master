import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductIdentityCell } from "../../apps/web/src/presentation/components/master/MasterIntelligenceComponents";
import type { MasterRow } from "../../apps/web/src/types/master";

test("supplier comparison displays each exact product code, including punctuation and leading zeros", () => {
  const codes = ["DI95-07", "DI9507", "BF1018/1", "BF10181", "0001.20"];
  const html = codes.map((product_code) => renderToStaticMarkup(createElement(ProductIdentityCell, {
    row: { product_code, brand: "Mann", description: "Filter" } as MasterRow,
  })));
  for (const [index, code] of codes.entries()) {
    assert.match(html[index], new RegExp(`<span class="product-identity-cell__code">${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`));
  }
  assert.notEqual(html[0], html[1]);
  assert.notEqual(html[2], html[3]);
});
