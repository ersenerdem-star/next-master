import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Load the actual private readers with their I/O replaced. This exercises
// fallback branches that are otherwise hard to reach through published RPCs.
function loadReaders(path: string, names: string[], dependencies: Record<string, unknown>) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const source = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ""))
    .map((node) => node.getText(ast)).join("\n");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}; return {${names.join(",")}};`)(...Object.values(dependencies));
}

test("portal legacy price fallback filters disabled suppliers before price ranking and pagination", async () => {
  const fixtures = [
    { normalized_code: "123", brand_id: "brand", buy_price: 1, suppliers: { name: "Disabled", price_usage_enabled: false } },
    { normalized_code: "123", brand_id: "brand", buy_price: 2, suppliers: { name: "Enabled", price_usage_enabled: true } },
    { normalized_code: "456", brand_id: "brand", buy_price: 3, suppliers: { name: "Enabled", price_usage_enabled: true } },
  ];
  const reads: Record<string, string>[] = [];
  const names = ["chunkValues", "effectiveSupplierPriceFilters", "fetchPortalBestSupplierPriceMap", "fetchPortalBestSupplierOptionMap", "fetchPortalBestSupplierPreviewMap"];
  const readers = loadReaders("../../netlify/functions/_shared/portal-orders.mts", names, {
    PORTAL_PRICE_LIST_SUPPLIER_PAGE_SIZE: 2,
    fetchAll: async (_url: string, _key: string, table: string, params: Record<string, string>) => {
      assert.equal(table, "supplier_prices");
      assert.match(params.select, /suppliers!inner\(/);
      assert.equal(params["suppliers.price_usage_enabled"], "eq.true");
      reads.push(params);
      const offset = Number(params.offset || 0);
      const limit = Number(params.limit);
      // Apply PostgREST's parent inner join before the limit, not afterward.
      return fixtures.filter((row) => row.suppliers.price_usage_enabled).slice(offset, offset + limit);
    },
  });
  const price = await readers.fetchPortalBestSupplierPriceMap("url", "key", "org", "brand", ["123"]);
  assert.equal(price.get("123"), 2);
  const options = await readers.fetchPortalBestSupplierOptionMap("url", "key", "org", "brand", ["123", "456"]);
  assert.equal(options.get("123").supplier_name, "Enabled");
  assert.equal(options.get("456").buy_price, 3);
  const preview = await readers.fetchPortalBestSupplierPreviewMap("url", "key", "org", [{ brandId: "brand", normalizedCode: "123" }]);
  assert.equal(preview.get("brand::123").buy_price, 2);
  assert.equal(reads.length, 4, "the options fallback also follows its pagination boundary");
});

test("catalog direct price fallback excludes disabled supplier from cheapest, second and supplier count", async () => {
  const rows = [
    { id: "old", normalized_code: "123", supplier_id: "disabled", buy_price: 1, suppliers: { name: "Disabled", price_usage_enabled: false } },
    { id: "new", normalized_code: "123", supplier_id: "enabled", buy_price: 10, suppliers: { name: "Enabled", price_usage_enabled: true } },
    { id: "other", normalized_code: "123", supplier_id: "other", buy_price: 15, suppliers: { name: "Other", price_usage_enabled: true } },
  ];
  const filters: Record<string, unknown> = {};
  const query = {
    select(value: string) { assert.match(value, /suppliers!inner\(name,price_usage_enabled\)/); return this; },
    eq(key: string, value: unknown) { filters[key] = value; return this; },
    not() { return this; },
    in() { return this; },
    then(resolve: (value: unknown) => unknown) {
      assert.equal(filters["suppliers.price_usage_enabled"], true);
      return Promise.resolve(resolve({ data: rows.filter((row) => row.suppliers.price_usage_enabled), error: null }));
    },
  };
  const readers = loadReaders("../../apps/web/src/infrastructure/api/masterApi.ts", ["chunkValues", "comparePriceRows", "roundPriceMetric", "fetchSupplierStatsFromPrices"], {
    supabaseClient: { from(table: string) { assert.equal(table, "supplier_prices"); return query; } },
    sanitizeUserFacingMessage: (value: string) => value,
  });
  const stats = await readers.fetchSupplierStatsFromPrices({ organizationId: "org", brandId: "brand", normalizedCodes: ["123"] });
  assert.deepEqual({
    cheapest: stats.get("123").cheapestSupplier,
    second: stats.get("123").secondSupplierName,
    price: stats.get("123").cheapestPrice,
    count: stats.get("123").supplierCount,
  }, { cheapest: "Enabled", second: "Other", price: 10, count: 2 });
});
