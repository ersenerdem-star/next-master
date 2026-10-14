import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {hashUploadFile,validateUploadAdmission,directStorageEndpoint,safeTusUrl,parseUploadStatus} from '../../apps/web/src/shared/supplierUploadProtocol.ts';
import {transferSupplierUpload} from '../../apps/web/src/shared/supplierTusTransfer.ts';
import {Upload} from 'tus-js-client';
const base='https://kaxsqafdevabkxofwdod.supabase.co',endpoint=directStorageEndpoint(base);
const sessionId='40000000-0000-0000-0000-000000000001',releaseId='50000000-0000-0000-0000-000000000001';
const admission={session_id:sessionId,release_id:releaseId,status:'created',verification_required:true,storage_bucket:'supplier-price-imports',
 storage_object_path:`10000000-0000-0000-0000-000000000001/supplier-price/${sessionId}/prices.csv`,total_bytes:3,
 upload_endpoint:base+'/storage/v1/upload/resumable',expires_at:new Date(Date.now()+3600000).toISOString()};
test('Incremental hashing helper matches known bytes and observes pause between chunks',async()=>{
 const bytes=Buffer.alloc(16*1024*1024+19,37),file=new Blob([bytes]);file.arrayBuffer=()=>{throw Error('Whole-file read forbidden');};
 let maxSlice=0,slices=0;const slice=file.slice.bind(file);file.slice=(a,b)=>{maxSlice=Math.max(maxSlice,b-a);slices++;return slice(a,b);};
 const events=[];const result=await hashUploadFile(file,{ init(){this.hash=createHash('sha256');}, update(b){this.hash.update(b);}, digest(){return this.hash.digest('hex');} },new AbortController().signal,n=>events.push(n));
 assert.equal(result,createHash('sha256').update(bytes).digest('hex'));assert.equal(maxSlice,4*1024*1024);assert.equal(slices,5);
 assert.equal(events.at(-1),bytes.length);
});
test('Hash pause stops before reading another chunk',async()=>{
 const c=new AbortController(),file=new Blob([Buffer.alloc(9)]);let reads=0;
 await assert.rejects(hashUploadFile(file,{init(){},update(){reads++;c.abort();},digest(){throw Error('Must not finish');}},c.signal,()=>{},3));
 assert.equal(reads,1);
});
test('Admission validates exact path/name/size, opt-in and Supabase origin',()=>{
 assert.equal(validateUploadAdmission(admission,{name:'prices.csv',size:3},base).session_id,sessionId);
});
for(const [name,value] of Object.entries({legacy:{verification_required:false},foreignEndpoint:{upload_endpoint:'https://attacker.invalid/upload'},
 wrongSize:{total_bytes:4},wrongBucket:{storage_bucket:'public'},foreignPath:{storage_object_path:'other/file.csv'},expired:{expires_at:'2000-01-01'},
 foreignName:{storage_object_path:admission.storage_object_path.replace('prices.csv','other.csv')},unknownState:{status:'published'}})) {
 test('Reject receipt: '+name,()=>assert.throws(()=>validateUploadAdmission({...admission,...value},{name:'prices.csv',size:3},base)));
}
test('Direct Storage endpoint is project-specific; foreign/custom/insecure endpoints fail closed',()=>{
 assert.equal(endpoint,'https://kaxsqafdevabkxofwdod.storage.supabase.co/storage/v1/upload/resumable');
 for(const url of ['http://local','https://foreign.test','https://user:pass@kaxsqafdevabkxofwdod.supabase.co'])assert.throws(()=>directStorageEndpoint(url));
 assert.ok(safeTusUrl(endpoint+'/abc',endpoint));
 for(const url of [endpoint,endpoint+'/abc?token=bad','https://attacker.invalid/abc',base+'/storage/v1/upload/resumable/abc'])assert.equal(safeTusUrl(url,endpoint),false);
});
const input={endpoint,base,actorId:'actor-1',sessionId,checksum:'a'.repeat(64),bucket:'supplier-price-imports',path:admission.storage_object_path,contentType:'text/csv'};
function fake({previous=[],stall=false}={}){let options,resumed,abortArgs;const handle={findPreviousUploads:async()=>previous,
 resumeFromPreviousUpload:p=>{resumed=p;},start:()=>{if(!stall)options.onSuccess({});},abort:async value=>{abortArgs=value;}};
 return {create:(_f,o)=>{options=o;return handle;},get options(){return options;},get resumed(){return resumed;},get abortArgs(){return abortArgs;}};}
test('Tus uses 6MiB, immutable object, scoped fingerprint and safe prior URL only',async()=>{
 const prior={uploadUrl:endpoint+'/safe'},f=fake({previous:[{uploadUrl:'https://attacker.invalid/stolen'},prior]});
 await transferSupplierUpload(new File(['abc'],'prices.csv'),input,new AbortController().signal,()=>{},f.create,async()=>({actorId:'actor-1',token:'user-token'}));
 assert.equal(f.resumed,prior);assert.equal(f.options.chunkSize,6*1024*1024);assert.equal(f.options.headers,undefined);
 assert.equal(f.options.metadata.objectName,input.path);assert.equal(await f.options.fingerprint(),`${base}:actor-1:${sessionId}:${input.checksum}`);
 assert.ok(!JSON.stringify(f.options).includes('x-upsert'));assert.equal(f.options.removeFingerprintOnSuccess,true);
});
test('Credentials only go to exact approved TUS origin; account switch rejected',async()=>{
 const f=fake();let actorId='actor-1',calls=0;const headers={};
 await transferSupplierUpload(new File(['a'],'prices.csv'),input,new AbortController().signal,()=>{},f.create,async()=>{calls++;return {actorId,token:'user-token'};});
 const req=url=>({getURL:()=>url,setHeader:(k,v)=>{headers[k]=v;}});
 await assert.rejects(f.options.onBeforeRequest(req('https://attacker.invalid/')),/Untrusted/);assert.equal(calls,0);
 await f.options.onBeforeRequest(req(endpoint));assert.equal(headers.authorization,'Bearer user-token');
 actorId='other';await assert.rejects(f.options.onBeforeRequest(req(endpoint+'/safe')),/account changed/);
});
test('Pause does not delete upload; auth/conflict errors do not retry; transient errors bounded',async()=>{
 const c=new AbortController(),f=fake({stall:true});const promise=transferSupplierUpload(new File(['a'],'prices.csv'),input,c.signal,()=>{},f.create,async()=>({actorId:'actor-1',token:'user'}));
 await new Promise(r=>setImmediate(r));
 for(const status of [401,403,409,400])assert.equal(f.options.onShouldRetry({originalResponse:{getStatus:()=>status}}),false);
 for(const status of [0,408,429,500,503])assert.equal(f.options.onShouldRetry({originalResponse:{getStatus:()=>status}}),true);
 c.abort();await assert.rejects(promise,{name:'AbortError'});assert.equal(f.abortArgs,false);
 assert.equal(f.options.onShouldRetry({originalResponse:{getStatus:()=>503}}),false);
 assert.equal(f.options.retryDelays.length,5);
});
test('Status proof does not accept foreign session/counters or fake publication',()=>{
 const s={sessionId,releaseId,uploadStatus:'uploaded',verificationStatus:'verified',transferReady:true,totalBytes:3,totalRows:2,
 processedRows:0,releaseStatus:'uploaded',errorCode:null,releaseUpdatedAt:new Date().toISOString(),expiresAt:admission.expires_at,updatedAt:new Date().toISOString(),published:false};
 assert.equal(parseUploadStatus(s,sessionId,3).totalRows,2);
 for(const bad of [{sessionId:releaseId},{totalBytes:4},{published:true},{totalRows:-1},{verificationStatus:'published'}])assert.throws(()=>parseUploadStatus({...s,...bad},sessionId,3));
});
test('Silent/stalled transfer times out without destroying the resumable upload',async()=>{
 const f=fake({stall:true});
 await assert.rejects(transferSupplierUpload(new File(['a'],'prices.csv'),input,new AbortController().signal,()=>{},f.create,
  async()=>({actorId:'actor-1',token:'user'}),10),/stalled/);
 assert.equal(f.abortArgs,false);
});
test('Real tus-js-client: interrupted PATCH resumes with HEAD at exact server offset, one object',async()=>{
 // Actual SDK, synthetic in-process HTTP/URL storage. Not a Supabase/browser E2E claim.
 const bytes=Buffer.alloc(6*1024*1024+19,41),file=new File([bytes],'prices.csv');
 const receipts=new Map(),requests=[];let offset=0,failPatch=true,creates=0,parts=[];
 const urlStorage={findAllUploads:async()=>[...receipts.values()].map(v=>v.upload),
  findUploadsByFingerprint:async fingerprint=>[...receipts.values()].filter(v=>v.fingerprint===fingerprint).map(v=>v.upload),
  addUpload:async(fingerprint,upload)=>{const key='fixture-'+receipts.size;receipts.set(key,{fingerprint,upload:{...upload,urlStorageKey:key}});return key;},
  removeUpload:async key=>{receipts.delete(key);}};
 const response=(status,headers={})=>({getStatus:()=>status,getHeader:k=>headers[k.toLowerCase()]??null,getBody:()=>'',getUnderlyingObject:()=>null});
 const httpStack={getName:()=>'synthetic-tus',createRequest:(method,url)=>{
  const headers={};return {getMethod:()=>method,getURL:()=>url,setHeader:(k,v)=>{headers[k.toLowerCase()]=v;},getHeader:k=>headers[k.toLowerCase()],
   setProgressHandler(){},getUnderlyingObject:()=>null,abort:async()=>{},send:async body=>{
    assert.equal(headers.authorization,'Bearer fixture-user');assert.equal(headers['x-upsert'],undefined);
    const content=body?Buffer.from(await body.arrayBuffer()):Buffer.alloc(0),length=content.length;
    requests.push({method,url,offset:headers['upload-offset'],length});
    if(method==='POST'){creates++;parts.push(content);offset=length;return response(201,{location:endpoint+'/one-object','upload-offset':String(offset)});}
    if(method==='HEAD')return response(200,{'upload-offset':String(offset),'upload-length':String(file.size)});
    if(method==='PATCH'){
     assert.equal(Number(headers['upload-offset']),offset);
     if(failPatch){failPatch=false;return response(409);}
     parts.push(content);offset+=length;return response(204,{'upload-offset':String(offset)});
    }throw Error('Unexpected method');
   }};
 }};
 const fileReader={openFile:async blob=>({size:blob.size,close(){},slice:async(start,end)=>({value:blob.slice(start,end),done:end>=blob.size})})};
 const create=(f,options)=>new Upload(f,{...options,urlStorage,httpStack,fileReader});
 const auth=async()=>({actorId:'actor-1',token:'fixture-user'}),signal=new AbortController().signal;
 await assert.rejects(transferSupplierUpload(file,input,signal,()=>{},create,auth,1000),/could not complete/);
 assert.equal(creates,1);assert.equal(offset,6*1024*1024);assert.equal(receipts.size,1);
 await transferSupplierUpload(file,input,signal,()=>{},create,auth,1000);
 assert.equal(creates,1);assert.equal(offset,file.size);assert.equal(receipts.size,0);assert.deepEqual(Buffer.concat(parts),bytes);
 assert.deepEqual(requests.map(r=>r.method),['POST','PATCH','HEAD','PATCH']);
 assert.equal(requests.at(-1).length,19);
});
test('UI rollout defaults off, bypasses legacy importer only on explicit opt-in; API has no price RPC',()=>{
 const page=readFileSync(new URL('../../apps/web/src/presentation/pages/SuppliersPage.tsx',import.meta.url),'utf8');
 assert.match(page,/isVerifiedSupplierUploadEnabled\(\)/);
 const start=page.indexOf('if(verifiedUploadEnabled) {'),end=page.indexOf('setLoadingRows(true);',start);
 assert.match(page.slice(start,end),/return;/);assert.match(page.slice(start,end),/uploadVerifiedSupplierFile/);
 const api=readFileSync(new URL('../../apps/web/src/infrastructure/api/supplierVerifiedUploadApi.ts',import.meta.url),'utf8');
 assert.doesNotMatch(api,/bulkImportSupplierPrices|\.rpc\(|service_role|sb_secret_/);
 assert.match(api,/status.transferReady/);assert.match(api,/status.verificationStatus==='not_requested'/);
});
