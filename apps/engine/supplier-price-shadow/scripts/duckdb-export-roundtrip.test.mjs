import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {materializePagedExportWithDuckDB,createDuckDbPagedExportSource} from '../src/export/duckdb-export-source.mjs';
import {exportBinding,preparePriceExport,assemblePriceExport} from '../src/export/partitioned-price-export.mjs';
import {fixtureSpec,fixtureSource} from '../src/export/local-export-fixture.mjs';
test('authorized pages roundtrip through DuckDB and produce XLSX',async()=>{
 const d=await mkdtemp(join(tmpdir(),'nm-duck-roundtrip-'));
 try {
 const spec=fixtureSpec(),binding=exportBinding(spec);
 const receipt=await materializePagedExportWithDuckDB({fetchPage:args=>fixtureSource(spec)({...args,spec}),binding,expectedRows:spec.expectedRows,outputDir:d});
 const fetchPage=createDuckDbPagedExportSource({...receipt,pageSize:spec.pageSize});
 await preparePriceExport({input:spec,directory:d,fetchPage});
 const ready=await assemblePriceExport({input:spec,directory:d});
 assert.equal(ready.rows,spec.expectedRows);assert.ok(ready.bytes>0);
 }finally{await rm(d,{recursive:true,force:true})}
});
