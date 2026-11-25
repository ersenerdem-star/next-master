import { test } from "node:test";
import assert from "node:assert/strict";
import { utils, write } from "xlsx";
import { parseOrderImportFile } from "../../apps/web/src/shared/orderImport";
import { priceExcelPreview } from "../../apps/web/src/modules/portal/portalExcelPricePreview";

test("actual Excel with VDO and leading zeros is parsed and priced without order writes", async () => {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["Part_No", "Brand", "Qty"], ["0001234567", "VDO", 2]]), "Parts");
  const bytes = write(workbook, { type: "buffer", bookType: "xlsx" });
  const file = new File([bytes], "vdo.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const rows = await parseOrderImportFile(file);
  assert.deepEqual(rows, [{ code: "0001234567", brand: "VDO", qty: 2 }]);
  const calls: unknown[] = [];
  const result = await priceExcelPreview(rows, async (chunk) => {
    calls.push(chunk);
    return { lines: [{ requestedCode: chunk[0].code, brand: "VDO/Continental", qty: 2, sell_price: 123.45 } as any], pricingProfile: { currency: "EUR" } };
  }, new AbortController().signal, () => {});
  assert.equal(calls.length, 1);
  assert.equal(result.lines[0].requestedCode, "0001234567");
  assert.equal(result.lines[0].brand, "VDO/Continental");
  assert.equal(result.lines[0].sell_price, 123.45);
  assert.equal(result.currency, "EUR");
});

test("prices sequential batches of at most 200 and stops on failure", async () => {
  const rows = Array.from({ length: 401 }, (_, i) => ({ code: `P${i}`, brand: "VDO", qty: 1 }));
  const sizes: number[] = [];
  const progress: number[] = [];
  const result = await priceExcelPreview(rows, async chunk => { sizes.push(chunk.length); return { lines: chunk.map(row => ({ requestedCode: row.code } as any)), pricingProfile: { currency: "EUR" } }; }, new AbortController().signal, count => progress.push(count));
  assert.deepEqual(sizes, [200, 200, 1]);
  assert.deepEqual(progress, [200, 400, 401]);
  assert.equal(result.lines.length, 401);
  let calls = 0;
  await assert.rejects(() => priceExcelPreview(rows, async () => { if (++calls === 2) throw new Error("network"); return { lines: [] }; }, new AbortController().signal, () => {}), /network/);
  assert.equal(calls, 2);
});

test("duplicate aliases, missing brands, currency changes and cancelled requests fail safely", async () => {
  const controller = new AbortController();
  const never = async () => { throw new Error("should not call prepare"); };
  await assert.rejects(() => priceExcelPreview([{ code: "0123", brand: "VDO/Continental", qty: 1 }, { code: "0123", brand: "vdo/continental", qty: 2 }], never, controller.signal, () => {}), /Duplicate/);
  await priceExcelPreview([{ code: "0123", brand: "VDO", qty: 1 }, { code: "0123", brand: "VDO/Continental", qty: 2 }], async () => ({lines: []}), controller.signal, () => {});
  await assert.rejects(() => priceExcelPreview([{ code: "0123", brand: "", qty: 1 }], never, controller.signal, () => {}), /Brand is required/);
  const rows = Array.from({ length: 201 }, (_, i) => ({ code: `P${i}`, brand: "VDO", qty: 1 }));
  let calls = 0;
  await assert.rejects(() => priceExcelPreview(rows, async () => ({ lines: [], pricingProfile: { currency: ++calls === 1 ? "EUR" : "USD" } }), controller.signal, () => {}), /Currency changed/);
  controller.abort();
  await assert.rejects(() => priceExcelPreview(rows, never, controller.signal, () => {}), { name: "AbortError" });
});
