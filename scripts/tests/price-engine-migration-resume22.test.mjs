import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMigrationPlan,TRANSACTION_SETUP_SQL,RESUME22_LOCKS_SQL} from '../ops/run-price-engine-production-migrations.mjs';
import {buildResume22Reconciliation,inspectResume22Snapshot,RESUME22_MANIFEST_SHA256}
 from '../ops/price-engine-migration-resume22.mjs';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';

test('actual PG17 partial21 reconciliation detects definition/ACL/data drift, confirmed rollback and later continuation',async()=>{
 const plan=await buildMigrationPlan({expectedManifestSha256:RESUME22_MANIFEST_SHA256});
 const reconciliation=await buildResume22Reconciliation(plan),db=await createFullReplayDb();
 const begin=async()=>{await db.exec('BEGIN');for(const sql of TRANSACTION_SETUP_SQL)await db.exec(sql);};
 const snapshot=async()=>{
  await db.exec('SET search_path=pg_catalog');
  return (await db.query(reconciliation.sql,reconciliation.parameters)).rows[0].resume22_snapshot;
 };
 try{
  await db.exec('ALTER TABLE public.supplier_prices ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid()');
  await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated,service_role');
  for(const item of plan.indexPlan.operations)await db.exec(item.source_sql);
  for(const entry of plan.entries.slice(0,21)){await begin();await db.exec(entry.sql);await db.exec('COMMIT');}
  await db.exec("INSERT INTO public.organizations(id,name) VALUES('1e4c5e99-e387-41aa-a6d3-cbe74558f766','Local resume test'); INSERT INTO public.customers(id,organization_id,customer_number,price_list_type) VALUES('fd9f8834-7935-4050-8895-fde8a2eb4914','1e4c5e99-e387-41aa-a6d3-cbe74558f766','RESUME-TEST','C')");
  assert.equal(reconciliation.parameters[0].length,16);assert.equal(reconciliation.parameters[1].length,47);
  assert.equal(inspectResume22Snapshot(reconciliation,await snapshot()).ready,true);
  assert.deepEqual((await db.query(RESUME22_LOCKS_SQL)).rows[0],{table_present:true,other_locks:0});
  for(const mutation of [
   'ALTER FUNCTION public.begin_supplier_price_import(text,text,text) SECURITY INVOKER',
   'GRANT UPDATE ON public.supplier_price_releases TO anon',
   'ALTER TABLE public.supplier_price_releases DISABLE ROW LEVEL SECURITY',
   'DROP INDEX public.idx_supplier_current_price_pointers_org_brand',
   "UPDATE public.customers SET price_list_type='A' WHERE id='fd9f8834-7935-4050-8895-fde8a2eb4914'",
   "UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=true,activation_decision_id='90000000-0000-4000-8000-000000000001',activated_by='90000000-0000-4000-8000-000000000002',activated_at=now()",
  ]){
   await db.exec('BEGIN');await db.exec(mutation);
   assert.equal(inspectResume22Snapshot(reconciliation,await snapshot()).ready,false,mutation);
   await db.exec('ROLLBACK');
  }
  await begin();await db.exec(plan.entries[21].sql);
  await assert.rejects(db.exec('SELECT 1/0'),/division by zero/);await db.exec('ROLLBACK');
  assert.equal(inspectResume22Snapshot(reconciliation,await snapshot()).ready,true,'Confirmed22 rollback preserves original prefix state');
  // A committed22 (including a client-unknown COMMIT) cannot reuse the original
  // rollback22 authorization. Only the complete original partial state matches.
  await begin();await db.exec(plan.entries[21].sql);await db.exec('COMMIT');
  assert.equal(inspectResume22Snapshot(reconciliation,await snapshot()).ready,false);
  for(const entry of plan.entries.slice(22)){
   await begin();if(entry.position===29)await db.exec(plan.alignment_sql);
   await db.exec(entry.sql);await db.exec('COMMIT');
  }
  assert.equal((await db.query("SELECT price_list_type FROM public.customers WHERE id='fd9f8834-7935-4050-8895-fde8a2eb4914'")).rows[0].price_list_type,'A');
  assert.deepEqual((await db.query('SELECT enabled,reversal_enabled FROM supplier_price_ingestion_internal.production_publication_control')).rows[0],{enabled:false,reversal_enabled:false});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.supplier_price_release_events')).rows[0].n,0);
 }finally{await db.close();}
});
