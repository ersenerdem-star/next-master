import test from 'node:test';
import assert from 'node:assert/strict';
import { startPortalPriceListExport, waitForPortalExportJob, downloadPortalExportJob } from '../../apps/web/src/infrastructure/api/portalOrderApi.ts';

const credentials = { email:'test@example.test', password:'test' };
const download = { signedUrl:'https://storage.example.test/storage/v1/object/sign/a/file?token=test',fileName:'prices.xlsx',byteSize:123,rowCount:2,expiresIn:300 };
const makeJob = (status:string) => ({ id:'job',status,exportType:'portal_price_list',rowCount:2,byteSize:123,cached:status==='finalized' });

test('ready artifact retains its signed download and needs no second request',async()=>{
 const originalFetch=globalThis.fetch; const originalWindow=globalThis.window;
 globalThis.window=globalThis as unknown as Window & typeof globalThis;
 let requests=0;
 globalThis.fetch=async()=>{ requests++; return Response.json({job:makeJob('finalized'),download}); };
 try {
  const job=await startPortalPriceListExport(credentials,'Bosch');
  const ready=await waitForPortalExportJob(credentials,job);
  assert.deepEqual(ready.download,download);assert.equal(requests,1);
 } finally {globalThis.fetch=originalFetch;globalThis.window=originalWindow;}
});

test('queued exports ignore premature download links and retain the original download endpoint',async()=>{
 const originalFetch=globalThis.fetch; const originalWindow=globalThis.window;
 globalThis.window=globalThis as unknown as Window & typeof globalThis;
 const calls:string[]=[];
 globalThis.fetch=async(input)=>{calls.push(String(input));return Response.json(calls.length===1?{job:makeJob('queued'),download}:{...download,parts:[{signedUrl:'a',byteSize:50},{signedUrl:'b',byteSize:73}]});};
 try {
  const job=await startPortalPriceListExport(credentials,'Bosch');
  assert.equal(job.download,undefined);
  const fallback=await downloadPortalExportJob(credentials,job.id);
  assert.equal(fallback.parts?.length,2);assert.equal(calls[1],'/api/portal-export-download');
 } finally {globalThis.fetch=originalFetch;globalThis.window=originalWindow;}
});
