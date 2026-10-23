import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { exactProductCode } from "../../apps/web/src/shared/currentSupplierPriceSync.mts";
import { canonicalizePriceProductCode } from "../../apps/web/src/domain/shared/normalize.ts";

function loadSalesResync(dependencies, exportedName = "resyncSalesOrderLinesFromCatalog") {
  dependencies = { canonicalizePriceProductCode, ...dependencies };
  const path = new URL("../../apps/web/src/shared/salesOrderCatalogSync.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.ES2022, true);
  const names = ["requireRepricingCurrency", "salesOrderResyncPriceSummary", "refreshSalesOrderPriceLines", "refreshLinePricesFromCatalog", "resyncSalesOrderLinesFromCatalog"];
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
    `const exports = {};\n${compiled}\nreturn ${exportedName};`)(...Object.values(dependencies));
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

function makeResync(resolveQuoteLine, references = new Map()) {
  return loadSalesResync({
    exactProductCode,
    normalizePartCode: (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    normalizeBrandKey: (value) => String(value || "").trim().toLowerCase(),
    canonicalizeBrandName: (value) => String(value || "").trim(),
    fetchCodeReferenceMatchesForRows: async () => references,
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

test('keeping saved prices fills an unpriced replacement from current options without changing other lines',async()=>{
  const priced=savedLine(),blank={...savedLine('350038'),brand:'Sachs',supplier_name:'',buy_price:null,sell_price:null,supplierOptions:[],selectedSupplierKey:''};
  const before=structuredClone([priced,blank]);const calls=[];
  const resync=makeResync(async({code})=>{calls.push(code);return {resolved:{found:true,product_code:code,brand:'Sachs'},
    supplierOptions:[{supplier_id:'current',supplier_name:'GroupAuto',buy_price:67.76,sell_price:74.54,price_date:'2026-10-19'}]};});
  const result=await resync([priced,blank],{...repriceOptions,keepPrices:true,hydrateMissingPricesIfKeepingPrices:true});
  assert.deepEqual(calls,['350038']);assert.deepEqual(result[0],priced);
  assert.equal(result[1].buy_price,67.76);assert.equal(result[1].supplier_name,'GroupAuto');assert.equal(result[1].price_sync_issue,null);
  assert.deepEqual([priced,blank],before);
});

test('unavailable prices and lookup failures remain explicit per-line outcomes while good missing lines are filled',async()=>{
  const blank=code=>({...savedLine(code),supplier_name:'',buy_price:null,sell_price:null,supplierOptions:[],selectedSupplierKey:''});
  const resync=makeResync(async({code})=>{
    if(code==='NETWORK')throw Error('RPC unavailable');
    return {resolved:{found:code!=='MISSING',product_code:code},supplierOptions:code==='MISSING'?[]:[{supplier_id:'s',supplier_name:'Sood',buy_price:1,sell_price:1.1}]};
  });
  const result=await resync(['GOOD','MISSING','NETWORK'].map(blank),{...repriceOptions,keepPrices:true,hydrateMissingPricesIfKeepingPrices:true});
  assert.equal(result[0].buy_price,1);assert.equal(result[1].price_sync_issue,'PRICE_NOT_AVAILABLE');assert.equal(result[2].price_sync_issue,'PRICE_LOOKUP_FAILED');
  assert.equal(result[1].buy_price,null);assert.equal(result[2].buy_price,null);
  await assert.rejects(resync([blank('GOOD')],{...repriceOptions,currency:'USD',keepPrices:true,hydrateMissingPricesIfKeepingPrices:true}),/currency to EUR/);
});

test('changing SKU discards old product fields and prices before exact successor resolution',async()=>{
  const old={...savedLine('318189'),brand:'Sachs',weight_kg:999,oem_no:'OLD-OEM',origin:'XX',hs_code:'OLD'};
  const before=structuredClone(old);
  const refs=new Map([['sachs::318189',{old_code:'318189',new_code:'350038',reason:'Official replacement'}]]);
  const resync=makeResync(async({code})=>({resolved:{found:true,product_code:code,brand:'Sachs',description:'Correct successor',weight_kg:4.18,oem_no:'NEW-OEM'},
    supplierOptions:[{supplier_id:'s',supplier_name:'Sood',buy_price:67.76,sell_price:74.54}]}),refs);
  const [result]=await resync([old],{...repriceOptions,keepPrices:true,hydrateMissingPricesIfKeepingPrices:true});
  assert.equal(result.requestedCode,'318189');assert.equal(result.resolvedCode,'350038');assert.equal(result.buy_price,67.76);
  assert.equal(result.description,'Correct successor');assert.equal(result.weight_kg,4.18);assert.equal(result.oem_no,'NEW-OEM');assert.equal(result.origin,'');
  assert.deepEqual(old,before);
});

test('explicit repricing may select a supplier only for a previously unpriced line with no saved supplier',async()=>{
  const resync=makeResync(async({code})=>({resolved:{found:true,product_code:code},supplierOptions:[{supplier_id:'s',supplier_name:'Sood',buy_price:10,sell_price:11}]}));
  const [result]=await resync([{...savedLine(),supplier_name:'',buy_price:null,sell_price:null,supplierOptions:[],selectedSupplierKey:''}],repriceOptions);
  assert.equal(result.buy_price,10);assert.equal(result.supplier_name,'Sood');
  await assert.rejects(resync([{...savedLine(),supplier_name:'',supplierOptions:[],selectedSupplierKey:''}],repriceOptions),/No exact current price/);
});

test("237-line sync bounds reads and shares duplicate SKU lookups without changing priced lines or quantities", async () => {
  const priced = Array.from({ length: 155 }, (_, index) => savedLine(`PRICED-${index}`));
  const blank = Array.from({ length: 82 }, (_, index) => ({
    ...savedLine(`BLANK-${index % 41}`), qty: index + 1,
    supplier_name: "", buy_price: null, sell_price: null, supplierOptions: [], selectedSupplierKey: "",
  }));
  const original = [...priced, ...blank];
  const before = structuredClone(original);
  let active = 0, peak = 0, calls = 0;
  const resync = makeResync(async ({ code }) => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    active -= 1;
    return { resolved: { found: true, product_code: code }, supplierOptions: [
      { supplier_id: "s", supplier_name: "GroupAuto", buy_price: 14.89, sell_price: 16.38 },
    ] };
  });
  const result = await resync(original, { ...repriceOptions, keepPrices: true, hydrateMissingPricesIfKeepingPrices: true });
  assert.equal(calls, 41);
  assert.ok(peak > 1 && peak <= 4);
  assert.deepEqual(result.slice(0, 155), priced);
  assert.deepEqual(result.map((line) => line.qty), original.map((line) => line.qty));
  assert.ok(result.slice(155).every((line) => line.buy_price === 14.89 && line.sell_price === 16.38));
  assert.deepEqual(original, before);
});

test("sync summary separates newly filled prices, unavailable prices and failed reads", () => {
  const summarize = loadSalesResync({}, "salesOrderResyncPriceSummary");
  const blank = { ...savedLine(), buy_price: null, sell_price: null };
  const before = [savedLine(), blank, blank, blank, blank];
  const after = [savedLine(), { ...blank, buy_price: 14.89, sell_price: 16.38 },
    { ...blank, price_sync_issue: "PRICE_NOT_AVAILABLE" },
    { ...blank, price_sync_issue: "PRICE_LOOKUP_FAILED" },
    { ...blank, buy_price: 10, sell_price: null }];
  assert.deepEqual(summarize(before, after), { filled: 1, unavailable: 2, failed: 1, unpriced: 3 });
});

test("saved SACHS rows canonicalize before metadata and price lookup while retaining the uploaded codes", async () => {
  const codes = ["311.409", "311.409", "314.880", "315.872", "315.872", "317.333", "802.561", "803.209"];
  const source = codes.map((code) => ({ ...savedLine(code), brand: "Sachs", supplier_name: "",
    buy_price: null, sell_price: null, supplierOptions: [], selectedSupplierKey: "", codeChanged: false }));
  const before = structuredClone(source);
  const resync = makeResync(async ({ code }) => {
    assert.match(code, /^\d{6}$/);
    return { resolved: { found: true, product_code: code, brand: "Sachs" }, supplierOptions: [
      { supplier_id: "s", supplier_name: "GroupAuto", buy_price: 38.8, sell_price: 42.68 },
    ] };
  });
  const result = await resync(source, { ...repriceOptions, keepPrices: true, hydrateMissingPricesIfKeepingPrices: true });
  assert.deepEqual(result.map((line) => line.requestedCode), codes);
  assert.deepEqual(result.map((line) => line.resolvedCode), codes.map((code) => code.replace(".", "")));
  assert.ok(result.every((line) => line.buy_price === 38.8 && line.codeChanged === false));
  assert.deepEqual(source, before);
});
