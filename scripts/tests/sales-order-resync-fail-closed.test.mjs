import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { exactProductCode } from "../../apps/web/src/shared/currentSupplierPriceSync.mts";

function loadSalesResync(dependencies) {
  const path = new URL("../../apps/web/src/shared/salesOrderCatalogSync.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.ES2022, true);
  const names = ["requireRepricingCurrency", "refreshLinePricesFromCatalog", "resyncSalesOrderLinesFromCatalog"];
  const declarations = names.map((name) => {
    const node = parsed.statements.find((statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `${name} must remain a function declaration`);
    return node.getText(parsed);
  });
  const compiled = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const dependencyNames = Object.keys(dependencies);
  return new Function(...dependencyNames,
    `const exports = {};\n${compiled}\nreturn resyncSalesOrderLinesFromCatalog;`)(...Object.values(dependencies));
}

function savedLine(code = "61/1") {
  return {
    requestedCode: code, resolvedCode: code, brand: "Clevite", qty: 1,
    description: "Old description", oem_no: "", hs_code: "", origin: "", weight_kg: null,
    supplier_name: "Sood", buy_price: 8.34, sell_price: 9.17,
    price_date: "2026-10-10", c_sell_price: null,
    supplierOptions: [{ supplier_id: "supplier-1", supplier_name: "Sood", buy_price: 8.34, sell_price: 9.17 }],
    selectedSupplierKey: "Sood-0", found: true,
  };
}

function makeResync(resolveQuoteLine) {
  return loadSalesResync({
    exactProductCode,
    normalizePartCode: (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    normalizeBrandKey: (value) => String(value || "").trim().toLowerCase(),
    canonicalizeBrandName: (value) => String(value || "").trim(),
    fetchCodeReferenceMatchesForRows: async () => new Map(),
    fetchCatalogMetadataForRows: async () => new Map(),
    mergeCatalogMetadata: (line) => line,
    fillText: (current, next) => next || current,
    fillNumber: (current, next) => next ?? current,
    getSelectedSupplierName: (line) => String(line.supplier_name || "").trim().toLowerCase(),
    lineHasVisiblePrices: (line) => Number(line.buy_price ?? 0) > 0 || Number(line.sell_price ?? 0) > 0,
    normalizeOrderQuantity: (qty) => ({ corrected: qty, adjusted: false, requested: qty }),
    resolveQuoteLine,
  });
}

const repriceOptions = { customerType: "A", marginA: 10, marginB: 15, currency: "EUR", keepPrices: false };

test("explicit resync rejects a removed exact SKU and never returns old priced lines", async () => {
  const original = [savedLine("61/1"), savedLine("611")];
  const before = structuredClone(original);
  const resync = makeResync(async ({ code }) => code === "61/1"
    ? { resolved: { found: false, product_code: code }, supplierOptions: [] }
    : { resolved: { found: true, product_code: code, brand: "Clevite" }, supplierOptions: [
      { supplier_id: "supplier-1", supplier_name: "Sood", buy_price: 405.72, sell_price: 446.29 },
    ] });
  await assert.rejects(resync(original, repriceOptions), /Clevite 61\/1.*No exact current price/);
  assert.deepEqual(original, before);
});

test("explicit resync propagates lookup errors with brand and SKU", async () => {
  const resync = makeResync(async () => { throw new Error("RPC unavailable"); });
  await assert.rejects(resync([savedLine()], repriceOptions), /Clevite 61\/1: RPC unavailable/);
});

test("explicit resync refuses a different supplier and a nonpositive current price", async () => {
  const wrongSupplier = makeResync(async () => ({
    resolved: { found: true, product_code: "61/1", brand: "Clevite" },
    supplierOptions: [{ supplier_id: "supplier-2", supplier_name: "Other", buy_price: 1, sell_price: 1.1 }],
  }));
  await assert.rejects(wrongSupplier([savedLine()], repriceOptions), /No exact current price/);

  const noPrice = makeResync(async () => ({
    resolved: { found: true, product_code: "61/1", brand: "Clevite" },
    supplierOptions: [{ supplier_id: "supplier-1", supplier_name: "Sood", buy_price: 0, sell_price: 9.17 }],
  }));
  await assert.rejects(noPrice([savedLine()], repriceOptions), /No exact current price/);
});

test("explicit resync uses only current prices and requires EUR", async () => {
  const resync = makeResync(async () => ({
    resolved: { found: true, product_code: "61/1", brand: "Clevite" },
    supplierOptions: [{ supplier_id: "supplier-1", supplier_name: "Sood", buy_price: 10, sell_price: 11, price_date: "2026-10-13" }],
  }));
  const [updated] = await resync([savedLine()], repriceOptions);
  assert.equal(updated.buy_price, 10);
  assert.equal(updated.sell_price, 11);
  assert.equal(updated.price_date, "2026-10-13");
  await assert.rejects(resync([savedLine()], { ...repriceOptions, currency: "USD" }), /currency to EUR/);
});

test("explicit keepPrices preserves saved prices without a lookup", async () => {
  let calls = 0;
  const resync = makeResync(async () => { calls += 1; throw new Error("RPC unavailable"); });
  const [kept] = await resync([savedLine()], { ...repriceOptions, currency: "USD", keepPrices: true });
  assert.equal(calls, 0);
  assert.equal(kept.buy_price, 8.34);
  assert.equal(kept.sell_price, 9.17);
});


test("explicit repricing clears a removed supplier pack rule without mutating the saved document", async () => {
  const original = { ...savedLine(), moq: 5, order_multiple: 4 };
  const before = structuredClone(original);
  const resync = makeResync(async () => ({
    resolved: { found: true, product_code: "61/1", brand: "Clevite" },
    supplierOptions: [{ supplier_id: "supplier-1", supplier_name: "Sood", buy_price: 10, sell_price: 11, moq: null, order_multiple: null }],
  }));
  const [updated] = await resync([original], repriceOptions);
  assert.equal(updated.moq, null);
  assert.equal(updated.order_multiple, null);
  assert.deepEqual(original, before);
});
