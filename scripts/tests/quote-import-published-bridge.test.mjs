import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = fileURLToPath(new URL("../../apps/web/src/infrastructure/api/quoteImportApi.ts", import.meta.url));
const mockedModules = {
  appRpcApi: "export const callAppRpc = (...args) => globalThis.__quoteImportMocks.callAppRpc(...args);",
  codeReferencesApi: "export const fetchCodeReferenceMatchesForRows = (...args) => globalThis.__quoteImportMocks.codeReferences(...args);",
  organizationApi: "export const getCurrentOrgId = (...args) => globalThis.__quoteImportMocks.organizationId(...args);",
  supabaseClient: "export const supabaseClient = globalThis.__quoteImportMocks.supabaseClient;",
};

const bundled = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [{
    name: "quote-import-boundary-mocks",
    setup(build) {
      build.onResolve({ filter: /\/(appRpcApi|codeReferencesApi|organizationApi|supabaseClient)$/ }, (args) => ({
        path: args.path.split("/").at(-1),
        namespace: "quote-import-test",
      }));
      build.onLoad({ filter: /.*/, namespace: "quote-import-test" }, (args) => ({
        contents: mockedModules[args.path],
        loader: "js",
      }));
    },
  }],
});
let moduleLoadCount = 0;
async function loadQuoteImport() {
  moduleLoadCount += 1;
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}#${moduleLoadCount}`);
}

function tableClient(tables, calls) {
  return {
    from(table) {
      calls.push(table);
      const filters = [];
      const query = {
        select() { return this; },
        eq(column, value) { filters.push((row) => row[column] === value); return this; },
        in(column, values) { filters.push((row) => values.includes(row[column])); return this; },
        not(column, _operator, value) { filters.push((row) => row[column] !== value); return this; },
        then(resolve, reject) {
          const data = (tables[table] || []).filter((row) => filters.every((filter) => filter(row)));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("published quote import keeps 61/1 distinct from 611 and ignores a colliding legacy reference", async () => {
  const calls = [];
  globalThis.__quoteImportMocks = {
    organizationId: async () => "org-1",
    codeReferences: async () => new Map([["clevite::611", {
      old_code: "611", new_code: "611", reason: null,
    }]]),
    supabaseClient: tableClient({
      brands: [{ id: "brand-1", name: "Clevite", organization_id: "org-1" }],
      catalog_products: [{ id: "catalog-611", product_code: "611", normalized_code: "611", normalized_oem: "", brand_id: "brand-1", organization_id: "org-1" }],
      supplier_prices: [{ supplier_id: "legacy-supplier", brand_id: "brand-1", product_code: "611", normalized_code: "611", buy_price: 0.01, is_active: true, organization_id: "org-1", suppliers: { name: "Wrong legacy price" } }],
    }, calls),
    callAppRpc: async (name, args) => {
      assert.equal(name, "cloud_current_supplier_price_options_batch");
      return args.input_requests.map(({ code }, request_index) => ({
        request_index,
        has_published_scope: true,
        options: [{
          supplier_id: "supplier-1", supplier_name: "Clevite supplier", brand_id: "brand-1", brand: "Clevite",
          product_code: code, description: "", buy_price: code === "61/1" ? "8.34" : "405.72",
          price_date: "2026-10-10", notes: null, moq: null, order_multiple: null, stock_qty: null, valid_to: null,
        }],
      }));
    },
  };
  const { batchResolveQuoteImportRows } = await loadQuoteImport();
  const lines = await batchResolveQuoteImportRows({
    rows: [{ code: "61/1", brand: "Clevite", qty: 1 }, { code: "611", brand: "Clevite", qty: 1 }],
    customerType: "A", marginA: 10, marginB: 15,
  });
  assert.deepEqual(lines.map((line) => [line.resolvedCode, line.buy_price, line.sell_price]), [
    ["61/1", 8.34, 9.17],
    ["611", 405.72, 446.29],
  ]);
  assert.equal(lines[0].codeChanged, false);
  assert.equal(calls.includes("supplier_prices"), false);
});

test("quote import uses canonical legacy supplier options when no publication exists", async () => {
  const calls = [];
  globalThis.__quoteImportMocks = {
    organizationId: async () => "org-1",
    codeReferences: async () => new Map(),
    supabaseClient: tableClient({
      brands: [{ id: "brand-2", name: "Bosch", organization_id: "org-1" }],
      catalog_products: [],
      supplier_prices: [{ supplier_id: "supplier-2", brand_id: "brand-2", product_code: "123-4", normalized_code: "1234", normalized_oem: "", buy_price: 10, valid_from: "2026-10-01", is_active: true, organization_id: "org-1", suppliers: { name: "Legacy supplier" } }],
    }, calls),
    callAppRpc: async (_name, args) => args.input_requests.map((_, request_index) => ({
      request_index, has_published_scope: false, options: [{ supplier_id: "supplier-2", supplier_name: "Legacy supplier", product_code: "123-4", buy_price: 10, price_date: "2026-10-01", moq: 5, order_multiple: 4, stock_qty: 0, valid_to: "2026-12-31" }],
    })),
  };
  const { batchResolveQuoteImportRows } = await loadQuoteImport();
  const [line] = await batchResolveQuoteImportRows({
    rows: [{ code: "123-4", brand: "Bosch", qty: 1 }],
    customerType: "B", marginA: 10, marginB: 15,
  });
  assert.equal(line.buy_price, 10);
  assert.equal(line.sell_price, 11.5);
  assert.equal(calls.includes("supplier_prices"), false);
  assert.equal(line.qty, 8);
  assert.equal(line.requested_qty, 1);
  assert.match(line.quantity_adjustment_note, /prepared 8 pcs/);
  assert.equal(line.supplierOptions[0].stock_qty, 0);
});

test("legacy bulk quote import does not borrow 611 catalog, reference, or price for 61/1", async () => {
  globalThis.__quoteImportMocks = {
    organizationId: async () => "org-1",
    codeReferences: async () => new Map([["clevite::611", {
      old_code: "611", new_code: "611", reason: null,
    }]]),
    supabaseClient: tableClient({
      brands: [{ id: "brand-1", name: "Clevite", organization_id: "org-1" }],
      catalog_products: [{ id: "catalog-611", product_code: "611", normalized_code: "611", normalized_oem: "611", brand_id: "brand-1", organization_id: "org-1" }],
      supplier_prices: [{ supplier_id: "supplier-1", brand_id: "brand-1", product_code: "611", normalized_code: "611", normalized_oem: "611", buy_price: 405.72, valid_from: "2026-10-01", is_active: true, organization_id: "org-1", suppliers: { name: "Legacy supplier" } }],
    }, []),
    callAppRpc: async (_name, args) => args.input_requests.map(({ code }, request_index) => ({
      request_index, has_published_scope: false, options: code === "611" ? [{ supplier_id: "supplier-1", supplier_name: "Legacy supplier", product_code: "611", buy_price: 405.72, moq: null, order_multiple: null, stock_qty: null, valid_to: null }] : [],
    })),
  };
  const { batchResolveQuoteImportRows } = await loadQuoteImport();
  const lines = await batchResolveQuoteImportRows({
    rows: [{ code: "61/1", brand: "Clevite", qty: 1 }, { code: "611", brand: "Clevite", qty: 1 }],
    customerType: "A", marginA: 10, marginB: 15,
  });
  assert.equal(lines[0].resolvedCode, "61/1");
  assert.equal(lines[0].found, false);
  assert.equal(lines[0].buy_price, null);
  assert.equal(lines[0].codeChanged, false);
  assert.equal(lines[1].resolvedCode, "611");
  assert.equal(lines[1].buy_price, 405.72);
});

test("an ambiguous published SKU stays unresolved even when a loose catalog or legacy price exists", async () => {
  const calls = [];
  globalThis.__quoteImportMocks = {
    organizationId: async () => "org-1",
    codeReferences: async () => new Map(),
    supabaseClient: tableClient({
      brands: [{ id: "brand-1", name: "Clevite", organization_id: "org-1" }],
      catalog_products: [{ id: "catalog-611", product_code: "611", normalized_code: "611", normalized_oem: "", brand_id: "brand-1", organization_id: "org-1" }],
      supplier_prices: [{ supplier_id: "legacy-supplier", brand_id: "brand-1", product_code: "611", normalized_code: "611", buy_price: 405.72, is_active: true, organization_id: "org-1", suppliers: { name: "Wrong loose match" } }],
    }, calls),
    callAppRpc: async (_name, args) => args.input_requests.map((_, request_index) => ({
      request_index, has_published_scope: true, options: [],
    })),
  };
  const { batchResolveQuoteImportRows } = await loadQuoteImport();
  const [line] = await batchResolveQuoteImportRows({
    rows: [{ code: "61-1", brand: "Clevite", qty: 1 }],
    customerType: "Other", marginA: 22.5, marginB: 15,
  });
  assert.equal(line.found, false);
  assert.equal(line.buy_price, null);
  assert.equal(line.sell_price, null);
  assert.equal(line.resolvedCode, "61-1");
  assert.equal(calls.includes("supplier_prices"), false);
});

test("retired C pricing cannot be used for a new quote import", async () => {
  const { batchResolveQuoteImportRows } = await loadQuoteImport();
  await assert.rejects(
    batchResolveQuoteImportRows({
      rows: [{ code: "611", brand: "Clevite", qty: 1 }],
      customerType: "C", marginA: 10, marginB: 15,
    }),
    /price list is retired/,
  );
});


test("expired legacy source cannot resurrect through direct supplier table reads during bulk import", async () => {
  const calls = [];
  globalThis.__quoteImportMocks = {
    organizationId: async () => "org-1", codeReferences: async () => new Map(),
    supabaseClient: tableClient({
      brands: [{ id: "brand-2", name: "Bosch", organization_id: "org-1" }],
      supplier_prices: [{ supplier_id: "supplier-2", brand_id: "brand-2", product_code: "123-4", normalized_code: "1234", buy_price: 10, valid_to: "2020-01-01", is_active: true, organization_id: "org-1", suppliers: { name: "Expired supplier" } }],
    }, calls),
    callAppRpc: async (_name, args) => args.input_requests.map((_, request_index) => ({ request_index, has_published_scope: false, options: [] })),
  };
  const { batchResolveQuoteImportRows } = await loadQuoteImport();
  const [line] = await batchResolveQuoteImportRows({ rows: [{ code: "123-4", brand: "Bosch", qty: 1 }], customerType: "A", marginA: 10, marginB: 15 });
  assert.equal(line.buy_price, null);
  assert.equal(line.sell_price, null);
  assert.equal(calls.includes("supplier_prices"), false);
});
