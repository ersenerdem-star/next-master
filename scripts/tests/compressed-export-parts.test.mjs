import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompressedLocalParts} from '../../apps/engine/supplier-price-shadow/src/export/compressed-local-parts.mjs';
import {exportBinding,preparePriceExport,assemblePriceExport} from '../../apps/engine/supplier-price-shadow/src/export/partitioned-price-export.mjs';

test('compressed parts preserve immutable validated workbook and substantially reduce scratch use',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'compressed-price-test-'));
 const input={tenantId:'tenant',requesterId:'requester',audience:'customer',customerId:'customer',snapshotId:'snap',pricingVersion:'v',brand:'Brand',currency:'EUR',expectedRows:10000,pageSize:5000};
 const binding=exportBinding(input),store=createCompressedLocalParts(dir,binding);
 try {
  await preparePriceExport({input,directory:dir,partsStore:store,fetchPage:async({after,limit})=>{
   const start=after?Number(after):0;const rows=Array.from({length:limit},(_,i)=>{const n=start+i+1;return {code:`P${String(n).padStart(6,'0')}`,cursorKey:String(n).padStart(12,'0'),brand:'Brand',description:'Repeated automotive part description',price:'10.00',currency:'EUR',priceDate:'2026-11-15',discontinued:false,replacementCode:''};});
   const done=start+limit===input.expectedRows;return {binding,expectedRows:input.expectedRows,rows,done,nextCursor:done?null:rows.at(-1).cursorKey};
  }});
  const record=await store.readJson('part-0000001.json');
  const compressed=(await stat(join(dir,'part-0000001.json.gz'))).size;
  assert.ok(compressed<Buffer.byteLength(JSON.stringify(record))/2,'scratch parts are less than half their original size');
  const result=await assemblePriceExport({input,directory:dir,partsStore:store});
  assert.equal(result.rows,10000);assert.equal((await readFile(join(dir,result.file))).subarray(0,4).toString('hex'),'504b0304');
  await assert.rejects(store.putJsonOnce('part-0000001.json',{changed:true}),/IMMUTABLE_WRITE_CONFLICT/);
  await writeFile(join(dir,'part-0000002.json.gz'),Buffer.from('corrupt'));
  await assert.rejects(store.readJson('part-0000002.json'));
  await assert.rejects(store.readJson('../other.json'),/PART_NAME_INVALID/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
