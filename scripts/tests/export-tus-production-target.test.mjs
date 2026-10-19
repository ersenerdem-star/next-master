import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {transferExportFile,exportTusEndpoint,safeExportTusUrl,EXPORT_TUS_CHUNK} from '../../apps/engine/supplier-price-shadow/src/export/resumable-export-transfer.mjs';
const prod='https://zjgueqijumzlfioihnkt.supabase.co',stage='https://kaxsqafdevabkxofwdod.supabase.co';
const key=origin=>'test.'+Buffer.from(JSON.stringify({role:'service_role',ref:new URL(origin).hostname.split('.')[0]})).toString('base64url')+'.test';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(origin=prod){
 const records=new Map(),sha256='a'.repeat(64);
 const receipt={binding:'binding',bucket:'app-exports',path:`org/price-export-v1/binding/${sha256}.xlsx`,
  sha256,bytes:EXPORT_TUS_CHUNK+17,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
 const partsStore={binding:receipt.binding,supabaseUrl:origin,readJson:async name=>records.get(name)||null,
  putJsonOnce:async(name,value)=>{assert.equal(records.has(name),false);records.set(name,value);}};
 return {records,receipt,partsStore};
}
test('large production and staging artifacts use only their own pinned TUS destination with exact bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'export-tus-target-')),file=join(dir,'export.xlsx');
 try{
  await writeFile(file,Buffer.alloc(EXPORT_TUS_CHUNK+17,65));
  for(const origin of [prod,stage]){
   const f=fixture(origin),endpoint=exportTusEndpoint(origin),url=endpoint+'/session-one',calls=[];let offset=0;
   const fetchImpl=async(target,init)=>{
    calls.push({target,method:init.method});assert.ok(target.startsWith(endpoint));
    assert.equal(init.headers['x-upsert'],'false');
    if(init.method==='POST'){
     assert.equal(target,endpoint);assert.equal(Number(init.headers['Upload-Length']),f.receipt.bytes);
     return new Response('',{status:201,headers:{'Tus-Resumable':'1.0.0',Location:url}});
    }
    assert.equal(init.method,'PATCH');assert.equal(target,url);
    assert.equal(Number(init.headers['Upload-Offset']),offset);
    let bytes=0;for await(const chunk of init.body)bytes+=chunk.length;
    offset+=bytes;
    return new Response(null,{status:204,headers:{'Tus-Resumable':'1.0.0','Upload-Offset':String(offset)}});
   };
   assert.deepEqual(await transferExportFile({...f,file,serviceRoleKey:key(origin),fetchImpl}),{bytes:f.receipt.bytes});
   assert.equal(offset,f.receipt.bytes);assert.equal(calls.filter(c=>c.method==='POST').length,1);
   assert.equal(calls.filter(c=>c.method==='PATCH').length,2);
   assert.equal(f.records.size,1);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('foreign/missing origins, foreign keys and saved foreign sessions are rejected before any request',async()=>{
 assert.equal(safeExportTusUrl(exportTusEndpoint(stage)+'/one',prod),false);
 assert.equal(safeExportTusUrl(exportTusEndpoint(prod)+'/one?token=secret',prod),false);
 for(const origin of [undefined,'https://attacker.invalid',prod+'/','https://zjgueqijumzlfioihnkt.supabase.co?x=1']){
  const f=fixture();f.partsStore.supabaseUrl=origin;
  await assert.rejects(transferExportFile({...f,file:'unused',serviceRoleKey:key(prod),fetchImpl:()=>assert.fail('network denied')}),/TARGET_INVALID/);
 }
 const wrongKey=fixture();
 await assert.rejects(transferExportFile({...wrongKey,file:'unused',serviceRoleKey:key(stage),fetchImpl:()=>assert.fail('network denied')}),/KEY_TARGET_INVALID/);
 const f=fixture();
 const payload={schema:'price-export-tus-v1',binding:f.receipt.binding,path:f.receipt.path,bucket:f.receipt.bucket,
  bytes:f.receipt.bytes,sha256:f.receipt.sha256,attempt:1,uploadUrl:exportTusEndpoint(stage)+'/old-session'};
 f.records.set(`tus-${f.receipt.sha256}-0001.json`,{payload,sha256:digest(payload)});
 await assert.rejects(transferExportFile({...f,file:'unused',serviceRoleKey:key(prod),fetchImpl:()=>assert.fail('network denied')}),/SESSION_INVALID/);
});
