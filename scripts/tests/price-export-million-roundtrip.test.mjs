import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {materializeSealedSnapshotWithDuckDB,createDuckDbPagedExportSource} from '../../apps/engine/supplier-price-shadow/src/export/duckdb-export-source.mjs';
import {exportBinding,preparePriceExport,assemblePriceExport} from '../../apps/engine/supplier-price-shadow/src/export/partitioned-price-export.mjs';
import {fixtureSpec} from '../../apps/engine/supplier-price-shadow/src/export/local-export-fixture.mjs';

test('real million-row DuckDB/XLSX round trip crosses the Excel sheet limit without truncation',
 {skip:process.env.RUN_PRICE_EXPORT_MILLION!=='1',timeout:600000},async()=>{
 const count=1048577,dir=await mkdtemp(join(tmpdir(),'nm-million-export-'));
 const input=fixtureSpec(count,{pageSize:5000}),binding=exportBinding(input),timings={};
 const row=i=>({cursorKey:String(i).padStart(12,'0'),code:i===30001?'FOLIA3,5':`P${String(i).padStart(8,'0')}`,
  description:i===30002?'Quoted "label", € price\nsecond line':'Synthetic part',price:'12.34',currency:'EUR',priceDate:'2026-10-23',
  discontinued:i===count,replacementCode:i===count?'NEW-1':'',brand:input.brand});
 const pool={async connect(){return{async query(_sql,[_id,after,limit]){return{rows:Array.from({length:Math.min(limit,count-after)},(_,j)=>({ordinal:after+j+1,payload:row(after+j+1)}))};},release(){}};}};
 try{
  let start=performance.now();
  const source=await materializeSealedSnapshotWithDuckDB({pool,snapshotId:input.snapshotId,binding,expectedRows:count,outputDir:dir});
  timings.materializeMs=Math.round(performance.now()-start);start=performance.now();
  await preparePriceExport({input,directory:dir,fetchPage:createDuckDbPagedExportSource({sortedPath:source.sortedPath,binding,expectedRows:count,pageSize:5000})});
  timings.prepareMs=Math.round(performance.now()-start);start=performance.now();
  const receipt=await assemblePriceExport({input,directory:dir});
  timings.assembleMs=Math.round(performance.now()-start);start=performance.now();
  assert.equal(receipt.rows,count);
  let seen=0;const sheetCounts=[];
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(join(dir,receipt.file),{worksheets:'emit',sharedStrings:'cache',styles:'ignore',hyperlinks:'ignore'});
  for await(const sheet of reader){let rows=0;
   for await(const actual of sheet){rows++;if(rows===1){assert.equal(actual.getCell(1).value,'Part_No');continue;}
    seen++;const expected=row(seen);
    assert.equal(actual.getCell(1).value,expected.code);assert.equal(actual.getCell(2).value,expected.description);
    assert.equal(actual.getCell(3).value,12.34);assert.equal(actual.getCell(4).value,'2026-10-23');
    assert.equal(actual.getCell(5).value,expected.discontinued?'Discontinued; replacement: NEW-1':'Active');
   }sheetCounts.push(rows);
  }
  timings.verifyMs=Math.round(performance.now()-start);
  assert.equal(seen,count);assert.deepEqual(sheetCounts,[1048576,3]);
  console.log(JSON.stringify({evidence:'local synthetic full-file roundtrip',rows:seen,sheetCounts,bytes:receipt.bytes,sha256:receipt.sha256,timings}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
