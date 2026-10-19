// C2a: private create-only shared parts; explicit full-V3 fence.
// This is a worker adapter, never a browser client or application permission gate.
import {exportSpec,exportBinding} from './partitioned-price-export.mjs';
import {supabaseApiHeaders} from '../supabase-headers.mjs';

export const EXPORT_PARTS_V3_URL='https://kaxsqafdevabkxofwdod.supabase.co';
export const EXPORT_PARTS_BUCKET='app-export-parts';
const MAX_JSON_BYTES=8*1024*1024;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=code=>{throw Error(`EXPORT_STORAGE_${code}`);};
function json(text) {try{return JSON.parse(text);}catch{fail('INVALID_JSON');}}
function objectMissing(reply) {
  if(reply.status!==400&&reply.status!==404)return false;
  const body=json(reply.text);
  return String(body.statusCode)==='404'&&['not_found','Not Found'].includes(body.error);
}
function duplicate(reply) {
  if(reply.status!==400&&reply.status!==409)return false;
  const body=json(reply.text);
  return String(body.statusCode)==='409'&&['Duplicate','Conflict'].includes(body.error);
}
async function boundedText(response,limit) {
  const size=response.headers.get('content-length');
  if(size!=null&&(!/^\d+$/.test(size)||Number(size)>limit)) {
    await response.body?.cancel();fail('RESPONSE_TOO_LARGE');
  }
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try {
    for(;;) {
      const {value,done}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>limit){await reader.cancel();fail('RESPONSE_TOO_LARGE');}
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,bytes).toString('utf8');
  } finally {reader.releaseLock();}
}
export function createExportPartsStore({
  supabaseUrl,serviceRoleKey,input,fetchImpl=fetch,timeoutMs=45000,
  expectedSupabaseUrl=EXPORT_PARTS_V3_URL,
  expectedProjectRef='kaxsqafdevabkxofwdod',
  bucket=EXPORT_PARTS_BUCKET,
  targetError='EXACT_TARGET_REQUIRED',
}) {
  if(supabaseUrl!==expectedSupabaseUrl)fail(targetError);
  if(typeof serviceRoleKey!=='string'||!serviceRoleKey||/\s/.test(serviceRoleKey))fail('SERVER_KEY_REQUIRED');
  if(!serviceRoleKey.startsWith('sb_secret_')) {
    let claims;
    try{claims=JSON.parse(Buffer.from(serviceRoleKey.split('.')[1],'base64url').toString('utf8'));}
    catch{fail('SERVER_KEY_REQUIRED');}
    if(claims.role!=='service_role'||claims.ref!==expectedProjectRef)fail('SERVICE_ROLE_TARGET_REQUIRED');
  }
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||typeof fetchImpl!=='function')fail('CONFIG_INVALID');
  const spec=exportSpec(input),binding=exportBinding(input);
  if(!uuid.test(spec.tenantId)||!uuid.test(spec.requesterId)
    ||spec.customerId!=null&&!uuid.test(spec.customerId))fail('SCOPE_UUID_REQUIRED');
  const prefix=`${spec.tenantId}/price-export-v1/${binding}/`;
  let initialized=false,initializing;
  async function request(path,init={},limit=MAX_JSON_BYTES) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(`${supabaseUrl}${path}`,{
        ...init,headers:{...supabaseApiHeaders(serviceRoleKey),...init.headers},
        redirect:'error',cache:'no-store',signal:controller.signal,
      });
      return {status:response.status,text:await boundedText(response,limit)};
    } catch(error) {
      // Never log body, signed links, credentials or arbitrary upstream messages.
      if(error?.message?.startsWith('EXPORT_STORAGE_'))throw error;
      fail(controller.signal.aborted?'REQUEST_TIMEOUT':'REQUEST_FAILED');
    } finally {clearTimeout(timer);}
  }
  async function initialize() {
    if(initialized)return;
    if(initializing)return initializing;
    initializing=(async()=>{
      const reply=await request(`/storage/v1/bucket/${bucket}`,{},128*1024);
      if(reply.status!==200)fail(`BUCKET_HTTP_${reply.status}`);
      const bucketMeta=json(reply.text);
      if(bucketMeta.id!==bucket||bucketMeta.public!==false)fail('PRIVATE_BUCKET_REQUIRED');
      initialized=true;
    })();
    try{await initializing;}finally{initializing=undefined;}
  }
  function objectPath(name) {
    if(!/^(identity\.json|manifest\.json|artifact-(ready|uploaded)\.json|part-\d{7}\.json|tus-[0-9a-f]{64}-000[1-3]\.json)$/.test(name))fail('OBJECT_NAME_INVALID');
    if(name.startsWith('part-')&&(+name.slice(5,12)<1||+name.slice(5,12)>10000))fail('OBJECT_NAME_INVALID');
    return `/storage/v1/object/${bucket}/${prefix}${name}`;
  }
  async function readText(name) {
    const path=objectPath(name);await initialize();
    const reply=await request(path);
    if(reply.status===200)return reply.text;
    if(objectMissing(reply))return null;
    fail(`READ_HTTP_${reply.status}`);
  }
  async function readJson(name) {const value=await readText(name);return value==null?null:json(value);}
  async function putJsonOnce(name,value) {
    const path=objectPath(name),body=JSON.stringify(value);
    if(typeof body!=='string'||Buffer.byteLength(body)>MAX_JSON_BYTES)fail('ARTIFACT_TOO_LARGE');
    const existing=await readText(name);
    if(existing!=null) {
      if(existing!==body)fail('IMMUTABLE_WRITE_CONFLICT');
      return;
    }
    const reply=await request(path,{method:'POST',headers:{'Content-Type':'application/json','x-upsert':'false'},body},128*1024);
    if(![200,201].includes(reply.status)&&!duplicate(reply))fail(`WRITE_HTTP_${reply.status}`);
    // Includes concurrent create race; only exact verified bytes are accepted.
    const stored=await readText(name);
    if(stored!==body)fail('WRITE_READBACK_MISMATCH');
  }
  return Object.freeze({binding,prefix,bucket,supabaseUrl,initialize,readJson,putJsonOnce});
}

export function createV3ExportPartsStore(options) {
  return createExportPartsStore({
    ...options,
    expectedSupabaseUrl: EXPORT_PARTS_V3_URL,
    expectedProjectRef: 'kaxsqafdevabkxofwdod',
    targetError: 'EXACT_V3_REQUIRED',
  });
}
