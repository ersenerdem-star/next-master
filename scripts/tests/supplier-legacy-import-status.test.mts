import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {SUPPLIER_LEGACY_IMPORT_COLUMNS,legacySupplierImportTelemetry,loadLegacySupplierOperations,legacyCustomerPriceReadiness} from '../../apps/web/src/shared/supplierLegacyImportStatus.ts';

const baseline=JSON.parse(await readFile(new URL('./fixtures/price-engine-full-replay-production-source.json',import.meta.url),'utf8'));
const run={status:'running',error_message:null,finalize_error_message:null,finalized_at:null,finished_at:null,superseded_by:null};

test('legacy history projection executes against independently captured production/staging schema',async()=>{
 const columns=baseline.tables.find((t:{schema:string;name:string})=>t.schema==='public'&&t.name==='supplier_price_import_runs').columns;
 assert.ok(columns.length>20,'captured schema must exist');
 const db=new PGlite();
 try{
  await db.exec(`create table public.supplier_price_import_runs(${columns.map((c:{name:string;type:string})=>`"${c.name}" ${c.type}`).join(',')})`);
  await db.query(`insert into public.supplier_price_import_runs(id,organization_id,status,finalize_error_message) values($1,$2,'failed','preserved finalizer error')`,['10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002']);
  const {rows}=await db.query(`select ${SUPPLIER_LEGACY_IMPORT_COLUMNS} from public.supplier_price_import_runs where organization_id=$1 order by started_at desc`,['20000000-0000-0000-0000-000000000002']);
  assert.equal(rows.length,1);
  assert.equal(rows[0].finalize_error_message,'preserved finalizer error');
  await assert.rejects(db.query('select finalize_worker_state from public.supplier_price_import_runs'),{code:'42703'});
 }finally{await db.close();}
});

test('stored active state never fabricates live worker telemetry or zero batch history',()=>{
 for(const status of ['running','finalizing','pending','unexpected']){
  const result=legacySupplierImportTelemetry({...run,status});
  assert.equal(result.supplier_import_worker_state,'unknown');
  assert.equal(result.supplier_import_last_heartbeat_at,null);
  assert.equal(result.supplier_import_last_progress_at,null);
  assert.equal(result.supplier_import_batches,null);
  assert.equal(result.supplier_import_last_batch_processed,null);
 }
 assert.equal(legacySupplierImportTelemetry(null).supplier_import_worker_state,'unknown');
});

test('failed and superseded history retain stored errors without showing queued success',()=>{
 const failed=legacySupplierImportTelemetry({...run,status:'failed',finalize_error_message:'finalizer timeout'});
 assert.equal(failed.supplier_import_worker_state,'failed');
 assert.equal(failed.supplier_import_error_message,'finalizer timeout');
 assert.equal(legacySupplierImportTelemetry({...run,finalize_error_message:'unresolved failure'}).supplier_import_error_message,'unresolved failure');
 const superseded=legacySupplierImportTelemetry({...run,status:'failed',error_message:'original error',finalize_error_message:'secondary error',superseded_by:'another-run'});
 assert.equal(superseded.supplier_import_worker_state,'superseded');
 assert.equal(superseded.supplier_import_error_message,'original error');
});

test('terminal success uses only committed completion timestamp and never invents a heartbeat',()=>{
 for(const status of ['finalized','succeeded']){
  const result=legacySupplierImportTelemetry({...run,status,finalized_at:'2026-10-14T10:00:00Z',finished_at:'2026-10-14T10:01:00Z'});
  assert.equal(result.supplier_import_worker_state,'completed');
  assert.equal(result.supplier_import_last_progress_at,'2026-10-14T10:00:00Z');
  assert.equal(result.supplier_import_last_heartbeat_at,null);
  assert.equal(result.supplier_import_error_message,null);
 }
});

test('optional superadmin rollup denial preserves actual import history and errors',async()=>{
 const imports=[{...run,id:'failed-import',status:'failed',error_message:'real import error'}];
 const result=await loadLegacySupplierOperations(async()=>imports,async()=>{throw Object.assign(new Error('Superadmin access required'),{status:403});});
 assert.equal(result.importRuns,imports);
 assert.equal(result.importRuns[0].error_message,'real import error');
 assert.equal(result.rollupRun,null);
 assert.equal(result.rollupUnavailable,true);
 assert.equal(legacyCustomerPriceReadiness(true,true,'unavailable'),'unavailable');
 assert.equal(legacyCustomerPriceReadiness(false,true,'unavailable'),'waiting');
});

test('required import failure still rejects when optional rollup read is forbidden',async()=>{
 const failure=new Error('Import history could not be read');
 await assert.rejects(loadLegacySupplierOperations(async()=>{throw failure;},async()=>{throw Object.assign(new Error('Superadmin access required'),{status:403});}),error=>error===failure);
});

test('unrelated rollup auth, server and transport failures are not swallowed',async()=>{
 for(const error of [
  Object.assign(new Error('Session expired'),{status:401}),
  Object.assign(new Error('Different denied scope'),{status:403}),
  Object.assign(new Error('Superadmin access required'),{status:500}),
  new Error('Superadmin access required'),
  new TypeError('Failed to fetch'),
 ])await assert.rejects(loadLegacySupplierOperations(async()=>[],async()=>{throw error;}),caught=>caught===error);
});

test('authorized rollup reads retain explicit status without manufacturing readiness',async()=>{
 const completed={id:'rollup',status:'completed'};
 const result=await loadLegacySupplierOperations(async()=>[],async()=>completed);
 assert.equal(result.rollupRun,completed);assert.equal(result.rollupUnavailable,false);
 assert.equal(legacyCustomerPriceReadiness(true,true,'completed'),'ready');
 assert.equal(legacyCustomerPriceReadiness(true,true,'pending'),'waiting');
 assert.equal(legacyCustomerPriceReadiness(true,false,'completed'),'waiting');
 const empty=await loadLegacySupplierOperations(async()=>[],async()=>null);
 assert.equal(empty.rollupRun,null);assert.equal(empty.rollupUnavailable,false);
});
