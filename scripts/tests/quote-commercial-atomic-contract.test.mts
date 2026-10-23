import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { readSupplierCommercialTerms } from "../../apps/web/src/domain/shared/supplierCommercialTerms.ts";
import { canonicalizePriceProductCode } from "../../apps/web/src/domain/shared/normalize.ts";

function resolver(options: unknown[], fail = false) {
  const file = new URL("../../apps/web/src/infrastructure/api/quoteResolverApi.ts", import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const declarations = ["exactSku", "resolveQuoteLine"].map((name) => {
    const node = source.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node); return node.getText(source);
  });
  const compiled = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const calls: string[] = [];
  const deps = {
    canonicalizePriceProductCode,
    canonicalizeBrandName: (v: string) => v,
    normalizePartCode: (v: string) => v.replace(/[^A-Z0-9]/gi, "").toUpperCase(),
    enrichLifecycle: async (v: unknown) => v,
    readSupplierCommercialTerms,
    callAppRpc: async (rpc: string, args: Record<string, unknown>) => {
      calls.push(rpc); assert.equal(args.input_code, "61/1");
      if (rpc === "cloud_resolve_quote_line_v3") return [{ found: true, product_code: "61/1", brand: "Clevite", buy_price: 999, sell_price: 1099, moq: 100, order_multiple: 12 }];
      assert.equal(rpc, "cloud_quote_supplier_commercial_options_v3", "Never fetch price and rules independently");
      if (fail) throw new Error("Current commercial lookup unavailable");
      return options;
    },
  };
  return { resolve: new Function(...Object.keys(deps), `const exports = {}; ${compiled}; return resolveQuoteLine;`)(...Object.values(deps)), calls };
}
const input = { code: "61/1", brand: "Clevite", customerType: "A", marginA: 10, marginB: 15 };
const option = { supplier_id: "supplier-1", supplier_name: "Exact supplier", buy_price: 10, sell_price: 11, price_date: "2026-10-14", notes: null, moq: 5, order_multiple: 4, stock_qty: 0, valid_to: "2026-12-31" };

test("quote price and MOQ/pack terms come from one current supplier row, preserving real zero", async () => {
  const { resolve, calls } = resolver([option]);
  const result = await resolve(input);
  assert.deepEqual(calls, ["cloud_resolve_quote_line_v3", "cloud_quote_supplier_commercial_options_v3"]);
  assert.equal(result.resolved.buy_price, 10);
  assert.equal(result.resolved.moq, 5);
  assert.equal(result.resolved.order_multiple, 4);
  assert.equal(result.supplierOptions[0].stock_qty, 0);
  assert.equal(Object.hasOwn(result.supplierOptions[0], "available_qty"), false);
});

test("authoritative null clears stale pack terms; expired/absent current option cannot restore old price", async () => {
  const cleared = await resolver([{ ...option, moq: null, order_multiple: null }]).resolve(input);
  assert.equal(cleared.resolved.moq, null);
  assert.equal(cleared.resolved.order_multiple, null);
  const expired = await resolver([]).resolve(input);
  assert.equal(expired.resolved.buy_price, null);
  assert.equal(expired.resolved.sell_price, null);
  assert.equal(expired.resolved.order_multiple, null);
});

test("commercial lookup failure, missing supplier identity or invalid terms never falls back to legacy rules", async () => {
  await assert.rejects(resolver([], true).resolve(input), /Current commercial lookup unavailable/);
  for (const value of [{ ...option, supplier_id: "" }, { ...option, order_multiple: 0 }, { ...option, stock_qty: undefined }, { ...option, valid_to: "2026-02-30" }]) {
    await assert.rejects(resolver([value]).resolve(input), /could not be verified/);
  }
});
