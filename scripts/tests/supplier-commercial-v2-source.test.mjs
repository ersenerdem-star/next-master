import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {parseNormalizedSupplierPriceRows,requireNormalizedCommercialFields}
 from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';
import {parseNormalizedSupplierPriceRowsFromXlsx} from '../../apps/engine/supplier-price-shadow/src/streaming-xlsx.mjs';
import {validateCsvWithDuckDB} from '../../apps/engine/supplier-price-shadow/src/duckdb-validation.mjs';
const options={commercialFields:true,sourceDate:'2026-10-14'};
const csv=(stock='',multiple='',end='',start='')=>'Product_Code,Buy_Price_EUR,Price_Date,Stock Quantity,Case Qty,Valid Until\n'+`A,12.50,${start},${stock},${multiple},${end}\n`;
async function rows(source,opts=options){const result=[];for await(const row of parseNormalizedSupplierPriceRows(Readable.from([source]),opts))result.push(row);return result;}

test('CSV canonical values preserve stock0, pack multiple, inclusive date and NULL independently in the row hash',async()=>{
 const [r]=await rows(csv('0','3','14/10/2026'));
 assert.equal(r.stock_qty,0);assert.equal(r.order_multiple,3);assert.equal(r.valid_to,'2026-10-14');assert.equal(r.valid_from,'2026-10-14');
 assert.equal(r.row_status,'accepted');requireNormalizedCommercialFields(r);
 const {row_hash,...payload}=r;assert.equal(row_hash,createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
 const [blank]=await rows(csv());assert.equal(blank.stock_qty,null);assert.equal(blank.order_multiple,null);assert.equal(blank.valid_to,null);
 for(const source of [csv('1','3','14/10/2026'),csv('0','4','14/10/2026'),csv('0','3','15/10/2026')])assert.notEqual((await rows(source))[0].row_hash,row_hash);
 assert.notEqual(blank.row_hash,row_hash);
});

test('v1 parser retains its exact absent-key contract and still refuses commercial nonempty fields',async()=>{
 const [old]=await rows(csv(),{});assert.equal(Object.hasOwn(old,'stock_qty'),false);assert.equal(Object.hasOwn(old,'order_multiple'),false);assert.equal(Object.hasOwn(old,'valid_to'),false);
 await assert.rejects(rows(csv('0'),{}),e=>e.code==='SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD');
 await assert.rejects(rows('Product_Code,Buy_Price_EUR,Stock Qty,Stock Quantity\nA,10,0,1\n'),/DUPLICATE_HEADER/);
});

test('invalid quantities/dates reject without rounding, clamping or exposing source values',async t=>{
 const cases=[['stock_qty','-1','',''],['stock_qty','1.5','',''],['stock_qty','2147483648','',''],['stock_qty','1e3','',''],
 ['order_multiple','','0',''],['order_multiple','','-1',''],['order_multiple','','2.5',''],['order_multiple','','2147483648',''],
 ['valid_to','','','2026-02-30'],['valid_to','','','2026-10-13'],['valid_to','','','not-a-date']];
 for(const [field,...values] of cases)await t.test(field+values.join('/'),async()=>{
  await assert.rejects(rows(csv(...values)),e=>e.code==='SUPPLIER_INVALID_COMMERCIAL_FIELD'&&e.fields[0]===field&&e.sourceRowNumber===1&&!e.message.includes('not-a-date'));
 });
 const [max]=await rows(csv('2147483647','2147483647','2030-12-31'));assert.equal(max.stock_qty,2147483647);assert.equal(max.order_multiple,2147483647);
});

test('nonempty end date requires an actual effective start date before handoff or receipt',async()=>{
 await assert.rejects(rows(csv('0','3','2026-10-15'),{commercialFields:true}),
  e=>e.code==='SUPPLIER_INVALID_COMMERCIAL_FIELD'&&e.fields[0]==='valid_to');
 await assert.rejects(rows(csv('0','3','2026-10-15','2026-02-30')),
  e=>e.code==='SUPPLIER_INVALID_COMMERCIAL_FIELD'&&e.fields[0]==='valid_to');
 const [row]=await rows(csv('0','3','2026-10-15'));
 for(const valid_from of [null,'',undefined,'2026-02-30'])assert.throws(
  ()=>requireNormalizedCommercialFields({...row,valid_from}),/PREPARED_COMMERCIAL_ROW_INVALID/);
});

test('XLSX typed dates and numeric serial dates (1900/1904 workbooks) retain all three fields',async t=>{
 for(const date1904 of [false,true])await t.test(String(date1904),async()=>{
  const book=new ExcelJS.Workbook();book.properties.date1904=date1904;const sheet=book.addWorksheet('Prices');
  sheet.addRows([['Product_Code','Buy_Price_EUR','Price_Date','Stock_Qty','Order_Multiple','Valid_To'],
   ['A',12.5,new Date('2026-10-14T00:00:00Z'),0,6,new Date('2026-10-15T00:00:00Z')],
   ['B',13.5,'',null,null,null]]);
  const parsed=[];for await(const row of parseNormalizedSupplierPriceRowsFromXlsx(Buffer.from(await book.xlsx.writeBuffer()),options))parsed.push(row);
  assert.equal(parsed.length,2);assert.equal(parsed[0].valid_from,'2026-10-14');assert.equal(parsed[0].valid_to,'2026-10-15');
  assert.equal(parsed[0].stock_qty,0);assert.equal(parsed[0].order_multiple,6);assert.equal(parsed[1].stock_qty,null);assert.equal(parsed[1].valid_from,'2026-10-14');
 });
});

test('actual DuckDB normalization validates complete commercial source and fails late invalid source before approval',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supplier-v2-validation-'));
 try{const path=join(dir,'source.csv');await writeFile(path,csv('0','3','2030-10-14'));
  const validation=await validateCsvWithDuckDB({inputPath:path,...options,memoryLimit:'128MB',threads:1});assert.equal(validation.publishable,true);assert.equal(validation.totalRows,1);
  await writeFile(path,csv('0','3','2030-10-14')+'B,13.50,,0,0,2030-10-14\n');
  await assert.rejects(validateCsvWithDuckDB({inputPath:path,...options,memoryLimit:'128MB',threads:1}),e=>e.code==='SUPPLIER_INVALID_COMMERCIAL_FIELD'&&e.sourceRowNumber===2&&e.fields[0]==='order_multiple');
 }finally{await rm(dir,{recursive:true,force:true});}
});
