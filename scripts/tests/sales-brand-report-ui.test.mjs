import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { collectSalesBrandExport, verifySalesBrandExport } from '../../apps/web/src/shared/salesBrandExport.ts';
import { buildWorkbookBytes } from '../../apps/web/src/shared/xlsxCore.ts';

const row = (n) => ({ order_id:`id-${n}`, order_no:`SO-${n}`, order_date:'2026-11-25',customer_id:null,customer_name:'Customer',status:'draft',brand:'Bosch',requested_code:'000123',product_code:'000456',description:'Part',quantity:1,unit_price:2,amount:2,currency:'EUR',line_index:1 });
const summary = (n) => [{ brand:'Bosch',currency:'EUR',order_count:n,line_count:n,detail_count:n,content_hash:"digest",missing_price_count:0,missing_quantity_count:0,quantity:n,amount:n*2 }];

test('fetches all filtered rows across page boundary before returning', async () => {
  const all = Array.from({length:501}, (_, i) => row(i));
  const offsets = [];
  const result = await collectSalesBrandExport(async () => summary(501), async (offset, limit) => { offsets.push(offset); return all.slice(offset, offset + limit); });
  assert.deepEqual(offsets, [0,500]); assert.equal(result.details.length,501);
});
test('rejects incomplete, duplicate or changed data', async () => {
  await assert.rejects(() => collectSalesBrandExport(async () => summary(501), async (offset) => offset ? [] : Array.from({length:500}, (_, i) => row(i))), /Tüm satırlar/);
  assert.throws(() => verifySalesBrandExport(summary(2),summary(2),[row(1),row(1)]), /tekrarlanan/);
  assert.throws(() => verifySalesBrandExport(summary(1),summary(2),[row(1)]), /değişti/);
  assert.throws(() => verifySalesBrandExport(summary(1),[{...summary(1)[0],content_hash:"changed"}],[row(1)]), /değişti/);
});
test('null price and quantity stay missing, never silently become zero', () => {
  const a = { ...row(1), quantity:null, unit_price:null, amount:null };
  const s = [{...summary(1)[0], missing_price_count:1, missing_quantity_count:1,quantity:null,amount:null}];
  assert.doesNotThrow(() => verifySalesBrandExport(s,s,[a]));
});
test('groups currencies separately and supports orders without a product line', () => {
  const eur = row(1);
  const usd = { ...row(2), currency:'USD', unit_price:null, amount:null };
  const blank = { ...row(3), brand:'(Marka belirtilmemiş)', line_index:0, quantity:null, unit_price:null, amount:null };
  const groups = [summary(1)[0], {...summary(1)[0],currency:'USD',missing_price_count:1,amount:null}, {...summary(1)[0],brand:'(Marka belirtilmemiş)',line_count:0,quantity:null,amount:null}];
  assert.doesNotThrow(() => verifySalesBrandExport(groups, groups, [eur,usd,blank]));
});
test('Excel preserves leading zeroes and text beginning with =', () => {
  const bytes = buildWorkbookBytes('Report', [['Summary'], ['Brand'], [], ['Details'], ['Part no','Description'], ['000456','=literal']], [], {headerRow:4});
  const sheet = XLSX.read(bytes,{type:'array'}).Sheets.Report;
  assert.equal(sheet.A6.t,'s'); assert.equal(sheet.A6.v,'000456'); assert.equal(sheet.B6.t,'s'); assert.equal(sheet.B6.v,'=literal'); assert.equal(sheet.B6.f,undefined); assert.equal(sheet['!autofilter'].ref,'A5:B6');
});
