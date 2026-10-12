import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {materializePagedExportWithDuckDB} from '../src/export/duckdb-export-source.mjs';

test('DuckDB export materializes authorized pages and preserves deterministic order',async()=>{
 const root=await mkdtemp(join(tmpdir(),'duckdb-export-test-')),out=join(root,'out'),temp=join(root,'temp');
 await mkdir(out);await mkdir(temp);
 const pages=[
  {binding:'binding-1',rows:[{cursorKey:'000000000002',code:'B',description:'b',price:'2.00',currency:'EUR',priceDate:'2026-01-01',discontinued:false,brand:'Clevite'}],done:false,nextCursor:'000000000002'},
  {binding:'binding-1',rows:[{cursorKey:'000000000001',code:'A',description:'a',price:'1.00',currency:'EUR',priceDate:'2026-01-01',discontinued:false,brand:'Clevite'}],done:true,nextCursor:null},
 ];
 let index=0;
 try{
  const result=await materializePagedExportWithDuckDB({binding:'binding-1',expectedRows:2,pageSize:1,outputDir:out,tempDirectory:temp,fetchPage:async()=>pages[index++]});
  assert.equal(result.processedRows,2);assert.equal(result.pageCount,2);
  const lines=(await readFile(result.sortedPath,'utf8')).trim().split('\n');
  assert.equal(lines[1].split(',')[1],'A');assert.equal(lines[2].split(',')[1],'B');
 }finally{await rm(root,{recursive:true,force:true})}
});
