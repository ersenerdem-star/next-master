import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { computeSupplierUploadChecksum, SUPPLIER_UPLOAD_HASH_CHUNK_BYTES as chunk } from '../../apps/web/src/shared/supplierUploadChecksum.ts';

for (const length of [1,63,64,65,chunk-1,chunk,chunk+1,chunk*3+19]) {
  test(`pure-JS checksum matches Node crypto for binary length ${length}`,async()=>{
    const bytes=Buffer.alloc(length);
    for(let i=0;i<length;i++) bytes[i]=(i*73+255)&255;
    const file=new Blob([bytes]);
    file.arrayBuffer=()=>{throw Error('Whole-file copy prohibited');};
    let maximum=0,slices=0;
    const slice=file.slice.bind(file);
    file.slice=(start,end)=>{maximum=Math.max(maximum,Number(end)-Number(start));slices++;return slice(start,end);};
    const progress:number[]=[];
    const result=await computeSupplierUploadChecksum(file,new AbortController().signal,bytes=>progress.push(bytes));
    assert.equal(result,createHash('sha256').update(bytes).digest('hex'));
    assert.ok(maximum<=chunk);assert.equal(slices,Math.ceil(length/chunk));
    assert.equal(progress.at(-1),length);
    assert.ok(progress.every((value,index)=>value>=(progress[index-1]||0)));
  });
}

test('zero bytes are hashed as bytes and empty uploads are rejected before any read',async()=>{
  const bytes=Buffer.alloc(chunk+3),file=new Blob([bytes]);
  assert.equal(await computeSupplierUploadChecksum(file,new AbortController().signal,()=>{}),createHash('sha256').update(bytes).digest('hex'));
  let reads=0;const empty=new Blob();empty.slice=()=>{reads++;throw Error('Do not read empty upload');};
  await assert.rejects(computeSupplierUploadChecksum(empty,new AbortController().signal,()=>{}),/1 byte and 1 GiB/);
  assert.equal(reads,0);
});

test('an aborted upload never reads or reports a checksum',async()=>{
  const controller=new AbortController();controller.abort();
  const file=new Blob([Buffer.alloc(8)]);let reads=0;
  file.slice=()=>{reads++;throw Error('Aborted read');};
  await assert.rejects(computeSupplierUploadChecksum(file,controller.signal,()=>{}));assert.equal(reads,0);
});

test('each chunk yields so a timer can pause hashing before the next read',async()=>{
  const file=new Blob([Buffer.alloc(chunk*4)]),controller=new AbortController();
  let reads=0;const slice=file.slice.bind(file);file.slice=(start,end)=>{reads++;return slice(start,end);};
  const progress:number[]=[];
  await assert.rejects(computeSupplierUploadChecksum(file,controller.signal,bytes=>{
    progress.push(bytes);if(progress.length===1)setTimeout(()=>controller.abort(),0);
  }));
  assert.equal(reads,1);assert.deepEqual(progress,[chunk]);
});

test('the production transfer uses this bounded helper and pins its pure-JS dependency',()=>{
  const api=readFileSync(new URL('../../apps/web/src/infrastructure/api/supplierVerifiedUploadApi.ts',import.meta.url),'utf8');
  assert.match(api,/await computeSupplierUploadChecksum\(file,signal/);
  assert.doesNotMatch(api,/await file\.arrayBuffer\(|WebAssembly|hash-wasm/);
  const pkg=JSON.parse(readFileSync(new URL('../../apps/web/package.json',import.meta.url),'utf8'));
  assert.equal(pkg.dependencies['@noble/hashes'],'2.4.0');
});
