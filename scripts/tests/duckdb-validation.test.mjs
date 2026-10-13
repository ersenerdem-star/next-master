import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
import {validateCsvWithDuckDB} from '../../apps/engine/supplier-price-shadow/src/duckdb-validation.mjs';
test('DuckDB validation streams CSV and matches normalized duplicate rules',async()=>{
 const p='/tmp/duckdb-validation-probe.csv'; await writeFile(p,'Product_Code;Brand;Buy_Price_EUR;Currency\nCOR1;Corteco;10;EUR\nCOR 1;Corteco;11;EUR\nCOR-2;Corteco;12;EUR\n');
 try{const r=await validateCsvWithDuckDB({inputPath:p});assert.equal(r.totalRows,3);assert.equal(r.distinctCodes,2);assert.equal(r.duplicateRows,1);assert.equal(r.publishable,false)}finally{await rm(p,{force:true})}
});
