import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSupplierCsv,parseSupplierPriceAmount,supplierCsvIssueCsv} from '../../apps/web/src/shared/supplierCsvPreflight.ts';
import {parseSupplierPriceAmount as workerAmount} from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';
const check=(text:string,signal=new AbortController().signal)=>inspectSupplierCsv(new Blob([text]),signal);
test('reports all missing codes, currency signs and duplicates with record positions',async()=>{
 const r=await check('Product_Code;Buy_Price_Eur\nA; € 14,19 \n;2,80\nA;5\nB;0\nC;1.234\nD;\n');
 assert.equal(r.totalRows,6);assert.equal(r.issueCount,6);
 assert.deepEqual(r.issues.map(x=>[x.row,x.code]),[[2,'currency_symbol'],[3,'missing_code'],[4,'duplicate_code'],[5,'invalid_price'],[6,'ambiguous_price'],[7,'missing_price']]);
 assert.match(supplierCsvIssueCsv(r),/Product_Code/);
});
test('supports quoted delimiters, BOM, header aliases and valid locale numbers',async()=>{
 const r=await check('\uFEFFpart_number,price,notes\r\nA,"1.234,56","x,y"\r\nB,12.28,"two\nlines"\r\n');
 assert.equal(r.totalRows,2);assert.equal(r.issueCount,0);
});
test('amount rules agree with worker for edge cases',()=>{
 for(const x of ['','€ 14,19','1.234','1,234','1.2340','1.234,56','1,234.56','1 234,56','1e3','0','-4','12,28','EUR 12'])assert.deepEqual(parseSupplierPriceAmount(x),workerAmount(x),x);
});
test('missing headers and empty files fail with actionable issues',async()=>{
 assert.equal((await check('name,value\nx,3')).issueCount,2);
 assert.equal((await check('')).issues[0].code,'empty_file');
});
test('cancellation stops preflight',async()=>{
 const c=new AbortController();c.abort();await assert.rejects(check('Product_Code;price\nA;2',c.signal));
});

test('optional weights accept decimal comma precision and invalid weights identify the exact product and cell',async()=>{
 const report=await inspectSupplierCsv(new Blob(['Product_Code;Buy_Price_Eur;Weight_kg\nA;1,50;0,355\nB;2,50;2,228\nC;3,50;abc\n']),new AbortController().signal);
 assert.equal(report.issueCount,1);assert.equal(report.issues[0].row,4);assert.equal(report.issues[0].column,'Weight_kg');assert.equal(report.issues[0].productCode,'C');assert.equal(report.issues[0].value,'abc');
});
