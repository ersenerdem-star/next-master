import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { requireVerifiedSupplierReplaceMode } from '../../apps/web/src/shared/supplierUploadProtocol.ts';

test('verified snapshot mode accepts exactly replace, without converting merge or unknown modes',()=>{
  assert.doesNotThrow(()=>requireVerifiedSupplierReplaceMode('replace'));
  for(const mode of ['merge','MERGE','append','',undefined,null])
    assert.throws(()=>requireVerifiedSupplierReplaceMode(mode),/complete replacement price list/);
});

test('actual client rejects merge before hashing, Auth lookup, progress or admission',async()=>{
  const api=new URL('../../apps/web/src/infrastructure/api/supplierVerifiedUploadApi.ts',import.meta.url);
  const output=await build({entryPoints:[api.pathname],bundle:true,write:false,platform:'node',format:'esm',target:'es2022',
    define:{'import.meta.env':JSON.stringify({VITE_SUPPLIER_PRICE_VERIFIED_UPLOAD_ENABLED:'true',
      VITE_SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED:'1',VITE_NM_PRODUCTION_TARGET:'zjgueqijumzlfioihnkt',
      VITE_SUPABASE_URL:'https://zjgueqijumzlfioihnkt.supabase.co'})},
    plugins:[{name:'auth-fixture',setup(b){
      b.onResolve({filter:/^\.\/supabaseClient$/},()=>({path:'auth-fixture',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const supabaseClient={auth:{getSession(){throw Error("Auth lookup must not occur");}}};',loader:'js'}));
    }}]});
  const client=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
  const file=new File(['abc'],'prices.csv');let reads=0,progress=0,requests=0;
  file.slice=()=>{reads++;throw Error('Hash read must not occur');};
  file.arrayBuffer=async()=>{reads++;throw Error('Whole-file read must not occur');};
  const priorFetch=globalThis.fetch;
  globalThis.fetch=async()=>{requests++;throw Error('Network must not occur');};
  try {
    await assert.rejects(client.uploadVerifiedSupplierFile(file,{supplierId:'20000000-0000-0000-0000-000000000001',
      brandId:'30000000-0000-0000-0000-000000000001',mode:'merge',sourceDate:'2026-10-14'},
      new AbortController().signal,()=>progress++),/complete replacement price list/);
    assert.equal(reads,0);assert.equal(progress,0);assert.equal(requests,0);
  } finally {globalThis.fetch=priorFetch;}
});

test('verified UI hides merge while the legacy branch retains its merge selection',()=>{
  const page=readFileSync(new URL('../../apps/web/src/presentation/pages/SuppliersPage.tsx',import.meta.url),'utf8');
  assert.match(page,/verifiedSupplierUploadRequested \? \[\] : \[\{ value: "merge"/);
  const start=page.indexOf('if(verifiedUploadEnabled) {'),end=page.indexOf('setLoadingRows(true);',start);
  const verified=page.slice(start,end);
  assert.match(verified,/importMode !== 'replace'/);assert.match(verified,/mode:importMode,/);
  assert.doesNotMatch(verified,/mode:importMode==='merge'\?'merge':'replace'/);
  assert.match(page.slice(end),/mode: importMode === "merge" \? "merge" : "replace"/);
  assert.match(page,/await startSupplierPriceListExport\(\{/);
  assert.match(page,/await downloadExportJob\(readyJob.id/);
});
