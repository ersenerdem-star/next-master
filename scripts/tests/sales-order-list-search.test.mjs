import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../../apps/web/src/presentation/pages/QuotesPage.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("QuotesPage.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const declaration = parsed.statements.find((statement) =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "matchesSalesOrderSearch");
assert.ok(declaration);
const compiled = ts.transpileModule(declaration.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const normalize = (value) => String(value || "").toLowerCase().trim();
const matchesSalesOrderSearch = new Function(
  "normalizeSearchText", "normalizePartCode", "buildEntityAlias", "matchesOriginalNumberSearch",
  `const exports = {}; ${compiled} return matchesSalesOrderSearch;`,
)(normalize, (value) => normalize(value).replace(/[^a-z0-9]/g, ""), normalize, () => false);

test("sales order summary search finds a brand even when order lines were not loaded", () => {
  const summary = {
    sales_order_no: "FU26-001", customer_name: "Fuatti", seller_company: "Juventa",
    purchase_company: "", status: "draft", source_channel: "internal", lines: [],
  };
  assert.equal(matchesSalesOrderSearch(summary, "Sachs", ["Sachs", "Boge"]), true);
  assert.equal(matchesSalesOrderSearch(summary, "BOGE", ["Sachs", "Boge"]), true);
  assert.equal(matchesSalesOrderSearch(summary, "Mercedes-Benz", ["Sachs", "Boge"]), false);
  assert.equal(matchesSalesOrderSearch(summary, "FU26-001", []), true);
});
