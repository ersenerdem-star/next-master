import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {admitBenchmark,benchmarkCsv,BENCHMARK_ROWS} from '../../apps/engine/supplier-price-shadow/src/staging-batch-benchmark.mjs';
import {parseNormalizedSupplierPriceRows} from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';

test('staging benchmark refuses production, mixed targets and mismatched batch before any request',async()=>{
 const valid={SUPABASE_URL:'https://kaxsqafdevabkxofwdod.supabase.co',SUPPLIER_PRICE_SHADOW_BATCH_SIZE:'250',
  SUPPLIER_PRICE_LOCAL_STREAM_ENABLED:'1',SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED:'1',SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED:'1'};
 for(const change of [{SUPABASE_URL:'https://zjgueqijumzlfioihnkt.supabase.co'},{NM_PRODUCTION_TARGET:'zjgueqijumzlfioihnkt'},
  {SUPPLIER_PRICE_SHADOW_BATCH_SIZE:'1000'},{SUPPLIER_PRICE_LOCAL_STREAM_ENABLED:'0'},{SUPPLIER_PRICE_TARGET_ENVIRONMENT:'production'}]){
  await assert.rejects(admitBenchmark(250,{...valid,...change},()=>{assert.fail('no request allowed')}),/TARGET_OR_CONFIG/);
 }
});

test('same 50003-row source retains exact identities, prices and commercial fields at every candidate boundary',async()=>{
 const csv=benchmarkCsv();assert.deepEqual(csv,benchmarkCsv());
 const digest=createHash('sha256').update(csv).digest('hex');
 let count=0;
 for await(const row of parseNormalizedSupplierPriceRows(Readable.from(csv),{commercialFields:true})){
  count++;assert.equal(row.source_row_number,count);assert.equal(row.product_code,`NM-PERF-${String(count).padStart(7,'0')}`);
  assert.equal(row.buy_price,(100+count%999)/100);assert.equal(row.origin,count%2?'TR':'DE');
  assert.equal(row.tariff,'87088099');assert.equal(row.stock_qty,count%7);assert.equal(row.order_multiple,3);
  assert.equal(row.valid_from,'2026-10-23');assert.equal(row.valid_to,'2027-10-23');assert.equal(row.row_status,'accepted');
 }
 assert.equal(count,BENCHMARK_ROWS);
 for(const batch of [250,500,1000]){
  const boundaries=Array.from({length:Math.ceil(count/batch)},(_,i)=>[i*batch+1,Math.min(count,(i+1)*batch)]);
  assert.equal(boundaries.reduce((n,[a,b])=>n+b-a+1,0),count);assert.equal(boundaries.at(-1)[1]-boundaries.at(-1)[0]+1,3);
 }
 console.log(JSON.stringify({rows:count,bytes:csv.length,sha256:digest}));
});
