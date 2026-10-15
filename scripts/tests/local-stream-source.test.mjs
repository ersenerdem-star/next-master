import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createLocalStreamSource,clearLocalStreamSources} from '../../apps/engine/supplier-price-shadow/src/local-stream-source.mjs';

const releaseId='11111111-1111-4111-8111-111111111111';
const handoffId='22222222-2222-4222-8222-222222222222';
const csv='Product Code,Buy Price,Currency,Price Date\nABC-1,10.50,EUR,2026-10-15\nABC-2,20.00,EUR,2026-10-15\nABC-3,30.25,EUR,2026-10-15\nABC-4,40.00,EUR,2026-10-15\n';
const sha=createHash('sha256').update(csv).digest('hex');

test('local stream source parses one file and serves exact leased ranges',async()=>{
 const fetchImpl=async(url,options={})=>{
  if(url.includes('/storage/v1/object/'))return new Response(csv,{status:200});
  if(url.includes('/rpc/record_supplier_price_source_compatibility'))return new Response(JSON.stringify({status:'recorded',release_id:releaseId,source_sha256:sha,total_rows:4}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error(`unexpected ${url} ${options.method||'GET'}`);
 };
 const source=createLocalStreamSource({supabaseUrl:'https://example.supabase.co',serviceRoleKey:'sb_secret_test',fetchImpl});
 const release={id:releaseId,handoff_id:handoffId,source_file_path:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/supplier-price/1/file.csv',source_file_sha256:sha,source_file_bytes:Buffer.byteLength(csv),total_rows:4,source_date:'2026-10-15'};
 const receipt=await source.prepare({release,batchSize:2});
 assert.equal(receipt.bucket,'supplier-price-local');
 assert.equal(receipt.validation.totalRows,4);
 const scan=await source.scan({release,claim:{cursor_start:3,cursor_end:4},batchSize:2,receipt});
 assert.equal(scan.batchRows,2);
 assert.equal(scan.rows[0].product_code,'ABC-3');
 assert.equal(scan.rows[1].product_code,'ABC-4');
 await clearLocalStreamSources();
});
