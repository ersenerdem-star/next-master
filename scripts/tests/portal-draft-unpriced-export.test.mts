import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentWorksheet } from '../../apps/web/src/shared/documentExport.ts';
import { buildBusinessDocumentHtml } from '../../apps/web/src/shared/documentPrint.ts';
import { mapSalesOrderLines } from '../../netlify/functions/_shared/portal-access.mts';
import { applyDocumentQuantityEdits } from '../../apps/web/src/modules/portal/portalDocumentQuantities.ts';
import { buildWorkbookBytes } from '../../apps/web/src/shared/xlsxCore.ts';
import * as XLSX from 'xlsx';

test('draft Excel exports visible 14 instead of saved 60 and recalculates without saving', () => {
  const saved = [{code:'P550428',qty:60,unitPrice:2,amount:120}];
  const preview = applyDocumentQuantityEdits(saved, {'order:0':14}, 'order');
  assert.equal(saved[0].qty,60);
  const model = buildDocumentWorksheet({kind:'sales-order',audience:'customer',number:'draft',party:'Customer',currency:'EUR',lines:preview.lines,allowMissingPrices:true,unsavedQuantityEdits:preview.changed});
  assert.equal(model.totals.total,28);
  const workbook = XLSX.read(buildWorkbookBytes('draft',model.rows,model.numericColumns,model.options),{type:'array'});
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]],{header:1});
  assert.equal(rows[7][rows[6].indexOf('Qty')],14);
  assert.ok(rows.some(row=>String(row[0]).includes('have not been saved')));
  const html = buildBusinessDocumentHtml({docType:'Sales Order',docNo:'draft',company:{companyName:'X',address:'',bankDetails:'',taxNumber:'',logoDataUrl:''},party:{title:'Customer',details:''},meta:[],lines:preview.lines.map(line=>({...line,description:''})),totals:{currency:'EUR',total:28},allowMissingPrices:true,unsavedQuantityEdits:preview.changed});
  assert.match(html,/>14</);
  assert.match(html,/quantity changes have not been saved/);
});

test('live portal snapshot supplies rounded amounts for Excel and keeps missing prices absent', () => {
  const rows = mapSalesOrderLines([{resolvedCode:'A', qty:3, buy_price:0.1, sell_price:0.1}, {resolvedCode:'B', qty:2, buy_price:null, sell_price:null}]);
  assert.equal(rows[0].line_total, 0.3);
  assert.equal(rows[1].line_total, null);
  const workbook = buildDocumentWorksheet({kind:'sales-order',audience:'customer',number:'draft',party:'Customer',currency:'EUR',total:0.3,allowMissingPrices:true,lines:rows.map(r=>({code:r.code,qty:r.qty,unitPrice:r.sell_price,amount:r.line_total}))});
  assert.equal(workbook.totals.total,0.3);
});

test('draft documents show missing prices without inventing a zero price', () => {
  const lines = [{code:'A',qty:200,unitPrice:0.29,amount:58}, {code:'B',qty:4,unitPrice:null,amount:undefined}];
  const worksheet = buildDocumentWorksheet({kind:'sales-order',audience:'customer',number:'draft',party:'Customer',currency:'EUR',lines,total:58,allowMissingPrices:true});
  assert.equal(worksheet.totals.total,58);
  assert.equal(worksheet.totals.amounts[1],null);
  assert.ok(worksheet.rows.some(row => String(row[0]).includes('Prices missing')));
  assert.throws(() => buildDocumentWorksheet({kind:'invoice',audience:'customer',number:'x',party:'Customer',currency:'EUR',lines,total:58}));
  const html = buildBusinessDocumentHtml({docType:'Sales Order',docNo:'draft',company:{companyName:'X',address:'',bankDetails:'',taxNumber:'',logoDataUrl:''},party:{title:'Customer',details:''},meta:[],lines:lines.map(line=>({...line,description:'',amount:line.amount ?? null})),totals:{currency:'EUR',total:58},allowMissingPrices:true});
  assert.match(html,/Total for priced items only/);
  assert.match(html,/>—</);
});
