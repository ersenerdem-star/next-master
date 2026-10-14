// Local read-only measurement: real parser + DBOS serializer + v5 step outputs.
// No network, DBOS launch, Storage write, SQL write or commercial publication.
// Usage: node scripts/measure-compact-history.mjs <local.csv> <rows> <YYYY-MM-DD>
import {createReadStream,readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {performance} from 'node:perf_hooks';
import {parseNormalizedSupplierPriceRows} from '../src/streaming-csv.mjs';
import {applyReleaseSourceDate} from '../src/storage-scan.mjs';
import {createCompactVerifiedWorkflow} from '../src/compact-verified-workflow.mjs';
import serialization from '../node_modules/@dbos-inc/dbos-sdk/dist/src/serialization.js';

const [file,rawRows,sourceDate]=process.argv.slice(2),totalRows=Number(rawRows);
if(!file||!Number.isSafeInteger(totalRows)||totalRows<1||totalRows>10000000||!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate||''))
 throw Error('USAGE: local.csv row_count YYYY-MM-DD');
const sdkVersion=JSON.parse(readFileSync(new URL('../node_modules/@dbos-inc/dbos-sdk/package.json',import.meta.url),'utf8')).version;
const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
const sourceSHA=hash.digest('hex'),sourceBytes=statSync(file).size;
const releaseId='fed8b4fe-402e-40c5-967c-df587c91acdd',handoffId='c99838e8-b11f-4036-8d22-b4aaf59585ab';
const org='22222222-2222-4222-8222-222222222222',partSHA='1'.repeat(64),batchSize=1000;
const release={id:releaseId,handoff_id:handoffId,total_rows:totalRows,source_file_path:org+'/source.csv',
 source_file_sha256:sourceSHA,source_file_bytes:sourceBytes,source_date:sourceDate};
const receipt={bucket:'supplier-price-prepared',key:`${org}/${releaseId}/${partSHA}/manifest.json`,sha256:partSHA,
 validation:{engine:'duckdb',totalRows,currencyCount:1,publishable:true}};
const iterator=parseNormalizedSupplierPriceRows(createReadStream(file));
let cursor=0,count=0,batches=0,v4ScanBytes=0,v4Max=0,v5AllBytes=0,v5StepCount=0,v5ScanStageBytes=0,v5ScanStageMax=0,v5AllMax=0;
const bytes=value=>Buffer.byteLength(serialization.DBOSJSON.stringify(value));
const DBOS={async runStep(fn,{name}){
 const value=await fn(),size=bytes(value);v5AllBytes+=size;v5StepCount++;v5AllMax=Math.max(v5AllMax,size);
 if(name==='compact-scan-stage-v5'){v5ScanStageBytes+=size;v5ScanStageMax=Math.max(v5ScanStageMax,size);}return value;
},async sleep(){throw Error('UNEXPECTED_BUSY');}};
const source={async prepare(){return receipt;},async scan({claim}){
 const rows=[];
 while(rows.length<claim.cursor_end-claim.cursor_start+1){
  const next=await iterator.next();if(next.done)throw Error('UNEXPECTED_SOURCE_END');
  rows.push(applyReleaseSourceDate(next.value,sourceDate));count++;
 }
 const scan={cursorEnd:count,scannedRows:rows.length,sourceRows:totalRows,batchRows:rows.length,
  acceptedRows:rows.filter(r=>r.row_status==='accepted').length,warningRows:rows.filter(r=>r.row_status==='warning').length,
  rejectedRows:rows.filter(r=>r.row_status==='rejected').length,checksum:sourceSHA,rows,prepared:true};
 const size=bytes(scan);v4ScanBytes+=size;v4Max=Math.max(v4Max,size);batches++;return scan;
}};
const rpc=async(name,args)=>{
 if(name==='get_supplier_price_verified_manifest')return release;
 if(name==='claim_supplier_price_verified_release_batch')return {status:'claimed',release_id:releaseId,
  batch_id:`11111111-1111-4111-8111-${String(cursor+1).padStart(12,'0')}`,cursor_start:cursor+1,cursor_end:Math.min(totalRows,cursor+batchSize)};
 if(name==='stage_supplier_price_release_batch')return {status:'staged',batch_id:args.input_batch_id,release_id_result:releaseId,staged_rows:args.input_rows.length};
 if(name==='heartbeat_supplier_price_release_batch')return {status:'heartbeat',batch_id:args.input_batch_id,release_id:releaseId,
  processed_rows:args.input_processed_rows,current_cursor:args.input_cursor};
 if(name==='finalize_supplier_price_release_shadow_batch'){
  cursor=args.input_cursor;return {status:'finalized',batch_id:args.input_batch_id,release_id:releaseId,
   current_cursor:cursor,release_status:cursor===totalRows?'staged':'parsing'};
 }
 if(name==='complete_supplier_price_release_duckdb_validation')return {status:'validated',release_id:releaseId,publishable:true};
 throw Error('UNEXPECTED_RPC');
};
const start=performance.now();
const result=await createCompactVerifiedWorkflow({DBOS,rpc,source,requireMode(){},batchSize})({releaseId,handoffId});
if(!(await iterator.next()).done)throw Error('SOURCE_ROW_COUNT_MISMATCH');
console.log(JSON.stringify({schemaVersion:1,evidenceKind:'local-serialization-measurement',sdkVersion,
 source:{basename:basename(file),sha256:sourceSHA,bytes:sourceBytes,rows:count,sourceDate},batchSize,batches,
 v4:{scanStepCount:batches,scanSerializedBytes:v4ScanBytes,maxScanSerializedBytes:v4Max},
 v5:{scanStageStepCount:batches,scanStageSerializedBytes:v5ScanStageBytes,maxScanStageSerializedBytes:v5ScanStageMax,
  allStepOutputCount:v5StepCount,allStepOutputSerializedBytes:v5AllBytes,maxStepOutputSerializedBytes:v5AllMax},
 scanStageReductionPercent:100*(1-v5ScanStageBytes/v4ScanBytes),elapsedSeconds:(performance.now()-start)/1000,
 published:result.published,
 scope:'Actual supplier export CSV, production row parser, v5 workflow and SDK DBOSJSON serializer; in-process mocked RPC and preparation receipt.',
 limits:['Not the original uploaded workbook.','No DuckDB validation, Storage partition I/O or remote SQL ran.',
  'Not PostgreSQL physical storage, indexes, TOAST, WAL, memory or end-to-end throughput.',
  'v4 metric includes scan outputs only; v5 total includes all successful workflow step outputs, not DBOS row metadata or workflow input/output.',
  'Fixture UUIDs and prepared manifest hash preserve identity field widths; row content and source hash are from the local file.'],
 reproduce:{script:'apps/engine/supplier-price-shadow/scripts/measure-compact-history.mjs',
  command:`node apps/engine/supplier-price-shadow/scripts/measure-compact-history.mjs <local-export.csv> ${totalRows} ${sourceDate}`}},null,2));
