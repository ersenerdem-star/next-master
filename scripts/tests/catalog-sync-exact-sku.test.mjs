import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { exactProductCode } from "../../apps/web/src/shared/currentSupplierPriceSync.mts";

// These UI modules depend on Vite's import.meta.env. Run their actual pure
// functions in isolation rather than replacing the SKU logic in the test.
function loadFunctions(relativeFile, functionNames, dependencies) {
  const path = new URL(relativeFile, import.meta.url);
  const source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.ES2022, true);
  const declarations = functionNames.map((name) => {
    const node = parsed.statements.find((statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `${name} must remain a function declaration`);
    return node.getText(parsed);
  });
  const compiled = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const names = Object.keys(dependencies);
  return new Function(...names, `const exports = {};\n${compiled}\nreturn { ${functionNames.join(", ")} };`)(...Object.values(dependencies));
}

test("purchase draft keeps punctuation-distinct SKUs on separate lines", () => {
  const { mergeCatalogLineIntoPurchaseDraft } = loadFunctions(
    "../../apps/web/src/presentation/pages/PurchasesPage.tsx",
    ["purchaseDraftLineKey", "mergeCatalogLineIntoPurchaseDraft"],
    { exactProductCode },
  );
  const slash = { brand: "Clevite", product_code: "61/1", old_code: "", qty: 1, line_total: 8.34 };
  const plain = { brand: "Clevite", product_code: "611", old_code: "", qty: 1, line_total: 405.72 };
  const original = { lines: [slash], line_count: 1, total_amount: 8.34 };
  const separate = mergeCatalogLineIntoPurchaseDraft(original, plain);
  assert.deepEqual(separate.lines.map((line) => line.product_code), ["611", "61/1"]);
  assert.equal(separate.line_count, 2);
  const combined = mergeCatalogLineIntoPurchaseDraft(original, { ...slash, product_code: " 61 / 1 ", qty: 2 });
  assert.equal(combined.line_count, 1);
  assert.equal(combined.lines[0].qty, 3);
});

test("sales-order resync refuses colliding code references and catalog metadata", async () => {
  const normalizePartCode = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const deps = {
    exactProductCode,
    normalizePartCode,
    normalizeBrandKey: (value) => String(value || "").trim().toLowerCase(),
    canonicalizeBrandName: (value) => String(value || "").trim(),
    fetchCodeReferenceMatchesForRows: async () => new Map([["clevite::611", { old_code: "611", new_code: "NEW", reason: "" }]]),
    fetchCatalogMetadataForRows: async () => new Map([["clevite::611", { product_code: "611", description: "plain metadata" }]]),
    mergeCatalogMetadata: (line, metadata) => ({ ...line, description: metadata?.description || line.description }),
  };
  const { resyncSalesOrderLinesFromCatalog } = loadFunctions(
    "../../apps/web/src/shared/salesOrderCatalogSync.ts",
    ["resyncSalesOrderLinesFromCatalog"],
    deps,
  );
  const input = [
    { brand: "Clevite", requestedCode: "61/1", resolvedCode: "61/1", description: "slash metadata", buy_price: 8.34, sell_price: 9.17 },
    { brand: "Clevite", requestedCode: "611", resolvedCode: "611", description: "plain", buy_price: 405.72, sell_price: 446.29 },
  ];
  const result = await resyncSalesOrderLinesFromCatalog(input, { customerType: "A", marginA: 10, marginB: 15 });
  assert.equal(result[0].resolvedCode, "61/1");
  assert.equal(result[0].description, "slash metadata");
  assert.equal(result[0].buy_price, 8.34);
  assert.equal(result[1].resolvedCode, "NEW");
});

test("single-line code reference lookup rejects a compact-key SKU collision", async () => {
  let rows = [{ id: "ref-1", brand_id: "brand-1", old_code: "611", new_code: "NEW", brands: { name: "Clevite" } }];
  const query = { select() { return this; }, eq() { return this; }, limit() { return this; } };
  const { findCodeReferenceMatch } = loadFunctions(
    "../../apps/web/src/infrastructure/api/codeReferencesApi.ts",
    ["findCodeReferenceMatch"],
    {
      normalizePartCode: (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      supabaseClient: { from: () => query },
      resolveBrandRow: async () => ({ id: "brand-1" }),
      withTimeout: async () => ({ data: rows, error: null }),
      sanitizeUserFacingMessage: (message) => message,
    },
  );
  assert.equal(await findCodeReferenceMatch({ code: "61/1", brand: "Clevite" }), null);
  assert.equal((await findCodeReferenceMatch({ code: "611", brand: "Clevite" }))?.new_code, "NEW");
  rows = [{ ...rows[0], old_code: "61/1" }];
  assert.equal((await findCodeReferenceMatch({ code: "61/1", brand: "Clevite" }))?.new_code, "NEW");
});

test("published quote import refuses 611 when 61/1 has no current price", async () => {
  const { fetchCurrentSupplierPriceBatch } = loadFunctions(
    "../../apps/web/src/infrastructure/api/quoteImportApi.ts",
    ["exactSku", "chunk", "fetchCurrentSupplierPriceBatch"],
    { callAppRpc: async () => [{ request_index: 0, has_published_scope: true, options: [{
      supplier_id: "supplier-1", supplier_name: "Sood", product_code: "611", buy_price: 405.72,
    }] }] },
  );
  await assert.rejects(
    fetchCurrentSupplierPriceBatch([{ code: "61/1", brand: "Clevite" }]),
    /invalid price/,
  );
});

test("single-line quote resolution refuses a differently priced compact-key SKU", async () => {
  const { resolveQuoteLine } = loadFunctions(
    "../../apps/web/src/infrastructure/api/quoteResolverApi.ts",
    ["exactSku", "resolveQuoteLine"],
    {
      canonicalizeBrandName: (value) => value,
      callAppRpc: async () => [{ found: true, product_code: "611", brand: "Clevite", buy_price: 405.72 }],
      enrichLifecycle: async (row) => row,
    },
  );
  await assert.rejects(
    resolveQuoteLine({ code: "61/1", brand: "Clevite", customerType: "A", marginA: 10, marginB: 15 }),
    /different product code/,
  );
});
