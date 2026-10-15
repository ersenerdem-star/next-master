// Single-file source adapter for the ordinary supplier price upload.
//
// The source is downloaded and parsed once per worker invocation.  Normalized
// rows stay in one private local JSONL file and are read by byte range for each
// leased database batch.  This keeps the resumable SQL contract while removing
// the per-batch Storage object fan-out that made a three-column upload slow and
// vulnerable to Storage rate limits.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { parseNormalizedSupplierPriceRowsFromXlsx } from './streaming-xlsx.mjs';
import { parseNormalizedSupplierPriceRows } from './streaming-csv.mjs';
import { applyReleaseSourceDate } from './storage-scan.mjs';
import { validateCsvWithDuckDB } from './duckdb-validation.mjs';
import { SUPPLIER_SOURCE_COMPATIBILITY_POLICY, SUPPLIER_SOURCE_COMMERCIAL_POLICY } from './streaming-csv.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;
const MAX_SOURCE_BYTES=1024*1024*1024;
const states=new Map();
const digest=value=>createHash('sha256').update(value).digest('hex');
const first=value=>Array.isArray(value)?value[0]:value;
const positive=(value,max)=>Number.isSafeInteger(value)&&value>0&&value<=max;

function validateRelease(release,batchSize){
  if(!UUID.test(release?.id||'')||!UUID.test(release?.handoff_id||'')
    ||!SHA.test(release?.source_file_sha256||'')||!positive(Number(release?.source_file_bytes),MAX_SOURCE_BYTES)
    ||!positive(Number(release?.total_rows),10_000_000)||!positive(batchSize,10_000)
    ||typeof release?.source_file_path!=='string'||release.source_file_path.split('/').some(x=>!x||x==='.'||x==='..')
    ||!/\.(csv|tsv|txt|xlsx)$/i.test(release.source_file_path)) throw Error('LOCAL_STREAM_BINDING_INVALID');
}

function objectUrl(origin,bucket,path){
  return `${origin}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function downloadSource({origin,key,bucket,path,expectedBytes,expectedSha,fetchImpl}){
  const response=await fetchImpl(objectUrl(origin,bucket,path),{headers:{Authorization:`Bearer ${key}`,apikey:key},redirect:'error'});
  if(!response.ok||!response.body) { await response.body?.cancel?.(); throw Error(`LOCAL_STREAM_SOURCE_FAILED:${response.status}`); }
  const dir=await mkdtemp(join(tmpdir(),'supplier-price-local-'));
  const file=join(dir,/\.xlsx$/i.test(path)?'source.xlsx':'source.csv');
  const hash=createHash('sha256'); let bytes=0;
  const input=typeof response.body.getReader==='function'?Readable.fromWeb(response.body):response.body;
  await pipeline(input,new Transform({transform(chunk,_encoding,done){
    bytes+=chunk.length; if(bytes>expectedBytes){done(Error('LOCAL_STREAM_SOURCE_TOO_LARGE'));return;}
    hash.update(chunk); done(null,chunk);
  }}),createWriteStream(file,{flags:'wx',mode:0o600}));
  if(bytes!==expectedBytes||hash.digest('hex')!==expectedSha){await rm(dir,{recursive:true,force:true});throw Error('LOCAL_STREAM_SOURCE_MISMATCH');}
  return {dir,file};
}

async function recordCompatibility({origin,key,release,commercialFields,fetchImpl}){
  const name=commercialFields?'record_supplier_price_source_compatibility_v2':'record_supplier_price_source_compatibility';
  const payload={input_release_id:release.id,input_handoff_id:release.handoff_id,
    input_source_sha256:release.source_file_sha256,input_total_rows:Number(release.total_rows),
    input_policy:commercialFields?SUPPLIER_SOURCE_COMMERCIAL_POLICY:SUPPLIER_SOURCE_COMPATIBILITY_POLICY};
  const response=await fetchImpl(`${origin}/rest/v1/rpc/${name}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,apikey:key,'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error'});
  const body=await response.json().catch(()=>null);
  if(!response.ok||!['recorded','replayed'].includes(body?.status)||body.release_id!==release.id
    ||body.source_sha256!==release.source_file_sha256||Number(body.total_rows)!==Number(release.total_rows))
    throw Error('LOCAL_STREAM_COMPATIBILITY_UNCONFIRMED');
}

async function prepareSource({origin,key,release,batchSize,commercialFields,fetchImpl}){
  validateRelease(release,batchSize);
  const cached=[...states.values()].find(s=>s.release.id===release.id&&s.batchSize===batchSize&&s.commercialFields===commercialFields);
  if(cached)return cached.receipt;
  const downloaded=await downloadSource({origin,key,bucket:'supplier-price-imports',path:release.source_file_path,
    expectedBytes:Number(release.source_file_bytes),expectedSha:release.source_file_sha256,fetchImpl});
  const validation=await validateCsvWithDuckDB({inputPath:downloaded.file,sourceDate:release.source_date,memoryLimit:'512MB',threads:4,tempDirectory:downloaded.dir,commercialFields});
  if(Number(validation.totalRows)!==Number(release.total_rows)||validation.publishable!==true) throw Error('LOCAL_STREAM_SOURCE_VALIDATION_FAILED');
  await recordCompatibility({origin,key,release,commercialFields,fetchImpl});
  const normalized=join(downloaded.dir,'normalized.jsonl');
  const output=createWriteStream(normalized,{flags:'wx',mode:0o600});
  const completed=once(output,'close');
  const index=[]; let cursor=0; let byteOffset=0; let batch=null; let batchNumber=0;
  const parser=/\.xlsx$/i.test(downloaded.file)
    ?parseNormalizedSupplierPriceRowsFromXlsx(downloaded.file,{commercialFields,sourceDate:release.source_date})
    :parseNormalizedSupplierPriceRows(createReadStream(downloaded.file),{commercialFields,sourceDate:release.source_date});
  for await(const parsed of parser){
    const row=applyReleaseSourceDate(parsed,release.source_date);
    const line=Buffer.from(JSON.stringify(row)+'\n');
    if(!output.write(line))await once(output,'drain');
    if(!batch)batch={start:cursor+1,startByte:byteOffset};
    cursor++; byteOffset+=line.length;
    if(cursor===release.total_rows||cursor-batch.start+1>=batchSize){
      batchNumber++; index.push({...batch,batchNumber,end:cursor,endByte:byteOffset,rowCount:cursor-batch.start+1}); batch=null;
    }
  }
  output.end(); await completed;
  if(cursor!==Number(release.total_rows))throw Error(`LOCAL_STREAM_ROW_COUNT_MISMATCH:${cursor}`);
  const manifest=JSON.stringify({version:1,release_id:release.id,source_sha256:release.source_file_sha256,total_rows:cursor,batch_size:batchSize,index});
  const receipt={bucket:'supplier-price-local',key:`${release.id}/manifest.json`,sha256:digest(manifest),validation};
  states.set(receipt.sha256,{release:{...release},batchSize,commercialFields,dir:downloaded.dir,file:normalized,index,receipt,manifest});
  return receipt;
}

async function readRows(state,claim){
  const entry=state.index.find(x=>x.start===Number(claim.cursor_start)&&x.end===Number(claim.cursor_end));
  if(!entry)throw Error('LOCAL_STREAM_BATCH_INDEX_MISSING');
  const stream=createReadStream(state.file,{start:entry.startByte,end:entry.endByte-1});
  let text=''; for await(const chunk of stream)text+=chunk.toString('utf8');
  const rows=text.trimEnd().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  if(rows.length!==entry.rowCount)throw Error('LOCAL_STREAM_BATCH_ROW_COUNT_MISMATCH');
  for(const [i,row] of rows.entries())if(Number(row.source_row_number)!==entry.start+i)throw Error('LOCAL_STREAM_BATCH_SEQUENCE_INVALID');
  let acceptedRows=0,warningRows=0,rejectedRows=0;
  for(const row of rows){if(row.row_status==='accepted')acceptedRows++;else if(row.row_status==='warning')warningRows++;else if(row.row_status==='rejected')rejectedRows++;else throw Error('LOCAL_STREAM_ROW_STATUS_INVALID');}
  return {cursorEnd:entry.end,scannedRows:entry.rowCount,sourceRows:state.release.total_rows,batchRows:rows.length,
    acceptedRows,warningRows,rejectedRows,checksum:state.release.source_file_sha256,rows,prepared:true};
}

export function createLocalStreamSource({supabaseUrl,serviceRoleKey,fetchImpl=fetch,commercialFields=false}={}){
  const origin=new URL(String(supabaseUrl||''));
  if(origin.protocol!=='https:'||!serviceRoleKey||typeof fetchImpl!=='function')throw Error('LOCAL_STREAM_CONFIG_INVALID');
  return {
    async prepare({release,batchSize}){return prepareSource({origin:origin.origin,key:serviceRoleKey,release,batchSize,commercialFields,fetchImpl});},
    async scan({release,claim,batchSize,receipt}){
      let state=states.get(receipt?.sha256);
      if(!state){await prepareSource({origin:origin.origin,key:serviceRoleKey,release,batchSize,commercialFields,fetchImpl});state=states.get(receipt?.sha256);}
      if(!state)throw Error('LOCAL_STREAM_STATE_MISSING');
      return readRows(state,claim);
    },
  };
}

export async function clearLocalStreamSources(){for(const state of states.values())await rm(state.dir,{recursive:true,force:true}).catch(()=>{});states.clear();}
