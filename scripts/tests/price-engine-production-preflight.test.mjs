import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { inspectSnapshot, inspectManifest } from '../ops/price-engine-production-preflight.mjs';
import { createFoundationTestDb } from './fixtures/price-engine-foundation-db.mjs';

const production = 'zjgueqijumzlfioihnkt';
const staging = 'kaxsqafdevabkxofwdod';
const sql = readFileSync(new URL('../ops/price-engine-production-preflight.sql', import.meta.url),'utf8');
const visibilityFunctions = ['get_supplier_price_workflow_failure_context','mark_supplier_price_processing_interrupted',
  'supplier_price_ingestion_internal.clear_processing_interrupted_on_progress'];
const triggerName = 'supplier_price_clear_processing_interrupted_on_progress';
let template;

test('metadata snapshot compiles on a database without feature tables and creates nothing', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create role authenticator;
      create schema storage; create table storage.buckets(id text primary key, public boolean, file_size_limit bigint, allowed_mime_types text[]);`);
    const before = (await db.query('select count(*)::int as count from pg_class')).rows[0].count;
    template = (await db.query(sql)).rows[0].price_engine_preflight;
    const after = (await db.query('select count(*)::int as count from pg_class')).rows[0].count;
    assert.equal(after,before);
    assert.equal(template.tables.length,32);
    assert.equal(template.tables.filter(row => row.present).length,0);
    const result = inspectSnapshot({project_ref:production,data:template},{phase:'baseline',expectedProject:production});
    assert.equal(result.ready,false);
    assert.ok(result.errors.includes('TABLE_MISSING:organizations'));
  } finally { await db.close(); }
});

function compatibleEnvelope(project_ref) {
  const data = structuredClone(template);
  for (const row of data.tables) Object.assign(row,{present:true,rls:true,service_select:true,service_insert:true,service_update:true,service_delete:false,anon_access:false,authenticated_access:false});
  for (const row of data.columns) Object.assign(row,{present:true,compatible:true});
  for (const row of data.functions) Object.assign(row,{present:true,service_execute:true,anon_execute:false,authenticated_execute:false,
    overloads:[{signature:row.signature||`${row.name}()`,definition_md5:'fixture-same',security_definer:true,config:['search_path=""']}]});
  for (const row of data.functions.filter(row => row.authenticated_storage_predicate))
    Object.assign(row,{service_execute:false,authenticated_execute:true});
  for (const row of data.functions.filter(row => row.owner_only))
    Object.assign(row,{service_execute:false});
  for (const row of data.functions.filter(row => typeof row.expected_security_definer === 'boolean'))
    row.overloads[0].security_definer = row.expected_security_definer;
  for (const row of data.triggers) Object.assign(row,{present:true,compatible:true,definition_md5:'a'.repeat(32)});
  for (const row of data.indexes) Object.assign(row,{present:true,valid:true,ready:true});
  for (const row of data.buckets) Object.assign(row,{present:true,private:true,size_compatible:true,binary_compatible:true});
  for (const row of data.schemas) Object.assign(row,{present:true,anon_usage:false,authenticated_usage:false,service_usage:false});
  data.job_constraints = [{validated:true,definition:"CHECK (export_type IN ('admin_price_list','portal_price_list','catalog_master','catalog_export','supplier_report','supplier_price_list'))"}];
  return {project_ref,data};
}

test('wrong target and omitted metadata never pass the baseline gate', () => {
  const complete = compatibleEnvelope(staging);
  assert.ok(inspectSnapshot(complete,{expectedProject:production}).errors.includes('PROJECT_TARGET_UNCONFIRMED'));
  complete.project_ref=production;
  complete.data.functions=[];
  assert.ok(inspectSnapshot(complete,{expectedProject:production}).errors.includes('SNAPSHOT_REQUIREMENTS_INCOMPLETE:functions'));
});

test('multipart MIME and direct browser job access are independent runtime blockers', () => {
  const prod = compatibleEnvelope(production),reference = compatibleEnvelope(staging);
  assert.equal(inspectSnapshot(prod,{expectedProject:production,reference}).ready,true);
  prod.data.buckets.find(row => row.name==='app-exports').binary_compatible=false;
  prod.data.tables.find(row => row.name==='app_export_jobs').authenticated_access=true;
  const result=inspectSnapshot(prod,{expectedProject:production,reference});
  assert.equal(result.ready,false);
  assert.ok(result.errors.includes('BUCKET_INCOMPATIBLE:app-exports'));
  assert.ok(result.errors.includes('DIRECT_BROWSER_JOB_ACCESS:app_export_jobs'));
});

test('a different function body cannot pass on name and signature alone', () => {
  const prod=compatibleEnvelope(production),reference=compatibleEnvelope(staging);
  prod.data.functions.find(row=>row.name==='cloud_supplier_price_export_chunk_v3').overloads[0].definition_md5='old-production-body';
  assert.ok(inspectSnapshot(prod,{expectedProject:production,reference}).errors.includes('FUNCTION_DRIFT:cloud_supplier_price_export_chunk_v3'));
});

test('the explicit migration plan stays closed while foundation, canaries or file hashes are unconfirmed', () => {
  const manifest=JSON.parse(readFileSync(new URL('../ops/price-engine-production-manifest.json',import.meta.url),'utf8'));
  const result=inspectManifest(manifest);
  assert.equal(result.ready,false);
  assert.equal(result.errors.filter(e=>e.startsWith('MIGRATION_CHANGED:')).length,0);
  const missingFoundation = structuredClone(manifest);
  Object.assign(missingFoundation.migration_order.find(entry => entry.id === 'production-supplier-foundation'),{file:null,sha256:null});
  assert.ok(inspectManifest(missingFoundation).errors.includes('MIGRATION_CAPTURE_PENDING:production-supplier-foundation'));
  assert.ok(result.errors.includes('ACCEPTANCE_PENDING:all-exports-browser-canary'));
  const tampered=inspectManifest(manifest,{loadFile:()=>Buffer.from('wrong revision')});
  assert.ok(tampered.errors.some(e=>e.startsWith('MIGRATION_CHANGED:')));
});

test('production manifest must explicitly require compact history; missing, disabled or ambiguous configuration is closed', () => {
  const original=JSON.parse(readFileSync(new URL('../ops/price-engine-production-manifest.json',import.meta.url),'utf8'));
  assert.equal(inspectManifest(original).errors.includes('COMPACT_HISTORY_PRODUCTION_REQUIRED'),false);
  for(const value of [undefined,'0','true','1 at activation']) {
    const manifest=structuredClone(original);
    manifest.runtime_configuration.find(item=>item.surface==='Render supplier worker').variables.SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED=value;
    assert.ok(inspectManifest(manifest).errors.includes('COMPACT_HISTORY_PRODUCTION_REQUIRED'));
  }
  const duplicate=structuredClone(original);
  duplicate.runtime_configuration.push(duplicate.runtime_configuration.find(item=>item.surface==='Render supplier worker'));
  assert.ok(inspectManifest(duplicate).errors.includes('COMPACT_HISTORY_PRODUCTION_REQUIRED'));
});

test('visibility metadata absence, ACL/posture drift and trigger drift cannot give a runtime green result', () => {
  for(const name of visibilityFunctions) {
    for(const patch of [{present:false},{definition_md5:'b'.repeat(32)},{security_definer:'wrong'},{config:['search_path=public']}]) {
      const prod=compatibleEnvelope(production),reference=compatibleEnvelope(staging);
      const fn=prod.data.functions.find(row=>row.name===name);
      if('present' in patch)Object.assign(fn,patch);else Object.assign(fn.overloads[0],patch);
      assert.equal(inspectSnapshot(prod,{expectedProject:production,reference}).ready,false);
    }
  }
  for(const patch of [{present:false},{compatible:false},{definition_md5:'b'.repeat(32)},{definition_md5:null}]) {
    const prod=compatibleEnvelope(production),reference=compatibleEnvelope(staging);
    Object.assign(prod.data.triggers[0],patch);
    assert.equal(inspectSnapshot(prod,{expectedProject:production,reference}).ready,false);
  }
  const missing=compatibleEnvelope(production);delete missing.data.triggers;
  assert.ok(inspectSnapshot(missing,{expectedProject:production}).errors.includes('SNAPSHOT_SECTION_MISSING:triggers'));
});

test('actual PG17 visibility functions and trigger are discovered without execution and reject ACL/event/body changes', async t => {
  const db=await createFoundationTestDb();t.after(()=>db.close());
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql',import.meta.url),'utf8'));
  const migration=readFileSync(new URL('../../supabase/migrations/20261014144957_supplier_price_workflow_failure_visibility.sql',import.meta.url),'utf8');
  await db.exec(migration);
  const snapshot=async()=> (await db.query(sql)).rows[0].price_engine_preflight;
  const original=await snapshot();
  assert.equal(original.functions.length,55);assert.equal(original.triggers.length,1);
  const reference=compatibleEnvelope(staging);
  const envelope=data=>{
    const result=compatibleEnvelope(production);
    for(const name of visibilityFunctions) {
      const index=result.data.functions.findIndex(row=>row.name===name);
      result.data.functions[index]=data.functions.find(row=>row.name===name);
    }
    result.data.triggers=data.triggers;return result;
  };
  const good=envelope(original);
  reference.data.functions=structuredClone(good.data.functions);reference.data.triggers=structuredClone(good.data.triggers);
  assert.equal(inspectSnapshot(good,{expectedProject:production,reference}).ready,true);
  assert.equal(original.triggers[0].compatible,true);
  assert.equal((await db.query('SELECT count(*)::integer n FROM public.supplier_price_release_events')).rows[0].n,0);
  const check=async code=>assert.ok(inspectSnapshot(envelope(await snapshot()),{expectedProject:production,reference}).errors.includes(code));
  await db.exec('GRANT EXECUTE ON FUNCTION public.get_supplier_price_workflow_failure_context(uuid[]) TO PUBLIC');
  await check('FUNCTION_SCOPE_INCOMPATIBLE:get_supplier_price_workflow_failure_context');
  await db.exec(migration);
  await db.exec('GRANT EXECUTE ON FUNCTION public.mark_supplier_price_processing_interrupted(uuid,uuid,text,bigint,timestamptz,timestamptz) TO authenticated');
  await check('FUNCTION_SCOPE_INCOMPATIBLE:mark_supplier_price_processing_interrupted');
  await db.exec(migration);
  await db.exec('GRANT EXECUTE ON FUNCTION supplier_price_ingestion_internal.clear_processing_interrupted_on_progress() TO service_role');
  await check('PRIVATE_HELPER_SCOPE_INCOMPATIBLE:supplier_price_ingestion_internal.clear_processing_interrupted_on_progress');
  await db.exec(migration);
  await db.exec(`ALTER TABLE public.supplier_price_releases DISABLE TRIGGER ${triggerName}`);
  await check(`TRIGGER_INCOMPATIBLE:${triggerName}`);
  for(const clause of ['AFTER UPDATE','BEFORE UPDATE OF current_cursor','BEFORE INSERT']) {
    await db.exec(`CREATE OR REPLACE TRIGGER ${triggerName} ${clause} ON public.supplier_price_releases
      FOR EACH ROW EXECUTE FUNCTION supplier_price_ingestion_internal.clear_processing_interrupted_on_progress()`);
    await check(`TRIGGER_INCOMPATIBLE:${triggerName}`);
  }
  await db.exec(`CREATE OR REPLACE TRIGGER ${triggerName} BEFORE UPDATE ON public.supplier_price_releases
    FOR EACH ROW WHEN (NEW.current_cursor>OLD.current_cursor)
    EXECUTE FUNCTION supplier_price_ingestion_internal.clear_processing_interrupted_on_progress()`);
  await check(`TRIGGER_INCOMPATIBLE:${triggerName}`);
  await db.exec(`CREATE FUNCTION supplier_price_ingestion_internal.wrong_clear_fixture()
    RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $$ BEGIN RETURN NEW; END $$;
    CREATE OR REPLACE TRIGGER ${triggerName} BEFORE UPDATE ON public.supplier_price_releases
    FOR EACH ROW EXECUTE FUNCTION supplier_price_ingestion_internal.wrong_clear_fixture()`);
  await check(`TRIGGER_INCOMPATIBLE:${triggerName}`);
  await db.exec(migration);
  await db.exec(`CREATE OR REPLACE FUNCTION supplier_price_ingestion_internal.clear_processing_interrupted_on_progress()
    RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $$ BEGIN RETURN NEW; END $$`);
  await check('FUNCTION_DRIFT:supplier_price_ingestion_internal.clear_processing_interrupted_on_progress');
  await db.exec(`DROP TRIGGER ${triggerName} ON public.supplier_price_releases`);
  await check(`TRIGGER_INCOMPATIBLE:${triggerName}`);
  await db.exec(migration);
  assert.equal(inspectSnapshot(envelope(await snapshot()),{expectedProject:production,reference}).ready,true);
});
