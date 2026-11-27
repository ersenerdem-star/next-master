import test, { after } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = await mkdtemp(resolve("node_modules/.supplier-report-test-"));
const output = resolve(tmp, "component.mjs");
await build({
  stdin: { contents: `export {AdditionalSupplierOffers} from './apps/web/src/presentation/components/master/AdditionalSupplierOffers.tsx';`, resolveDir: process.cwd(), loader: "tsx" },
  outfile: output, bundle: true, platform: "node", format: "esm", jsx: "automatic", packages: "external",
  plugins: [{ name: "supplier-offer-fixture", setup(builder) {
    builder.onResolve({ filter: /supplierComparisonOffersApi$/ }, () => ({ path: "api", namespace: "test" }));
    builder.onResolve({ filter: /I18nProvider$/ }, () => ({ path: "i18n", namespace: "test" }));
    builder.onResolve({ filter: /InterfaceText$/ }, () => ({ path: "interface", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => ({ loader: "js", contents:
      path === "api" ? `export const fetchSupplierComparisonOffers=(input)=>globalThis.__supplierReportTest.load(input);` :
      path === "i18n" ? `export const useI18n=()=>({locale:'tr',t:(key)=>key});` :
      `export const useInterfaceText=()=>x=>x;export const InterfaceText=({text})=>text;`
    }));
  } }],
});
const { AdditionalSupplierOffers } = await import(pathToFileURL(output).href);
after(async () => { await rm(tmp, { recursive: true, force: true }); });

const baseRow = { product_code: "001/20", brand: "MANN", supplier_count: 4,
  cheapest_supplier: "First", cheapest_price: 3.89, second_supplier_name: "Second", second_price: 4.05 };
const offer = (supplier_id: string, supplier_name: string, buy_price: number, extra = {}) => ({ supplier_id, supplier_name, buy_price,
  price_date: "2026-11-27", moq: null, order_multiple: null, stock_qty: null, valid_to: null, notes: null, ...extra });
function content(node: ReactTestInstance | string): string { return typeof node === "string" ? node : node.children.map(content).join(""); }
function deferred() { let resolve!: (value: any) => void, reject!: (error: Error) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("opens lazily and shows third and subsequent suppliers without repeating first two", async () => {
  const request = deferred(); const calls: any[] = [];
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).__supplierReportTest = { load: (input: unknown) => { calls.push(input); return request.promise; } };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(AdditionalSupplierOffers, { brandId: "brand-id", row: baseRow })); });
  const toggle = renderer!.root.findByType("button");
  assert.equal(toggle.props["aria-expanded"], false); assert.equal(calls.length, 0);
  await act(async () => toggle.props.onClick());
  assert.equal(toggle.props["aria-expanded"], true); assert.deepEqual(calls, [{ brandId: "brand-id", productCode: "001/20" }]);
  assert.match(content(renderer!.root), /yükleniyor/);
  await act(async () => request.resolve([offer("1", "First", 3.89), offer("2", "Second", 4.05),
    offer("3", "Third", 4.96, { stock_qty: 0, moq: 5 }), offer("4", "Fourth", 6.2)]));
  const text = content(renderer!.root); assert.match(text, /Third/); assert.match(text, /Fourth/); assert.match(text, /4\.96/);
  assert.match(text, /Tedarikçi stoku: 0/); assert.match(text, /MOQ: 5/); assert.doesNotMatch(text, /First|Second/);
  await act(async () => toggle.props.onClick()); assert.equal(toggle.props["aria-expanded"], false); assert.doesNotMatch(content(renderer!.root), /Third/);
  await act(async () => renderer!.unmount());
});

test("failure gives retry and an empty current result is explicit", async () => {
  let count = 0;
  (globalThis as any).__supplierReportTest = { load: async () => { if (++count === 1) throw Error("failed"); return [offer("1", "First", 3.89), offer("2", "Second", 4.05)]; } };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(AdditionalSupplierOffers, { brandId: "brand-id", row: baseRow })); });
  await act(async () => renderer!.root.findByType("button").props.onClick());
  assert.match(content(renderer!.root), /yüklenemedi/);
  const retry = renderer!.root.findAllByType("button").find(button => content(button) === "Tekrar dene"); assert.ok(retry);
  await act(async () => retry.props.onClick()); assert.match(content(renderer!.root), /Başka güncel tedarikçi bulunamadı/);
  await act(async () => renderer!.unmount());
});

test("a changed ranking shows all current offers instead of hiding an unrelated supplier", async () => {
  (globalThis as any).__supplierReportTest = { load: async () => [offer("0", "New cheapest", 3.50), offer("1", "First", 3.89), offer("2", "Second", 4.05), offer("3", "Third", 4.96)] };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(AdditionalSupplierOffers, { brandId: "brand-id", row: baseRow })); });
  await act(async () => renderer!.root.findByType("button").props.onClick());
  const text = content(renderer!.root); assert.match(text, /fiyatlar değişmiş olabilir/); assert.match(text, /New cheapest/); assert.match(text, /First/); assert.match(text, /Second/); assert.match(text, /Third/);
  await act(async () => renderer!.unmount());
});

test("one or two suppliers do not consume space with an extra-offer control", async () => {
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(AdditionalSupplierOffers, { brandId: "brand-id", row: { ...baseRow, supplier_count: 2 } })); });
  assert.equal(renderer!.toJSON(), null);
  await act(async () => renderer!.unmount());
});

test("closing and reopening ignores a late response from the earlier request", async () => {
  const oldRequest = deferred(), currentRequest = deferred(); let count = 0;
  (globalThis as any).__supplierReportTest = { load: () => (++count === 1 ? oldRequest.promise : currentRequest.promise) };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(AdditionalSupplierOffers, { brandId: "brand-id", row: baseRow })); });
  const toggle = renderer!.root.findByType("button");
  await act(async () => toggle.props.onClick());
  await act(async () => toggle.props.onClick());
  await act(async () => toggle.props.onClick());
  await act(async () => currentRequest.resolve([offer("1", "First", 3.89), offer("2", "Second", 4.05), offer("3", "Current", 4.96)]));
  await act(async () => oldRequest.resolve([offer("1", "First", 3.89), offer("2", "Second", 4.05), offer("3", "Stale", 4.96)]));
  assert.match(content(renderer!.root), /Current/); assert.doesNotMatch(content(renderer!.root), /Stale/);
  await act(async () => renderer!.unmount());
});
