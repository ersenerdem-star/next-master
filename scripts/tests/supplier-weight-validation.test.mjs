import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseSupplierWeight} from '../../apps/engine/supplier-price-shadow/src/supplier-weight.mjs';
import {normalizeSupplierPriceRow} from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';
import {validateCsvWithDuckDB} from '../../apps/engine/supplier-price-shadow/src/duckdb-validation.mjs';
import {createLocalStreamSource} from '../../apps/engine/supplier-price-shadow/src/local-stream-source.mjs';

test('kg decimals retain all precision including three comma/dot decimals; price interpretation is unchanged',()=>{
 for(const [raw,n] of [['0,355',0.355],['2,228',2.228],['0,35',0.35],['4.200',4.2],['0,000355',0.000355],['1 234,5',1234.5]])assert.equal(parseSupplierWeight(raw),n);
 for(const raw of ['0','-1','abc','2 kg','2,2,8','1.234,5','1000001'])assert.equal(parseSupplierWeight(raw),null);
 const input={sourceRowNumber:1,row:{product_code:'27-079-0',weight:'2,228',buy_price:'27,37',currency:'EUR'}};
 assert.equal(normalizeSupplierPriceRow(input,{commercialFields:true,sourceDate:'2026-10-19'}).weight,2.228);
 assert.equal(normalizeSupplierPriceRow(input).weight,null); // Historical v1 parse remains unchanged.
 assert.equal(normalizeSupplierPriceRow({...input,row:{...input.row,buy_price:'1,234'}},{commercialFields:true}).error_code,'AMBIGUOUS_BUY_PRICE_FORMAT');
});

test('validation records exact CSV record, code, column and raw value before refusing invalid input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'source-diagnostics-test-'));
 try{
  const file=join(dir,'source.csv');await writeFile(file,'Product_Code;Buy_Price_Eur;Weight_kg\nA;1,50;0,355\nB;2,50;2,228\nC;3,50;abc\n');
  const r=await validateCsvWithDuckDB({inputPath:file,commercialFields:true,sourceDate:'2026-10-19'});
  assert.equal(r.publishable,false);assert.equal(r.warningRows,1);assert.equal(r.diagnostics.issueCount,1);
  assert.deepEqual(r.diagnostics.samples[0],{row:4,productCode:'C',column:'Weight_kg',code:'INVALID_WEIGHT',value:'abc',severity:'warning'});
  await writeFile(file,'Product_Code;Buy_Price_Eur\nA;1,50\na;2,50\n');
  const d=await validateCsvWithDuckDB({inputPath:file,commercialFields:true,sourceDate:'2026-10-19'});
  assert.equal(d.duplicateRows,1);assert.equal(d.diagnostics.samples[0].row,3);assert.equal(d.diagnostics.samples[0].code,'DUPLICATE_PRODUCT_CODE');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('local stream persists a hash-bound report before failing, without recording compatibility or staging rows',async()=>{
 const bytes=Buffer.from('Product_Code;Buy_Price_Eur;Weight_kg\nA;1,50;abc\n'),calls=[];
 const release={id:'20000000-0000-4000-8000-000000000001',handoff_id:'20000000-0000-4000-8000-000000000002',source_file_sha256:createHash('sha256').update(bytes).digest('hex'),source_file_bytes:bytes.length,total_rows:1,source_file_path:'org/source.csv',source_date:'2026-10-19'};
 const adapter=createLocalStreamSource({supabaseUrl:'https://example.supabase.co',serviceRoleKey:'test',commercialFields:true,fetchImpl:async(url,init)=>{
  if(url.includes('/storage/'))return new Response(bytes);
  calls.push({url,body:JSON.parse(init.body)});return Response.json({status:'recorded'});
 }});
 await assert.rejects(adapter.prepare({release,batchSize:1000}),/LOCAL_STREAM_SOURCE_VALIDATION_FAILED/);
 assert.equal(calls.length,1);assert.match(calls[0].url,/record_supplier_price_source_validation_report$/);
 assert.equal(calls[0].body.input_source_sha256,release.source_file_sha256);assert.equal(calls[0].body.input_report.samples[0].value,'abc');
});
