import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,rm,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateCsvWithDuckDB} from '../../apps/engine/supplier-price-shadow/src/duckdb-validation.mjs';
test('DuckDB validation streams CSV and matches normalized duplicate rules',async()=>{
 const p='/tmp/duckdb-validation-probe.csv'; await writeFile(p,'Product_Code;Brand;Buy_Price_EUR;Currency\nCOR1;Corteco;10;EUR\nCOR 1;Corteco;11;EUR\nCOR-2;Corteco;12;EUR\n');
 try{const r=await validateCsvWithDuckDB({inputPath:p});assert.equal(r.totalRows,3);assert.equal(r.distinctCodes,2);assert.equal(r.duplicateRows,1);assert.equal(r.publishable,false)}finally{await rm(p,{force:true})}
});
test('Corteco semicolon aliases and decimal/date values pass the exact staging parser',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supplier-price-duckdb-test-')),p=join(dir,'corteco.csv');
 try{
  await writeFile(p,'Product_Code;Brand;Product_Name;Buy_Price_EUR;Price_Date\n49127909;Corteco;Shaft Seal;12,28;1.01.2026\n');
  const r=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(r.totalRows,1);assert.equal(r.currencyCount,1);assert.equal(r.missingDateRows,0);
  assert.equal(r.rejectedRows,0);assert.equal(r.publishable,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('punctuation-distinct SKUs remain separate, while true duplicate identity is blocked',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supplier-price-duckdb-test-')),p=join(dir,'sku.tsv');
 try{
  await writeFile(p,'Part_No\tPurchase_Price\tCurrency\tEffective_Date\n61/1\t8.34\tEUR\t2026-10-13\n611\t405.72\tEUR\t2026-10-13\n');
  let r=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(r.distinctCodes,2);assert.equal(r.duplicateRows,0);assert.equal(r.publishable,true);
  await writeFile(p,'Part_No\tPurchase_Price\tCurrency\tEffective_Date\n61/1\t8.34\tEUR\t2026-10-13\n61 / 1\t405.72\tEUR\t2026-10-13\n');
  r=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(r.duplicateRows,1);assert.equal(r.publishable,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing date uses release source_date; malformed date and unsafe price/currency/code fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supplier-price-duckdb-test-')),p=join(dir,'check.csv');
 try{
  await writeFile(p,'Product_Code,Buy_Price_EUR\nCOR-1,12.50\n');
  let r=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir,sourceDate:'2026-10-13'});
  assert.equal(r.missingDateRows,0);assert.equal(r.publishable,true);
  r=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(r.missingDateRows,1);assert.equal(r.publishable,false);
  await writeFile(p,'Product_Code,Buy_Price_EUR,Price_Date\n-,0,32.13.2026\nBAD,-2,2026-10-13\n');
  r=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(r.invalidCodeRows,1);
  assert.equal(r.rejectedRows,2);assert.equal(r.nonPositivePriceRows,2);
  assert.equal(r.invalidDateRows,1);assert.equal(r.publishable,false);
  await writeFile(p,'Product_Code,Buy_Price_USD,Price_Date\nUSD-1,5,2026-10-13\n');
  r=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(r.nonEurCurrencyRows,1);assert.equal(r.publishable,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('ambiguous aliases and missing price/code headers fail before staging',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supplier-price-duckdb-test-')),p=join(dir,'ambiguous.csv');
 try{
  await writeFile(p,'Product_Code;Part_No;Buy_Price_EUR;Price_Date\nA;B;1;2026-10-13\n');
  await assert.rejects(validateCsvWithDuckDB({inputPath:p,tempDirectory:dir}),/CSV_DUPLICATE_HEADER/);
  await writeFile(p,'Product_Code;Currency;Price_Date\nA;EUR;2026-10-13\n');
  await assert.rejects(validateCsvWithDuckDB({inputPath:p,tempDirectory:dir}),/CSV_REQUIRED_HEADER_MISSING/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('ambiguous CSV amounts fail the same DuckDB gate used before staging',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supplier-price-duckdb-test-')),p=join(dir,'ambiguous-prices.csv');
 try{
  await writeFile(p,'Product_Code;Buy_Price_EUR;Price_Date\nDOT;1.234;2026-10-13\nCOMMA;1,234;2026-10-13\n');
  const blocked=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(blocked.rejectedRows,2);
  assert.equal(blocked.missingPriceRows,2);
  assert.equal(blocked.publishable,false);
  await writeFile(p,'Product_Code;Buy_Price_EUR;Price_Date\nDECIMAL;1,2340;2026-10-13\nGROUPED;1.234,56;2026-10-13\n');
  const allowed=await validateCsvWithDuckDB({inputPath:p,tempDirectory:dir});
  assert.equal(allowed.rejectedRows,0);
  assert.equal(allowed.publishable,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
